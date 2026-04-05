---
name: notebook-pipeline
description: This skill should be used when the user asks to "ingest and podcast", "research and report", "run pipeline", "full notebook workflow", "multi-format output", "end-to-end notebook", or wants to run compound multi-step NotebookLM workflows that chain multiple operations.
version: 0.1.0
---

# Notebook Pipeline

Run pre-built multi-step workflows that chain multiple NotebookLM operations. Pipelines automate common compound workflows like "add sources then generate audio."

## Prerequisites

- `notebooklm-mcp` server must be running
- User must have authenticated via `nlm login`

## Available Pipelines

### ingest-and-podcast
**Input:** Sources (URLs, text, Drive files)
**Steps:** Create notebook → add sources → generate audio overview
**Output:** Audio briefing file

### research-and-report
**Input:** Research query and optional seed sources
**Steps:** Create notebook → run web/Drive research → import findings → generate report
**Output:** Written report

### multi-format
**Input:** Sources + list of desired output formats
**Steps:** Create notebook → add sources → generate multiple studio outputs in sequence
**Output:** Multiple artifacts (e.g., audio + slides + mind map)

## Workflow

### 1. Identify the pipeline

Match the user's request to a pipeline. If the request doesn't fit a pre-built pipeline, compose a custom sequence using individual skills.

### 2. Execute via pipeline tool

```
pipeline({
  type: "ingest-and-podcast",
  name: "Weekly Research Digest",
  sources: [
    { type: "url", url: "https://example.com/article1" },
    { type: "url", url: "https://example.com/article2" }
  ]
})
```

For multi-format:
```
pipeline({
  type: "multi-format",
  name: "Project Alpha Overview",
  sources: [{ type: "text", content: "...", title: "Notes" }],
  formats: ["audio", "slides", "mind maps"]
})
```

### 3. Monitor progress

Pipelines run multiple steps internally. Report progress at each stage:
- "Creating notebook..."
- "Adding 3 sources..."
- "Generating audio overview (this takes 1-5 minutes)..."
- "Downloading artifact..."

### 4. Deliver results

Report all generated artifacts with file paths and offer follow-up actions.

## Key Tool

| Tool | Purpose |
|------|---------|
| `pipeline` | Execute a compound multi-step workflow |

## Custom Pipelines

If the user's request doesn't match a pre-built pipeline, compose a custom sequence by chaining tools from the other skills:

1. `notebook_create` (from create-notebook)
2. `source_add` (from create-notebook)
3. `notebook_query` or `research_start` (from research-query)
4. `studio_create` + `studio_status` + `download_artifact` (from audio-briefing)

This manual composition gives full control over each step.

## Additional Resources

- **`references/pipeline-definitions.md`** — Detailed pipeline parameters and step breakdowns
