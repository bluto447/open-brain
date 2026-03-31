# Open Brain: Competitive Analysis & Evolution Roadmap

## The Landscape (March 2026)

The AI memory layer space has exploded. What was a niche concept when you started building Open Brain is now a recognized category with funded players, published benchmarks (LoCoMo, LongMemEval, MemoryStress), and 48k-star GitHub repos. That's both validation and pressure.

This doc breaks down what OB1 and the top competitors are doing that your Open Brain isn't yet, and what to steal, skip, or leapfrog.

---

## Your Open Brain Today

**Stack:** Supabase PostgreSQL + pgvector, Edge Functions (Deno/TS), OpenAI text-embedding-3-small for embeddings, gpt-4o-mini for metadata extraction, MCP server for Claude Desktop.

**Core capabilities:** semantic search (match_brain), tag-based search, list recent, add memory. Ingestion pipeline via Edge Function. Notion sync. 235 memories across 18 sources. HNSW index. RLS policies.

**What's working:** You're eating your own cooking. 235 memories, session logs flowing in, dual-write architecture with Notion, Gemini/Perplexity imports, YouTube history capture. The data diversity is a genuine strength most open-source memory projects don't have because their creators aren't actually using them daily.

**What's missing:** Everything below.

---

## OB1 (NateBJones) vs Your Open Brain

OB1 is architecturally similar (Supabase, Edge Functions, MCP, pgvector) but takes a fundamentally different product approach.

### Where OB1 is ahead

**Extension architecture.** OB1 ships 6 progressive extensions (household knowledge base, home maintenance, family calendar, meal planning, professional CRM, job hunt pipeline) that each teach a compounding concept. Your Open Brain is a single flat table. OB1 treats memory as domain-specific schemas that interconnect; you treat it as a universal blob store.

**Multi-user / household sharing.** OB1 implements scoped MCP servers. A "shared server" gives household members read-only access to relevant data (recipes, meal plans, shopping lists) without exposing the full system. Your Open Brain is single-user only.

**Community packaging.** OB1 has a clear folder structure separating extensions, recipes, dashboards, integrations, primitives, and skills. Each is a discrete contribution surface. Your repo is 15 files in a flat structure.

**Data interconnection.** In OB1, CRM entries are visible to the meal planner. Job hunt contacts integrate with the professional network. Data flows between extensions. Your memories are isolated vectors with tags.

### Where you're ahead

**Daily active use.** 235 memories across 18 real sources vs OB1's tutorial-oriented extensions. You have real ingestion pipelines, not just sample data.

**Ingestion diversity.** YouTube history, Gemini imports, Perplexity brain dumps, session logs, manual entries, Claude conversations. OB1 doesn't have this breadth of capture.

**MCP-first design.** Your MCP server is the primary interface. OB1 treats MCP as one integration among many.

**Dual-write architecture.** Notion as view layer, Open Brain as truth layer is a sophisticated pattern OB1 doesn't address.

### The takeaway from OB1

Steal the extension model. Not the specific extensions (you don't need meal planning), but the concept of domain-specific schemas that share a common memory substrate. Your flat open_brain table should remain the foundation, but typed extensions on top would massively increase the value of each memory.

---

## The Competitive Field

### Mem0 (48k stars, funded)

**What they have that you don't:**
- Memory deduplication and conflict resolution (ADD/UPDATE/DELETE/NOOP operations when new facts contradict old ones)
- Graph memory layer on top of vector search
- User/session/agent-level memory scoping
- Reranking pipeline for retrieval quality
- 26% accuracy improvement over OpenAI Memory on LoCoMo benchmark
- Enterprise features: SOC 2, audit logs, workspace governance
- OpenMemory MCP server with built-in dashboard

**What to steal:** The memory mutation logic. When a user says "I moved from Austin to Denver," your system just adds a new memory. Mem0 deletes the old city fact and adds the new one. This is the single biggest gap in your architecture. Without it, your brain accumulates contradictions over time.

### Zep / Graphiti (temporal knowledge graph)

**What they have that you don't:**
- Temporal knowledge graph with bi-temporal modeling (event time vs ingestion time)
- Automatic entity and relationship extraction from conversations
- Validity windows on facts (valid_from / valid_to)
- Community subgraph for high-level pattern detection
- 94.8% on DMR benchmark, up to 18.5% accuracy improvement over baselines

**What to steal:** Temporal validity windows. Adding valid_from and valid_to columns to your open_brain table is a low-effort, high-impact upgrade. It lets you answer "what was true on date X?" and naturally handles fact supersession without deleting history.

### CaviraOSS OpenMemory (cognitive memory engine)

**What they have that you don't:**
- Hierarchical memory decomposition: episodic, semantic, procedural, emotional, reflective sectors
- Composite scoring (salience + recency + coactivation, not just cosine similarity)
- Adaptive decay per memory sector instead of hard TTLs
- Temporal windows with valid_from/valid_to
- Explainable recall with "waypoint" traces showing which memory nodes activated
- Migration tools for importing from Mem0, Zep, Supermemory

**What to steal:** Memory typing/sectors. Your tags are doing some of this work, but there's no structured distinction between "Brian prefers Supabase" (semantic/preference) and "Brian deployed the Edge Function on March 5" (episodic/event). Typing memories enables smarter retrieval and decay policies.

### Letta / MemGPT (self-editing memory)

**What they have that you don't:**
- Memory blocks that agents can self-edit via tool calls
- Hierarchical memory tiers (in-context, archival, recall)
- Agent-managed memory compaction and summarization
- All state persisted in database, never lost even when evicted from context window

**What to steal:** Self-editing memory. Right now your MCP server is read-heavy. The agent can add memories but can't update, merge, or deprecate them. Giving Claude tools to edit and consolidate memories would make Open Brain self-improving.

### Khoj (YC-backed, 25k+ stars)

**What they have that you don't:**
- Full RAG pipeline over local files (PDFs, markdown, Obsidian, GitHub repos)
- Custom agent builder with scheduled automations
- Deep research mode
- Multi-LLM support (local and cloud)
- Obsidian and Notion integrations as first-class features

**What to steal:** The scheduled automation pattern. You already have n8n workflows, but Khoj builds scheduling directly into the memory layer. "Every Monday, summarize what I learned last week" as a native capability.

---

## Feature Gap Matrix

| Capability | Your OB | OB1 | Mem0 | Zep | CaviraOSS | Letta | Khoj |
|---|---|---|---|---|---|---|---|
| Vector semantic search | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Graph relationships | No | Partial | Yes | Yes | Yes | No | No |
| Memory dedup/conflict resolution | No | No | Yes | Yes | Yes | Yes | No |
| Temporal validity windows | No | No | No | Yes | Yes | No | No |
| Memory typing/sectors | Tags only | Schema-based | Scoped | Entity types | 5 sectors | Blocks | No |
| Self-editing memory (agent writes) | Add only | Add only | Full CRUD | Full CRUD | Full CRUD | Full CRUD | No |
| Multi-user / sharing | No | Yes (RLS) | Yes | Yes | Yes | Yes | No |
| Ingestion diversity | 18 sources | 6 extensions | API-driven | Conversation | Connectors | API | Files + web |
| Dashboard / UI | No | Dashboards | Yes | Yes | Yes | Yes | Yes |
| Scheduled automations | Via n8n | No | No | No | No | No | Yes |
| MCP server | Yes | Yes | Yes | No | Yes | No | No |
| Daily active use by creator | Yes | Tutorial | Enterprise | Enterprise | Rewriting | Enterprise | Cloud SaaS |

---

## Recommended Evolution Path

### V1.5: Foundation Fixes (Sprint-able now)

1. **Memory mutation operations.** Add update_memory and deprecate_memory RPC functions. When adding a new memory, run a similarity check against existing memories. If similarity > 0.92, flag for merge/update instead of blind insert. This is your biggest quality gap.

2. **Temporal columns.** Add valid_from (defaults to created_at) and valid_to (null = still true) to open_brain table. Modify match_brain to optionally filter by temporal validity. Low migration effort, massive capability unlock.

3. **Memory typing.** Add a memory_type enum column: episodic, semantic, procedural, preference, decision. Your metadata extraction pipeline (gpt-4o-mini) can classify this automatically on ingest. Enables smarter retrieval weighting.

4. **Agent write tools.** Expand MCP server beyond add_memory to include update_memory, merge_memories, deprecate_memory. Let Claude self-maintain the brain.

### V2.0: Architecture Upgrades

5. **Composite scoring.** Replace pure cosine similarity with a weighted score: similarity * 0.6 + recency * 0.2 + access_frequency * 0.2. Add an access_count column that increments on retrieval. Memories that get used stay sharp; unused ones fade.

6. **Relationship extraction.** On ingest, use gpt-4o-mini to extract entity pairs (person, project, tool, decision) and store in a lightweight edges table. You don't need a full graph database. A simple entity_a, relationship, entity_b, memory_id join table in Postgres gives you 80% of graph memory value.

7. **Dashboard.** Build a simple Next.js or SvelteKit dashboard showing memory stats, recent additions, entity graph visualization, and memory health (contradictions, staleness). OB1 ships dashboard templates you could fork.

8. **Extension model.** Create typed extension tables that reference the core open_brain table. Start with what you actually use: projects (maps to your Control Tower), sessions (already exists via session_log source), and contacts (for your CRM needs).

### V3.0: Differentiation Plays

9. **Memory health scoring.** Run a weekly cron that identifies contradictory memories (high similarity but different facts), stale memories (not accessed in 90 days), and orphan memories (no entity connections). Surface these in the dashboard as "brain maintenance" tasks.

10. **Cross-agent memory.** Your dual-write architecture (Notion + Supabase) is actually more sophisticated than most competitors realize. Formalize this into a "memory bus" pattern where Claude Code, Claude Desktop, n8n, and Cowork all read/write to the same brain with source attribution.

11. **Community recipe format.** Steal OB1's contribution model. Define a standard format for import recipes (YouTube history, Gmail, Twitter, etc.) that others can contribute. This is your real open-source moat, not the core engine.

---

## Strategic Positioning

You made the right call not going full SaaS against Mem0/Khoj. But the market has shifted. The opportunity now is:

**For developers who already use Supabase and Claude.** Not "yet another memory layer" but "the memory layer that works with the stack you already chose." Your Supabase-native approach is genuinely differentiated. Mem0 runs its own infra. Zep needs Neo4j. Khoj is a separate server. You're a SQL migration and an Edge Function away from memory.

**Position:** "Open Brain is the memory layer for your Supabase stack. Add persistent AI memory to any project with one migration and one Edge Function. No new infrastructure. No vendor lock-in. Your Postgres, your data, your brain."

That's the pitch that none of the funded players can make.

---

## Priority Stack Rank

1. Memory mutation (dedup/update) - fixes data quality rot
2. Agent write tools (MCP expansion) - enables self-improving brain
3. Temporal validity columns - low effort, high signal
4. Memory typing - automatic via existing pipeline
5. Composite scoring - retrieval quality jump
6. Lightweight relationship extraction - graph value without graph complexity
7. Dashboard - visibility and debugging
8. Extension model - domain-specific schemas
9. Community recipe format - open-source growth
10. Memory health scoring - long-term brain maintenance

---

## Sources

- [OB1 GitHub Repository](https://github.com/NateBJones-Projects/OB1)
- [Mem0 - Universal Memory Layer](https://github.com/mem0ai/mem0)
- [Mem0 Research: 26% Accuracy Boost](https://mem0.ai/research)
- [Zep: Temporal Knowledge Graph Architecture (Paper)](https://arxiv.org/abs/2501.13956)
- [Graphiti - Real-Time Knowledge Graphs](https://github.com/getzep/graphiti)
- [CaviraOSS OpenMemory](https://github.com/CaviraOSS/OpenMemory)
- [Letta - Stateful AI Agents](https://github.com/letta-ai/letta)
- [Khoj - AI Second Brain](https://github.com/khoj-ai/khoj)
- [OpenMemory MCP by Mem0](https://mem0.ai/openmemory)
- [AI Agent Memory Systems Compared (2026)](https://yogeshyadav.medium.com/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Top 10 AI Memory Products 2026](https://medium.com/@bumurzaqov2/top-10-ai-memory-products-2026-09d7900b5ab1)
- [Best AI Agent Memory Systems (Vectorize)](https://vectorize.io/articles/best-ai-agent-memory-systems)
- [Memory in the Age of AI Agents (Paper)](https://arxiv.org/abs/2512.13564)
- [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)
- [Knowledge Graph Memory MCP Server](https://www.pulsemcp.com/servers/modelcontextprotocol-knowledge-graph-memory)
