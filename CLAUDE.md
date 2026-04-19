# Open Brain — Claude Code Project Instructions

> **Public repo.** Do not commit secrets, project IDs, or internal planning docs. See .gitignore for excluded files.
> **System architecture:** see [yonasol-ops/ARCHITECTURE.md](https://github.com/bluto447/yonasol-ops/blob/main/ARCHITECTURE.md)

## Overview

Open Brain is a personal AI-readable memory and context layer. Supabase PostgreSQL with pgvector for vector embeddings, Edge Functions for ingestion, MCP server for Claude Desktop integration. This is the memory infrastructure for the Yonasol portfolio.

**Current version: v1.5 (Memory Intelligence)** — Shipped April 3, 2026. Memory mutation, temporal validity, type classification, dedup, contradiction detection, 8 MCP tools.

**Next milestone: v2.0** — Composite scoring, relationship extraction (entity graph), dashboard.

## Stack

- **Database:** Supabase PostgreSQL 17 + pgvector
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
- **MCP Server:** JavaScript (ESM), Node.js runtime
- **SQL:** PostgreSQL 17 syntax, use RPC functions for anything called from MCP
- **Naming:** snake_case for SQL (tables, columns, functions), camelCase for JS/TS variables and functions
- **Formatting:** 2-space indentation, single quotes in JS/TS, no semicolons in TS Edge Functions, semicolons in JS MCP server

## File Structure

```
open-brain/
├── CLAUDE.md                          ← You are here (gitignored, local only)
├── CONTRIBUTING.md                    ← Public contributor guide
├── ARCHITECTURE.md
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
│   │   ├── index.js                       # Repo copy of MCP server (reference)
│   │   └── package.json
│   └── setup-guide.md
├── scripts/
│   ├── backfill-memory-types.js           # Classify existing memories via gpt-4o-mini
│   └── package.json
├── notebooklm/                            # Cowork plugin — NotebookLM integration
├── sync/
│   ├── notion-sync.js
│   ├── package.json
│   ├── .env.example
│   └── README.md
├── LICENSE
└── README.md
```

### Gitignored (local only, not in repo)

- `CLAUDE.md` — this file
- `SPRINT_STATUS.md`, `BACKLOG.md`, `ROADMAP.md` — sprint planning
- `TASK_BRIEF_*.md` — task briefs
- `open-brain-v1.5-prd.md` — PRD
- `open-brain-competitive-analysis.md` — competitive analysis
- `scripts/.env` — credentials
- `scripts/node_modules/` — dependencies

## Public Repo Rules

- **Never commit secrets.** All credentials live in .env files (gitignored). Use YOUR_PROJECT_REF as placeholder in docs.
- **No hardcoded Supabase project IDs** in committed files. Use placeholders or env vars.
- **Internal planning docs stay gitignored.** Sprint status, backlogs, PRDs, task briefs, competitive analysis are local only.
- **CLAUDE.md is gitignored.** This file is for Claude Code sessions only, not public.

## Git Rules

- Commit to main branch
- Never auto-push. Brian pushes manually.
- Commit messages: imperative mood, short first line, body if needed
- Example: "Add memory mutation RPC functions"
- Before committing: `git diff --cached` to verify no secrets or project IDs leak

## Do NOT

- Do NOT modify supabase-setup.sql (it's the original schema for reference)
- Do NOT change the existing 8 MCP tools' interfaces without good reason
- Do NOT hard-delete any data. Deprecate with valid_to, never DROP or DELETE existing memories.
- Do NOT change the Edge Function slug (hyper-worker)
- Do NOT add new npm dependencies to the MCP server unless absolutely necessary
- Do NOT create separate databases or tables — everything extends open_brain
- Do NOT commit .env files, API keys, or Supabase project IDs

## Key Technical Notes

- The Edge Function uses OPENAI_API_KEY stored as a Supabase secret
- JWT verification is ON for the Edge Function
- RLS is enabled on open_brain with service_role and authenticated having full access
- The metadata column is JSONB and already contains: tags (array), people (array), topics (array), sentiment, action_items
- Embeddings are 1536 dimensions (text-embedding-3-small)
- The HNSW index uses cosine similarity

## Sprint Context

See SPRINT_STATUS.md (local, gitignored) for current sprint, tickets, and progress.

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
- **Verify no secrets or project IDs in the diff** before pushing

## Resources

- [pgvector docs](https://github.com/pgvector/pgvector)
- [MCP Specification](https://modelcontextprotocol.io/)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- Competitive analysis: see open-brain-competitive-analysis.md (local, gitignored)
