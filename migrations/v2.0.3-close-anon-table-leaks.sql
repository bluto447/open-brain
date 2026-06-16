-- ============================================================
-- v2.0.3 — close anon-readable table leaks (RLS layer)
--
-- 2026-06-15 full-table anon sweep (SET LOCAL ROLE anon; count rows) — the
-- data-layer companion to v2.0.2's function-layer lockdown. Three public
-- tables returned rows to anon:
--
--   idea_sources       358 rows  P1  email bodies / scraped page content /
--                                    structured extracts (ADR-016). Its only
--                                    policy ("Service role full access") was
--                                    misbound to PUBLIC with USING(true) FOR
--                                    ALL — so anon could READ, WRITE, and
--                                    DELETE every row.
--   ob_scoring_config    1 row   P1  RLS was DISABLED entirely; anon held full
--                                    DML grants → anon could read AND rewrite
--                                    the composite-scoring weights.
--   releases             1 row   OK  Intentional public changelog: policy
--                                    "Public read published releases" (anon,
--                                    is_public AND NOT draft). Read path is
--                                    BY DESIGN and left intact; only the unused
--                                    anon write grants are revoked.
--
-- Pattern target = the Supabase Table Policy Convention (.claude/CLAUDE.md):
-- RLS on + "Allow authenticated all" + "Allow service role all", nothing for
-- anon. Verified consumers: intake pipeline / edge functions / pg_cron use
-- service_role; Command Center reads as authenticated. Nothing reads these
-- two tables as anon.
--
-- Idempotent: DROP POLICY IF EXISTS before CREATE; ENABLE RLS is a no-op if
-- already on; REVOKE of an absent grant is a no-op.
-- ============================================================

BEGIN;

-- ── idea_sources: replace the PUBLIC-bound policy with the convention pair ──
DROP POLICY IF EXISTS "Service role full access" ON public.idea_sources;
DROP POLICY IF EXISTS "Allow authenticated all"  ON public.idea_sources;
DROP POLICY IF EXISTS "Allow service role all"   ON public.idea_sources;
CREATE POLICY "Allow authenticated all" ON public.idea_sources
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON public.idea_sources
  FOR ALL TO service_role  USING (true);
-- No anon access intended — strip the default table grants too (defense in
-- depth; ob_scoring_config below shows RLS can be toggled off by accident).
REVOKE ALL ON public.idea_sources FROM anon;

-- ── ob_scoring_config: turn RLS ON and add the convention pair ─────────────
ALTER TABLE public.ob_scoring_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated all" ON public.ob_scoring_config;
DROP POLICY IF EXISTS "Allow service role all"  ON public.ob_scoring_config;
CREATE POLICY "Allow authenticated all" ON public.ob_scoring_config
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON public.ob_scoring_config
  FOR ALL TO service_role  USING (true);
REVOKE ALL ON public.ob_scoring_config FROM anon;

-- ── releases: keep intentional public read, revoke unused anon writes ──────
-- "Public read published releases" (anon, is_public AND NOT draft) stays.
-- anon never needs to write; RLS already blocks it (no permissive write
-- policy for anon) but the table grant is dead weight. Revoke-all then
-- re-grant ONLY SELECT — cleaner than enumerating verbs and it also strips
-- PG17's MAINTAIN privilege (Codex review P2). SELECT is required for the
-- public-read policy to function.
REVOKE ALL  ON public.releases FROM anon;
GRANT  SELECT ON public.releases TO   anon;

COMMIT;

-- ── Smoke tests (run manually) ──────────────────────────────
-- 1. Full anon sweep should now show ONLY releases (1 intentional row):
--    DO $$ DECLARE r record; n bigint; vis boolean;
--    BEGIN
--      CREATE TEMP TABLE _leak(tbl text, anon_rows bigint) ON COMMIT DROP;
--      FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
--               WHERE ns.nspname='public' AND c.relkind='r' LOOP
--        BEGIN SET LOCAL ROLE anon;
--          EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)', r.relname) INTO vis;
--          IF vis THEN EXECUTE format('SELECT count(*) FROM public.%I', r.relname) INTO n;
--            RESET ROLE; INSERT INTO _leak VALUES (r.relname, n);
--          ELSE RESET ROLE; END IF;
--        EXCEPTION WHEN OTHERS THEN RESET ROLE; END;
--      END LOOP;
--    END $$;
--    SELECT * FROM _leak WHERE anon_rows > 0;   -- expect only: releases
-- 2. idea_sources / ob_scoring_config now blocked at the GRANT layer:
--    SET LOCAL ROLE anon; SELECT count(*) FROM idea_sources;
--    -- expect ERROR: permission denied (anon lost the table grant, so it
--    --   fails before RLS even applies — NOT a 0-row result)
--    SELECT has_table_privilege('anon','public.idea_sources','SELECT');  -- f
-- 3. Authenticated still works (Command Center path) — exercise from the app.
-- 4. RLS is on for both:
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('idea_sources','ob_scoring_config');   -- both t
