# Task Brief: OB-001 through OB-005

**Sprint:** 1 — Memory Mutation
**Type:** Database migration + RPC functions
**Priority:** Critical (blocks all other v1.5 work)
**Estimated Time:** 1 Claude Code session (~2 hours)

## Objective

Run the v1.5 database migration and create 4 new RPC functions that give Open Brain the ability to update, deprecate, merge, and deduplicate memories. After this task, the database layer is complete for v1.5.

## Acceptance Criteria

1. open_brain table has 5 new columns: memory_type (text, enum-checked), valid_from (timestamptz, defaults to now()), valid_to (timestamptz, nullable), access_count (integer, default 0), superseded_by (bigint, FK to open_brain.id)
2. All 235 existing memories have valid_from = their original created_at (not now()), valid_to = NULL, memory_type = 'semantic' (default, will be backfilled later), access_count = 0
3. update_memory(p_id bigint, p_content text, p_metadata jsonb) RPC function exists and: updates content, metadata, updated_at; does NOT re-embed (embedding update handled by caller/Edge Function); returns the updated row
4. deprecate_memory(p_id bigint, p_reason text, p_superseded_by bigint DEFAULT NULL) RPC function exists and: sets valid_to = now(); sets superseded_by if provided; appends deprecation reason to metadata->'deprecation_reason'; returns the deprecated row
5. merge_memories(p_ids bigint[], p_merged_content text, p_source text DEFAULT 'merge') RPC function exists and: inserts a new memory with p_merged_content (embedding = NULL, to be filled by Edge Function); deprecates all memories in p_ids with superseded_by = new memory id; returns the new memory row
6. find_duplicates(p_embedding vector(1536), p_threshold float DEFAULT 0.92, p_limit int DEFAULT 5) RPC function exists and: returns id, content, similarity score for matches above threshold; excludes deprecated memories (valid_to IS NOT NULL); ordered by similarity descending
7. match_brain is updated to accept optional p_filter_type text and p_only_valid boolean (default true); when p_only_valid = true, excludes memories where valid_to IS NOT NULL; when p_filter_type is provided, filters by memory_type
8. Existing match_brain calls with no new params work identically to before (backward compatible)
9. All functions have SECURITY DEFINER and appropriate search_path set
10. Migration file is saved as migrations/v1.5-memory-intelligence.sql
11. Migration runs clean on the live database (no errors)
12. Quick smoke test: insert a test memory, find its duplicate, update it, deprecate it — all via SQL

## What NOT to Do

- Do NOT modify supabase-setup.sql
- Do NOT drop or recreate the open_brain table
- Do NOT change existing RPC function signatures (match_brain's new params must be optional with defaults)
- Do NOT run any DELETE operations on existing data
- Do NOT create new tables (all changes are to open_brain + new functions)
- Do NOT handle embedding generation in the RPC functions (that's the Edge Function's job in OB-006/007)
- Do NOT break the Edge Function's external API contract (POST body shape, 2xx response)

## Context Files to Read First

1. CLAUDE.md — Project rules and conventions
2. ARCHITECTURE.md — System diagram and data flow
3. supabase-setup.sql — Current schema, understand existing RPC signatures
4. edge-functions/ingest/index.ts — Understand current ingest pipeline

## Definition of Done

- Migration SQL file exists at migrations/v1.5-memory-intelligence.sql
- Migration has been run on Supabase project lolivmsgmwmeqqqpjszo
- All 5 new columns exist on open_brain with correct types and defaults
- All 4 new RPC functions are callable
- match_brain works with and without new optional params
- Existing 235 memories are unmodified (valid_from = created_at, valid_to = NULL)
- Smoke test passes: full lifecycle (insert → find_duplicates → update → deprecate)

## Downstream Dependency Notes

**Active consumers of Open Brain that must not break:**

1. **MCP Server (Cowork + Claude Desktop)** — Calls match_brain, search_by_tag, list_recent, add_memory, brain_stats. All existing signatures must remain backward compatible. New params on match_brain must be optional with defaults that reproduce current behavior.

2. **Edge Function (hyper-worker)** — POST endpoint used by n8n workflows (YouTube history, session debriefs, Perplexity imports, Gemini imports), Notion sync script, and manual ingestion. The external API contract (POST body shape, 2xx response) must not change in this task. Edge Function modifications happen in OB-006/007.

3. **n8n Workflows** — Multiple workflows POST to hyper-worker. When OB-006/007 adds dedup to the Edge Function, the response shape changes for duplicates. To handle this safely: add a `force_insert=true` query param that bypasses the dedup check entirely. Batch import workflows should use this flag so existing flows don't break. Document this in the Edge Function README.

4. **Session Logging Skill (Cowork)** — Writes to both the `sessions` table and `open_brain` via MCP add_memory. No changes needed; add_memory signature is unchanged.

5. **Notion Sync Script** — Calls the Edge Function. Same contract protection as n8n workflows above.

**Validation step:** After running the migration, confirm all 4 existing RPC functions return identical results to pre-migration by running: `SELECT * FROM match_brain('<any existing embedding>', 0.5, 5)` and comparing output.

## SQL Reference: Migration Structure

```sql
-- 1. Add columns
ALTER TABLE open_brain ADD COLUMN memory_type text DEFAULT 'semantic'
  CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'preference', 'decision'));
ALTER TABLE open_brain ADD COLUMN valid_from timestamptz;
ALTER TABLE open_brain ADD COLUMN valid_to timestamptz;
ALTER TABLE open_brain ADD COLUMN access_count integer DEFAULT 0;
ALTER TABLE open_brain ADD COLUMN superseded_by bigint REFERENCES open_brain(id);

-- 2. Backfill valid_from from created_at
UPDATE open_brain SET valid_from = created_at WHERE valid_from IS NULL;

-- 3. Set default for future inserts
ALTER TABLE open_brain ALTER COLUMN valid_from SET DEFAULT now();

-- 4. Create RPC functions (see ARCHITECTURE.md for signatures)

-- 5. Update match_brain (DROP + CREATE OR REPLACE with new optional params)
```
