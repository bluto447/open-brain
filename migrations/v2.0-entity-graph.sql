-- =============================================================================
-- Open Brain v2.0 — Relationship Extraction (Entity Graph)
-- =============================================================================
-- Run this in the Supabase SQL Editor for project lolivmsgmwmeqqqpjszo.
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS guards.
--
-- Adds the v2.0 entity graph (derived from existing memory metadata):
--   1. pg_trgm extension + ob_normalize_entity() helper
--   2. Tables: entities, memory_entities, entity_edges, entity_aliases
--   3. RLS (both required policies) + GRANTs on every new table
--   4. Write-path RPCs: upsert_memory_entities(), rebuild_entity_graph()
--   5. Read-path RPCs: get_entity(), get_entity_neighbors(),
--      get_memories_for_entity(), list_entities()
--
-- Extraction = Option A: entities + edges are derived from the people/topics/tags
-- already extracted into open_brain.metadata by the hyper-worker pipeline. No new
-- LLM call. v2.1 (typed LLM triples) lands in entity_edges via relation <> 'co_occurs'
-- with NO schema change.
--
-- ALL co-occurrence edges are captured (topic<->topic included); read-path RPCs
-- expose p_min_weight so callers (the dashboard) filter noise at query time rather
-- than dropping edge data at write time.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 0: Extension + normalization helper
-- =============================================================================

-- Trigram index support for fuzzy entity-name search (dashboard search box).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Deterministic entity-name normalization. IMMUTABLE so it can back the resolver
-- and any future expression index. Lowercase, strip punctuation -> spaces,
-- collapse whitespace, trim. "Brian Snipes!" and "brian  snipes" -> "brian snipes".
CREATE OR REPLACE FUNCTION public.ob_normalize_entity(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(btrim(p_name)), '[[:punct:]]+', ' ', 'g'),
      '\s+', ' ', 'g'
    )
  )
$$;

COMMENT ON FUNCTION public.ob_normalize_entity IS
  'v2.0: Deterministic entity-name dedup key (lowercase, punct->space, ws-collapsed, trimmed).';


-- =============================================================================
-- SECTION 1: Tables
-- =============================================================================

-- 1a. entities (nodes) -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entities (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL,                 -- display form, first-seen casing
  normalized_name text NOT NULL,                 -- ob_normalize_entity(name)
  entity_type     text NOT NULL,                 -- person|project|topic|tool|org
  project_slug    text,                          -- best-effort hint; only for type='project'
  embedding       vector(1536),                  -- reserved for fuzzy dedup (deferred, unused in v1)
  mention_count   integer NOT NULL DEFAULT 0,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entities_type_check
    CHECK (entity_type IN ('person','project','topic','tool','org')),
  CONSTRAINT entities_uniq_norm_type UNIQUE (normalized_name, entity_type)
);

COMMENT ON TABLE public.entities IS
  'v2.0 entity graph: nodes derived from open_brain.metadata (people/topics/tags). Unique on (normalized_name, entity_type).';

CREATE INDEX IF NOT EXISTS entities_type_idx         ON public.entities (entity_type);
CREATE INDEX IF NOT EXISTS entities_normalized_idx   ON public.entities (normalized_name);
CREATE INDEX IF NOT EXISTS entities_project_slug_idx ON public.entities (project_slug) WHERE project_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_name_trgm_idx    ON public.entities USING gin (name gin_trgm_ops);

-- 1b. memory_entities (join) -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_entities (
  memory_id   bigint NOT NULL REFERENCES public.open_brain(id) ON DELETE CASCADE,
  entity_id   bigint NOT NULL REFERENCES public.entities(id)   ON DELETE CASCADE,
  role        text,                              -- provenance: 'people' | 'topics' | 'tags'
  weight      real NOT NULL DEFAULT 1.0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id)
);

COMMENT ON TABLE public.memory_entities IS
  'v2.0 entity graph: memory<->entity links. Deprecation does NOT delete rows — filter open_brain.valid_to for live-only.';

CREATE INDEX IF NOT EXISTS memory_entities_entity_idx ON public.memory_entities (entity_id);
CREATE INDEX IF NOT EXISTS memory_entities_memory_idx ON public.memory_entities (memory_id);

-- 1c. entity_edges (co-occurrence relationships) -----------------------------
-- Undirected co-occurrence stored canonically as source = LEAST(a,b),
-- target = GREATEST(a,b). v2.1 typed edges use relation <> 'co_occurs' and keep
-- true direction; the UNIQUE key includes relation so both coexist.
CREATE TABLE IF NOT EXISTS public.entity_edges (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_entity_id    bigint NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  target_entity_id    bigint NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  relation            text NOT NULL DEFAULT 'co_occurs',
  weight              real NOT NULL DEFAULT 0,        -- running co-occurrence strength
  evidence_count      integer NOT NULL DEFAULT 0,
  evidence_memory_ids bigint[] NOT NULL DEFAULT '{}', -- capped sample of supporting memory ids
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_seen           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_edges_no_self CHECK (source_entity_id <> target_entity_id),
  CONSTRAINT entity_edges_uniq UNIQUE (source_entity_id, target_entity_id, relation)
);

COMMENT ON TABLE public.entity_edges IS
  'v2.0 entity graph: undirected co-occurrence edges (relation=co_occurs). Read-path filters by weight. v2.1 adds typed relations here.';

CREATE INDEX IF NOT EXISTS entity_edges_source_idx ON public.entity_edges (source_entity_id);
CREATE INDEX IF NOT EXISTS entity_edges_target_idx ON public.entity_edges (target_entity_id);

-- 1d. entity_aliases (manual merges; ships empty) ----------------------------
CREATE TABLE IF NOT EXISTS public.entity_aliases (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alias_norm   text NOT NULL,                    -- ob_normalize_entity() form to redirect
  entity_type  text NOT NULL,
  canonical_id bigint NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_aliases_uniq UNIQUE (alias_norm, entity_type)
);

COMMENT ON TABLE public.entity_aliases IS
  'v2.0 entity graph: manual alias -> canonical entity merges (e.g. "brian" -> "brian snipes"). Checked by the resolver before creating a new entity.';


-- =============================================================================
-- SECTION 2: RLS — both required policies on every new table
-- =============================================================================
-- Per portfolio policy: every new table needs BOTH an authenticated and a
-- service_role policy or app writes silently fail.

-- entities
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated all" ON public.entities;
DROP POLICY IF EXISTS "Allow service role all"  ON public.entities;
CREATE POLICY "Allow authenticated all" ON public.entities FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all"  ON public.entities FOR ALL TO service_role USING (true);
GRANT SELECT ON public.entities TO authenticated;
GRANT ALL    ON public.entities TO service_role;

-- memory_entities
ALTER TABLE public.memory_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated all" ON public.memory_entities;
DROP POLICY IF EXISTS "Allow service role all"  ON public.memory_entities;
CREATE POLICY "Allow authenticated all" ON public.memory_entities FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all"  ON public.memory_entities FOR ALL TO service_role USING (true);
GRANT SELECT ON public.memory_entities TO authenticated;
GRANT ALL    ON public.memory_entities TO service_role;

-- entity_edges
ALTER TABLE public.entity_edges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated all" ON public.entity_edges;
DROP POLICY IF EXISTS "Allow service role all"  ON public.entity_edges;
CREATE POLICY "Allow authenticated all" ON public.entity_edges FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all"  ON public.entity_edges FOR ALL TO service_role USING (true);
GRANT SELECT ON public.entity_edges TO authenticated;
GRANT ALL    ON public.entity_edges TO service_role;

-- entity_aliases
ALTER TABLE public.entity_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated all" ON public.entity_aliases;
DROP POLICY IF EXISTS "Allow service role all"  ON public.entity_aliases;
CREATE POLICY "Allow authenticated all" ON public.entity_aliases FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all"  ON public.entity_aliases FOR ALL TO service_role USING (true);
GRANT SELECT ON public.entity_aliases TO authenticated;
GRANT ALL    ON public.entity_aliases TO service_role;


-- =============================================================================
-- SECTION 3: Write-path RPC — upsert_memory_entities
-- =============================================================================
-- Resolves people/topics/tags into entities, links them to the memory, and
-- upserts a co-occurrence edge for every unordered pair. Single transaction.
-- Used by BOTH the live ingest pipeline (hyper-worker Step 6) and the backfill,
-- so there is zero drift between them.
--
-- p_people -> person (weight 1.0)
-- p_topics -> topic  (weight 1.0)
-- p_tags   -> topic  (weight 0.5, role='tags' so it can be down-weighted later)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.upsert_memory_entities(
  p_memory_id bigint,
  p_people    text[] DEFAULT '{}',
  p_topics    text[] DEFAULT '{}',
  p_tags      text[] DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cand        record;
  v_norm      text;
  v_entity_id bigint;
  v_ids       bigint[] := '{}';
  v_a         bigint;
  v_b         bigint;
  i           int;
  j           int;
  EVIDENCE_CAP constant int := 20;
BEGIN
  IF p_memory_id IS NULL THEN
    RETURN;
  END IF;

  -- Candidate set: (raw name, entity_type, role, weight)
  FOR cand IN
    SELECT t.nm AS nm, 'person'::text AS etype, 'people'::text AS role, 1.0::real AS weight
      FROM unnest(COALESCE(p_people, '{}')) AS t(nm)
    UNION ALL
    SELECT t.nm, 'topic', 'topics', 1.0
      FROM unnest(COALESCE(p_topics, '{}')) AS t(nm)
    UNION ALL
    SELECT t.nm, 'topic', 'tags', 0.5
      FROM unnest(COALESCE(p_tags, '{}')) AS t(nm)
  LOOP
    v_norm := public.ob_normalize_entity(cand.nm);
    CONTINUE WHEN v_norm IS NULL OR v_norm = '';

    -- Alias redirect: if this normalized name maps to a canonical entity, use it.
    SELECT a.canonical_id INTO v_entity_id
      FROM public.entity_aliases a
      WHERE a.alias_norm = v_norm AND a.entity_type = cand.etype;

    IF v_entity_id IS NOT NULL THEN
      UPDATE public.entities
        SET mention_count = mention_count + 1, last_seen = now()
        WHERE id = v_entity_id;
    ELSE
      INSERT INTO public.entities (name, normalized_name, entity_type, mention_count, first_seen, last_seen)
      VALUES (btrim(cand.nm), v_norm, cand.etype, 1, now(), now())
      ON CONFLICT (normalized_name, entity_type)
      DO UPDATE SET mention_count = public.entities.mention_count + 1, last_seen = now()
      RETURNING id INTO v_entity_id;
    END IF;

    -- Link memory -> entity (idempotent on the composite PK).
    INSERT INTO public.memory_entities (memory_id, entity_id, role, weight)
    VALUES (p_memory_id, v_entity_id, cand.role, cand.weight)
    ON CONFLICT (memory_id, entity_id) DO NOTHING;

    IF NOT (v_entity_id = ANY(v_ids)) THEN
      v_ids := array_append(v_ids, v_entity_id);
    END IF;
  END LOOP;

  -- Co-occurrence edges for every unordered pair of resolved entities.
  IF array_length(v_ids, 1) >= 2 THEN
    FOR i IN 1 .. array_length(v_ids, 1) - 1 LOOP
      FOR j IN i + 1 .. array_length(v_ids, 1) LOOP
        v_a := LEAST(v_ids[i], v_ids[j]);
        v_b := GREATEST(v_ids[i], v_ids[j]);

        INSERT INTO public.entity_edges (
          source_entity_id, target_entity_id, relation,
          weight, evidence_count, evidence_memory_ids, first_seen, last_seen
        )
        VALUES (v_a, v_b, 'co_occurs', 1, 1, ARRAY[p_memory_id], now(), now())
        ON CONFLICT (source_entity_id, target_entity_id, relation)
        DO UPDATE SET
          -- Counters increment only when THIS memory hasn't already counted toward
          -- the pair, so re-processing the same memory is idempotent. (The evidence
          -- array is a capped sample, so rebuild_entity_graph() is the exact
          -- idempotency guarantee; this gate covers the common re-run case.)
          weight = public.entity_edges.weight
            + CASE WHEN p_memory_id = ANY(public.entity_edges.evidence_memory_ids) THEN 0 ELSE 1 END,
          evidence_count = public.entity_edges.evidence_count
            + CASE WHEN p_memory_id = ANY(public.entity_edges.evidence_memory_ids) THEN 0 ELSE 1 END,
          -- Append memory id only if new and under the cap (bounds array growth).
          evidence_memory_ids = CASE
            WHEN p_memory_id = ANY(public.entity_edges.evidence_memory_ids) THEN public.entity_edges.evidence_memory_ids
            WHEN COALESCE(array_length(public.entity_edges.evidence_memory_ids, 1), 0) >= EVIDENCE_CAP THEN public.entity_edges.evidence_memory_ids
            ELSE public.entity_edges.evidence_memory_ids || p_memory_id
          END,
          last_seen = now();
      END LOOP;
    END LOOP;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.upsert_memory_entities IS
  'v2.0: Resolve people/topics/tags into entities, link to memory, upsert co-occurrence edges. Shared by ingest + backfill.';

-- Write-path: service_role only. REVOKE FROM PUBLIC first — CREATE grants EXECUTE to
-- PUBLIC by default, which would let the anon role trigger arbitrary entity writes.
REVOKE EXECUTE ON FUNCTION public.upsert_memory_entities(bigint, text[], text[], text[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_memory_entities(bigint, text[], text[], text[]) TO service_role;


-- =============================================================================
-- SECTION 4: Write-path RPC — rebuild_entity_graph (backfill primitive)
-- =============================================================================
-- Idempotent full rebuild. KEEPS entity rows so IDs (and entity_aliases targets)
-- stay stable; zeroes counts, truncates the two leaf tables, then replays every
-- memory through upsert_memory_entities (the SAME path as live ingest). Finally
-- drops orphaned entities that are no longer mentioned and not alias targets.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.rebuild_entity_graph()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec        record;
  v_entities int;
  v_links    int;
  v_edges    int;
BEGIN
  -- entity_edges + memory_entities are leaf tables (no inbound FKs) -> safe TRUNCATE.
  -- entities are KEPT (stable IDs for aliases); counts recomputed below.
  TRUNCATE public.entity_edges, public.memory_entities;
  UPDATE public.entities SET mention_count = 0;

  FOR rec IN
    SELECT ob.id,
           COALESCE(ob.metadata->'people', '[]'::jsonb) AS people,
           COALESCE(ob.metadata->'topics', '[]'::jsonb) AS topics,
           COALESCE(ob.metadata->'tags',   '[]'::jsonb) AS tags
      FROM public.open_brain ob
  LOOP
    PERFORM public.upsert_memory_entities(
      rec.id,
      ARRAY(SELECT jsonb_array_elements_text(rec.people)),
      ARRAY(SELECT jsonb_array_elements_text(rec.topics)),
      ARRAY(SELECT jsonb_array_elements_text(rec.tags))
    );
  END LOOP;

  -- Drop entities no longer mentioned and not referenced by a manual alias.
  DELETE FROM public.entities e
   WHERE e.mention_count = 0
     AND NOT EXISTS (SELECT 1 FROM public.entity_aliases a WHERE a.canonical_id = e.id);

  SELECT count(*) INTO v_entities FROM public.entities;
  SELECT count(*) INTO v_links    FROM public.memory_entities;
  SELECT count(*) INTO v_edges    FROM public.entity_edges;

  RETURN jsonb_build_object(
    'entities', v_entities,
    'links',    v_links,
    'edges',    v_edges,
    'rebuilt_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.rebuild_entity_graph IS
  'v2.0: Idempotent full rebuild of the entity graph from open_brain.metadata. Replays every memory through upsert_memory_entities. Returns {entities,links,edges} counts.';

-- Write-path: service_role only. anon/authenticated must not be able to trigger a
-- full (expensive) graph rebuild via the REST rpc endpoint.
REVOKE EXECUTE ON FUNCTION public.rebuild_entity_graph() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rebuild_entity_graph() TO service_role;


-- =============================================================================
-- SECTION 5: Read-path RPCs (consumed by MCP tools + the future dashboard)
-- =============================================================================

-- get_entity: normalized lookup by name (optional type filter).
-- Falls back through entity_aliases so a name merged into a canonical entity
-- (e.g. "Brian Snipes" -> "Brian") still resolves on read.
CREATE OR REPLACE FUNCTION public.get_entity(
  p_name text,
  p_type text DEFAULT NULL
)
RETURNS SETOF public.entities
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH norm AS (SELECT public.ob_normalize_entity(p_name) AS n)
  SELECT e.*
  FROM public.entities e, norm
  WHERE e.normalized_name = norm.n
    AND (p_type IS NULL OR e.entity_type = p_type)
  UNION
  SELECT e.*
  FROM public.entity_aliases a
  JOIN public.entities e ON e.id = a.canonical_id, norm
  WHERE a.alias_norm = norm.n
    AND (p_type IS NULL OR a.entity_type = p_type)
  ORDER BY mention_count DESC
$$;

COMMENT ON FUNCTION public.get_entity IS 'v2.0: Resolve an entity by (normalized) name, optional type filter. Falls back through entity_aliases so merged-away names still resolve.';
REVOKE EXECUTE ON FUNCTION public.get_entity(text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_entity(text, text) TO service_role, authenticated;

-- get_entity_neighbors: graph edges from an entity. p_min_weight is the hairball filter.
CREATE OR REPLACE FUNCTION public.get_entity_neighbors(
  p_entity_id  bigint,
  p_min_weight real DEFAULT 0,
  p_limit      int  DEFAULT 20
)
RETURNS TABLE (
  neighbor_id    bigint,
  neighbor_name  text,
  neighbor_type  text,
  relation       text,
  weight         real,
  evidence_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id,
    e.name,
    e.entity_type,
    ee.relation,
    ee.weight,
    ee.evidence_count
  FROM public.entity_edges ee
  JOIN public.entities e
    ON e.id = CASE WHEN ee.source_entity_id = p_entity_id
                   THEN ee.target_entity_id
                   ELSE ee.source_entity_id END
  WHERE (ee.source_entity_id = p_entity_id OR ee.target_entity_id = p_entity_id)
    AND ee.weight >= p_min_weight
  ORDER BY ee.weight DESC
  LIMIT p_limit
$$;

COMMENT ON FUNCTION public.get_entity_neighbors IS
  'v2.0: Co-occurrence neighbors of an entity, ordered by weight. p_min_weight filters noise at query time.';
REVOKE EXECUTE ON FUNCTION public.get_entity_neighbors(bigint, real, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_entity_neighbors(bigint, real, int) TO service_role, authenticated;

-- get_memories_for_entity: drill-down from an entity to its source memories.
CREATE OR REPLACE FUNCTION public.get_memories_for_entity(
  p_entity_id  bigint,
  p_only_valid boolean DEFAULT true,
  p_limit      int     DEFAULT 50
)
RETURNS TABLE (
  id          bigint,
  content     text,
  metadata    jsonb,
  source      text,
  memory_type text,
  created_at  timestamptz,
  role        text,
  weight      real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ob.id,
    ob.content,
    ob.metadata,
    ob.source,
    ob.memory_type,
    ob.created_at,
    me.role,
    me.weight
  FROM public.memory_entities me
  JOIN public.open_brain ob ON ob.id = me.memory_id
  WHERE me.entity_id = p_entity_id
    AND (p_only_valid = false OR ob.valid_to IS NULL OR ob.valid_to > now())
  ORDER BY ob.created_at DESC
  LIMIT p_limit
$$;

COMMENT ON FUNCTION public.get_memories_for_entity IS
  'v2.0: Memories linked to an entity (drill-down). Filters deprecated memories when p_only_valid.';
REVOKE EXECUTE ON FUNCTION public.get_memories_for_entity(bigint, boolean, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_memories_for_entity(bigint, boolean, int) TO service_role, authenticated;

-- list_entities: node list for browsing / dashboard, ordered by mention_count.
CREATE OR REPLACE FUNCTION public.list_entities(
  p_type         text DEFAULT NULL,
  p_min_mentions int  DEFAULT 1,
  p_limit        int  DEFAULT 100
)
RETURNS SETOF public.entities
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.entities
  WHERE (p_type IS NULL OR entity_type = p_type)
    AND mention_count >= p_min_mentions
  ORDER BY mention_count DESC
  LIMIT p_limit
$$;

COMMENT ON FUNCTION public.list_entities IS 'v2.0: List entities (node list) filtered by type/min-mentions, ranked by mention_count.';
REVOKE EXECUTE ON FUNCTION public.list_entities(text, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.list_entities(text, int, int) TO service_role, authenticated;


COMMIT;


-- =============================================================================
-- SMOKE TESTS (run manually after migration)
-- =============================================================================
--
-- -- 1. Tables + both RLS policies present (expect 2 rows per table)
-- SELECT tablename, count(*) FROM pg_policies
-- WHERE tablename IN ('entities','memory_entities','entity_edges','entity_aliases')
-- GROUP BY tablename;
--
-- -- 2. Normalization helper
-- SELECT public.ob_normalize_entity('  Brian Snipes! ');   -- -> 'brian snipes'
--
-- -- 3. Backfill the graph from existing metadata
-- SELECT public.rebuild_entity_graph();   -- -> {"entities":N,"links":M,"edges":K,...}
--
-- -- 4. Distribution by type
-- SELECT entity_type, count(*) FROM public.entities GROUP BY 1 ORDER BY 2 DESC;
--
-- -- 5. Neighbors of the top-mentioned person
-- SELECT * FROM public.get_entity_neighbors(
--   (SELECT id FROM public.entities WHERE entity_type='person' ORDER BY mention_count DESC LIMIT 1),
--   0, 20
-- );
--
-- -- 6. Drill-down: memories for an entity
-- SELECT id, memory_type, role, weight FROM public.get_memories_for_entity(
--   (SELECT id FROM public.entities ORDER BY mention_count DESC LIMIT 1), true, 10
-- );
--
-- -- 7. Node list for the dashboard
-- SELECT id, name, entity_type, mention_count FROM public.list_entities(NULL, 2, 25);
