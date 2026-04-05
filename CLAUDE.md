# Open Brain — Claude Code Project Instructions

> **System architecture:** see [yonasol-ops/ARCHITECTURE.md](https://github.com/bluto447/yonasol-ops/blob/main/ARCHITECTURE.md)

## Overview

Open Brain is a personal AI-readable memory and context layer. Supabase PostgreSQL with pgvector for vector embeddings, Edge Functions for ingestion, MCP server for Claude Desktop integration. This is the memory infrastructure for the Yonasol portfolio.

**Current version: v1.5 (Memory Intelligence)** — Shipped April 3, 2026. Memory mutation, temporal validity, type classification, dedup, contradiction detection, 8 MCP tools.

**Next milestone: v2.0** — Composite scoring, relationship extraction (entity graph), dashboard.

## Stack

- **Database:** Supabase PostgreSQL 17 + pgvector (project: lolivmsgmwmeqqqpjszo)
- **Embeddings:** OpenAI text-embedding-3-small (1536 dims)
- **Metadata extraction:** OpenAI gpt-4o-mini
- **Edge Functions:** Deno/TypeScript (Supabase Edge Functions)
- **MCP Server:** Node.js (custom-mcp-server/)
- **Sync:** Node.js (sync/notion-sync.js)
- **Vector Index:** HNSW (cosine similarity)

## Goals (v2.0)

1. Composite scoring: similarity * 0.6 + recency * 0.2 + access_frequency * 0.2
2. Lightweight relationship extraction (entity_a, relationship, entity_b join table)
3. Dashboard (Next.js or SvelteKit — memory stats + entity graph visualization)
4. Extension model (typed tables referencing open_brain)

## Code Style

- **Edge Functions:** TypeScript, Deno runtime, no Node.js APIs
- **MCP Server:** JavaScript (ESM), Node.js runtime — live server at `C:\Users\brian\projects\open-brain-mcp\server.js`
- **SQL:** PostgreSQL 17 syntax, use RPC functions for anything called from MCP
- **Naming:** snake_case for SQL (tables, columns, functions), camelCase for JS/TS variables and functions
- **Formatting:** 2-space indentation, single quotes in JS/TS, no semicolons in TS Edge Functions, semicolons in JS MCP server

## File Structure

```
open-brain/
├── CLAUDE.md                          ← You are here
├── ARCHITECTURE.md
├── SPRINT_STATUS.md
├── TECH_STACK.md
├── supabase-setup.sql                 ← Original schema (reference only, don't modify)
├── ship-checklist.md                  ← Cross-repo doc update checklist
├── migrations/
│   ├── v1.5-memory-intelligence.sql       # v1.5 schema: types, temporal, mutation RPCs
│   ├── v1.5.1-contradiction-detection.sql # find_contradictions() RPC
│   └── v1.5.1-doc-sync-helpers.sql        # list_public_rpcs() + list_table_info()
├── supabase/
│   └── functions/
│       ├── hyper-worker/index.ts          # Edge Function — ingest + classify + dedup
│       └── arch-snapshot/index.ts         # Edge Function — live Data Layer markdown
├── mcp-config/
│   ├── custom-mcp-server/
│   │   ├── index.js                       # Repo copy of MCP server (5 tools, reference)
│   │   └── package.json
│   └── setup-guide.md
├── scripts/
│   ├── backfill-memory-types.js           # Classify existing memories via gpt-4o-mini
│   └── package.json
├── notebooklm/                            # Cowork plugin — NotebookLM integration
│   ├── .claude-plugin/plugin.json         # Plugin manifest
│   ├── .mcp.json                          # MCP server config (notebooklm-mcp)
│   ├── CONNECTORS.md                      # Open Brain MCP dependency docs
│   ├── README.md
│   └── skills/                            # 5 skills: create-notebook, audio-briefing,
│       ├── create-notebook/               #   research-query, notebook-pipeline,
│       ├── audio-briefing/                #   open-brain-sync
│       ├── research-query/
│       ├── notebook-pipeline/
│       └── open-brain-sync/
├── sync/
│   ├── notion-sync.js
│   ├── package.json
│   ├── .env.example
│   └── README.md
├── LICENSE
└── README.md
```

## Git Rules

- Commit to main branch
- Never auto-push. Brian pushes manually.
- Commit messages: imperative mood, short first line, body if needed
- Example: "Add memory mutation RPC functions"

## Do NOT

- Do NOT modify supabase-setup.sql (it's the original schema for reference)
- Do NOT change the existing 8 MCP tools' interfaces without good reason
- Do NOT hard-delete any data. Deprecate with valid_to, never DROP or DELETE existing memories.
- Do NOT change the Edge Function slug (hyper-worker)
- Do NOT add new npm dependencies to the MCP server unless absolutely necessary
- Do NOT create separate databases or tables — everything extends open_brain
- Do NOT edit the repo copy of the MCP server (mcp-config/custom-mcp-server/index.js) expecting it to go live — the live server is at open-brain-mcp/server.js (outside this repo)

## Key Technical Notes

- The Supabase project ID is lolivmsgmwmeqqqpjszo
- Edge Function URL: https://lolivmsgmwmeqqqpjszo.supabase.co/functions/v1/hyper-worker
- The Edge Function uses OPENAI_API_KEY stored as a Supabase secret
- JWT verification is ON for the Edge Function
- RLS is enabled on open_brain with service_role and authenticated having full access
- The metadata column is JSONB and already contains: tags (array), people (array), topics (array), sentiment, action_items
- Embeddings are 1536 dimensions (text-embedding-3-small)
- The HNSW index uses cosine similarity

## Sprint Context

See SPRINT_STATUS.md for current sprint, tickets, and progress.

## Testing

- Test RPC functions directly via Supabase SQL editor or `supabase` CLI
- Test Edge Function via curl POST to the function URL
- Test MCP tools via Claude Desktop (configure using mcp-config/)
- Validate dedup threshold with real memories (check for false positives at 0.92)

## Shipping

Before pushing a release that changes schema, RPCs, MCP tools, or Edge Functions, run through `ship-checklist.md`. Key items:
- Run `arch-snapshot` Edge Function for live Data Layer markdown
- Update cross-repo references (yonasol-ops/ARCHITECTURE.md, README, setup-guide)
- Log the release to Open Brain via `add_memory`

## Resources

- [Supabase Dashboard](https://supabase.com/dashboard/project/lolivmsgmwmeqqqpjszo)
- [pgvector docs](https://github.com/pgvector/pgvector)
- [MCP Specification](https://modelcontextprotocol.io/)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- Competitive analysis: see open-brain-competitive-analysis.md
