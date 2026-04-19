# 🧠 Open Brain

**Your personal AI-readable memory and context layer.**

Open Brain is a self-hosted knowledge graph that stores your memories, notes, and context with vector embeddings for semantic search. It connects to AI clients like Claude Desktop via MCP (Model Context Protocol), giving your AI tools persistent, searchable memory across sessions.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  AI Clients     │     │  Ingest Pipeline │     │  Supabase       │
│  (Claude, etc.) │◄───►│  (Edge Function) │────►│  PostgreSQL     │
│  via MCP        │     │                  │     │  + pgvector     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │      │
                    ┌─────────┘      └─────────┐
                    ▼                          ▼
            ┌──────────────┐          ┌──────────────┐
            │ OpenAI       │          │ OpenAI       │
            │ Embeddings   │          │ gpt-4o-mini  │
            │ (1536-dim)   │          │ (metadata)   │
            └──────────────┘          └──────────────┘
```

### How it works

1. **Ingest** — Send any text to the Edge Function via POST
2. **Embed** — OpenAI `text-embedding-3-small` generates a 1536-dimensional vector
3. **Extract** — OpenAI `gpt-4o-mini` pulls structured metadata (tags, people, topics, sentiment, action items)
4. **Classify** — OpenAI `gpt-4o-mini` assigns a memory type (episodic, semantic, procedural, preference, decision)
5. **Dedup** — Checks for near-duplicate memories (cosine similarity > 0.92) before inserting
6. **Store** — Content, embedding, metadata, and type are saved to Supabase PostgreSQL with pgvector
7. **Search** — Query by semantic similarity, tags, recency, or type via MCP or direct API
8. **Mutate** — Update, deprecate, or merge memories to keep the brain accurate over time

## Stack

| Component | Technology |
|---|---|
| Database | [Supabase](https://supabase.com) PostgreSQL + pgvector |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dimensions) |
| Metadata extraction | OpenAI `gpt-4o-mini` |
| Ingest API | Supabase Edge Function (Deno) |
| AI bridge | MCP server for Claude Desktop |
| Vector index | HNSW (cosine similarity) |

## v2.0 — Composite Scoring (current)

v2.0 adds blended retrieval ranking so the most *relevant* memories surface — not just the most similar:

- **Composite scoring** — Retrieval blends three signals: `similarity * 0.60 + recency * 0.20 + frequency * 0.20`
- **Per-type recency decay** — Exponential half-life tuned by memory type: episodic 30d, procedural 90d, semantic 180d, preference/decision 365d
- **Frequency signal** — Log-scaled access count with a 0.3 floor so un-accessed memories aren't buried
- **Top-3 access bump** — Each retrieval increments `access_count` and `last_accessed_at` for the top 3 results only (reduces rich-get-richer)
- **Tunable weights** — `ob_scoring_config` singleton table lets you adjust weights and half-lives without code changes
- **Backward compatible** — `match_brain` gains a `p_use_composite` flag (default false). MCP `semantic_search` uses composite by default with a `use_composite` toggle

### v1.5 features (preserved)

- **Memory types** — Every memory is classified as `episodic`, `semantic`, `procedural`, `preference`, or `decision`
- **Temporal validity** — `valid_from` and `valid_to` columns track when facts were true
- **Mutation tools** — Update, deprecate, and merge memories via MCP (Claude can self-correct its own brain)
- **Dedup on ingest** — Near-duplicate detection prevents redundant memories (threshold: 0.92 cosine similarity)
- **Contradiction detection** — `find_contradictions()` surfaces high-similarity memory pairs for review

### MCP Tools (8 total)

| Tool | Description |
|------|-------------|
| `semantic_search` | Blended retrieval using composite scoring (v2.0). Params: `use_composite` (default true), `filter_type`, `only_valid`. Falls back to pure cosine similarity when `use_composite=false` |
| `add_memory` | Store a new memory (auto-embeds + extracts metadata) |
| `list_recent` | Get the most recent memories |
| `search_by_tag` | Find memories by tag |
| `brain_stats` | Memory count, source breakdown, top tags |
| `update_memory` | Update content + re-embed (v1.5) |
| `deprecate_memory` | Soft-delete with reason + superseded_by chain (v1.5) |
| `merge_memories` | Combine N memories into one, deprecate sources (v1.5) |

## Quick Start

### 1. Set up Supabase

Create a free project at [supabase.com](https://supabase.com), then run `supabase-setup.sql` in the SQL Editor.

### 2. Deploy the Edge Function

Add your `OPENAI_API_KEY` to Edge Function secrets, then deploy `edge-functions/ingest/index.ts` via the Supabase dashboard or CLI:

```bash
supabase functions deploy ingest --project-ref <your-project-ref>
```

### 3. Test it

```bash
curl -X POST \
  https://<your-project-ref>.supabase.co/functions/v1/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-anon-key>" \
  -d '{"content": "Your first memory goes here.", "source": "manual"}'
```

### 4. Connect Claude Desktop (optional)

See [`mcp-config/setup-guide.md`](mcp-config/setup-guide.md) for MCP server setup on Windows/Mac.

## Project Structure

```
open-brain/
├── supabase-setup.sql              # Original schema (reference only)
├── migrations/
│   ├── v1.5-memory-intelligence.sql       # v1.5 schema: types, temporal, mutation RPCs
│   ├── v1.5.1-contradiction-detection.sql # find_contradictions() RPC
│   └── v2.0-composite-scoring.sql         # v2.0: composite_search, ob_scoring_config, match_brain v2
├── edge-functions/
│   └── ingest/
│       └── index.ts                # Deno Edge Function — ingest + classify + dedup
├── mcp-config/
│   ├── custom-mcp-server/
│   │   ├── index.js                # MCP server reference copy (8 tools)
│   │   └── package.json
│   └── setup-guide.md              # Windows 11 setup guide
├── scripts/
│   ├── backfill-memory-types.js    # Classify existing memories via gpt-4o-mini
│   └── package.json
├── sync/
│   ├── notion-sync.js              # Notion Session Log → Open Brain sync
│   └── package.json
├── LICENSE
└── README.md
```

## API Reference

### Ingest Endpoint

**POST** `/functions/v1/hyper-worker`

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Text to ingest (max 100,000 chars) |
| `source` | string | No | Origin label (default: `"manual"`) |
| `memory_type` | string | No | Override auto-classification. One of: `episodic`, `semantic`, `procedural`, `preference`, `decision` |

**Query params:** `?force_insert=true` — bypass duplicate detection

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": 42,
    "content": "Your text",
    "source": "manual",
    "memory_type": "semantic",
    "embedding": [0.012, -0.034, ...],
    "metadata": {
      "tags": ["example"],
      "people": [],
      "topics": ["knowledge management"],
      "sentiment": "neutral",
      "action_items": []
    },
    "created_at": "2026-03-02T21:35:00.000Z"
  }
}
```

**Response (200 — duplicate detected):**

```json
{
  "duplicate": true,
  "existing_id": 38,
  "similarity": 0.946,
  "existing_content_preview": "Similar memory already stored...",
  "message": "A similar memory already exists. Use ?force_insert=true to insert anyway."
}
```

### RPC Functions (via Supabase client)

| Function | Description |
|---|---|
| `composite_search(query_embedding, match_count, match_threshold, p_filter_type, p_only_valid, p_weights_override)` | Blended ranking: similarity + recency decay + frequency. Bumps top-3 access stats per call (v2.0) |
| `match_brain(query_embedding, match_threshold, match_count, filter_source, p_filter_type, p_only_valid, p_use_composite)` | Semantic search — pure cosine (default) or composite via flag (v2.0) |
| `get_scoring_config()` | Returns the `ob_scoring_config` singleton row (v2.0) |
| `search_by_tag(tag_key, tag_value, result_limit)` | Find memories by metadata tag |
| `list_recent(count, filter_source)` | Get most recent memories |
| `add_memory(p_content, p_metadata, p_source, p_embedding)` | Insert a memory row |
| `update_memory(p_id, p_content, p_metadata)` | Update content + metadata (v1.5) |
| `deprecate_memory(p_id, p_reason, p_superseded_by)` | Soft-delete with reason (v1.5) |
| `merge_memories(p_ids, p_merged_content, p_source)` | Merge N memories into one (v1.5) |
| `find_duplicates(p_embedding, p_threshold, p_limit)` | Find near-duplicate memories (v1.5) |
| `find_contradictions(p_min_similarity, p_max_similarity, p_limit)` | Surface potential contradictions (v1.5) |

## Roadmap

- [x] Supabase schema + pgvector
- [x] Edge Function ingest pipeline
- [x] MCP server for Claude Desktop (4 tools)
- [x] **v1.5 Memory Intelligence** — mutation tools, temporal validity, type classification, dedup, contradiction detection (8 tools)
- [x] Memory type backfill (280 memories classified)
- [x] **v2.0 Sprint 1: Composite scoring** — blended retrieval with per-type recency decay + log-scaled frequency (deployed April 2026)
- [ ] v2.0: Relationship extraction (entity graph)
- [ ] v2.0: Dashboard (memory stats + entity graph visualization)
- [ ] Quick Capture templates (Slack webhook, iOS shortcut)
- [ ] Open-source release + MCP marketplace listing

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Brian Snipes](https://github.com/bluto447) as part of the [Yonasol](https://yonasol.com) portfolio.
