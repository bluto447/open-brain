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
| OB-006 | Update Edge Function: add memory_type classification to ingest | Done (code) | Classifies via gpt-4o-mini in parallel. Needs `supabase functions deploy`. |
| OB-007 | Update Edge Function: add dedup check before insert | Done (code) | Threshold 0.92, returns match if found. force_insert=true bypasses. Needs deploy. |
| OB-008 | Add update_memory, deprecate_memory, merge_memories to MCP server | Done (code) | 3 new tools in index.js. update_memory re-embeds, merge_memories re-embeds. Needs MCP restart. |
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
- OB-006: Edge Function updated with memory_type classification (needs deploy)
- OB-007: Edge Function updated with dedup check (needs deploy)
- OB-008: MCP server updated with 3 new tools (needs restart)
- OB-009: match_brain updated and deployed
- OB-010: E2E test passed (insert → update → merge → deprecate lifecycle)

---

## Sprint 2: Backfill + Polish
**Dates:** April 7 – April 13, 2026
**Goal:** Classify all existing memories, resolve contradictions, update docs, push to GitHub.

| ID | Task | Status | Notes |
|---|---|---|---|
| OB-011 | Build backfill script for memory_type classification | Not Started | scripts/backfill-memory-types.js |
| OB-012 | Run backfill, validate results | Not Started | Target: 80%+ correct classification |
| OB-013 | Build contradiction detection query | Not Started | High similarity + different content |
| OB-014 | Review and resolve top contradictions | Not Started | Use new deprecate/merge tools |
| OB-015 | Update README with v1.5 features | Not Started | New tools, type system, temporal |
| OB-016 | Update MCP server docs | Not Started | Document all 7 tools |
| OB-017 | Push to GitHub | Not Started | Brian pushes manually |
| OB-018 | Log completion to Open Brain + Notion | Not Started | Session log + pipeline update |

### Blocked

None.

### Done

(None yet — sprint hasn't started)

---

## Upcoming: v2.0 Preview

After v1.5 ships, the next evolution targets:

- Composite scoring (similarity * 0.6 + recency * 0.2 + access_frequency * 0.2)
- Lightweight relationship extraction (entity_a, relationship, entity_b join table)
- Dashboard (Next.js or SvelteKit, memory stats + entity graph)
- Extension model (typed tables referencing open_brain)
