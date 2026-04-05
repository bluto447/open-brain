-- =============================================================================
-- Open Brain v1.5.1 — Doc-Sync Helper Functions
-- =============================================================================
-- Run this in the Supabase SQL Editor for project lolivmsgmwmeqqqpjszo.
-- Safe to re-run: uses CREATE OR REPLACE.
--
-- Changes:
--   1. Creates list_public_rpcs() — returns all public RPC functions + signatures
--   2. Creates list_table_info() — returns public tables with column details
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: list_public_rpcs()
-- Returns all user-defined functions in the public schema with their arguments.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_public_rpcs()
RETURNS TABLE (
  function_name text,
  argument_signature text,
  return_type text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.proname::text AS function_name,
    pg_get_function_arguments(p.oid)::text AS argument_signature,
    pg_get_function_result(p.oid)::text AS return_type
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
  ORDER BY p.proname
$$;

-- =============================================================================
-- SECTION 2: list_table_info()
-- Returns all public tables with their columns, types, and defaults.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_table_info()
RETURNS TABLE (
  table_name text,
  column_name text,
  data_type text,
  is_nullable text,
  column_default text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.table_name::text,
    c.column_name::text,
    c.data_type::text,
    c.is_nullable::text,
    c.column_default::text
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
  ORDER BY c.table_name, c.ordinal_position
$$;

-- =============================================================================
-- SECTION 3: Restrict access to service_role only
-- These are internal doc-sync helpers, not user-facing APIs.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.list_public_rpcs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_public_rpcs() TO service_role;

REVOKE EXECUTE ON FUNCTION public.list_table_info() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_table_info() TO service_role;

COMMIT;
