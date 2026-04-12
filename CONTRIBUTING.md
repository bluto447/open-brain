# Contributing to Open Brain

## Overview

Open Brain is a personal AI-readable memory and context layer built on Supabase PostgreSQL + pgvector. Contributions are welcome.

## Stack

- **Database:** Supabase PostgreSQL 17 + pgvector
- **Embeddings:** OpenAI text-embedding-3-small (1536 dims)
- **Metadata extraction:** OpenAI gpt-4o-mini
- **Edge Functions:** Deno/TypeScript (Supabase Edge Functions)
- **MCP Server:** Node.js (mcp-config/custom-mcp-server/)
- **Sync:** Node.js (sync/notion-sync.js)

## Code Style

- **Edge Functions:** TypeScript, Deno runtime, no Node.js APIs
- **MCP Server:** JavaScript (ESM), Node.js runtime
- **SQL:** PostgreSQL 17 syntax, use RPC functions for anything called from MCP
- **Naming:** snake_case for SQL (tables, columns, functions), camelCase for JS/TS variables and functions
- **Formatting:** 2-space indentation, single quotes in JS/TS

## File Structure

```
open-brain/
├── supabase-setup.sql                     # Original schema (reference only, don't modify)
├── migrations/                            # Schema changes and RPC functions
├── supabase/functions/                    # Supabase Edge Functions (Deno)
│   ├── hyper-worker/index.ts              # Ingest pipeline
│   └── arch-snapshot/index.ts             # Live architecture snapshot
├── mcp-config/
│   ├── custom-mcp-server/                 # MCP server (8 tools)
│   └── setup-guide.md                     # Setup instructions
├── scripts/                               # One-time utility scripts
├── sync/                                  # Notion sync
└── notebooklm/                            # NotebookLM plugin
```

## Setup

1. Create a Supabase project and run `supabase-setup.sql`
2. Copy `scripts/.env.example` to `scripts/.env` and fill in your credentials
3. Deploy Edge Functions via Supabase CLI
4. See `mcp-config/setup-guide.md` for MCP server setup

## Guidelines

- Do not modify `supabase-setup.sql` (it's the original schema for reference)
- Never hard-delete data. Use `deprecate_memory` with `valid_to` instead.
- Don't change the Edge Function slug (`hyper-worker`)
- Keep npm dependencies minimal in the MCP server
- All data lives in the `open_brain` table. Don't create separate tables.

## Testing

- Test RPC functions via the Supabase SQL Editor or CLI
- Test the Edge Function via curl POST
- Test MCP tools via Claude Desktop (configure using mcp-config/)
- Validate dedup threshold with real memories (watch for false positives at 0.92)

## Git

- Commit to main branch
- Imperative mood commit messages, short first line
- Example: `Add memory mutation RPC functions`

## License

MIT
