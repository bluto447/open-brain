-- =============================================================================
-- Open Brain v1.5.1 — Contradiction Detection
-- =============================================================================
-- Run this in the Supabase SQL Editor for project lolivmsgmwmeqqqpjszo.
-- Safe to re-run: uses CREATE OR REPLACE.
--
-- Adds find_contradictions() RPC function that surfaces pairs of active
-- memories with high embedding similarity (same topic) but different content.
-- These are candidates for human review — vector similarity alone cannot
-- distinguish agreement from contradiction, only topic overlap.
-- =============================================================================

-- =============================================================================
-- SECTION 1: find_contradictions RPC
-- =============================================================================
-- Finds pairs of active memories in the similarity band between "related" and
-- "duplicate" (default 0.85–0.92). Below 0.85, memories are just topically
-- related. Above 0.92, they are near-duplicates (handled by find_duplicates).
--
-- With ~235 rows, the cross-join produces ~27K pairs — sequential scan is fine.
-- At scale (10K+), this would need a batched ANN approach.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.find_contradictions(
  p_min_similarity float DEFAULT 0.85,
  p_max_similarity float DEFAULT 0.92,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  id_a bigint,
  content_a text,
  memory_type_a text,
  created_at_a timestamptz,
  id_b bigint,
  content_b text,
  memory_type_b text,
  created_at_b timestamptz,
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
    a.id        AS id_a,
    a.content   AS content_a,
    a.memory_type AS memory_type_a,
    a.created_at  AS created_at_a,
    b.id        AS id_b,
    b.content   AS content_b,
    b.memory_type AS memory_type_b,
    b.created_at  AS created_at_b,
    (1 - (a.embedding <=> b.embedding))::float AS similarity
  FROM public.open_brain a
  JOIN public.open_brain b
    ON a.id < b.id                                    -- no self-joins or duplicate pairs
  WHERE
    a.embedding IS NOT NULL
    AND b.embedding IS NOT NULL
    AND a.valid_to IS NULL                            -- only active memories
    AND b.valid_to IS NULL
    AND (1 - (a.embedding <=> b.embedding)) >= p_min_similarity
    AND (1 - (a.embedding <=> b.embedding)) < p_max_similarity
  ORDER BY (1 - (a.embedding <=> b.embedding)) DESC
  LIMIT p_limit;
END;
$$;

-- Grant execute to the roles that need it
GRANT EXECUTE ON FUNCTION public.find_contradictions(float, float, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.find_contradictions(float, float, int) TO authenticated;
