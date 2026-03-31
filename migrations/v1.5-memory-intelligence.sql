-- =============================================================================
-- Open Brain v1.5 — Memory Intelligence Migration
-- =============================================================================
-- Run this in the Supabase SQL Editor for project lolivmsgmwmeqqqpjszo.
-- Safe to re-run: uses IF NOT EXISTS, OR REPLACE, and WHERE guards.
--
-- Changes:
--   1. Adds 5 new columns to open_brain
--   2. Backfills valid_from from created_at for existing rows
--   3. Creates 4 new RPC functions (update_memory, deprecate_memory,
--      merge_memories, find_duplicates)
--   4. Replaces match_brain with new optional params (backward compatible)
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: Schema Changes — New Columns
-- =============================================================================

-- Memory type classification
-- Allowed: episodic, semantic, procedural, preference, decision
ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS memory_type text DEFAULT 'semantic';

-- Add CHECK constraint only if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'open_brain_memory_type_check'
      AND conrelid = 'public.open_brain'::regclass
  ) THEN
    ALTER TABLE public.open_brain
      ADD CONSTRAINT open_brain_memory_type_check
      CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'preference', 'decision'));
  END IF;
END
$$;

-- Temporal validity: when this memory was/is true
ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS valid_from timestamptz;

ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS valid_to timestamptz;

-- Usage tracking
ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0;

-- Supersession chain: points to the memory that replaced this one
ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS superseded_by bigint;

-- Add FK constraint only if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'open_brain_superseded_by_fkey'
      AND conrelid = 'public.open_brain'::regclass
  ) THEN
    ALTER TABLE public.open_brain
      ADD CONSTRAINT open_brain_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES public.open_brain(id);
  END IF;
END
$$;


-- =============================================================================
-- SECTION 2: Backfill Existing Rows
-- =============================================================================

-- Set valid_from = created_at for all existing rows that haven't been set yet.
-- This preserves the original timestamp rather than setting it to now().
UPDATE public.open_brain
SET valid_from = created_at
WHERE valid_from IS NULL;

-- Now set the default for future inserts
ALTER TABLE public.open_brain
  ALTER COLUMN valid_from SET DEFAULT now();


-- =============================================================================
-- SECTION 3: New Indexes
-- =============================================================================

-- Partial index for fast "only valid memories" filtering.
-- Most queries will use only_valid = true, so this covers the common case.
CREATE INDEX IF NOT EXISTS open_brain_valid_to_null_idx
  ON public.open_brain (valid_to)
  WHERE valid_to IS NULL;

-- Index on memory_type for type-filtered queries
CREATE INDEX IF NOT EXISTS open_brain_memory_type_idx
  ON public.open_brain (memory_type);


-- =============================================================================
-- SECTION 4: New RPC — update_memory
-- =============================================================================
-- Updates content and metadata for an existing memory.
-- Does NOT re-embed — the caller (MCP server or Edge Function) handles that.
--
-- Parameters:
--   p_id       — the memory ID to update
--   p_content  — new content text
--   p_metadata — new metadata JSONB (replaces existing metadata)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_memory(
  p_id       bigint,
  p_content  text,
  p_metadata jsonb
)
RETURNS SETOF public.open_brain
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.open_brain
  SET
    content    = p_content,
    metadata   = p_metadata,
    updated_at = now()
  WHERE id = p_id
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.update_memory IS
  'Update content and metadata for a memory. Does not re-embed — caller must handle embedding update.';


-- =============================================================================
-- SECTION 5: New RPC — deprecate_memory
-- =============================================================================
-- Marks a memory as no longer valid by setting valid_to = now().
-- Optionally links to the memory that supersedes it.
-- Appends the deprecation reason to metadata->'deprecation_reason'.
--
-- Parameters:
--   p_id             — the memory ID to deprecate
--   p_reason         — why this memory is being deprecated
--   p_superseded_by  — optional ID of the replacement memory
-- =============================================================================

CREATE OR REPLACE FUNCTION public.deprecate_memory(
  p_id            bigint,
  p_reason        text,
  p_superseded_by bigint DEFAULT NULL
)
RETURNS SETOF public.open_brain
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.open_brain
  SET
    valid_to      = now(),
    superseded_by = COALESCE(p_superseded_by, open_brain.superseded_by),
    metadata      = metadata || jsonb_build_object('deprecation_reason', p_reason),
    updated_at    = now()
  WHERE id = p_id
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.deprecate_memory IS
  'Deprecate a memory: sets valid_to, optionally links superseded_by, appends reason to metadata.';


-- =============================================================================
-- SECTION 6: New RPC — merge_memories
-- =============================================================================
-- Creates a new merged memory and deprecates all source memories.
-- The new memory has embedding = NULL — the Edge Function will embed it.
--
-- Parameters:
--   p_ids            — array of memory IDs to merge
--   p_merged_content — the combined content text
--   p_source         — source label for the new memory (default 'merge')
-- =============================================================================

CREATE OR REPLACE FUNCTION public.merge_memories(
  p_ids            bigint[],
  p_merged_content text,
  p_source         text DEFAULT 'merge'
)
RETURNS SETOF public.open_brain
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id bigint;
BEGIN
  -- 1. Insert the new merged memory (embedding = NULL for later processing)
  INSERT INTO public.open_brain (content, metadata, source, embedding, memory_type, valid_from)
  VALUES (
    p_merged_content,
    jsonb_build_object(
      'merged_from', to_jsonb(p_ids),
      'tags', '[]'::jsonb,
      'people', '[]'::jsonb,
      'topics', '[]'::jsonb,
      'sentiment', 'neutral',
      'action_items', '[]'::jsonb
    ),
    p_source,
    NULL,
    'semantic',
    now()
  )
  RETURNING id INTO new_id;

  -- 2. Deprecate all source memories, pointing to the new merged memory
  UPDATE public.open_brain
  SET
    valid_to      = now(),
    superseded_by = new_id,
    metadata      = metadata || jsonb_build_object('deprecation_reason', 'Merged into memory #' || new_id),
    updated_at    = now()
  WHERE id = ANY(p_ids);

  -- 3. Return the new merged memory
  RETURN QUERY
  SELECT * FROM public.open_brain WHERE id = new_id;
END;
$$;

COMMENT ON FUNCTION public.merge_memories IS
  'Merge multiple memories into one. Creates new row, deprecates sources. Embedding = NULL (caller re-embeds).';


-- =============================================================================
-- SECTION 7: New RPC — find_duplicates
-- =============================================================================
-- Finds memories with high cosine similarity to a given embedding.
-- Excludes deprecated memories (valid_to IS NOT NULL).
--
-- Parameters:
--   p_embedding  — the 1536-dim vector to check against
--   p_threshold  — minimum similarity to count as duplicate (default 0.92)
--   p_limit      — max results (default 5)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.find_duplicates(
  p_embedding  vector(1536),
  p_threshold  float DEFAULT 0.92,
  p_limit      int   DEFAULT 5
)
RETURNS TABLE (
  id         bigint,
  content    text,
  similarity float
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ob.id,
    ob.content,
    (1 - (ob.embedding <=> p_embedding))::float AS similarity
  FROM public.open_brain ob
  WHERE
    ob.embedding IS NOT NULL
    AND ob.valid_to IS NULL  -- exclude deprecated memories
    AND (1 - (ob.embedding <=> p_embedding)) >= p_threshold
  ORDER BY ob.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.find_duplicates IS
  'Find near-duplicate memories by cosine similarity. Excludes deprecated memories. Default threshold: 0.92.';


-- =============================================================================
-- SECTION 8: Updated RPC — match_brain (backward compatible)
-- =============================================================================
-- Adds two new optional parameters:
--   p_filter_type — filter by memory_type (NULL = no filter)
--   p_only_valid  — when true, exclude deprecated memories (default true)
--
-- Also adds memory_type, valid_from, valid_to to the return type.
--
-- Existing calls with (query_embedding, threshold, count) or
-- (query_embedding, threshold, count, filter_source) still work identically.
-- =============================================================================

-- Must DROP first because we're changing the parameter list and return type.
-- Drop both possible type signatures to handle implicit type resolution.
DROP FUNCTION IF EXISTS public.match_brain(vector(1536), float, int, text);
DROP FUNCTION IF EXISTS public.match_brain(vector(1536), double precision, integer, text);

CREATE FUNCTION public.match_brain(
  query_embedding  vector(1536),
  match_threshold  float    DEFAULT 0.7,
  match_count      int      DEFAULT 10,
  filter_source    text     DEFAULT NULL,
  p_filter_type    text     DEFAULT NULL,
  p_only_valid     boolean  DEFAULT true
)
RETURNS TABLE (
  id          bigint,
  content     text,
  metadata    jsonb,
  source      text,
  similarity  float,
  created_at  timestamptz,
  memory_type text,
  valid_from  timestamptz,
  valid_to    timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ob.id,
    ob.content,
    ob.metadata,
    ob.source,
    (1 - (ob.embedding <=> query_embedding))::float AS similarity,
    ob.created_at,
    ob.memory_type,
    ob.valid_from,
    ob.valid_to
  FROM public.open_brain ob
  WHERE
    ob.embedding IS NOT NULL
    AND (1 - (ob.embedding <=> query_embedding)) >= match_threshold
    -- Existing filter: source
    AND (filter_source IS NULL OR ob.source = filter_source)
    -- NEW: memory_type filter
    AND (p_filter_type IS NULL OR ob.memory_type = p_filter_type)
    -- NEW: only valid (non-deprecated) memories
    AND (p_only_valid = false OR ob.valid_to IS NULL)
  ORDER BY ob.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.match_brain IS
  'Cosine similarity search over open_brain embeddings. v1.5: adds filter_type and only_valid params.';


COMMIT;


-- =============================================================================
-- SMOKE TEST QUERIES (run manually after migration)
-- =============================================================================
-- Uncomment and run these one at a time to verify the migration worked.
--
-- -- 1. Verify new columns exist and backfill is correct
-- SELECT id, memory_type, valid_from, valid_to, access_count, superseded_by,
--        (valid_from = created_at) AS backfill_correct
-- FROM open_brain
-- LIMIT 5;
--
-- -- 2. Verify ALL existing rows have valid_from = created_at
-- SELECT count(*) AS mismatched FROM open_brain WHERE valid_from != created_at;
-- -- Expected: 0
--
-- -- 3. Verify match_brain backward compat (3 positional args)
-- SELECT id, content, similarity
-- FROM match_brain(
--   (SELECT embedding FROM open_brain WHERE embedding IS NOT NULL LIMIT 1),
--   0.5, 5
-- );
--
-- -- 4. Verify match_brain with new params
-- SELECT id, content, memory_type, valid_from, similarity
-- FROM match_brain(
--   (SELECT embedding FROM open_brain WHERE embedding IS NOT NULL LIMIT 1),
--   0.5, 5, NULL, NULL, true
-- );
--
-- -- 5. Test update_memory
-- SELECT * FROM update_memory(
--   (SELECT id FROM open_brain LIMIT 1),
--   'Test updated content — revert after testing',
--   '{"tags": ["test"], "people": [], "topics": [], "sentiment": "neutral", "action_items": []}'::jsonb
-- );
--
-- -- 6. Test find_duplicates
-- SELECT * FROM find_duplicates(
--   (SELECT embedding FROM open_brain WHERE embedding IS NOT NULL LIMIT 1),
--   0.85, 3
-- );
--
-- -- 7. Test deprecate_memory (use a test row, not production data)
-- -- SELECT * FROM deprecate_memory(<test_id>, 'Smoke test deprecation');
--
-- -- 8. Test merge_memories (use test rows, not production data)
-- -- SELECT * FROM merge_memories(ARRAY[<id1>, <id2>], 'Merged test content');
