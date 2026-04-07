# Open Brain — Feature Backlog

> Prioritized backlog for v2.0. Tickets prefixed OB-1xx for scoring, OB-2xx for relationships, OB-3xx for dashboard, OB-4xx for extensions, OB-5xx for improvements.

## Priority Legend

- **P0** — Must ship for v2.0. Core value.
- **P1** — High value, ships if capacity allows.
- **P2** — Nice to have. Can defer to v2.1+.

---

## Composite Scoring (Sprint: Scoring)

Better retrieval by blending similarity, recency, and usage signals instead of pure vector distance.

| ID | Task | Priority | Estimate | Notes |
|---|---|---|---|---|
| OB-100 | Design composite score formula + weighting config | P0 | S | similarity * 0.6 + recency * 0.2 + access_frequency * 0.2. Store weights in a config table or as function defaults so they're tunable. |
| OB-101 | Create `composite_search` RPC function | P0 | M | New RPC that computes blended score server-side. Returns results ranked by composite score. Accepts optional weight overrides. |
| OB-102 | Update `match_brain` to accept `use_composite` flag | P0 | S | Backward-compatible. Default false so existing callers are unaffected. When true, delegates to composite_search logic. |
| OB-103 | Normalize access_count + recency into 0-1 range | P0 | S | access_count: log-scale normalization. Recency: exponential decay (half-life ~30 days). Document the math. |
| OB-104 | Update MCP `semantic_search` tool to pass composite flag | P0 | S | Add optional `use_composite` param. Default true for MCP callers so Claude gets best results by default. |
| OB-105 | Benchmark composite vs pure similarity on 20 test queries | P1 | M | Compare top-5 results. Document precision/relevance improvements. Tune weights if needed. |
| OB-106 | Add score_breakdown to search results | P1 | S | Return `{ similarity, recency_score, frequency_score, composite }` so callers can see why a result ranked where it did. |

---

## Relationship Extraction (Sprint: Entity Graph)

Lightweight knowledge graph layer. Entities connected by typed relationships, extracted from memory content.

| ID | Task | Priority | Estimate | Notes |
|---|---|---|---|---|
| OB-200 | Design entity_relationships schema | P0 | S | `entity_relationships(id, entity_a, entity_b, relationship, source_memory_id, confidence, created_at)`. FK to open_brain.id. Indexes on entity_a, entity_b. |
| OB-201 | Write + deploy migration SQL | P0 | S | New table + indexes. No changes to open_brain table itself. |
| OB-202 | Create `extract_relationships` helper (gpt-4o-mini) | P0 | M | Given memory content, return array of `{entity_a, relationship, entity_b}` triples. Prompt engineering for consistent output. |
| OB-203 | Integrate relationship extraction into hyper-worker ingest | P0 | M | Run in parallel with type classification. Store results in entity_relationships table. Fail-safe: if extraction fails, memory still ingests. |
| OB-204 | Create `get_entity_graph` RPC | P0 | M | Given an entity name, return all connected entities + relationship types + hop depth (1-2 hops). |
| OB-205 | Create `search_entities` RPC | P0 | S | Fuzzy search on entity_a/entity_b. Returns distinct entities matching a query string. |
| OB-206 | Add `entity_graph` MCP tool | P0 | S | Exposes get_entity_graph to Claude. "Show me everything connected to Open Brain" |
| OB-207 | Backfill relationships from existing ~280 memories | P1 | M | Script similar to backfill-memory-types.js. Batch process, rate-limit OpenAI calls. |
| OB-208 | Dedup entity names (alias resolution) | P2 | M | "Brian" vs "Brian Snipes" vs "@brian" should resolve to same entity. Alias table or normalization function. |

---

## Dashboard (Sprint: Dashboard)

Visual interface for memory stats, entity graph, and memory health.

| ID | Task | Priority | Estimate | Notes |
|---|---|---|---|---|
| OB-300 | Scaffold dashboard app (Next.js or SvelteKit) | P0 | M | Separate repo or subfolder. Connects to Supabase directly via supabase-js. Basic auth (Supabase anon key + RLS, or simple password gate). |
| OB-301 | Memory stats page: total count, type distribution, ingest rate, top tags | P0 | M | Cards + charts. Pull from brain_stats RPC + custom aggregation queries. |
| OB-302 | Entity graph visualization | P0 | L | Interactive force-directed graph (d3-force or vis.js). Click node to see connected memories. |
| OB-303 | Memory timeline view | P1 | M | Chronological view of memories with filtering by type, tag, source. Good for spotting gaps. |
| OB-304 | Memory health indicators | P1 | S | Flag: memories with no type, no tags, no embedding, deprecated count, duplicate candidates above threshold. |
| OB-305 | Search + browse memories from dashboard | P2 | M | Full-text + semantic search from the UI. Edit/deprecate from dashboard. |
| OB-306 | Deploy to Vercel | P1 | S | Connect to Vercel for zero-config deploys. Environment vars for Supabase creds. |

---

## Extension Model (Sprint: Extensions)

Typed tables that reference open_brain for domain-specific data (sessions, projects, decisions).

| ID | Task | Priority | Estimate | Notes |
|---|---|---|---|---|
| OB-400 | Design extension model pattern | P0 | S | Convention: extension tables have `memory_id bigint REFERENCES open_brain(id)` + domain columns. Document the pattern. |
| OB-401 | Create `sessions` extension table | P0 | M | `ob_sessions(id, memory_id, session_date, duration_minutes, tools_used[], projects[], summary)`. First extension, validates the pattern. |
| OB-402 | Migrate existing session memories into ob_sessions | P1 | M | Parse session-type memories, extract structured fields, populate extension table. Keep original memory intact. |
| OB-403 | Create `decisions` extension table | P1 | S | `ob_decisions(id, memory_id, decision, alternatives[], rationale, status, revisit_date)`. |
| OB-404 | RPC for querying extension tables with memory join | P1 | S | `get_sessions(filters)`, `get_decisions(filters)` that join back to open_brain for full context. |
| OB-405 | MCP tool for session queries | P2 | S | "What did I work on last week?" queries ob_sessions directly. |

---

## Improvements + Tech Debt (No Sprint — Pick as Capacity Allows)

| ID | Task | Priority | Estimate | Notes |
|---|---|---|---|---|
| OB-500 | Add retry logic to Edge Function OpenAI calls | P1 | S | Currently no retry on 429/500. Add exponential backoff (max 3 retries). |
| OB-501 | Structured logging in Edge Function | P1 | S | JSON logs with request_id, latency per step, error context. |
| OB-502 | Rate limit the Edge Function endpoint | P2 | S | Prevent abuse. Simple token bucket or rely on Supabase's built-in rate limiting. |
| OB-503 | Add `memory_source_url` column to open_brain | P2 | S | Store the original URL (Notion page, Slack thread) for traceability. |
| OB-504 | Notion sync: handle pagination for large databases | P1 | M | Current sync doesn't paginate. Will break if Notion DB exceeds 100 pages. |
| OB-505 | MCP server health check endpoint | P2 | S | Simple `/health` that confirms Supabase connectivity. |

---

## Size Legend

- **S** — Small. A few hours or less. Single file change.
- **M** — Medium. Half-day to full day. Multiple files or moderate complexity.
- **L** — Large. Multi-day. New system or significant integration.
