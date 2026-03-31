# Open Brain v1.5 — Tech Stack

## Runtime

| Component | Version | Notes |
|---|---|---|
| PostgreSQL | 17.6.1 | Supabase-managed |
| pgvector | Latest (Supabase bundled) | HNSW index, cosine similarity |
| Deno | Supabase Edge Runtime | Edge Functions runtime |
| Node.js | 18+ | MCP server, sync scripts |

## Database

| Component | Details |
|---|---|
| Provider | Supabase (free tier) |
| Project ID | lolivmsgmwmeqqqpjszo |
| Region | us-east-1 |
| Engine | PostgreSQL 17 |
| Extensions | pgvector |
| Index type | HNSW (cosine) |
| Embedding dimensions | 1536 |
| RLS | Enabled (service_role + authenticated) |

## APIs

| Service | Model/Endpoint | Purpose | Cost |
|---|---|---|---|
| OpenAI | text-embedding-3-small | Vector embeddings (1536 dims) | ~$0.02/1M tokens |
| OpenAI | gpt-4o-mini | Metadata extraction + type classification | ~$0.15/1M input tokens |
| Supabase | Edge Functions | Ingest pipeline (hyper-worker) | Free tier |
| Supabase | RPC (PostgREST) | Database operations | Free tier |

## Key Libraries

### MCP Server (custom-mcp-server/)

| Package | Purpose |
|---|---|
| @supabase/supabase-js | Supabase client for RPC calls |
| @modelcontextprotocol/sdk | MCP protocol implementation |
| dotenv | Environment variable loading |

### Sync Scripts (sync/)

| Package | Purpose |
|---|---|
| @supabase/supabase-js | Supabase client |
| @notionhq/client | Notion API client |
| dotenv | Environment variable loading |

### Edge Function (edge-functions/ingest/)

No npm packages. Uses Deno standard library + fetch for OpenAI API calls.

## Development Environment

| Tool | Purpose |
|---|---|
| Supabase CLI | Edge Function deployment, local dev |
| Supabase Dashboard | SQL editor, function logs, table viewer |
| Claude Desktop | MCP server testing |
| VS Code / Claude Code | Development |

## External Services

| Service | Tier | Monthly Cost |
|---|---|---|
| Supabase | Free | $0 |
| OpenAI API | Pay-as-you-go | ~$1-3 (current usage) |
| GitHub | Free (public repo) | $0 |
| Notion | Plus | Already paid (existing) |

## Package Manager

- npm for Node.js projects (MCP server, sync scripts)
- No package manager for Edge Functions (Deno uses URL imports)
