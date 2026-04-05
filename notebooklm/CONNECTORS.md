# NotebookLM Plugin — Connectors

## Required MCP Server

### notebooklm-mcp

- **Package:** `notebooklm-mcp-cli` (pip)
- **Command:** `notebooklm-mcp` (stdio transport)
- **Auth:** Cookie-based via `nlm login` (stores at `~/.notebooklm-mcp-cli/`)
- **Repo:** [github.com/jacob-bd/notebooklm-mcp-cli](https://github.com/jacob-bd/notebooklm-mcp-cli)

All five skills depend on this MCP server for notebook operations.

## Optional MCP Server (for open-brain-sync skill)

### open-brain

The `open-brain-sync` skill calls Open Brain MCP tools for bi-directional sync. When the Open Brain MCP server is not connected, only the NotebookLM side of the sync workflow is available.

**Open Brain tools used by open-brain-sync:**

| Tool | Direction | Purpose |
|------|-----------|---------|
| `search_by_tag` | Export (OB → NLM) | Find memories by tag for notebook creation |
| `semantic_search` | Export (OB → NLM) | Find memories by semantic query |
| `list_recent` | Export (OB → NLM) | Get latest memories for digest |
| `add_memory` | Import (NLM → OB) | Store notebook insights as memories |

**Connection:** The Open Brain MCP server must be configured separately in Claude Desktop or Claude Code. See the main Open Brain repo README for setup instructions.
