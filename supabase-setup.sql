-- =============================================================================
-- Open Brain — Supabase Setup Script
-- =============================================================================
-- Paste this entire script into the Supabase SQL Editor and run it once.
-- It is safe to re-run (uses IF NOT EXISTS / OR REPLACE throughout).
-- =============================================================================


-- =============================================================================
-- SECTION 1: Extensions
-- =============================================================================

-- Enable pgvector for storing and querying vector embeddings.
-- Required for cosine similarity search on the embedding column.
CREATE EXTENSION IF NOT EXISTS vector;


-- =============================================================================
-- SECTION 2: Main Table — open_brain
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.open_brain (
    -- Surrogate primary key, auto-incrementing
    id          bigserial PRIMARY KEY,

    -- The raw thought, note, or memory text (required)
    content     text NOT NULL,

    -- Flexible JSON metadata: tags, people, topics, etc. (LLM-extracted or manual)
    -- Example: { "tags": ["idea", "product"], "people": ["Alice"], "topic": "strategy" }
    metadata    jsonb NOT NULL DEFAULT '{}',

    -- Vector embedding for semantic search (text-embedding-3-small = 1536 dims)
    -- NULL is allowed — rows without embeddings are excluded from similarity search
    embedding   vector(1536),

    -- Origin of the memory entry
    -- Allowed values: 'notion', 'slack', 'voice', 'manual', 'perplexity'
    source      text NOT NULL DEFAULT 'manual',

    -- Timestamps
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Helpful comment on the table itself
COMMENT ON TABLE public.open_brain IS
    'Central store for thoughts, notes, and memories with vector embeddings for semantic search.';

COMMENT ON COLUMN public.open_brain.embedding IS
    'OpenAI text-embedding-3-small (1536 dims). NULL rows are excluded from similarity search.';

COMMENT ON COLUMN public.open_brain.source IS
    'Origin of the entry. Valid values: notion | slack | voice | manual | perplexity';


-- =============================================================================
-- SECTION 3: Indexes
-- =============================================================================

-- HNSW index for fast approximate nearest-neighbor vector search (cosine distance).
-- HNSW is preferred over IVFFlat for Supabase — no need to run VACUUM to build it.
CREATE INDEX IF NOT EXISTS open_brain_embedding_hnsw_idx
    ON public.open_brain
    USING hnsw (embedding vector_cosine_ops);

-- B-tree index on created_at DESC for fast "most recent" queries
CREATE INDEX IF NOT EXISTS open_brain_created_at_idx
    ON public.open_brain (created_at DESC);

-- GIN index on metadata for efficient JSONB containment and key-existence queries
CREATE INDEX IF NOT EXISTS open_brain_metadata_gin_idx
    ON public.open_brain
    USING gin (metadata);

-- B-tree index on source for fast source-filtered lookups
CREATE INDEX IF NOT EXISTS open_brain_source_idx
    ON public.open_brain (source);


-- =============================================================================
-- SECTION 4: updated_at Trigger
-- =============================================================================

-- Helper function: automatically bumps updated_at to now() on every row update.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Attach the trigger to open_brain
DROP TRIGGER IF EXISTS trg_open_brain_updated_at ON public.open_brain;

CREATE TRIGGER trg_open_brain_updated_at
    BEFORE UPDATE ON public.open_brain
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();


-- =============================================================================
-- SECTION 5: RPC — match_brain (semantic / vector similarity search)
-- =============================================================================
-- Performs cosine similarity search against stored embeddings.
-- Pass a pre-computed query embedding from text-embedding-3-small.
--
-- Parameters:
--   query_embedding  — the 1536-dim vector to search against
--   match_threshold  — minimum similarity score to return (0.0–1.0, default 0.7)
--   match_count      — max number of results to return (default 10)
--   filter_source    — optional source filter ('notion', 'slack', etc.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.match_brain(
    query_embedding  vector(1536),
    match_threshold  float   DEFAULT 0.7,
    match_count      int     DEFAULT 10,
    filter_source    text    DEFAULT NULL
)
RETURNS TABLE (
    id          bigint,
    content     text,
    metadata    jsonb,
    source      text,
    similarity  float,
    created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ob.id,
        ob.content,
        ob.metadata,
        ob.source,
        -- 1 - cosine_distance gives cosine similarity in the range [-1, 1]
        (1 - (ob.embedding <=> query_embedding))::float AS similarity,
        ob.created_at
    FROM public.open_brain ob
    WHERE
        -- Only rows that have an embedding can participate in similarity search
        ob.embedding IS NOT NULL
        -- Apply cosine similarity threshold
        AND (1 - (ob.embedding <=> query_embedding)) >= match_threshold
        -- Optional source filter
        AND (filter_source IS NULL OR ob.source = filter_source)
    ORDER BY ob.embedding <=> query_embedding   -- ascending distance = descending similarity
    LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.match_brain IS
    'Cosine similarity search over open_brain embeddings. Requires a pre-computed 1536-dim vector.';


-- =============================================================================
-- SECTION 6: RPC — search_by_tag (metadata JSONB key-value search)
-- =============================================================================
-- Finds entries where metadata contains a specific key-value pair.
-- Works against any top-level key in the metadata JSONB column.
--
-- Parameters:
--   tag_key      — the metadata key to match (e.g., 'topic', 'person', 'tag')
--   tag_value    — the value to match for that key
--   result_limit — max rows to return (default 20)
--
-- Example call:
--   SELECT * FROM search_by_tag('topic', 'strategy');
-- =============================================================================

CREATE OR REPLACE FUNCTION public.search_by_tag(
    tag_key      text,
    tag_value    text,
    result_limit int DEFAULT 20
)
RETURNS TABLE (
    id          bigint,
    content     text,
    metadata    jsonb,
    source      text,
    created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ob.id,
        ob.content,
        ob.metadata,
        ob.source,
        ob.created_at
    FROM public.open_brain ob
    WHERE
        -- Match top-level key-value: metadata->>'key' = 'value'
        ob.metadata ->> tag_key = tag_value
        -- Also match array-valued keys: metadata @> '{"tags": ["value"]}'
        OR ob.metadata @> jsonb_build_object(tag_key, jsonb_build_array(tag_value))
    ORDER BY ob.created_at DESC
    LIMIT result_limit;
END;
$$;

COMMENT ON FUNCTION public.search_by_tag IS
    'Search open_brain by a metadata key-value pair. Handles both scalar and array-valued keys.';


-- =============================================================================
-- SECTION 7: RPC — list_recent (most recent entries)
-- =============================================================================
-- Returns the N most recent entries, with an optional source filter.
--
-- Parameters:
--   count         — number of entries to return (default 10)
--   filter_source — optional source filter ('notion', 'slack', etc.)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_recent(
    count         int  DEFAULT 10,
    filter_source text DEFAULT NULL
)
RETURNS TABLE (
    id          bigint,
    content     text,
    metadata    jsonb,
    source      text,
    created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ob.id,
        ob.content,
        ob.metadata,
        ob.source,
        ob.created_at
    FROM public.open_brain ob
    WHERE
        filter_source IS NULL OR ob.source = filter_source
    ORDER BY ob.created_at DESC
    LIMIT count;
END;
$$;

COMMENT ON FUNCTION public.list_recent IS
    'Return the most recent open_brain entries, with optional source filter.';


-- =============================================================================
-- SECTION 8: RPC — add_memory (insert a new memory row)
-- =============================================================================
-- Inserts a new entry into open_brain and returns the full new row.
-- Embedding can be NULL and backfilled later by an async job.
--
-- Parameters:
--   p_content    — the raw thought/note text (required)
--   p_metadata   — JSONB metadata bag (default empty)
--   p_source     — origin of the entry (default 'manual')
--   p_embedding  — optional pre-computed 1536-dim vector
-- =============================================================================

CREATE OR REPLACE FUNCTION public.add_memory(
    p_content    text,
    p_metadata   jsonb         DEFAULT '{}',
    p_source     text          DEFAULT 'manual',
    p_embedding  vector(1536)  DEFAULT NULL
)
RETURNS SETOF public.open_brain
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO public.open_brain (content, metadata, source, embedding)
    VALUES (p_content, p_metadata, p_source, p_embedding)
    RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.add_memory IS
    'Insert a new memory into open_brain. Embedding is optional and can be backfilled later.';


-- =============================================================================
-- SECTION 9: Row Level Security (RLS)
-- =============================================================================

-- Enable RLS on the table. Without an explicit policy, ALL access is denied.
ALTER TABLE public.open_brain ENABLE ROW LEVEL SECURITY;

-- Policy: allow full access for the service_role (used by your backend / Edge Functions).
-- The service_role bypasses RLS by default in Supabase, but making it explicit is good
-- practice for documentation and in case that default ever changes.
DROP POLICY IF EXISTS "service_role_full_access" ON public.open_brain;

CREATE POLICY "service_role_full_access"
    ON public.open_brain
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Policy: allow authenticated users to read and write their own data.
-- If you plan to call Supabase from the browser with a user JWT, add a user_id
-- column and replace `true` with `auth.uid() = user_id`.
-- For now this grants authenticated users full access (single-user / backend-only setup).
DROP POLICY IF EXISTS "authenticated_full_access" ON public.open_brain;

CREATE POLICY "authenticated_full_access"
    ON public.open_brain
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.open_brain IS
    'RLS is enabled. service_role and authenticated roles have full access. '
    'To restrict by user, add a user_id column and update policies accordingly.';


-- =============================================================================
-- DONE
-- =============================================================================
-- Schema summary:
--
--   Table:     public.open_brain
--   Indexes:   HNSW (embedding), btree (created_at DESC), GIN (metadata), btree (source)
--   Trigger:   trg_open_brain_updated_at  → auto-updates updated_at on every UPDATE
--   Functions:
--     match_brain(query_embedding, match_threshold, match_count, filter_source)
--     search_by_tag(tag_key, tag_value, result_limit)
--     list_recent(count, filter_source)
--     add_memory(p_content, p_metadata, p_source, p_embedding)
--   RLS:       Enabled — service_role + authenticated have full access
-- =============================================================================
