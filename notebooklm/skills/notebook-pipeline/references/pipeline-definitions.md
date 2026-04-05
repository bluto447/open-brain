# Pipeline Definitions Reference

## ingest-and-podcast

**Purpose:** One-shot source ingestion to audio briefing.

**Parameters:**
- `type`: `"ingest-and-podcast"`
- `name` (string) — Notebook name
- `sources` (array) — Array of source objects:
  - `{ type: "url", url: "..." }`
  - `{ type: "youtube", url: "..." }`
  - `{ type: "text", content: "...", title: "..." }`
  - `{ type: "drive", file_id: "..." }`

**Internal steps:**
1. `notebook_create({ name })`
2. `source_add(...)` for each source
3. `studio_create({ type: "audio" })`
4. Poll `studio_status` until completed
5. `download_artifact` to local filesystem

**Timing:** 2-7 minutes total depending on source count and length.

## research-and-report

**Purpose:** Research a topic and produce a written report.

**Parameters:**
- `type`: `"research-and-report"`
- `name` (string) — Notebook name
- `query` (string) — Research query
- `sources` (array, optional) — Seed sources to add before research
- `research_sources` (array, optional) — Where to research: `["web"]`, `["drive"]`, or `["web", "drive"]`

**Internal steps:**
1. `notebook_create({ name })`
2. `source_add(...)` for any seed sources
3. `research_start({ query, sources: research_sources })`
4. Poll `research_status` until completed
5. `research_import` findings into notebook
6. `studio_create({ type: "reports" })`
7. Poll `studio_status` until completed
8. `download_artifact` to local filesystem

**Timing:** 3-8 minutes total.

## multi-format

**Purpose:** Generate multiple output formats from the same sources.

**Parameters:**
- `type`: `"multi-format"`
- `name` (string) — Notebook name
- `sources` (array) — Source objects
- `formats` (array of strings) — List of studio content types to generate

**Internal steps:**
1. `notebook_create({ name })`
2. `source_add(...)` for each source
3. For each format in `formats`:
   a. `studio_create({ type: format })`
   b. Poll `studio_status` until completed
   c. `download_artifact` to local filesystem

**Timing:** Varies. Each format adds 1-5 minutes. Audio and video are slowest.

**Notes:**
- Formats are generated sequentially, not in parallel
- All formats share the same source material
- File naming convention: `{notebook-name}-{format}.{ext}`

## Error Handling

- If a source fails to add, the pipeline continues with remaining sources
- If studio generation fails, report the error and offer to retry
- If research times out, offer to continue with available sources
- Pipeline failures at any step should report which step failed and what completed successfully
