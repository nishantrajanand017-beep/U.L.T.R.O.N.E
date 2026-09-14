-- ==============================================================================
-- ULTRON PERSISTENT RAG / DOCUMENT KNOWLEDGE SCHEMA FOR SUPABASE
-- Migration: 002_user_rag.sql
-- ==============================================================================

-- 1. Create Documents Metadata Table
CREATE TABLE IF NOT EXISTS public.ultron_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ultron_documents_user_hash UNIQUE (user_id, content_hash)
);

-- 2. Create Document Chunks Table
CREATE TABLE IF NOT EXISTS public.ultron_document_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.ultron_documents(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ultron_doc_chunk_index UNIQUE (document_id, chunk_index)
);

-- 3. Indexes for User-Scoped Lookups & Foreign Key Cascades
CREATE INDEX IF NOT EXISTS idx_ultron_documents_user_id 
    ON public.ultron_documents (user_id);

CREATE INDEX IF NOT EXISTS idx_ultron_documents_user_updated 
    ON public.ultron_documents (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ultron_document_chunks_user_id 
    ON public.ultron_document_chunks (user_id);

CREATE INDEX IF NOT EXISTS idx_ultron_document_chunks_doc_id 
    ON public.ultron_document_chunks (document_id);

CREATE INDEX IF NOT EXISTS idx_ultron_document_chunks_user_doc 
    ON public.ultron_document_chunks (user_id, document_id);

-- 4. Row Level Security (RLS) Policies
-- Document knowledge is strictly private and user-scoped.
ALTER TABLE public.ultron_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ultron_document_chunks ENABLE ROW LEVEL SECURITY;

-- Deny direct public anonymous access
DROP POLICY IF EXISTS "Deny anon public documents access" ON public.ultron_documents;
CREATE POLICY "Deny anon public documents access"
    ON public.ultron_documents
    FOR ALL
    TO anon
    USING (false);

DROP POLICY IF EXISTS "Deny anon public chunks access" ON public.ultron_document_chunks;
CREATE POLICY "Deny anon public chunks access"
    ON public.ultron_document_chunks
    FOR ALL
    TO anon
    USING (false);

-- Permit service_role / backend server operations with explicit user_id scoping
DROP POLICY IF EXISTS "Allow service role documents access" ON public.ultron_documents;
CREATE POLICY "Allow service role documents access"
    ON public.ultron_documents
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service role chunks access" ON public.ultron_document_chunks;
CREATE POLICY "Allow service role chunks access"
    ON public.ultron_document_chunks
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
