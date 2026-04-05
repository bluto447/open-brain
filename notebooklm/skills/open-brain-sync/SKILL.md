---
name: open-brain-sync
description: This skill should be used when the user asks to "sync to notebook", "briefing from open brain", "push research to open brain", "project audio digest", "sync open brain", "notebook from my memories", "what did I log about", "export memories to notebook", or wants bi-directional sync between Open Brain and NotebookLM.
version: 0.1.0
---

# Open Brain Sync

Bi-directional sync between Open Brain (semantic memory) and NotebookLM (content processing). Export memories to notebooks for audio briefings, or import notebook insights back as memories.

## Prerequisites

- `notebooklm-mcp` server must be running
- Open Brain MCP server must be connected (for OB tools: `search_by_tag`, `semantic_search`, `add_memory`)
- User must have authenticated NotebookLM via `nlm login`

## Mode Detection

Determine the sync direction from the user's request:

- **Export (Open Brain → NotebookLM):** "sync to notebook", "briefing from open brain", "notebook from my memories", "project audio digest"
- **Import (NotebookLM → Open Brain):** "push research to open brain", "save notebook findings", "store insights"

## Export Workflow (Open Brain → NotebookLM)

### 1. Query Open Brain for memories

Use the appropriate Open Brain MCP tool based on what the user wants:

```
search_by_tag({ tag: "shanaki" })
semantic_search({ query: "project alpha progress" })
list_recent({ limit: 20 })
```

### 2. Format memories into a structured text block

Consolidate all matching memories into a single text document. Batch memories into one source rather than creating one source per memory — NotebookLM works better with consolidated context.

Format each memory as:
```
## [Memory Title or First Line]
**Tags:** tag1, tag2
**Created:** 2026-04-01
**Type:** observation | decision | insight | ...

[Memory content]

---
```

### 3. Create notebook and add formatted source

Use tags from the query as part of the notebook name for traceability:
```
notebook_create({ name: "Shanaki - Week of Apr 5" })
source_add({ notebook_id: "<id>", type: "text", content: "<formatted_memories>", title: "Open Brain Export — shanaki" })
```

### 4. Optionally generate audio briefing

Offer to generate an audio overview. If accepted, follow the audio-briefing skill workflow:
```
studio_create({ notebook_id: "<id>", type: "audio" })
```
Then poll `studio_status` and `download_artifact` when ready.

### 5. Confirm and summarize

Report: number of memories exported, notebook name, sources added, and any generated artifacts.

## Import Workflow (NotebookLM → Open Brain)

### 1. Select notebook and extract insights

```
notebook_list()
notebook_query({ notebook_id: "<id>", query: "What are the key findings and insights?" })
```

For broader extraction, use cross-notebook query:
```
cross_notebook_query({ query: "key insights and decisions" })
```

### 2. Parse into discrete findings

Break the query response into individual findings. Each finding should be a standalone memory — a fact, insight, decision, or observation.

### 3. Confirm tags with user

Before writing to Open Brain, present the parsed findings with proposed tags and ask the user to confirm or adjust. This is a required step — do not auto-write without confirmation.

### 4. Store in Open Brain

For each confirmed finding:
```
add_memory({ content: "<finding>", tags: ["source:notebooklm", "notebook:<name>", ...user_tags] })
```

Always include `source:notebooklm` tag for provenance tracking.

### 5. Confirm what was captured

Report the number of memories created and their tags.

## Key Tools

### NotebookLM Side
| Tool | Purpose |
|------|---------|
| `notebook_create` | Create notebook for exported memories |
| `notebook_list` | List notebooks for import selection |
| `source_add` | Add formatted memories as text source |
| `notebook_query` | Extract insights from a notebook |
| `cross_notebook_query` | Search across all notebooks |
| `studio_create` | Generate audio briefing from exported memories |

### Open Brain Side
| Tool | Purpose |
|------|---------|
| `search_by_tag` | Find memories by tag for export |
| `semantic_search` | Find memories by semantic query |
| `list_recent` | Get latest memories for digest |
| `add_memory` | Store imported insights as memories |

## Additional Resources

- **`references/export-workflow.md`** — Detailed export formatting and batching patterns
- **`references/import-workflow.md`** — Import parsing and tag conventions
