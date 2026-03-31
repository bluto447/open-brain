# Open Brain — Claude Code Project Instructions

## Overview

Open Brain is a personal AI-readable memory and context layer. Supabase PostgreSQL with pgvector for vector embeddings, Edge Functions for ingestion, MCP server for Claude Desktop integration. This is the memory infrastructure for the Yonasol portfolio.

**Current milestone: v1.5 (Memory Intelligence)** — Adding memory mutation, temporal validity, memory typing, and expanded MCP tools.

## Stack

- **Database:** Supabase PostgreSQL 17 + pgvector (project: lolivmsgmwmeqqqpjszo)
- **Embeddings:** OpenAI text-embedding-3-small (1536 dims)
- **Metadata extraction:** OpenAI gpt-4o-mini
- **Edge Functions:** Deno/TypeScript (Supabase Edge Functions)
- **MCP Server:** Node.js (custom-mcp-server/)
- **Sync:** Node.js (sync/notion-sync.js)
- **Vector Index:** HNSW (cosine similarity)

## Goals

1. **#1 PRIORITY: Memory mutation.** Add update, deprecate, and merge operations so the brain resolves contradictions instead of accumulating them.
2. Add temporal validity columns (valid_from, valid_to) so we know when facts were true.
3. Add memory_type classification on ingest so retrieval can be type-aware.
4. Expand MCP server with 3 new tools (update_memory, deprecate_memory, merge_memories).
5. Backfill existing 235 memories with type classifications.

## Code Style

- **Edge Functions:** TypeScript, Deno runtime, no Node.js APIs
- **MCP Server:** JavaScript (CommonJS), Node.js runtime
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
├── migrations/
│   └── v1.5-memory-intelligence.sql   ← NEW: v1.5 schema changes
├── edge-functions/
│   ├── ingest/
│   │   └── index.ts                   ← MODIFY: add type classification + dedup
│   └── README.md
├── mcp-config/
│   ├── claude-desktop-config.json
│   ├── custom-mcp-config.json
│   ├── custom-mcp-server/
│   │   ├── index.js                   ← MODIFY: add 3 new tools
│   │   └── package.json
│   └── setup-guide.md
├── scripts/
│   └── backfill-memory-types.js       ← NEW: classify existing memories
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
- Do NOT change the existing 4 MCP tools' interfaces (add_memory, semantic_search, search_by_tag, list_recent)
- Do NOT hard-delete any data. Deprecate with valid_to, never DROP or DELETE existing memories.
- Do NOT change the Edge Function slug (hyper-worker)
- Do NOT add new npm dependencies to the MCP server unless absolutely necessary
- Do NOT create a separate database or table for v1.5 features — everything extends open_brain

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

## Resources

- [Supabase Dashboard](https://supabase.com/dashboard/project/lolivmsgmwmeqqqpjszo)
- [pgvector docs](https://github.com/pgvector/pgvector)
- [MCP Specification](https://modelcontextprotocol.io/)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- Competitive analysis: see open-brain-competitive-analysis.md
