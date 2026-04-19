-- =============================================================================
-- Open Brain v2.0 Sprint 1 — Composite Scoring
-- =============================================================================
-- Adds:
--   1. open_brain.last_accessed_at column (backfilled from created_at)
--   2. ob_scoring_config singleton table (tunable weights + per-type half-lives)
--   3. get_scoring_config() helper
--   4. composite_search() RPC — similarity + recency + frequency blended ranking,
--      bumps access_count + last_accessed_at for top-3 results on every call
--   5. match_brain() extended with p_use_composite flag (7th param). When true,
--      delegates to composite_search and projects the v1.5 return shape for
--      backward compatibility. When false (default), pure cosine similarity —
--      identical to v1.5 body.
--
-- Note: v1.5 match_brain was marked STABLE. v2.0 drops STABLE because the
-- composite path writes. Pure path behavior is unchanged otherwise.
--
-- Covers tickets: OB-100, OB-101, OB-102, OB-103, OB-106, OB-107.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Schema: last_accessed_at column on open_brain
-- -----------------------------------------------------------------------------
ALTER TABLE public.open_brain
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;

UPDATE public.open_brain
SET last_accessed_at = created_at
WHERE last_accessed_at IS NULL;

ALTER TABLE public.open_brain
  ALTER COLUMN last_accessed_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS open_brain_last_accessed_at_idx
  ON public.open_brain (last_accessed_at DESC);

COMMENT ON COLUMN public.open_brain.last_accessed_at IS
  'v2.0: Timestamp of most recent retrieval via composite_search. Backfilled from created_at. Used for recency scoring.';

-- -----------------------------------------------------------------------------
-- 2. Schema: ob_scoring_config singleton table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ob_scoring_config (
  id                       smallint PRIMARY KEY DEFAULT 1,
  weight_similarity        float   NOT NULL DEFAULT 0.60,
  weight_recency           float   NOT NULL DEFAULT 0.20,
  weight_frequency         float   NOT NULL DEFAULT 0.20,
  halflife_episodic_days   float   NOT NULL DEFAULT 30,
  halflife_procedural_days float   NOT NULL DEFAULT 90,
  halflife_semantic_days   float   NOT NULL DEFAULT 180,
  halflife_preference_days float   NOT NULL DEFAULT 365,
  halflife_decision_days   float   NOT NULL DEFAULT 365,
  halflife_default_days    float   NOT NULL DEFAULT 90,
  frequency_floor          float   NOT NULL DEFAULT 0.3,
  frequency_saturation     int     NOT NULL DEFAULT 50,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ob_scoring_config_singleton CHECK (id = 1),
  CONSTRAINT ob_scoring_config_weights_sum CHECK (
    abs((weight_similarity + weight_recency + weight_frequency) - 1.0) < 0.001
  )
);

INSERT INTO public.ob_scoring_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.ob_scoring_config IS
  'v2.0: Singleton config row for composite_search weights + per-type recency half-lives. Edit via UPDATE ob_scoring_config SET ... WHERE id = 1.';

GRANT SELECT ON public.ob_scoring_config TO authenticated;
GRANT ALL    ON public.ob_scoring_config TO service_role;

-- -----------------------------------------------------------------------------
-- 3. get_scoring_config() helper
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_scoring_config()
RETURNS public.ob_scoring_config
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.ob_scoring_config WHERE id = 1
$$;

COMMENT ON FUNCTION public.get_scoring_config IS
  'v2.0: Returns the single scoring config row.';

GRANT EXECUTE ON FUNCTION public.get_scoring_config() TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 4. composite_search() RPC
-- -----------------------------------------------------------------------------
-- Returns results ranked by blended score:
--   composite = w_sim * similarity + w_rec * recency_score + w_freq * frequency_score
--
-- Where:
--   similarity      = 1 - cosine_distance  (0..1)
--   recency_score   = exp(-ln(2) * age_days / halflife)  (per-type half-life)
--                     age_days measured from GREATEST(last_accessed_at, valid_from)
--   frequency_score = floor + (1-floor) * min(1, ln(1+access_count)/ln(1+saturation))
--
-- Side-effect: top-3 ranked rows get access_count += 1 and last_accessed_at = now().
-- The bump uses the pre-call snapshot, so returned access_count values reflect
-- state BEFORE this call's bump (as they should for scoring transparency).
--
-- p_weights_override example: '{"similarity":1.0,"recency":0,"frequency":0}'::jsonb
-- (no sum-to-1 constraint on overrides — allow arbitrary ablations).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.composite_search(
  query_embedding    vector(1536),
  match_count        int     DEFAULT 10,
  match_threshold    float   DEFAULT 0.7,
  p_filter_type      text    DEFAULT NULL,
  p_only_valid       boolean DEFAULT true,
  p_weights_override jsonb   DEFAULT NULL
)
RETURNS TABLE (
  id                bigint,
  content           text,
  metadata          jsonb,
  source            text,
  similarity        float,
  recency_score     float,
  frequency_score   float,
  composite_score   float,
  created_at        timestamptz,
  memory_type       text,
  valid_from        timestamptz,
  valid_to          timestamptz,
  access_count      int,
  last_accessed_at  timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg    public.ob_scoring_config%ROWTYPE;
  w_sim  float;
  w_rec  float;
  w_freq float;
BEGIN
  SELECT sc.* INTO cfg FROM public.ob_scoring_config sc WHERE sc.id = 1;

  w_sim  := COALESCE((p_weights_override->>'similarity')::float, cfg.weight_similarity);
  w_rec  := COALESCE((p_weights_override->>'recency')::float,    cfg.weight_recency);
  w_freq := COALESCE((p_weights_override->>'frequency')::float,  cfg.weight_frequency);

  RETURN QUERY
  WITH ranked AS (
    SELECT
      ob.id,
      ob.content,
      ob.metadata,
      ob.source,
      ob.created_at,
      ob.memory_type,
      ob.valid_from,
      ob.valid_to,
      ob.access_count,
      ob.last_accessed_at,
      (1 - (ob.embedding <=> query_embedding))::float AS similarity,
      CASE ob.memory_type
        WHEN 'episodic'   THEN cfg.halflife_episodic_days
        WHEN 'procedural' THEN cfg.halflife_procedural_days
        WHEN 'semantic'   THEN cfg.halflife_semantic_days
        WHEN 'preference' THEN cfg.halflife_preference_days
        WHEN 'decision'   THEN cfg.halflife_decision_days
        ELSE cfg.halflife_default_days
      END AS halflife_days,
      GREATEST(
        EXTRACT(EPOCH FROM (now() - GREATEST(
          COALESCE(ob.last_accessed_at, ob.created_at),
          COALESCE(ob.valid_from, ob.created_at)
        ))) / 86400.0,
        0
      ) AS age_days
    FROM public.open_brain ob
    WHERE ob.embedding IS NOT NULL
      AND (1 - (ob.embedding <=> query_embedding)) >= match_threshold
      AND (p_filter_type IS NULL OR ob.memory_type = p_filter_type)
      AND (p_only_valid = false OR ob.valid_to IS NULL OR ob.valid_to > now())
  ),
  scored AS (
    SELECT
      r.*,
      exp(-ln(2) * r.age_days / NULLIF(r.halflife_days, 0))::float AS recency_score,
      (cfg.frequency_floor
        + (1.0 - cfg.frequency_floor)
        * LEAST(1.0, ln(1 + r.access_count)::float / NULLIF(ln(1 + cfg.frequency_saturation)::float, 0))
      )::float AS frequency_score
    FROM ranked r
  ),
  hits AS MATERIALIZED (
    SELECT
      s.*,
      (w_sim * s.similarity + w_rec * s.recency_score + w_freq * s.frequency_score)::float AS composite_score
    FROM scored s
    ORDER BY (w_sim * s.similarity + w_rec * s.recency_score + w_freq * s.frequency_score) DESC
    LIMIT match_count
  ),
  bump AS (
    UPDATE public.open_brain ob
    SET access_count     = ob.access_count + 1,
        last_accessed_at = now()
    FROM (SELECT h.id FROM hits h ORDER BY h.composite_score DESC LIMIT 3) top3
    WHERE ob.id = top3.id
    RETURNING ob.id
  )
  SELECT
    h.id, h.content, h.metadata, h.source,
    h.similarity, h.recency_score, h.frequency_score, h.composite_score,
    h.created_at, h.memory_type, h.valid_from, h.valid_to,
    h.access_count, h.last_accessed_at
  FROM hits h
  ORDER BY h.composite_score DESC;
END;
$$;

COMMENT ON FUNCTION public.composite_search IS
  'v2.0: Blended ranking — similarity + per-type recency decay + log-scaled access frequency. Bumps top-3 access_count + last_accessed_at on each call. See ob_scoring_config for tunable weights and half-lives.';

GRANT EXECUTE ON FUNCTION public.composite_search(vector(1536), int, float, text, boolean, jsonb)
  TO service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 5. match_brain — add p_use_composite flag (drop + recreate to change signature)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_brain(vector(1536), float, int, text, text, boolean);
DROP FUNCTION IF EXISTS public.match_brain(vector(1536), double precision, integer, text, text, boolean);

CREATE FUNCTION public.match_brain(
  query_embedding  vector(1536),
  match_threshold  float    DEFAULT 0.7,
  match_count      int      DEFAULT 10,
  filter_source    text     DEFAULT NULL,
  p_filter_type    text     DEFAULT NULL,
  p_only_valid     boolean  DEFAULT true,
  p_use_composite  boolean  DEFAULT false
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
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_use_composite THEN
    RETURN QUERY
    SELECT
      c.id,
      c.content,
      c.metadata,
      c.source,
      c.composite_score AS similarity,
      c.created_at,
      c.memory_type,
      c.valid_from,
      c.valid_to
    -- NOTE: filter_source is not forwarded — composite_search has no source filter.
    -- Callers needing source filtering should use p_use_composite=false.
    FROM public.composite_search(
      query_embedding, match_count, match_threshold,
      p_filter_type, p_only_valid, NULL
    ) c;
    RETURN;
  END IF;

  -- Pure cosine similarity path (preserved verbatim from v1.5)
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
    AND (filter_source IS NULL OR ob.source = filter_source)
    AND (p_filter_type IS NULL OR ob.memory_type = p_filter_type)
    AND (p_only_valid = false OR ob.valid_to IS NULL OR ob.valid_to > now())
  ORDER BY ob.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION public.match_brain IS
  'v2.0: Adds p_use_composite (default false). When true, delegates to composite_search and projects v1.5 return shape (composite_score surfaces as similarity column). When false, pure cosine similarity — identical to v1.5 body.';

GRANT EXECUTE ON FUNCTION public.match_brain(vector(1536), float, int, text, text, boolean, boolean)
  TO service_role, authenticated;

COMMIT;

-- =============================================================================
-- SMOKE TESTS (run manually after migration)
-- =============================================================================
--
-- -- 1. Verify schema + config row
-- SELECT * FROM public.ob_scoring_config;
-- \d public.open_brain
--
-- -- 2. Sanity check: composite_search returns all three score columns,
-- --    composite sorted desc, top-3 get access bumped
-- WITH probe AS (SELECT embedding FROM public.open_brain WHERE embedding IS NOT NULL LIMIT 1)
-- SELECT id, memory_type, similarity, recency_score, frequency_score, composite_score, access_count
-- FROM public.composite_search((SELECT embedding FROM probe), 5, 0.5, NULL, true, NULL);
--
-- -- 3. Verify top-3 access bump
-- SELECT id, access_count, last_accessed_at FROM public.open_brain
-- ORDER BY last_accessed_at DESC LIMIT 5;
--
-- -- 4. Backward-compat: match_brain with legacy 6 args still works
-- WITH probe AS (SELECT embedding FROM public.open_brain WHERE embedding IS NOT NULL LIMIT 1)
-- SELECT id, similarity, memory_type
-- FROM public.match_brain((SELECT embedding FROM probe), 0.5, 5, NULL, NULL, true);
--
-- -- 5. Weight override: all weight on similarity — should match pure match_brain order
-- WITH probe AS (SELECT embedding FROM public.open_brain WHERE embedding IS NOT NULL LIMIT 1)
-- SELECT id, composite_score FROM public.composite_search(
--   (SELECT embedding FROM probe), 5, 0.5, NULL, true,
--   '{"similarity":1.0,"recency":0,"frequency":0}'::jsonb
-- );
--
-- -- 6. Filter by type
-- WITH probe AS (SELECT embedding FROM public.open_brain WHERE embedding IS NOT NULL LIMIT 1)
-- SELECT id, memory_type FROM public.composite_search(
--   (SELECT embedding FROM probe), 5, 0.0, 'decision', true, NULL
-- );
