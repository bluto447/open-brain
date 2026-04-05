# Export Workflow Reference (Open Brain → NotebookLM)

## Memory Query Strategies

### By Tag
Best for project-specific exports. Use `search_by_tag` with the project or topic tag:
- `search_by_tag({ tag: "shanaki" })` — all memories tagged with a project
- `search_by_tag({ tag: "meeting-notes" })` — all meeting notes

### By Semantic Query
Best for conceptual exports. Use `semantic_search` with a natural language query:
- `semantic_search({ query: "decisions about pricing strategy" })`
- `semantic_search({ query: "technical architecture choices" })`

### By Recency
Best for digest/briefing exports. Use `list_recent` with a count:
- `list_recent({ limit: 10 })` — last 10 memories
- `list_recent({ limit: 50 })` — comprehensive recent dump

### Combined
For comprehensive exports, combine multiple queries and deduplicate by memory ID.

## Formatting Template

Consolidate all memories into a single text block using this template:

```markdown
# Open Brain Export: [Topic/Tag]
Generated: [date]
Source: Open Brain semantic memory
Memory count: [N]

---

## [Memory 1 title or first line]
**Tags:** tag1, tag2, tag3
**Created:** 2026-04-01T14:30:00Z
**Type:** observation

[Full memory content]

---

## [Memory 2 title or first line]
**Tags:** tag1, tag4
**Created:** 2026-04-02T09:15:00Z
**Type:** decision

[Full memory content]

---

[... repeat for all memories]
```

## Batching Rules

- **Always batch into one source.** NotebookLM performs better with consolidated context than many fragmented sources.
- If the total text exceeds ~50,000 characters, split into 2-3 thematic sources (e.g., "Shanaki — Decisions", "Shanaki — Observations").
- Include metadata (tags, dates, types) in the formatted text — NotebookLM can reference these in queries and audio.

## Notebook Naming Convention

Use descriptive names that include the source tag and time scope:
- `Shanaki - Week of Apr 5`
- `Architecture Decisions - Q1 2026`
- `Meeting Notes - Sprint 14`
- `Open Brain Digest - April 2026`

## Audio Briefing Sub-Flow

After export, offer to generate an audio briefing. Follow the audio-briefing skill pattern:
1. `studio_create({ notebook_id, type: "audio" })`
2. Poll `studio_status` every 20-30 seconds
3. `download_artifact` when completed
4. Report file path and offer additional formats
