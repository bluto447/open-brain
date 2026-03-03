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
4. **Store** — Content, embedding, and metadata are saved to Supabase PostgreSQL with pgvector
5. **Search** — Query by semantic similarity, tags, recency, or full-text via MCP or direct API

## Stack

| Component | Technology |
|---|---|
| Database | [Supabase](https://supabase.com) PostgreSQL + pgvector |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dimensions) |
| Metadata extraction | OpenAI `gpt-4o-mini` |
| Ingest API | Supabase Edge Function (Deno) |
| AI bridge | MCP server for Claude Desktop |
| Vector index | HNSW (cosine similarity) |

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
├── supabase-setup.sql              # Database schema, indexes, RPC functions
├── edge-functions/
│   ├── ingest/
│   │   └── index.ts                # Deno Edge Function — ingest pipeline
│   └── README.md                   # Edge Function docs & testing guide
├── mcp-config/
│   ├── claude-desktop-config.json  # Generic Supabase MCP config
│   ├── custom-mcp-config.json      # Custom MCP server config
│   ├── custom-mcp-server/
│   │   ├── index.js                # MCP server with semantic_search, add_memory, etc.
│   │   └── package.json            # Dependencies
│   └── setup-guide.md              # Windows 11 setup guide
├── sync/
│   ├── notion-sync.js              # Notion Session Log → Open Brain sync
│   ├── package.json                # Dependencies
│   ├── .env.example                # Environment variable template
│   └── README.md                   # Sync setup guide
├── LICENSE                         # MIT License
└── README.md                       # This file
```

## API Reference

### Ingest Endpoint

**POST** `/functions/v1/ingest`

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Text to ingest (max 100,000 chars) |
| `source` | string | No | Origin label (default: `"manual"`) |

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "content": "Your text",
    "source": "manual",
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

### RPC Functions (via Supabase client)

| Function | Description |
|---|---|
| `match_brain(query_embedding, match_threshold, match_count)` | Semantic similarity search |
| `search_by_tag(tag_name, result_limit)` | Find memories by tag |
| `list_recent(result_limit)` | Get most recent memories |
| `add_memory(content_text, source_name, metadata_obj)` | Insert without embedding |

## Roadmap

- [x] Supabase schema + pgvector
- [x] Edge Function ingest pipeline
- [x] MCP server for Claude Desktop
- [ ] Memory migration (bulk import from AI tools)
- [ ] Quick Capture templates (Slack webhook, iOS shortcut)
- [ ] Weekly Review intelligence synthesis
- [ ] Notion bi-directional sync
- [ ] Open-source release + MCP marketplace listing

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Brian Snipes](https://github.com/bluto447) as part of the [Yonasol](https://yonasol.com) portfolio.
