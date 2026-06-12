-- ============================================================
-- v2.0.2 — revoke anon EXECUTE across all SECURITY DEFINER RPCs
--
-- 2026-06-11 sweep (during the v2.0.1 anon probe) found 20 SECURITY DEFINER
-- functions in public executable by anon and/or PUBLIC. Root cause: Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to anon EXPLICITLY on every function
-- postgres creates in public, so the repo's REVOKE-FROM-PUBLIC discipline never
-- removed anon. get_advisors(security) does NOT flag this class (zero lints
-- while the holes were live).
--
-- Exposure before this migration (any holder of the public-by-design anon key):
--   - WRITE: update_memory / deprecate_memory / merge_memories — mutate the
--     memory corpus as postgres (RLS bypassed via SECURITY DEFINER)
--   - READ: composite_search / match_brain / find_contradictions /
--     find_duplicates — semantic search over the full corpus
--   - COST/STATE: rpc_* pipeline orchestration — trigger paid LLM runs,
--     mutate pipeline state
--
-- Verified safe to revoke: pg_cron jobs 3/4/5 call the rpc_* functions via
-- direct SQL as the job owner (no PostgREST, no keys); MCP server + edge
-- functions + n8n use service_role; Command Center reads tables as
-- authenticated. Nothing calls these as anon by design.
--
-- Idempotent: REVOKE of an absent grant is a no-op; GRANTs re-assert the
-- intended grants even if already present. Pipeline/trigger functions are
-- live-managed objects owned by the pipeline project (not created by this
-- repo's migrations), so they are guarded with to_regprocedure for clean
-- rebuilds (Codex review P2).
-- ============================================================

BEGIN;

-- ── Batch 1: Open Brain write RPCs → service_role ONLY ─────────
-- (CLAUDE.md convention: write RPCs locked to service_role. The MCP server is
-- the only writer; Command Center is a view layer per ADR-002.)
REVOKE EXECUTE ON FUNCTION public.update_memory(bigint, text, jsonb)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.deprecate_memory(bigint, text, bigint)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_memories(bigint[], text, text)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.update_memory(bigint, text, jsonb)      TO service_role;
GRANT  EXECUTE ON FUNCTION public.deprecate_memory(bigint, text, bigint)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.merge_memories(bigint[], text, text)    TO service_role;

-- ── Batch 2: Open Brain read/search RPCs → authenticated + service_role ──
REVOKE EXECUTE ON FUNCTION public.composite_search(vector, integer, double precision, text, boolean, jsonb)                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.match_brain(vector, double precision, integer, text, text, boolean, boolean)               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.find_contradictions(double precision, double precision, integer)                           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.find_duplicates(vector, double precision, integer)                                         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_scoring_config()                                                                       FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.composite_search(vector, integer, double precision, text, boolean, jsonb)                  TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.match_brain(vector, double precision, integer, text, text, boolean, boolean)               TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.find_contradictions(double precision, double precision, integer)                           TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.find_duplicates(vector, double precision, integer)                                         TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.get_scoring_config()                                                                       TO authenticated, service_role;

-- ── Batch 2b: entity-graph RPCs — explicit anon revoke (Codex review P1) ──
-- migrations/v2.0-entity-graph.sql only revoked PUBLIC; the live DB was fixed
-- by hand on 2026-06-04 but a clean rebuild from migration files would
-- re-create the anon grants via the default ACL. No-ops against current prod.
REVOKE EXECUTE ON FUNCTION public.upsert_memory_entities(bigint, text[], text[], text[])  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.rebuild_entity_graph()                                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_entity(text, text)                                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_entity_neighbors(bigint, real, int)                 FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_memories_for_entity(bigint, boolean, int)           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_entities(text, int, int)                           FROM PUBLIC, anon;

-- ── Batch 3: pipeline orchestration RPCs → authenticated + service_role ──
-- (pg_cron calls these as the job owner — unaffected by these grants.
--  Guarded: these objects are owned by the pipeline project and may not
--  exist on a clean open-brain-only rebuild.)
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.rpc_intake_next_idea()',
    'public.rpc_invoke_claude_researcher(uuid, boolean)',
    'public.rpc_poll_http_request(bigint)',
    'public.rpc_run_next_reasoning_scorer()',
    'public.rpc_run_next_researcher()',
    'public.rpc_state_transition_reenter(uuid, text, text[], text)',
    'public.rpc_state_transition_rollback(uuid, text)',
    'public.rpc_task_claim_next(uuid, text, text)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END IF;
  END LOOP;
END $$;

-- ── Batch 4: trigger functions — hygiene only ──────────────────
-- (Not directly callable via RPC — PostgREST rejects trigger-returning
-- functions, and trigger firing does not check the DML role's EXECUTE —
-- but no reason for anon/PUBLIC to hold EXECUTE. Guarded like Batch 3.)
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.log_stage_transition_insert()',
    'public.log_stage_transition_update()',
    'public.notify_pipeline_change()',
    'public.notify_task_change()'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    END IF;
  END LOOP;
END $$;

-- ── Batch 5: root cause — stop future functions being born anon-executable ──
-- Only the FOR ROLE postgres entry is changed; the supabase_admin default ACL
-- (platform-managed objects) is deliberately left alone.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

COMMIT;

-- ── Smoke tests (run manually) ──────────────────────────────
-- 1. No SECURITY DEFINER function in public should remain anon/PUBLIC-executable:
--    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosecdef
--      AND (p.proacl IS NULL OR p.proacl::text LIKE '%anon=%' OR p.proacl::text ~ '(\{|,)=X/');
--    -- expect 0 rows
-- 2. Live anon probe on a no-arg function:
--    DO $$ BEGIN SET LOCAL ROLE anon; PERFORM get_scoring_config();
--      RAISE EXCEPTION 'anon can execute'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
-- 3. Default ACL no longer includes anon for postgres-created functions:
--    SELECT defaclacl::text FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
--    WHERE pg_get_userbyid(defaclrole) = 'postgres' AND n.nspname = 'public' AND defaclobjtype = 'f';
--    -- expect no 'anon=' entry
-- 4. Service-role write path still works: exercise the open-brain MCP
--    update_memory tool (calls update_memory RPC as service_role).
