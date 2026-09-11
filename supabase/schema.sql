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

-- Allow anon / service role access for pairing sessions
DROP POLICY IF EXISTS "Allow anon pairing sessions" ON public.ultron_pairing_sessions;
CREATE POLICY "Allow anon pairing sessions"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO anon, authenticated, service_role
    USING (true)
    WITH CHECK (true);

-- Allow anon / service role access for device registration and heartbeats
DROP POLICY IF EXISTS "Allow anon devices access" ON public.ultron_devices;
CREATE POLICY "Allow anon devices access"
    ON public.ultron_devices
    FOR ALL
    TO anon, authenticated, service_role
    USING (true)
    WITH CHECK (true);
