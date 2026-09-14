-- ==============================================================================
-- ULTRON PERSISTENT USER MEMORY SCHEMA FOR SUPABASE
-- Migration: 001_user_memory.sql
-- ==============================================================================

-- 1. Create User Memories Table
CREATE TABLE IF NOT EXISTS public.ultron_user_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    key VARCHAR(100) NOT NULL,
    value VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ultron_user_memory UNIQUE (user_id, category, key)
);

-- 2. Indexes for High-Performance User-Scoped Lookups
CREATE INDEX IF NOT EXISTS idx_ultron_user_memories_user_id 
    ON public.ultron_user_memories (user_id);

CREATE INDEX IF NOT EXISTS idx_ultron_user_memories_user_updated 
    ON public.ultron_user_memories (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ultron_user_memories_category 
    ON public.ultron_user_memories (user_id, category);

-- 3. Row Level Security (RLS) Policies
-- The memory table stores private personal information and must not be publicly readable.
ALTER TABLE public.ultron_user_memories ENABLE ROW LEVEL SECURITY;

-- Deny direct public anonymous access to protect user privacy
DROP POLICY IF EXISTS "Deny anon public memory access" ON public.ultron_user_memories;
CREATE POLICY "Deny anon public memory access"
    ON public.ultron_user_memories
    FOR ALL
    TO anon
    USING (false);

-- Permit service_role / backend server access with explicit user_id query filtering
DROP POLICY IF EXISTS "Allow service role full access" ON public.ultron_user_memories;
CREATE POLICY "Allow service role full access"
    ON public.ultron_user_memories
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
