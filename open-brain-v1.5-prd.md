# Open Brain v1.5 — PRD

## Codename: Open Brain v1.5 (Memory Intelligence)

**Owner:** Brian Snipes
**Status:** Spec'd — Ready for Build
**Sprint Start:** 2026-03-31 (Monday)
**Type:** Evolution milestone on existing product
**Repo:** bluto447/open-brain

---

## 1. Problem

Open Brain works. 235 memories across 18 sources, daily active use, dual-write with Notion, MCP-first architecture. The core pipeline (ingest, embed, store, search) is solid.

But the brain is getting dumber as it grows. Three critical issues:

**Memory rot.** Every new memory is a blind insert. When Brian says "I moved EverConvert to Next.js," the old "EverConvert runs on SvelteKit" memory stays. The brain now contains contradictions it can't resolve. Mem0 solved this with ADD/UPDATE/DELETE/NOOP operations. Open Brain has ADD only.

**Flat retrieval.** Cosine similarity is the only ranking signal. A memory from 25 days ago that's been retrieved 50 times ranks the same as a memory from yesterday that's never been touched, if they have the same embedding distance. No recency weighting, no access frequency, no memory typing.

**Read-only agent.** The MCP server exposes add_memory, match_brain, search_by_tag, list_recent. Claude can search and add, but can't update, merge, or deprecate memories. The brain can't self-maintain. Every competitor (Mem0, Zep, Letta, CaviraOSS) gives agents full CRUD over memory.

## 2. Solution

Add a memory intelligence layer to Open Brain: mutation operations that resolve contradictions, temporal columns that track when facts were true, memory typing that enables smarter retrieval, and expanded MCP tools that let Claude self-maintain the brain.

One sentence: Make Open Brain's memories get better over time instead of slowly rotting.

## 3. Target User

Brian Snipes. This is infrastructure for the Yonasol portfolio. Secondary user: open-source developers running Supabase + Claude who want persistent AI memory without spinning up new infrastructure.

## 4. Success Metrics (v1.5 milestone)

| Metric | Target | Timeframe |
|---|---|---|
| Contradictory memories resolved | 0 active contradictions | End of Sprint 2 |
| MCP tools available | 7 (up from 4) | End of Sprint 1 |
| Memory types classified | 100% of new memories | End of Sprint 1 |
| Backfill typed | 80%+ of existing 235 memories | End of Sprint 2 |
| Retrieval relevance (subjective) | Noticeably better results in daily use | End of Sprint 2 |

## 5. Scope

### In Scope (v1.5)

- Memory mutation: update_memory, deprecate_memory, merge_memories RPC functions
- Similarity-based duplicate detection on ingest (threshold: 0.92)
- Temporal columns: valid_from, valid_to on open_brain table
- Memory typing: memory_type enum (episodic, semantic, procedural, preference, decision)
- Auto-classification of memory_type via gpt-4o-mini on ingest
- Expanded MCP server: update_memory, deprecate_memory, merge_memories tools
- Backfill script: classify memory_type for existing 235 memories
- Updated match_brain to support optional temporal filtering and type filtering

### Out of Scope (v2.0+)

- Graph relationships / entity extraction
- Composite scoring (recency + frequency weighting)
- Dashboard / UI
- Multi-user / sharing / RLS per-user
- Extension model (domain-specific schemas)
- Community recipe format
- Scheduled automations
- Memory health scoring cron

## 6. Technical Approach

### Architecture (current + v1.5 additions)

```
                    ┌──────────────────────┐
                    │   Claude / MCP Client │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   MCP Server (Node)   │
                    │                       │
                    │  EXISTING:            │
                    │  - semantic_search     │
                    │  - search_by_tag       │
                    │  - list_recent         │
                    │  - add_memory          │
                    │                       │
                    │  NEW (v1.5):          │
                    │  - update_memory       │
                    │  - deprecate_memory    │
                    │  - merge_memories      │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
   ┌──────────▼──┐  ┌─────────▼────┐  ┌────────▼───────┐
   │  Supabase   │  │ Edge Function │  │  RPC Functions  │
   │  PostgreSQL  │  │ (hyper-worker)│  │                │
   │  + pgvector  │  │              │  │  EXISTING:     │
   │              │  │  Ingest:     │  │  match_brain   │
   │  open_brain  │  │  1. Embed    │  │  search_by_tag │
   │  + valid_from│  │  2. Extract  │  │  list_recent   │
   │  + valid_to  │  │  3. Classify │  │  add_memory    │
   │  + mem_type  │  │  4. Dedup    │  │                │
   │              │  │  5. Store    │  │  NEW (v1.5):   │
   └──────────────┘  └──────────────┘  │  update_memory │
                                       │  deprecate_mem │
                                       │  merge_memories│
                                       │  find_dupes    │
                                       └────────────────┘
```

### Key Technical Decisions

1. **Dedup at ingest, not batch.** Run similarity check against top 5 matches when a new memory arrives. If any match > 0.92, return the match ID and flag for merge/update instead of blind insert. This adds ~200ms to ingest but prevents rot at the source. **Critical: include a `force_insert=true` query param that bypasses dedup entirely.** Existing n8n batch import workflows, Notion sync, and other automated writers must be able to skip the check to avoid breaking changes. New interactive writes (MCP, manual) use dedup by default.

2. **Temporal columns as nullable defaults.** valid_from defaults to created_at. valid_to defaults to NULL (still true). This means all 235 existing memories are automatically "currently valid" with no migration pain. Deprecating a memory just sets valid_to = now().

3. **Memory type as enum, not free text.** Five types: episodic (events/sessions), semantic (facts/knowledge), procedural (how-to/process), preference (likes/choices), decision (explicit decisions made). The gpt-4o-mini metadata extraction already runs on ingest; adding type classification is one more field in the prompt.

4. **MCP expansion via existing server.** The custom-mcp-server/index.js already handles 4 tools. Adding 3 more follows the same pattern. No new infrastructure.

## 7. Data Model Changes

### ALTER open_brain table

```sql
-- New columns
ALTER TABLE open_brain ADD COLUMN memory_type text DEFAULT 'semantic'
  CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'preference', 'decision'));
ALTER TABLE open_brain ADD COLUMN valid_from timestamptz DEFAULT now();
ALTER TABLE open_brain ADD COLUMN valid_to timestamptz DEFAULT NULL;
ALTER TABLE open_brain ADD COLUMN access_count integer DEFAULT 0;
ALTER TABLE open_brain ADD COLUMN superseded_by bigint REFERENCES open_brain(id);
```

### New RPC Functions

```
update_memory(memory_id, new_content, new_metadata)
  → Updates content/metadata, re-embeds, sets updated_at

deprecate_memory(memory_id, reason, superseded_by_id)
  → Sets valid_to = now(), links to superseding memory

merge_memories(memory_ids[], merged_content)
  → Creates new memory from merged content, deprecates originals

find_duplicates(query_embedding, threshold)
  → Returns memories above similarity threshold
```

## 8. Monetization

Not applicable for v1.5. Open Brain is infrastructure. Revenue comes through the products it powers (EverConvert, ReplyLead, etc.) and eventually through the open-source hosted tier ($15-20/mo) if the project hits the 6-month evaluation gate (200+ stars, 20+ paid users).

## 9. Competitive Positioning

"The memory layer for your Supabase stack. Add persistent AI memory to any project with one migration and one Edge Function. No new infrastructure."

v1.5 closes the gap on Mem0's memory mutation and Zep's temporal validity while maintaining the Supabase-native advantage none of them have.

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dedup threshold too aggressive (false positives) | Medium | Medium | Start at 0.92, expose as configurable param |
| gpt-4o-mini misclassifies memory type | Low | Low | Classification is additive; wrong type doesn't break search |
| Migration breaks existing MCP consumers | Low | High | All new columns are nullable with defaults; existing queries unchanged |
| Backfill script API costs | Low | Low | 235 memories * ~$0.001/embed = ~$0.24 total |

## 11. Dependencies

- Supabase project: lolivmsgmwmeqqqpjszo (ACTIVE_HEALTHY, Postgres 17)
- OpenAI API key (already configured as Supabase secret)
- Edge Function: hyper-worker (already deployed)
- MCP server: custom-mcp-server (already running)

## 12. Sprint Plan

### Sprint 1: Memory Mutation (Week of March 31)

| ID | Task | Est |
|---|---|---|
| OB-001 | Add temporal + type columns to open_brain table | 15min |
| OB-002 | Create update_memory RPC function | 30min |
| OB-003 | Create deprecate_memory RPC function | 30min |
| OB-004 | Create merge_memories RPC function | 45min |
| OB-005 | Create find_duplicates RPC function | 30min |
| OB-006 | Update Edge Function ingest to include memory_type classification | 45min |
| OB-007 | Update Edge Function ingest to run dedup check before insert | 45min |
| OB-008 | Add update_memory, deprecate_memory, merge_memories to MCP server | 1hr |
| OB-009 | Update match_brain to support type and temporal filters | 30min |
| OB-010 | Test full pipeline: ingest with dedup + type + temporal | 30min |

### Sprint 2: Backfill + Polish (Week of April 7)

| ID | Task | Est |
|---|---|---|
| OB-011 | Build backfill script: classify memory_type for 235 existing memories | 1hr |
| OB-012 | Run backfill, validate classifications | 30min |
| OB-013 | Build contradiction detection query (high similarity, different facts) | 45min |
| OB-014 | Manually review and resolve top contradictions using new tools | 1hr |
| OB-015 | Update GitHub repo README with v1.5 features | 30min |
| OB-016 | Update MCP server README with new tool docs | 30min |
| OB-017 | Push all changes to GitHub | 15min |
| OB-018 | Log v1.5 completion to Open Brain + update Notion pipeline | 15min |

## 13. Open Questions

1. Should the dedup check also run against deprecated memories (valid_to IS NOT NULL)? Leaning no for v1.5, revisit in v2.
2. Should merge_memories preserve the originals as deprecated or hard delete? Recommendation: deprecate with superseded_by link. Never delete memories.
3. Should the MCP server expose find_duplicates directly to Claude, or only use it internally during ingest? Recommendation: expose it. Let Claude proactively find and clean up dupes.
