# Open Brain — v2.0 Roadmap

> v2.0 turns Open Brain from a memory store into an intelligence layer. Smarter retrieval, entity awareness, visual interface, and structured extensions.

## Version History

| Version | Theme | Status | Shipped |
|---|---|---|---|
| v1.0 | Core Memory | Shipped | March 2026 |
| v1.5 | Memory Intelligence | Shipped | April 3, 2026 |
| v1.5.1 | Doc Sync | Shipped | April 5, 2026 |
| **v2.0** | **Knowledge Graph + Dashboard** | **In Progress** | **Target: May 2026** |

---

## v2.0 Sprints

Sprints are scoped by feature area, not calendar dates. Each sprint ships a distinct, usable increment. Work them in order since Entity Graph depends on Scoring being stable, and Dashboard depends on both.

### Sprint 1: Scoring

**Goal:** Replace pure cosine similarity with composite scoring that factors in recency and usage. Every retrieval gets smarter without changing any caller interfaces.

**Tickets:** OB-100 through OB-106 (see BACKLOG.md)

**P0 Deliverables:**
- `composite_search` RPC with tunable weights
- `match_brain` updated with `use_composite` flag
- MCP `semantic_search` defaults to composite scoring
- Normalization logic for access_count + recency

**Definition of Done:**
- Composite search returns demonstrably better results than pure similarity on 10+ test queries
- All existing MCP tools work unchanged (backward compatible)
- Score breakdown available in search results

**Ships:** Scoring RPC + updated match_brain + MCP integration

---

### Sprint 2: Entity Graph

**Goal:** Extract entity relationships from memories and expose a queryable knowledge graph. "Who is connected to what?" becomes answerable.

**Tickets:** OB-200 through OB-208 (see BACKLOG.md)

**P0 Deliverables:**
- `entity_relationships` table deployed
- Relationship extraction in hyper-worker ingest pipeline
- `get_entity_graph` + `search_entities` RPCs
- `entity_graph` MCP tool

**Definition of Done:**
- New memories automatically get relationships extracted on ingest
- Claude can query "show me everything connected to [entity]" and get useful results
- Existing ~280 memories backfilled with relationships (P1, can follow as fast-follow)

**Ships:** Schema + ingest integration + MCP tool + backfill script

---

### Sprint 3: Dashboard

**Goal:** Visual interface for memory stats, entity graph exploration, and memory health monitoring.

**Tickets:** OB-300 through OB-306 (see BACKLOG.md)

**P0 Deliverables:**
- Dashboard app scaffolded and deployed
- Memory stats page (counts, types, ingest rate, top tags)
- Interactive entity graph visualization

**Definition of Done:**
- Dashboard is live on Vercel with auth gate
- Stats page loads in <2s and reflects real-time data
- Entity graph is interactive (click to explore connections)

**Ships:** Deployed dashboard with stats + entity graph

---

### Sprint 4: Extensions

**Goal:** Establish the extension model pattern and ship the first two typed tables (sessions, decisions) that give structured access to domain-specific memory data.

**Tickets:** OB-400 through OB-405 (see BACKLOG.md)

**P0 Deliverables:**
- Extension model pattern documented
- `ob_sessions` table deployed
- Migration of existing session memories

**Definition of Done:**
- ob_sessions populated from existing session-type memories
- RPC for querying sessions with memory context
- Pattern documented well enough that adding a new extension table is a 30-minute task

**Ships:** Extension pattern + sessions table + decisions table

---

## Stretch / v2.1 Candidates

These didn't make the v2.0 cut but are worth tracking:

- Entity alias resolution / dedup (OB-208)
- Memory search + edit from dashboard (OB-305)
- MCP tool for session queries (OB-405)
- Source URL tracking (OB-503)
- Edge Function rate limiting (OB-502)
- Multi-hop graph traversal (beyond 2 hops)
- Memory aging / auto-deprecation rules
- Slack sync (direct Slack → Open Brain pipeline)
- Memory importance scoring (beyond access_count)

---

## Dependencies + Risks

**Sprint ordering matters:** Entity Graph queries benefit from composite scoring being live (better ranked results when exploring connections). Dashboard needs both scoring and entity data to be meaningful. Extensions are independent but ship last because they're lower leverage.

**OpenAI cost:** Relationship extraction adds another gpt-4o-mini call per ingest. At current volume (~5-10 memories/day) this is negligible. Backfilling 280 memories will cost ~$0.05-0.10 total.

**Dashboard stack decision:** Next.js vs SvelteKit. Recommendation: Next.js for ecosystem + Vercel deploy simplicity, unless you want SvelteKit for the lighter footprint. Decide at sprint 3 kickoff.

---

## How to Use These Docs

- **BACKLOG.md** — Source of truth for all tickets. Update status there as work progresses.
- **ROADMAP.md** — This file. High-level milestones and sprint goals. Update when scope changes.
- **SPRINT_STATUS.md** — Active sprint tracker. Move tickets in/out as the sprint progresses.
