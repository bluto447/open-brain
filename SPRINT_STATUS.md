# Sprint Status — Open Brain

## Sprint 1 — Memory Mutation (Complete)
**Goal:** Ship memory mutation ops, temporal columns, type classification, and expanded MCP tools so Claude can update, deprecate, and merge memories

| ID | Task | Status | Notes |
|----|------|--------|-------|
| OB-001 | Run v1.5 migration SQL (temporal cols, type col, access_count, superseded_by) | Done | All 235 rows backfilled |
| OB-002 | Create update_memory RPC function | Done | SECURITY DEFINER, does NOT re-embed |
| OB-003 | Create deprecate_memory RPC function | Done | Sets valid_to, appends reason to metadata |
| OB-004 | Create merge_memories RPC function | Done | Creates new row, deprecates sources, embedding=NULL |
| OB-005 | Create find_duplicates RPC function | Done | Excludes deprecated, default threshold 0.92 |
| OB-006 | Update Edge Function: add memory_type classification to ingest | Done | gpt-4o-mini classification in parallel |
| OB-007 | Update Edge Function: add dedup check before insert | Done | Threshold 0.92, force_insert=true bypasses |
| OB-008 | Add update_memory, deprecate_memory, merge_memories to MCP server | Done | All 8 tools smoke-tested |
| OB-009 | Update match_brain RPC with filter_type and only_valid params | Done | Backward compatible |
| OB-010 | Test full pipeline end-to-end | Done | insert → update → merge → deprecate lifecycle verified |

---

## Sprint 2 — Backfill + Polish (Complete)
**Goal:** Classify all existing memories, resolve contradictions, update docs

| ID | Task | Status | Notes |
|----|------|--------|-------|
| OB-011 | Build backfill script for memory_type classification | Done | scripts/backfill-memory-types.js. --dry-run and --ids flags |
| OB-012 | Run backfill, validate results | Done | 280/280 classified, 0 failures. Distribution: episodic 74%, semantic 11%, procedural 9%, decision 5%, preference 1% |
| OB-013 | Build contradiction detection query (find_contradictions RPC) | Done | Top 10 candidate pairs in 0.85-0.92 similarity band |
| OB-014 | Review and resolve top contradictions | Done | 20 pairs reviewed: 1 deprecated, 1 merged, 18 kept |
| OB-015 | Update README with v1.5 features | Done | 8-tool table, API docs, dedup response, roadmap |
| OB-016 | Update MCP server docs | Done | setup-guide.md with all 8 tools + example prompts |
| OB-017 | Push to GitHub | Done | 3 commits to main |
| OB-018 | Log completion to Open Brain + Notion | Done | Memory #351 |

---

## Sprint 3 — Doc-Sync (Complete)
**Goal:** Ensure architecture docs stay current with automated introspection

| ID | Task | Status | Notes |
|----|------|--------|-------|
| OB-019 | Create list_public_rpcs() + list_table_info() RPCs | Done | SECURITY DEFINER, service_role only |
| OB-020 | Build arch-snapshot Edge Function | Done | Dynamic table discovery, exact-match extension filter |
| OB-021 | Create ship-checklist.md | Done | Cross-repo doc update checklist |
| OB-022 | Update yonasol-ops/ARCHITECTURE.md with pointers | Done | Removed hardcoded row counts, added authoritative source notes |
| OB-023 | Update CLAUDE.md + ARCHITECTURE.md | Done | Added Shipping section, updated file structure |

---

## Sprint 4 — Composite Scoring (Not Started)
**Goal:** Replace pure cosine similarity with composite scoring so every retrieval gets smarter

| ID | Task | Status | Notes |
|----|------|--------|-------|
| OB-100 | Design composite score formula + weighting config | Pending | similarity*0.6 + recency*0.2 + access_frequency*0.2. Tunable weights |
| OB-101 | Create composite_search RPC function | Pending | Blended score, accepts optional weight overrides |
| OB-102 | Update match_brain to accept use_composite flag | Pending | Backward-compatible. Default false |
| OB-103 | Normalize access_count + recency into 0-1 range | Pending | Log-scale for access, exponential decay for recency |
| OB-104 | Update MCP semantic_search tool to pass composite flag | Pending | Default true for MCP callers |
| OB-105 | Benchmark composite vs pure similarity on 20 test queries | Pending | Compare top-5 results, tune weights |
| OB-106 | Add score_breakdown to search results | Pending | Return component scores alongside composite |

---

## Future: Sprint 5 — Entity Graph
| ID | Task | Notes |
|----|------|-------|
| OB-107 | Design entity extraction pipeline (people, projects, tools, decisions) | |
| OB-108 | Create entities table + relationship edges | |
| OB-109 | Extract entities from existing 280+ memories | |
| OB-110 | Graph-aware retrieval (follow relationships during search) | |

## Future: Sprint 6 — Dashboard
| ID | Task | Notes |
|----|------|-------|
| OB-111 | Web UI for browsing, searching, and managing memories | |
| OB-112 | Memory timeline visualization | |
| OB-113 | Type distribution + health metrics | |
| OB-114 | Manual edit/deprecate/merge from UI | |

## Future: Sprint 7 — Extensions
| ID | Task | Notes |
|----|------|-------|
| OB-115 | Multi-user scoping (per-user memory isolation) | |
| OB-116 | Pagination for large result sets | Per ADR, needs fix |
| OB-117 | Memory import/export (JSON) | |
| OB-118 | Webhook triggers on memory changes | |
