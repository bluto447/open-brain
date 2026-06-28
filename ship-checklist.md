# Ship Checklist

Run through this before pushing a release that changes schema, RPCs, MCP tools, or Edge Functions.

## Edge Function source (commit before deploy)

- [ ] Every deployed Edge Function's source is committed to `open-brain/supabase/functions/<slug>/` — deploy ≠ commit. The `edge-deploy-guard` PreToolUse hook blocks an MCP `deploy_edge_function` whose inline source isn't committed at HEAD (override `ALLOW_EDGE_DEPLOY_DRIFT=1`); `/sync-check` Phase 1c is the post-hoc audit.

## Auto-generated docs

- [ ] Run `arch-snapshot` Edge Function to get live Data Layer markdown
- [ ] Update yonasol-ops/ARCHITECTURE.md "Data Layer" section with the output (or verify pointers are still accurate)

## Cross-repo references

- [ ] **open-brain/README.md** — Update if MCP tools or RPC functions changed
- [ ] **open-brain/mcp-config/setup-guide.md** — Update if MCP tool interfaces changed
- [ ] **open-brain/CLAUDE.md** — Update file structure if new files/directories added
- [ ] **yonasol-ops/ARCHITECTURE.md "Edge Functions"** — Update if new Edge Functions deployed
- [ ] **yonasol-ops/ARCHITECTURE.md "Command Center"** — Update if Command Center routes changed

## Open Brain memory

- [ ] Log the release summary via `add_memory` MCP tool (source: claude-desktop)
