# Open Brain — Architecture

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                          │
│                                                         │
│  Claude Desktop ──► MCP Server (Node.js, port 3000)     │
│  Claude Code   ──► MCP Server                           │
│  Cowork        ──► MCP Server                           │
│  n8n           ──► Edge Function (REST)                  │
│  Notion Sync   ──► Edge Function (REST)                  │
└─────────────┬───────────────────────┬───────────────────┘
              │                       │
              ▼                       ▼
┌─────────────────────┐  ┌──────────────────────────────┐
│   MCP Server        │  │  Edge Function (hyper-worker) │
│   custom-mcp-server │  │  Deno/TypeScript              │
│                     │  │                              │
│  Tools:             │  │  Pipeline:                    │
│  ├─ semantic_search │  │  1. Receive text (POST)       │
│  ├─ search_by_tag   │  │  2. Embed (text-embed-3-sm)   │
│  ├─ list_recent     │  │  3. Extract metadata (4o-mini)│
│  ├─ add_memory      │  │  4. Classify type (4o-mini)   │ ◄── NEW v1.5
│  ├─ update_memory   │  │  5. Check duplicates          │ ◄── NEW v1.5
│  ├─ deprecate_memory│  │  6. Store / flag for merge    │
│  ├─ merge_memories  │  │                              │
│  └─ brain_stats     │  └──────────────┬───────────────┘
│                     │                 │
└────────┬────────────┘                 │
         │                              │
         ▼                              ▼
┌────────────────────────────────────────────────────────┐
│              SUPABASE POSTGRESQL 17                     │
│              Project: lolivmsgmwmeqqqpjszo              │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ open_brain (235 rows)                             │  │
│  │                                                    │  │
│  │ id          bigint (PK, serial)                    │  │
│  │ content     text                                   │  │
│  │ metadata    jsonb (tags, people, topics, etc.)     │  │
│  │ embedding   vector(1536) — HNSW indexed            │  │
│  │ source      text (manual, notion, slack, etc.)     │  │
│  │ memory_type text (episodic|semantic|procedural|    │  │
│  │                    preference|decision)      NEW   │  │
│  │ valid_from  timestamptz (default now())      NEW   │  │
│  │ valid_to    timestamptz (null = still true)  NEW   │  │
│  │ access_count integer (default 0)             NEW   │  │
│  │ superseded_by bigint (FK → open_brain.id)    NEW   │  │
│  │ created_at  timestamptz                            │  │
│  │ updated_at  timestamptz                            │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  RPC Functions:                                        │
│  ├─ match_brain(query_embedding, match_threshold,      │
│  │              match_count, filter_type,         NEW  │
│  │              only_valid)                       NEW  │
│  ├─ search_by_tag(tag_name)                            │
│  ├─ list_recent(n)                                     │
│  ├─ add_memory(content, metadata, embedding, source,   │
│  │             memory_type)                       NEW  │
│  ├─ update_memory(id, content, metadata)          NEW  │
│  ├─ deprecate_memory(id, reason, superseded_by)   NEW  │
│  ├─ merge_memories(ids[], merged_content)          NEW  │
│  └─ find_duplicates(embedding, threshold)          NEW  │
│                                                        │
│  Extensions: pgvector                                  │
│  Index: HNSW on embedding (cosine)                     │
│  RLS: Enabled (service_role + authenticated = full)    │
└────────────────────────────────────────────────────────┘
```

## Data Flow

### Ingest Flow (updated for v1.5)

```
Text arrives (POST /functions/v1/hyper-worker)
    │
    ├─► Embed text (OpenAI text-embedding-3-small)
    │
    ├─► Extract metadata (gpt-4o-mini)
    │   Returns: tags[], people[], topics[], sentiment, action_items
    │
    ├─► Classify memory_type (gpt-4o-mini)        ◄── NEW
    │   Returns: episodic | semantic | procedural | preference | decision
    │
    ├─► Check duplicates (find_duplicates RPC)     ◄── NEW
    │   Query: top 5 matches above 0.92 threshold
    │   Skipped entirely if ?force_insert=true query param is set
    │   │
    │   ├─ No duplicates → INSERT new memory
    │   └─ Duplicate found → Return 200 with match ID + similarity score
    │      (client decides: update existing or re-call with force_insert=true)
    │
    └─► Store in open_brain table
        Sets: valid_from = now(), valid_to = NULL, memory_type = classified
```

### Retrieval Flow (updated for v1.5)

```
Query arrives (MCP semantic_search or match_brain RPC)
    │
    ├─► Embed query text (if not already embedded)
    │
    ├─► match_brain RPC
    │   Parameters:
    │   - query_embedding (required)
    │   - match_threshold (default 0.5)
    │   - match_count (default 5)
    │   - filter_type (optional, NEW)
    │   - only_valid (default true, NEW — filters valid_to IS NULL)
    │
    ├─► Increment access_count on returned memories  ◄── NEW
    │
    └─► Return results with similarity score
```

### Mutation Flow (NEW v1.5)

```
Update: Agent calls update_memory(id, new_content, new_metadata)
    │
    ├─► Re-embed new_content
    ├─► Update content, metadata, embedding, updated_at
    └─► Return updated memory

Deprecate: Agent calls deprecate_memory(id, reason, superseded_by)
    │
    ├─► Set valid_to = now()
    ├─► Set superseded_by = superseded_by_id (if provided)
    ├─► Append deprecation reason to metadata
    └─► Return deprecated memory

Merge: Agent calls merge_memories(ids[], merged_content)
    │
    ├─► Create new memory from merged_content
    ├─► Embed + extract metadata for new memory
    ├─► Deprecate all source memories (valid_to = now(), superseded_by = new.id)
    └─► Return new merged memory
```

## Key Files

| File | Purpose |
|---|---|
| supabase-setup.sql | Original schema (reference, don't modify) |
| migrations/v1.5-memory-intelligence.sql | v1.5 ALTER statements, new RPC functions |
| migrations/v1.5.1-doc-sync-helpers.sql | list_public_rpcs() + list_table_info() helper RPCs |
| supabase/functions/hyper-worker/index.ts | Ingestion pipeline (embed, extract, classify, dedup, store) |
| supabase/functions/arch-snapshot/index.ts | GET endpoint returning live Data Layer markdown |
| mcp-config/custom-mcp-server/index.js | MCP server (8 tools after v1.5) |
| scripts/backfill-memory-types.js | One-time script to classify existing memories |
| ship-checklist.md | Cross-repo doc update checklist for releases |
| sync/notion-sync.js | Notion → Open Brain sync |

## APIs and External Services

| Service | Purpose | Cost |
|---|---|---|
| OpenAI text-embedding-3-small | Vector embeddings | ~$0.02/1M tokens |
| OpenAI gpt-4o-mini | Metadata + type extraction | ~$0.15/1M input tokens |
| Supabase (free tier) | PostgreSQL + Edge Functions | $0/mo |

## Environment Variables

### Edge Function (Supabase Secrets)

- `OPENAI_API_KEY` — OpenAI API key for embeddings + metadata extraction

### MCP Server (.env)

- `SUPABASE_URL` — https://lolivmsgmwmeqqqpjszo.supabase.co
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key for RPC calls

### Sync Scripts (.env)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NOTION_TOKEN` — Notion integration token
- `NOTION_DATABASE_ID` — Session logs database ID

## Build & Deploy

### Edge Function

```bash
supabase functions deploy hyper-worker --project-ref lolivmsgmwmeqqqpjszo
supabase functions deploy arch-snapshot --project-ref lolivmsgmwmeqqqpjszo
```

### Database Migration

```bash
# Run via Supabase SQL editor or CLI
psql -f migrations/v1.5-memory-intelligence.sql
```

### MCP Server

```bash
cd mcp-config/custom-mcp-server
npm install
# Configured via Claude Desktop config — no separate deploy
```

### Backfill Script

```bash
cd scripts
node backfill-memory-types.js
# Reads all memories, classifies via gpt-4o-mini, updates in place
```
