---
name: research-query
description: This skill should be used when the user asks to "query notebook", "ask notebooklm", "what does the notebook say about", "research this", "search my notebooks", "cross-notebook query", "run research", or wants to query NotebookLM notebooks for cited answers.
version: 0.1.0
---

# Research Query

Query NotebookLM notebooks for cited answers. Supports single-notebook queries, cross-notebook search, and web/Drive research with import.

## Prerequisites

- `notebooklm-mcp` server must be running
- User must have authenticated via `nlm login`
- At least one notebook with sources must exist

## Workflow

### 1. Identify the query and scope

Determine whether the user wants to:
- **Single notebook query** — ask a specific notebook
- **Cross-notebook query** — search across multiple notebooks
- **New research** — run web/Drive research and import findings

### 2a. Single Notebook Query

List notebooks, identify the target, and query:
```
notebook_list()
notebook_query({ notebook_id: "<id>", query: "What are the key findings about X?" })
```

The response includes cited answers with source attribution. Present citations clearly — they reference specific sources within the notebook.

### 2b. Cross-Notebook Query

Search across all notebooks for broader questions:
```
cross_notebook_query({ query: "What do I know about competitor pricing?" })
```

Results include notebook name, source, and relevance. Present results grouped by notebook.

### 2c. Web/Drive Research

Start a research session to find new information:
```
research_start({ notebook_id: "<id>", query: "latest developments in AI safety", sources: ["web"] })
```

Poll for completion (research can take 30-60 seconds):
```
research_status({ research_id: "<id>" })
```

Import findings into the notebook:
```
research_import({ notebook_id: "<id>", research_id: "<id>" })
```

### 3. Present results

Format query results with:
- Clear answer text
- Source citations (which source, which section)
- Confidence indicators when available
- Offer follow-up queries or research

## Key Tools

| Tool | Purpose |
|------|---------|
| `notebook_list` | List available notebooks for selection |
| `notebook_query` | Query a single notebook with cited answers |
| `cross_notebook_query` | Search across all notebooks |
| `research_start` | Begin web/Drive research |
| `research_status` | Check research progress |
| `research_import` | Import research findings into a notebook |

## Query Tips

- Be specific in queries — "What are the three main risks?" outperforms "Tell me about risks"
- Cross-notebook queries are best for broad questions spanning multiple topics
- Research import adds new sources to the notebook, enriching future queries
- Free tier allows ~50 queries/day — be efficient with queries

## Additional Resources

- **`references/query-patterns.md`** — Effective query patterns and examples
