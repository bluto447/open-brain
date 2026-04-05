# NotebookLM Plugin for Claude Code

A Cowork plugin that integrates Google's NotebookLM with Claude Code via the `notebooklm-mcp-cli` MCP server. Create notebooks, generate audio briefings, query research, run multi-step pipelines, and sync bi-directionally with Open Brain's semantic memory layer.

## Prerequisites

- **Python 3.11+** with pip or uv
- **Google account** with access to [NotebookLM](https://notebooklm.google.com)
- **Open Brain MCP** (optional, required for the open-brain-sync skill)

## Installation

### 1. Install the MCP server

```bash
pip install notebooklm-mcp-cli
```

If installing into a virtualenv, ensure the venv is activated so `notebooklm-mcp` is on your PATH. Alternatively, use `python -m notebooklm_mcp_cli` as the MCP command.

### 2. Authenticate

```bash
nlm login
```

This opens a browser for Google sign-in and stores session cookies at `~/.notebooklm-mcp-cli/`. Cookies last 2-4 weeks before needing a refresh.

### 3. Install the plugin

Copy the `notebooklm/` directory into your Claude Code plugins path, or install from the Open Brain repo.

## Skills

### create-notebook

Create notebooks and add sources (URLs, YouTube, Google Drive, text).

**Triggers:** "create a notebook", "new notebook", "add to notebooklm", "notebook from this doc"

```
> Create a notebook from these three articles: [url1], [url2], [url3]
> Push this meeting transcript to NotebookLM
```

### audio-briefing

Generate podcast-style audio overviews from notebook content.

**Triggers:** "generate audio", "make a podcast", "audio overview", "make this listenable"

```
> Generate an audio briefing from my research notebook
> Make a podcast from the project docs
```

### research-query

Query notebooks for cited answers, search across notebooks, or run web research.

**Triggers:** "query notebook", "ask notebooklm", "what does the notebook say about", "search my notebooks"

```
> What does my research notebook say about competitor pricing?
> Search across all notebooks for mentions of AI safety
```

### notebook-pipeline

Run compound multi-step workflows: ingest-and-podcast, research-and-report, multi-format.

**Triggers:** "ingest and podcast", "research and report", "run pipeline", "full notebook workflow"

```
> Ingest these docs and generate a podcast
> Research AI safety trends and produce a report
> Generate audio, slides, and a mind map from this document
```

### open-brain-sync

Bi-directional sync between Open Brain semantic memory and NotebookLM.

**Triggers:** "sync to notebook", "briefing from open brain", "push research to open brain", "notebook from my memories"

```
> Create a notebook from everything tagged "shanaki" in Open Brain
> Generate an audio digest of my last 20 memories
> Save the key findings from this notebook back to Open Brain
```

**Export (Open Brain → NotebookLM):** Query memories by tag or semantic search, format into a text source, create notebook, optionally generate audio briefing.

**Import (NotebookLM → Open Brain):** Query notebook for insights, parse into discrete findings, confirm tags with user, store as memories with `source:notebooklm` provenance tag.

## Limitations

- **Undocumented API:** NotebookLM has no official public API. This plugin uses `notebooklm-mcp-cli` which reverse-engineers the web interface via cookie-based auth.
- **Cookie expiration:** Session cookies last 2-4 weeks. Run `nlm login` to refresh when auth fails.
- **Free tier rate limits:** ~50 queries/day. Audio generation is not rate-limited but takes 1-5 minutes.
- **35 MCP tools:** The NotebookLM MCP server exposes 35 tools, which is heavy on context. Toggle with `@notebooklm-mcp` in Claude Code when not in use.
- **No offline support:** Requires active internet connection and valid Google session.

## Links

- [notebooklm-mcp-cli](https://github.com/jacob-bd/notebooklm-mcp-cli) — MCP server package (MIT, 3.3k+ stars)
- [Open Brain](https://github.com/bluto447/open-brain) — Semantic memory layer (this repo)
- [NotebookLM](https://notebooklm.google.com) — Google's notebook product
