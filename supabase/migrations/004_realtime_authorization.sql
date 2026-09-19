-- ==============================================================================
-- ULTRON MIGRATION 004: SUPABASE REALTIME AUTHORIZATION & CHANNEL ISOLATION
-- File: supabase/migrations/004_realtime_authorization.sql
-- Description:
--   Enforces strict Row Level Security (RLS) policies on realtime.messages
--   to secure Realtime WebSocket channels and prevent:
--     1. Cross-user channel eavesdropping / subscription (SELECT policy)
--     2. Cross-user command/event injection (INSERT policy)
--     3. Anonymous access to private device channels
--
-- Channels Protected:
--   - ultron:devices:<userId>
--   - realtime:ultron:devices:<userId>
--   - ultron:device:<deviceId>
--   - realtime:ultron:device:<deviceId>
--
-- Security Rules Enforced:
--   - Anonymous (anon) direct access is explicitly DENIED on realtime.messages.
--   - Service role (service_role) retains full access for server-side command dispatch.
--   - Authenticated users can ONLY subscribe to their own user/device channels.
--   - Authenticated users can ONLY broadcast to their own user/device channels.
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS realtime;

-- Ensure realtime.messages table exists (Supabase Realtime standard authorization table)
CREATE TABLE IF NOT EXISTS realtime.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic TEXT NOT NULL,
    extension TEXT NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security on realtime.messages
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- Helper function for topic retrieval if not already present
CREATE OR REPLACE FUNCTION realtime.topic()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT nullif(current_setting('realtime.topic', true), '');
$$;

-- ------------------------------------------------------------------------------
-- 1. DROP INSECURE OR LEGACY POLICIES
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow anon realtime broadcast" ON realtime.messages;
DROP POLICY IF EXISTS "Allow anon realtime subscribe" ON realtime.messages;
DROP POLICY IF EXISTS "Allow authenticated realtime all" ON realtime.messages;
DROP POLICY IF EXISTS "Deny anon realtime access" ON realtime.messages;
DROP POLICY IF EXISTS "Allow service role realtime access" ON realtime.messages;
DROP POLICY IF EXISTS "Users can subscribe to own device channels" ON realtime.messages;
DROP POLICY IF EXISTS "Users can broadcast only to own device channels" ON realtime.messages;

-- ------------------------------------------------------------------------------
-- 2. DENY DIRECT ANONYMOUS ACCESS
-- ------------------------------------------------------------------------------
CREATE POLICY "Deny anon realtime access"
    ON realtime.messages
    FOR ALL
    TO anon
    USING (false);

-- ------------------------------------------------------------------------------
-- 3. ALLOW SERVICE ROLE FULL BACKEND ACCESS
-- ------------------------------------------------------------------------------
-- Used by server-side /api/devices/[deviceId]/commands route for authorized command dispatch
CREATE POLICY "Allow service role realtime access"
    ON realtime.messages
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 4. SUBSCRIBE AUTHORIZATION (SELECT) FOR AUTHENTICATED USERS
-- ------------------------------------------------------------------------------
-- Controls which channels a client is permitted to join and listen to
CREATE POLICY "Users can subscribe to own device channels"
    ON realtime.messages
    FOR SELECT
    TO authenticated
    USING (
        -- 1. Scoped user-channel: ultron:devices:<userId> or realtime:ultron:devices:<userId>
        (
            coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || (auth.jwt()->>'sub')
            OR coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || auth.uid()::text
        )
        OR
        -- 2. Scoped device-channel: ultron:device:<deviceId> or realtime:ultron:device:<deviceId>
        EXISTS (
            SELECT 1 FROM public.ultron_devices d
            WHERE (
                coalesce(realtime.topic(), topic) LIKE '%ultron:device:' || d.device_id
                OR coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || d.device_id
            )
            AND (d.user_id = (auth.jwt()->>'sub') OR d.user_id = auth.uid()::text)
        )
    );

-- ------------------------------------------------------------------------------
-- 5. PUBLISH / BROADCAST AUTHORIZATION (INSERT) FOR AUTHENTICATED USERS
-- ------------------------------------------------------------------------------
-- Controls which channels a client is permitted to broadcast events onto
CREATE POLICY "Users can broadcast only to own device channels"
    ON realtime.messages
    FOR INSERT
    TO authenticated
    WITH CHECK (
        -- Must be the user's own channel; prevents cross-user broadcast/command injection
        (
            coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || (auth.jwt()->>'sub')
            OR coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || auth.uid()::text
        )
        OR
        EXISTS (
            SELECT 1 FROM public.ultron_devices d
            WHERE (
                coalesce(realtime.topic(), topic) LIKE '%ultron:device:' || d.device_id
                OR coalesce(realtime.topic(), topic) LIKE '%ultron:devices:' || d.device_id
            )
            AND (d.user_id = (auth.jwt()->>'sub') OR d.user_id = auth.uid()::text)
        )
    );
