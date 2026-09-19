-- ==============================================================================
-- ULTRON MIGRATION 003: ROW LEVEL SECURITY & USER DATA ISOLATION
-- File: supabase/migrations/003_secure_rls.sql
-- Description:
--   Removes overly permissive policies (USING (true) / WITH CHECK (true))
--   Enforces strict Row Level Security (RLS) across all user-private tables:
--     1. public.ultron_devices
--     2. public.ultron_pairing_sessions
--     3. public.ultron_device_catalogs
--     4. public.ultron_user_memories
--     5. public.ultron_documents
--     6. public.ultron_document_chunks
--
-- Security Rules Enforced:
--   - Anonymous (anon) direct access is explicitly DENIED on all private tables.
--   - Service role (service_role) retains full backend server access for pairing,
--     heartbeats, background memory consolidation, and server-side indexing.
--   - Authenticated users (authenticated) can ONLY access rows they own:
--     Direct ownership: user_id = (auth.jwt()->>'sub') OR user_id = auth.uid()::text
--     Relational ownership (catalogs): EXISTS subquery validating device ownership
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. PAIRED DEVICES (public.ultron_devices)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_devices ENABLE ROW LEVEL SECURITY;

-- Drop insecure legacy permissive policy
DROP POLICY IF EXISTS "Allow anon devices access" ON public.ultron_devices;

-- Deny direct anonymous access
DROP POLICY IF EXISTS "Deny anon devices access" ON public.ultron_devices;
CREATE POLICY "Deny anon devices access"
    ON public.ultron_devices
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access
DROP POLICY IF EXISTS "Allow service role devices access" ON public.ultron_devices;
CREATE POLICY "Allow service role devices access"
    ON public.ultron_devices
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce strict authenticated user ownership
DROP POLICY IF EXISTS "Users can manage their own devices" ON public.ultron_devices;
CREATE POLICY "Users can manage their own devices"
    ON public.ultron_devices
    FOR ALL
    TO authenticated
    USING (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    )
    WITH CHECK (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    );


-- ------------------------------------------------------------------------------
-- 2. PAIRING SESSIONS (public.ultron_pairing_sessions)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_pairing_sessions ENABLE ROW LEVEL SECURITY;

-- Drop insecure legacy permissive policy
DROP POLICY IF EXISTS "Allow anon pairing sessions" ON public.ultron_pairing_sessions;

-- Deny direct anonymous access
DROP POLICY IF EXISTS "Deny anon pairing sessions" ON public.ultron_pairing_sessions;
CREATE POLICY "Deny anon pairing sessions"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access (device pairing claim & registration)
DROP POLICY IF EXISTS "Allow service role pairing access" ON public.ultron_pairing_sessions;
CREATE POLICY "Allow service role pairing access"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce authenticated user isolation on pairing session codes
DROP POLICY IF EXISTS "Users can manage their own pairing sessions" ON public.ultron_pairing_sessions;
CREATE POLICY "Users can manage their own pairing sessions"
    ON public.ultron_pairing_sessions
    FOR ALL
    TO authenticated
    USING (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    )
    WITH CHECK (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    );


-- ------------------------------------------------------------------------------
-- 3. DEVICE APPLICATION CATALOGS (public.ultron_device_catalogs)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_device_catalogs ENABLE ROW LEVEL SECURITY;

-- Ensure foreign key constraint exists for referential integrity
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_ultron_device_catalogs_device'
    ) THEN
        ALTER TABLE public.ultron_device_catalogs 
        ADD CONSTRAINT fk_ultron_device_catalogs_device 
        FOREIGN KEY (device_id) REFERENCES public.ultron_devices(device_id) ON DELETE CASCADE;
    END IF;
END $$;

-- Drop insecure legacy permissive policy
DROP POLICY IF EXISTS "Allow anon device catalogs" ON public.ultron_device_catalogs;

-- Deny direct anonymous access
DROP POLICY IF EXISTS "Deny anon device catalogs" ON public.ultron_device_catalogs;
CREATE POLICY "Deny anon device catalogs"
    ON public.ultron_device_catalogs
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access
DROP POLICY IF EXISTS "Allow service role device catalogs" ON public.ultron_device_catalogs;
CREATE POLICY "Allow service role device catalogs"
    ON public.ultron_device_catalogs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce catalog ownership derived from device ownership
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


-- ------------------------------------------------------------------------------
-- 4. USER MEMORIES (public.ultron_user_memories)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_user_memories ENABLE ROW LEVEL SECURITY;

-- Ensure direct anonymous access remains denied
DROP POLICY IF EXISTS "Deny anon public memory access" ON public.ultron_user_memories;
CREATE POLICY "Deny anon public memory access"
    ON public.ultron_user_memories
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access
DROP POLICY IF EXISTS "Allow service role full access" ON public.ultron_user_memories;
CREATE POLICY "Allow service role full access"
    ON public.ultron_user_memories
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce authenticated user memory isolation
DROP POLICY IF EXISTS "Users can manage their own memories" ON public.ultron_user_memories;
CREATE POLICY "Users can manage their own memories"
    ON public.ultron_user_memories
    FOR ALL
    TO authenticated
    USING (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    )
    WITH CHECK (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    );


-- ------------------------------------------------------------------------------
-- 5. RAG DOCUMENTS (public.ultron_documents)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_documents ENABLE ROW LEVEL SECURITY;

-- Ensure direct anonymous access remains denied
DROP POLICY IF EXISTS "Deny anon public documents access" ON public.ultron_documents;
CREATE POLICY "Deny anon public documents access"
    ON public.ultron_documents
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access
DROP POLICY IF EXISTS "Allow service role documents access" ON public.ultron_documents;
CREATE POLICY "Allow service role documents access"
    ON public.ultron_documents
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce authenticated user document isolation
DROP POLICY IF EXISTS "Users can manage their own documents" ON public.ultron_documents;
CREATE POLICY "Users can manage their own documents"
    ON public.ultron_documents
    FOR ALL
    TO authenticated
    USING (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    )
    WITH CHECK (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    );


-- ------------------------------------------------------------------------------
-- 6. RAG DOCUMENT CHUNKS (public.ultron_document_chunks)
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.ultron_document_chunks ENABLE ROW LEVEL SECURITY;

-- Ensure direct anonymous access remains denied
DROP POLICY IF EXISTS "Deny anon public chunks access" ON public.ultron_document_chunks;
CREATE POLICY "Deny anon public chunks access"
    ON public.ultron_document_chunks
    FOR ALL
    TO anon
    USING (false);

-- Allow trusted server-side service_role access
DROP POLICY IF EXISTS "Allow service role chunks access" ON public.ultron_document_chunks;
CREATE POLICY "Allow service role chunks access"
    ON public.ultron_document_chunks
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Enforce authenticated user chunk isolation
DROP POLICY IF EXISTS "Users can manage their own document chunks" ON public.ultron_document_chunks;
CREATE POLICY "Users can manage their own document chunks"
    ON public.ultron_document_chunks
    FOR ALL
    TO authenticated
    USING (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    )
    WITH CHECK (
        user_id = (auth.jwt()->>'sub') 
        OR user_id = auth.uid()::text
    );
