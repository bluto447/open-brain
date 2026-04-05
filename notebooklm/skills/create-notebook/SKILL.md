---
name: create-notebook
description: This skill should be used when the user asks to "create a notebook", "new notebook", "add to notebooklm", "push this to notebook", "notebook from this doc", "add sources to notebook", or wants to create a NotebookLM notebook from documents, URLs, YouTube links, or text.
version: 0.1.0
---

# Create Notebook

Create NotebookLM notebooks and populate them with sources. Supports documents, URLs, YouTube links, Google Drive files, and raw text as source material.

## Prerequisites

- `notebooklm-mcp` server must be running (installed via `pip install notebooklm-mcp-cli`)
- User must have authenticated via `nlm login` (cookie auth, lasts 2-4 weeks)

## Workflow

### 1. Determine source material

Identify what the user wants to add. Supported source types:
- **URL** — web page, article, blog post
- **YouTube** — video link (NotebookLM transcribes automatically)
- **Google Drive** — file from user's Drive
- **Text** — raw text or pasted content
- **Local file** — read file content, pass as text source

### 2. Create the notebook

Call `notebook_create` with a descriptive title. Use the source material's topic or the user's description as the name.

```
notebook_create({ name: "Project Alpha — Research Notes" })
```

### 3. Add sources

Call `source_add` for each source. Batch multiple sources in sequence — do not wait for user confirmation between each one unless there is ambiguity about what to add.

```
source_add({ notebook_id: "<id>", type: "url", url: "https://example.com/article" })
source_add({ notebook_id: "<id>", type: "youtube", url: "https://youtube.com/watch?v=..." })
source_add({ notebook_id: "<id>", type: "text", content: "<pasted content>", title: "Meeting Notes" })
```

For Google Drive sources, first list available files:
```
source_list_drive({ query: "project alpha" })
```
Then add the selected file:
```
source_add({ notebook_id: "<id>", type: "drive", file_id: "<drive_file_id>" })
```

### 4. Confirm and offer next steps

After adding sources:
1. Call `notebook_get` to confirm the notebook state
2. Report what was added (source count, types)
3. Offer to generate studio content (audio briefing, report, etc.)

## Key Tools

| Tool | Purpose |
|------|---------|
| `notebook_create` | Create a new notebook |
| `source_add` | Add a source to a notebook |
| `notebook_get` | Get notebook details and source list |
| `source_list_drive` | List Google Drive files for selection |
| `source_sync_drive` | Sync Drive sources with latest content |

## Tips

- Use descriptive notebook names — they help with later retrieval via `notebook_list`
- When adding multiple URLs, batch them without pausing for confirmation
- For large text sources, include a meaningful `title` parameter so the source is identifiable
- If a source fails to add, report the error and continue with remaining sources
- Google Drive sync (`source_sync_drive`) updates existing Drive sources with latest content — useful for living documents

## Additional Resources

- **`references/tool-reference.md`** — Detailed tool parameters and response formats
