-- ==============================================================================
-- ULTRON MIGRATION 005: DISTRIBUTED RATE LIMITING & ABUSE PROTECTION
-- File: supabase/migrations/005_rate_limiting.sql
-- Description:
--   Durable PostgreSQL-backed rate limiting for Vercel/serverless environments.
--   Provides atomic token/window tracking across distributed serverless instances.
--
-- Security Rules Enforced:
--   - Direct anonymous access is completely DENIED.
--   - Direct client modification is DENIED.
--   - Atomic check and increment via SECURITY DEFINER function with row-level locks.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.ultron_rate_limits (
    key TEXT PRIMARY KEY,
    count INT NOT NULL DEFAULT 1,
    window_start BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup on rate-limiting key
CREATE INDEX IF NOT EXISTS idx_ultron_rate_limits_updated_at ON public.ultron_rate_limits(updated_at);

-- Enable Row Level Security
ALTER TABLE public.ultron_rate_limits ENABLE ROW LEVEL SECURITY;

-- 1. DROP EXISTING POLICIES
DROP POLICY IF EXISTS "Deny anon rate limits" ON public.ultron_rate_limits;
DROP POLICY IF EXISTS "Allow service role rate limits" ON public.ultron_rate_limits;
DROP POLICY IF EXISTS "Deny authenticated direct rate limits" ON public.ultron_rate_limits;

-- 2. DENY DIRECT CLIENT ACCESS
CREATE POLICY "Deny anon rate limits"
    ON public.ultron_rate_limits
    FOR ALL
    TO anon
    USING (false);

CREATE POLICY "Deny authenticated direct rate limits"
    ON public.ultron_rate_limits
    FOR ALL
    TO authenticated
    USING (false);

-- 3. ALLOW SERVICE ROLE BACKEND ACCESS
CREATE POLICY "Allow service role rate limits"
    ON public.ultron_rate_limits
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 4. ATOMIC RATE LIMIT CHECKING STORED PROCEDURE
-- Returns: allowed, current_count, remaining, reset_at (epoch ms), retry_after (seconds)
CREATE OR REPLACE FUNCTION public.check_rate_limit(
    p_key TEXT,
    p_window_ms BIGINT,
    p_max_requests INT
)
RETURNS TABLE (
    allowed BOOLEAN,
    current_count INT,
    remaining INT,
    reset_at BIGINT,
    retry_after INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now BIGINT := (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;
    v_window_start BIGINT;
    v_count INT;
    v_reset_at BIGINT;
    v_retry_after INT;
BEGIN
    -- Acquire row-level lock on key to guarantee atomicity across concurrent serverless instances
    SELECT window_start, count INTO v_window_start, v_count
    FROM public.ultron_rate_limits
    WHERE key = p_key
    FOR UPDATE;

    IF NOT FOUND THEN
        -- First request in window
        INSERT INTO public.ultron_rate_limits (key, count, window_start, updated_at)
        VALUES (p_key, 1, v_now, NOW())
        ON CONFLICT (key) DO UPDATE
        SET count = public.ultron_rate_limits.count + 1,
            updated_at = NOW();

        RETURN QUERY SELECT true, 1, GREATEST(0, p_max_requests - 1), (v_now + p_window_ms), 0;
        RETURN;
    END IF;

    -- If existing window has expired, reset window
    IF (v_now - v_window_start) >= p_window_ms THEN
        UPDATE public.ultron_rate_limits
        SET count = 1,
            window_start = v_now,
            updated_at = NOW()
        WHERE key = p_key;

        RETURN QUERY SELECT true, 1, GREATEST(0, p_max_requests - 1), (v_now + p_window_ms), 0;
        RETURN;
    END IF;

    -- Within active window
    v_reset_at := v_window_start + p_window_ms;
    v_retry_after := GREATEST(1, CEIL((v_reset_at - v_now)::FLOAT / 1000)::INT);

    IF v_count < p_max_requests THEN
        -- Quota available: increment count
        UPDATE public.ultron_rate_limits
        SET count = count + 1,
            updated_at = NOW()
        WHERE key = p_key;

        RETURN QUERY SELECT true, (v_count + 1), GREATEST(0, p_max_requests - (v_count + 1)), v_reset_at, 0;
        RETURN;
    ELSE
        -- Quota exhausted: reject
        RETURN QUERY SELECT false, v_count, 0, v_reset_at, v_retry_after;
        RETURN;
    END IF;
END;
$$;
