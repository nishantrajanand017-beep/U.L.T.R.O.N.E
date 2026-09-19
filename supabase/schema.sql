-- ==============================================================================
-- ULTRON DEVICE PAIRING & PERSISTENCE SCHEMA FOR SUPABASE
-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/jnnngbfucobujlfttxee/sql/new
-- ==============================================================================

-- 1. Pairing Sessions Table (Short-lived 5-minute single-use pairing codes)
CREATE TABLE IF NOT EXISTS public.ultron_pairing_sessions (
    code VARCHAR(16) PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for pruning expired or used sessions
CREATE INDEX IF NOT EXISTS idx_ultron_pairing_expires ON public.ultron_pairing_sessions (expires_at);

-- 2. Paired Devices Table
CREATE TABLE IF NOT EXISTS public.ultron_devices (
    device_id VARCHAR(64) PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'Android',
    app_version TEXT NOT NULL DEFAULT '1.0.0',
    device_token_hash VARCHAR(64) NOT NULL,
    connection_status VARCHAR(20) NOT NULL DEFAULT 'connected',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_ultron_devices_user ON public.ultron_devices (user_id);
CREATE INDEX IF NOT EXISTS idx_ultron_devices_token_hash ON public.ultron_devices (device_token_hash);

-- 3. Row Level Security (RLS) Policies
-- Enable RLS
ALTER TABLE public.ultron_pairing_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ultron_devices ENABLE ROW LEVEL SECURITY;

-- Deny anon access; allow service_role and authenticated owner only
DROP POLICY IF EXISTS "Allow anon pairing sessions" ON public.ultron_pairing_sessions;
DROP POLICY IF EXISTS "Deny anon pairing sessions" ON public.ultron_pairing_sessions;
CREATE POLICY "Deny anon pairing sessions"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO anon
    USING (false);

DROP POLICY IF EXISTS "Allow service role pairing access" ON public.ultron_pairing_sessions;
CREATE POLICY "Allow service role pairing access"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can manage their own pairing sessions" ON public.ultron_pairing_sessions;
CREATE POLICY "Users can manage their own pairing sessions"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO authenticated
    USING (user_id = (auth.jwt()->>'sub') OR user_id = auth.uid()::text)
    WITH CHECK (user_id = (auth.jwt()->>'sub') OR user_id = auth.uid()::text);

-- Devices RLS
DROP POLICY IF EXISTS "Allow anon devices access" ON public.ultron_devices;
DROP POLICY IF EXISTS "Deny anon devices access" ON public.ultron_devices;
CREATE POLICY "Deny anon devices access"
    ON public.ultron_devices
    FOR ALL
    TO anon
    USING (false);

DROP POLICY IF EXISTS "Allow service role devices access" ON public.ultron_devices;
CREATE POLICY "Allow service role devices access"
    ON public.ultron_devices
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can manage their own devices" ON public.ultron_devices;
CREATE POLICY "Users can manage their own devices"
    ON public.ultron_devices
    FOR ALL
    TO authenticated
    USING (user_id = (auth.jwt()->>'sub') OR user_id = auth.uid()::text)
    WITH CHECK (user_id = (auth.jwt()->>'sub') OR user_id = auth.uid()::text);

-- 4. Device Installed Application Catalogs (Phase 12 Step 3)
CREATE TABLE IF NOT EXISTS public.ultron_device_catalogs (
    device_id VARCHAR(64) PRIMARY KEY REFERENCES public.ultron_devices(device_id) ON DELETE CASCADE,
    catalog JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ultron_device_catalogs_updated ON public.ultron_device_catalogs (updated_at);

ALTER TABLE public.ultron_device_catalogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon device catalogs" ON public.ultron_device_catalogs;
DROP POLICY IF EXISTS "Deny anon device catalogs" ON public.ultron_device_catalogs;
CREATE POLICY "Deny anon device catalogs"
    ON public.ultron_device_catalogs
    FOR ALL
    TO anon
    USING (false);

DROP POLICY IF EXISTS "Allow service role device catalogs" ON public.ultron_device_catalogs;
CREATE POLICY "Allow service role device catalogs"
    ON public.ultron_device_catalogs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can manage their own device catalogs" ON public.ultron_device_catalogs;
CREATE POLICY "Users can manage their own device catalogs"
    ON public.ultron_device_catalogs
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.ultron_devices d
            WHERE d.device_id = ultron_device_catalogs.device_id
              AND (d.user_id = (auth.jwt()->>'sub') OR d.user_id = auth.uid()::text)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.ultron_devices d
            WHERE d.device_id = ultron_device_catalogs.device_id
              AND (d.user_id = (auth.jwt()->>'sub') OR d.user_id = auth.uid()::text)
        )
    );


