# Ship Checklist

Run through this before pushing a release that changes schema, RPCs, MCP tools, or Edge Functions.

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
