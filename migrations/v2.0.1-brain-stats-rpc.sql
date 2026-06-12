-- ============================================================
-- v2.0.1 — ob_brain_stats(): server-side stats aggregation
--
-- Closes the remaining P3 from the 2026-06-09 Codex security review of
-- open-brain-mcp/server.js: the brain_stats MCP tool paginated the ENTIRE
-- open_brain table into Node memory (3 cols x every row, growing daily)
-- just to compute counts and a date range. This RPC moves the aggregation
-- into Postgres so the client receives one jsonb row.
--
-- Parity note: like the old client-side loop, this counts ALL rows,
-- including deprecated memories (valid_to IS NOT NULL).
--
-- Returns jsonb:
-- {
--   "total":    <int>,
--   "oldest":   <timestamptz | null>,
--   "newest":   <timestamptz | null>,
--   "sources":  [{"source": text, "count": int}, ...]   -- count desc
--   "top_tags": [{"tag": text, "count": int}, ...]      -- count desc, capped
-- }
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.ob_brain_stats(top_tags_limit int DEFAULT 15)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'total',  (SELECT count(*) FROM public.open_brain),
    'oldest', (SELECT min(created_at) FROM public.open_brain),
    'newest', (SELECT max(created_at) FROM public.open_brain),
    'sources', (
      SELECT coalesce(
        jsonb_agg(jsonb_build_object('source', s.source, 'count', s.cnt)
                  ORDER BY s.cnt DESC, s.source),
        '[]'::jsonb)
      FROM (
        SELECT coalesce(source, 'unknown') AS source, count(*) AS cnt
        FROM public.open_brain
        GROUP BY 1
      ) s
    ),
    'top_tags', (
      SELECT coalesce(
        jsonb_agg(jsonb_build_object('tag', t.tag, 'count', t.cnt)
                  ORDER BY t.cnt DESC, t.tag),
        '[]'::jsonb)
      FROM (
        SELECT tag, count(*) AS cnt
        FROM public.open_brain ob,
             LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(ob.metadata->'tags') = 'array'
                    THEN ob.metadata->'tags'
                    ELSE '[]'::jsonb END
             ) AS tag
        GROUP BY tag
        ORDER BY cnt DESC, tag
        LIMIT least(greatest(coalesce(top_tags_limit, 15), 1), 100)
      ) t
    )
  );
$$;

-- Read-only, but still not for anon. TWO revokes are required:
--   1. CREATE FUNCTION implicitly grants EXECUTE to PUBLIC (memory #1584).
--   2. Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE to anon EXPLICITLY,
--      so revoking PUBLIC alone leaves anon=X in the ACL. Verified live
--      2026-06-11: after REVOKE FROM PUBLIC, anon could still execute.
--      get_advisors(security) does NOT flag this — test with SET ROLE anon.
-- SECURITY INVOKER (default) on purpose — service_role bypasses RLS,
-- authenticated reads via the "Allow authenticated all" policy.
REVOKE EXECUTE ON FUNCTION public.ob_brain_stats(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ob_brain_stats(int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.ob_brain_stats(int) TO service_role, authenticated;

COMMIT;

-- ── Smoke tests (run manually in SQL editor) ────────────────
-- SELECT ob_brain_stats();                                          -- one jsonb row
-- SELECT (ob_brain_stats()->>'total')::int > 0;                     -- t
-- SELECT jsonb_array_length(ob_brain_stats()->'top_tags') <= 15;    -- t
-- SELECT jsonb_array_length(ob_brain_stats(3)->'top_tags') <= 3;    -- t
-- SET ROLE anon; SELECT ob_brain_stats(); RESET ROLE;               -- must FAIL (permission denied)
