# Import Workflow Reference (NotebookLM → Open Brain)

## Insight Extraction Patterns

### Single Notebook Query
For focused extraction from a specific notebook:
```
notebook_query({ notebook_id: "<id>", query: "List all key findings, decisions, and insights" })
```

### Cross-Notebook Synthesis
For broad extraction across all notebooks:
```
cross_notebook_query({ query: "What are the most important insights and decisions?" })
```

### Topic-Specific Extraction
For targeted extraction:
```
notebook_query({ notebook_id: "<id>", query: "What decisions were made about [topic]?" })
notebook_query({ notebook_id: "<id>", query: "What open questions remain?" })
```

## Parsing Response into Memories

Break the query response into discrete, standalone memories. Each memory should be:
- **Self-contained** — understandable without the original notebook context
- **Atomic** — one finding per memory, not a paragraph covering multiple topics
- **Actionable or informative** — facts, decisions, insights, or observations

### Example Parsing

NotebookLM response:
> "The research shows three key findings: (1) users prefer async communication by 3:1, (2) response times under 2 hours correlate with higher satisfaction, and (3) automated reminders reduce follow-up burden by 40%."

Parsed into 3 memories:
1. "Users prefer async communication over sync by a 3:1 ratio"
2. "Response times under 2 hours correlate with higher user satisfaction"
3. "Automated reminders reduce follow-up burden by 40%"

## Tag Conventions

### Required Tags
- `source:notebooklm` — provenance tracking, always include
- `notebook:<notebook-name>` — which notebook the insight came from

### Recommended Tags
- Topic tags matching the notebook's subject matter
- `type:insight`, `type:decision`, `type:finding` for classification
- Project tags if applicable

### Example
```
add_memory({
  content: "Users prefer async communication over sync by a 3:1 ratio",
  tags: ["source:notebooklm", "notebook:user-research-q1", "communication", "user-preferences", "type:finding"]
})
```

## Confirmation Step

Before writing memories to Open Brain, always present the parsed findings to the user:

```
I found 5 key insights from the "User Research Q1" notebook. Here's what I'll store in Open Brain:

1. "Users prefer async communication..." → tags: communication, user-preferences
2. "Response times under 2 hours..." → tags: response-time, satisfaction
3. ...

Confirm these, or adjust any tags/content before I save?
```

This step is mandatory — never auto-write imported memories without user confirmation.

## Deduplication

Before adding memories, consider checking for existing similar memories in Open Brain:
```
semantic_search({ query: "<finding content>" })
```

If a highly similar memory exists (similarity > 0.9), flag it to the user rather than creating a duplicate. Offer to update the existing memory or skip.
