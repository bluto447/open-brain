-- Migration: Swap researcher binding from claude-researcher to perplexity-researcher
-- Date: 2026-04-12
-- Context: Cost reduction from $1.20-5.00/idea (Opus) to ~$0.01-0.02/idea (Perplexity Sonar Pro)
--
-- PREREQUISITES:
--   1. Deploy perplexity-researcher Edge Function to Supabase
--   2. Add PERPLEXITY_API_KEY to Edge Function secrets
--   3. Run this migration
--
-- ROLLBACK:
--   UPDATE vault.secrets SET secret = 'claude-researcher'
--     WHERE name = 'researcher_function_slug';
--   -- Or just revert rpc_invoke_claude_researcher to hardcoded slug

-- Step 1: Add a vault entry for the researcher function slug (makes future swaps a config change)
-- Check if it exists first; if not, insert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'researcher_function_slug'
  ) THEN
    INSERT INTO vault.secrets (name, secret, description)
    VALUES (
      'researcher_function_slug',
      'perplexity-researcher',
      'Edge Function slug for the pipeline researcher. Swap between claude-researcher and perplexity-researcher.'
    );
  ELSE
    UPDATE vault.secrets
    SET secret = 'perplexity-researcher'
    WHERE name = 'researcher_function_slug';
  END IF;
END $$;

-- Step 2: Update rpc_invoke_claude_researcher to read the slug from vault
-- This makes the binding swappable without code changes
CREATE OR REPLACE FUNCTION public.rpc_invoke_claude_researcher(
  p_idea_id uuid,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_idea      record;
  v_base_url  text;
  v_bearer    text;
  v_slug      text;
  v_url       text;
  v_request_id bigint;
BEGIN
  -- Guard: idea must exist and be in researching stage
  SELECT id, stage INTO v_idea
  FROM pipeline
  WHERE id = p_idea_id
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'idea_not_found: %', p_idea_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_idea.stage <> 'researching' THEN
    RAISE EXCEPTION 'wrong_stage: idea % is in stage %, expected researching',
      p_idea_id, v_idea.stage
      USING ERRCODE = 'P0001';
  END IF;

  -- Read secrets from vault
  SELECT decrypted_secret INTO v_base_url
  FROM vault.decrypted_secrets
  WHERE name = 'edge_functions_base_url';

  SELECT decrypted_secret INTO v_bearer
  FROM vault.decrypted_secrets
  WHERE name = 'edge_functions_bearer';

  -- Read researcher slug from vault (defaults to perplexity-researcher)
  SELECT COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'researcher_function_slug'),
    'perplexity-researcher'
  ) INTO v_slug;

  v_url := v_base_url || '/' || v_slug;

  -- Fire async via pg_net
  SELECT net.http_post(
    url     := v_url,
    body    := jsonb_build_object(
      'idea_id', p_idea_id::text,
      'dry_run', p_dry_run
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_bearer,
      'apikey', v_bearer
    )
  ) INTO v_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'idea_id', p_idea_id,
    'dry_run', p_dry_run,
    'researcher_binding', v_slug,
    'pg_net_request_id', v_request_id,
    'fired_at', now()
  );
END;
$$;

-- Step 3: Update rpc_run_next_researcher to pick ideas without perplexity-researcher results
-- The pick query checks for NULL research_result OR old binding
CREATE OR REPLACE FUNCTION public.rpc_run_next_researcher()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_idea_id uuid;
  v_result  jsonb;
BEGIN
  -- Pick oldest researching idea that hasn't been processed by current researcher
  SELECT id INTO v_idea_id
  FROM pipeline
  WHERE stage = 'researching'
    AND (
      research_result IS NULL
      OR research_result->>'binding' NOT IN ('perplexity-researcher', 'claude-researcher')
    )
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_idea_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'picked', false,
      'reason', 'no_stale_researching_rows'
    );
  END IF;

  -- Fire the researcher
  v_result := public.rpc_invoke_claude_researcher(v_idea_id, false);

  RETURN v_result;
END;
$$;

-- Step 4: Verify
-- SELECT * FROM vault.decrypted_secrets WHERE name = 'researcher_function_slug';
-- SELECT public.rpc_run_next_researcher();  -- should fire perplexity-researcher
