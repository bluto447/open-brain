-- ============================================================
-- v2.0.4 — close anon leak via the product_pulse_priority view
--
-- 2026-06-15, continuing the anon sweep: the BASE-table sweep (v2.0.3) missed
-- views. A views+matviews pass plus the get_advisors `security_definer_view`
-- ERROR found `public.product_pulse_priority` readable by anon — 7 rows of
-- per-product BUSINESS-SENSITIVE data: stripe_mrr_cents, stripe_active_subs,
-- stripe_last_payment_at, stripe_product_id, internal blockers/next_action,
-- vercel + github project details.
--
-- Why a base-table-locked source still leaked: the view is owned by `postgres`
-- and was created WITHOUT security_invoker, so it runs with the VIEW OWNER's
-- privileges and bypasses the querying role's RLS. The base table
-- `product_pulse` IS correctly locked (RLS on, no anon-permissive policy — anon
-- reads 0 rows directly), but anon held SELECT on the view and the definer view
-- read straight past that protection.
--
-- Fix:
--   1. Revoke the view grant from anon/PUBLIC (the immediate close).
--   2. GRANT SELECT to the roles that legitimately need the dashboard
--      (authenticated = Command Center, service_role = automation).
--   3. Flip the view to security_invoker so it honors the caller's RLS on
--      product_pulse from now on — even if a grant is re-added by accident,
--      anon (no base-table access) gets 0 rows. Defense in depth.
--
-- Idempotent: REVOKE/GRANT and ALTER VIEW SET are safe to re-run.
-- ============================================================

BEGIN;

-- View-level: close anon, grant the legitimate dashboard readers.
REVOKE ALL ON public.product_pulse_priority FROM anon, PUBLIC;
GRANT  SELECT ON public.product_pulse_priority TO authenticated, service_role;

-- Flip to invoker so the view honors the caller's RLS on product_pulse.
ALTER VIEW public.product_pulse_priority SET (security_invoker = true);

-- Under security_invoker the caller needs the BASE-table grant too (Codex P1).
-- Live check 2026-06-15 confirmed authenticated + service_role already hold it
-- (and service_role has BYPASSRLS), so this is a no-op on prod — included so a
-- clean rebuild from migrations cannot silently break the dashboard. anon is
-- deliberately NOT granted: the base table has no anon-permissive policy, so an
-- invoker read by anon returns 0 rows even if it somehow reached the base table.
GRANT SELECT ON public.product_pulse TO authenticated, service_role;

COMMIT;

-- ── Smoke tests (run manually) ──────────────────────────────
-- 1. anon can no longer read the view (grant gone AND invoker RLS):
--    SET LOCAL ROLE anon; SELECT count(*) FROM product_pulse_priority;  -- ERROR: permission denied
--    SELECT has_table_privilege('anon','public.product_pulse_priority','SELECT');  -- f
-- 2. invoker flag is set:
--    SELECT reloptions FROM pg_class WHERE relname='product_pulse_priority';  -- {security_invoker=true}
-- 3. authenticated (Command Center) still reads the dashboard — REQUIRES that
--    authenticated retains SELECT on the base product_pulse + its "Allow
--    authenticated read" policy (verified present 2026-06-15):
--    SET LOCAL ROLE authenticated; SELECT count(*) FROM product_pulse_priority;  -- 7 (works)
