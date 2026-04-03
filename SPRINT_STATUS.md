# Open Brain v1.5 — Sprint Status

## Sprint 1: Memory Mutation
**Dates:** March 31 – April 6, 2026
**Goal:** Ship memory mutation ops, temporal columns, type classification, and expanded MCP tools. After this sprint, Claude can update, deprecate, and merge memories.

| ID | Task | Status | Notes |
|---|---|---|---|
| OB-001 | Run v1.5 migration SQL (temporal cols, type col, access_count, superseded_by) | Done | Migration deployed to Supabase. All 235 rows backfilled. |
| OB-002 | Create update_memory RPC function | Done | Deployed. SECURITY DEFINER, does NOT re-embed. |
| OB-003 | Create deprecate_memory RPC function | Done | Deployed. Sets valid_to, appends reason to metadata. |
| OB-004 | Create merge_memories RPC function | Done | Deployed. Creates new row, deprecates sources, embedding=NULL. |
| OB-005 | Create find_duplicates RPC function | Done | Deployed. Excludes deprecated, default threshold 0.92. |
| OB-006 | Update Edge Function: add memory_type classification to ingest | Done | Deployed via Supabase MCP (v5). Classifies via gpt-4o-mini in parallel. |
| OB-007 | Update Edge Function: add dedup check before insert | Done | Deployed. Threshold 0.92, returns match if found. force_insert=true bypasses. |
| OB-008 | Add update_memory, deprecate_memory, merge_memories to MCP server | Done | 3 new tools added to open-brain-mcp/server.js (live server). All 8 tools smoke-tested. |
| OB-009 | Update match_brain RPC to support filter_type and only_valid params | Done | Deployed. DROP+CREATE, backward compatible, returns memory_type/valid_from/valid_to. |
| OB-010 | Test full pipeline end-to-end | Done | RPC lifecycle verified: insert → update → merge → deprecate. All passing. |

### Blocked

None.

### Done

- OB-001: Migration deployed to Supabase (5 new columns, backfill, 2 indexes)
- OB-002: update_memory RPC deployed
- OB-003: deprecate_memory RPC deployed
- OB-004: merge_memories RPC deployed
- OB-005: find_duplicates RPC deployed
- OB-006: Edge Function deployed with memory_type classification (v5, April 3)
- OB-007: Edge Function deployed with dedup check (v5, April 3)
- OB-008: MCP server live with 8 tools — 3 new v1.5 tools smoke-tested (April 3)
- OB-009: match_brain updated and deployed
- OB-010: E2E test passed (insert → update → merge → deprecate lifecycle)

---

## Sprint 2: Backfill + Polish
**Dates:** April 7 – April 13, 2026
**Goal:** Classify all existing memories, resolve contradictions, update docs, push to GitHub.

| ID | Task | Status | Notes |
|---|---|---|---|
| OB-011 | Build backfill script for memory_type classification | Done | scripts/backfill-memory-types.js — supports --dry-run and --ids flags. |
| OB-012 | Run backfill, validate results | Done | 280/280 classified, 0 failures. Distribution: episodic 74%, semantic 11%, procedural 9%, decision 5%, preference 1%. Episodic skew is genuine (source mix). |
| OB-013 | Build contradiction detection query | Done | find_contradictions() deployed to Supabase. Verified: returns top 10 candidate pairs in 0.85–0.92 similarity band. |
| OB-014 | Review and resolve top contradictions | Done | 20 pairs reviewed: deprecated ID 26 (→53), merged IDs 291+293 (→306). 14 Gemini series kept, 3 sequential sessions kept. |
| OB-015 | Update README with v1.5 features | Done | Added v1.5 section, 8-tool table, updated API docs, dedup response, roadmap. |
| OB-016 | Update MCP server docs | Done | setup-guide.md updated with all 8 tools + v1.5 example prompts. |
| OB-017 | Push to GitHub | Not Started | Brian pushes manually |
| OB-018 | Log completion to Open Brain + Notion | Not Started | Session log + pipeline update |

### Blocked

None.

### Done

- OB-011: Backfill script built and tested (scripts/backfill-memory-types.js)
- OB-012: Backfill run complete — 280/280 classified, 0 failures (April 3)
- OB-013: find_contradictions() deployed and verified (April 3)
- OB-014: 20 pairs reviewed — 1 deprecated, 1 merged, 18 kept (April 3)
- OB-015: README updated with v1.5 features, 8-tool table, API docs (April 3)
- OB-016: MCP setup guide updated with all 8 tools (April 3)

---

## Upcoming: v2.0 Preview

After v1.5 ships, the next evolution targets:

- Composite scoring (similarity * 0.6 + recency * 0.2 + access_frequency * 0.2)
- Lightweight relationship extraction (entity_a, relationship, entity_b join table)
- Dashboard (Next.js or SvelteKit, memory stats + entity graph)
- Extension model (typed tables referencing open_brain)
