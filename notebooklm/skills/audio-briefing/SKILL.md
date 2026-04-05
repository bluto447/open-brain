---
name: audio-briefing
description: This skill should be used when the user asks to "generate audio", "make a podcast", "audio overview", "briefing from notebook", "make this listenable", "generate a briefing", "audio digest", or wants to turn notebook content into an audio overview.
version: 0.1.0
---

# Audio Briefing

Generate audio overviews from NotebookLM notebooks. This is the killer use case — turn any document collection into a listenable podcast-style briefing.

## Prerequisites

- `notebooklm-mcp` server must be running
- User must have authenticated via `nlm login`
- Notebook must exist with at least one source (use create-notebook skill first if needed)

## Workflow

### 1. Select or create a notebook

If the user specifies a notebook by name, list notebooks and match:
```
notebook_list()
```

If no notebook exists for the content, create one first using the create-notebook workflow.

### 2. Generate audio overview

Call `studio_create` with type `audio`:
```
studio_create({ notebook_id: "<id>", type: "audio" })
```

Inform the user that audio generation takes 1-5 minutes depending on source length.

### 3. Poll for completion

Check status every 20-30 seconds. Do not poll more frequently than every 15 seconds.

```
studio_status({ notebook_id: "<id>", studio_id: "<id>" })
```

Status values:
- `pending` — Queued for generation
- `processing` — Currently generating
- `completed` — Ready to download
- `failed` — Generation failed (report error to user)

### 4. Download the artifact

Once status is `completed`, download:
```
download_artifact({ studio_id: "<id>", output_path: "<local_path>" })
```

Default to a descriptive filename in the current directory, e.g., `project-alpha-briefing.mp3`.

### 5. Confirm delivery

Report the file path and size. Offer to generate additional formats (report, slides, mind map).

## Key Tools

| Tool | Purpose |
|------|---------|
| `notebook_list` | List available notebooks |
| `studio_create` | Generate studio content (audio, video, etc.) |
| `studio_status` | Check generation progress |
| `download_artifact` | Save completed content to local filesystem |

## Timing Expectations

- Short sources (1-2 pages): ~1 minute
- Medium sources (5-10 pages): ~2-3 minutes
- Large sources (20+ pages): ~4-5 minutes
- Multi-source notebooks: varies, generally 2-5 minutes

## Other Studio Content Types

While this skill focuses on audio, `studio_create` supports all these types:
- `audio` — Podcast-style audio overview (primary)
- `video` — Video presentation
- `reports` — Written report
- `quizzes` — Interactive quiz
- `flashcards` — Study flashcards
- `mind maps` — Visual mind map
- `slides` — Slide deck
- `infographics` — Visual infographic
- `data tables` — Structured data tables

If the user requests a non-audio format, use the same workflow with the appropriate `type` parameter.

## Additional Resources

- **`references/studio-content-types.md`** — Detailed breakdown of all studio content types and their use cases
