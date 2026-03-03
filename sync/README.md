# Open Brain — Notion Sync

Syncs your Notion **Session Log** database into the Supabase `open_brain` table.

For each session page the script:
1. Reads the **Session** (title), **What We Did**, **Decisions Made**, and **Next Steps** properties
2. Fetches the full page body (paragraph, heading, list, callout, and quote blocks)
3. Combines all text into a single content string with the session name as a header
4. Generates a vector embedding via **OpenAI text-embedding-3-small**
5. Extracts structured metadata (tags, topics, people, action_items) via **gpt-4o-mini**
6. Upserts the result into Supabase, deduplicating on the Notion page ID

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18 |
| npm | ≥ 8 |

---

## Setup

### 1. Install dependencies

```bash
cd /home/user/workspace/open-brain/sync
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Then open `.env` and set:

| Variable | Where to find it |
|---|---|
| `NOTION_TOKEN` | [notion.so/my-integrations](https://www.notion.so/my-integrations) — create an integration, then share the Session Log DB with it |
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API → service_role key |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

### 3. Share the Notion database with your integration

In Notion, open the **Session Log** database → click the `...` menu (top-right) → **Add connections** → select your integration. Without this step the API will return a 404.

### 4. Ensure the Supabase table exists

The script writes to the `open_brain` table. It expects at minimum:

```sql
create table if not exists open_brain (
  id         uuid primary key default gen_random_uuid(),
  content    text,
  embedding  vector(1536),   -- text-embedding-3-small outputs 1536 dims
  source     text,
  metadata   jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

If you already have this table from another part of the project, ensure the `embedding` column is `vector(1536)` (pgvector).

---

## Running the sync

### Incremental sync (recommended for daily use)

Only processes pages that were edited since the last successful run:

```bash
node notion-sync.js
# or
npm run sync
```

The timestamp of the last successful run is saved to `.last-sync` in this directory. On the first run (or if `.last-sync` is absent) the script fetches all pages.

### Full re-sync

Forces a re-sync of every page in the database, regardless of when it was last edited:

```bash
node notion-sync.js --full
# or
npm run sync:full
```

Use this after schema changes, if you suspect drift, or when setting up for the first time.

---

## Scheduling (optional)

To run automatically, add a cron job:

```bash
# Run incremental sync every hour
0 * * * * cd /home/user/workspace/open-brain/sync && node notion-sync.js >> sync.log 2>&1
```

Or use a process manager like **PM2**:

```bash
npm install -g pm2
pm2 start notion-sync.js --name notion-sync --cron "0 * * * *" --no-autorestart
```

---

## How deduplication works

Each Supabase row stores `metadata.notion_session_id` — set to the Notion page's unique ID (`page.id`). On every sync run the script:

1. Queries Supabase for a row matching `source = 'notion'` and `metadata->>'notion_session_id' = <page_id>`
2. If found → **updates** content, embedding, and metadata in place
3. If not found → **inserts** a new row

This means re-running the sync (even `--full`) is safe and idempotent.

---

## Output / logging

The script logs progress to stdout:

```
============================================================
  Notion → Open Brain Sync
  Mode: INCREMENTAL
  Started: 2026-03-02T20:54:00.000Z
============================================================
[Notion] Fetching pages edited after 2026-03-01T10:00:00.000Z…
[Notion] Page 1: retrieved 4 entries (total so far: 4)

[1/4]
  → Processing: "Session 2026-03-01" (abc123...)
  [INSERTED] "Session 2026-03-01"

...

============================================================
  Sync Complete
  Inserted : 3
  Updated  : 1
  Skipped  : 0
  Errored  : 0
  Finished : 2026-03-02T20:54:12.345Z
============================================================
```

Errors on individual pages are logged and skipped — the script always continues to the next entry.

---

## File structure

```
sync/
├── notion-sync.js    # Main sync script
├── package.json      # Node.js dependencies
├── .env.example      # Environment variable template
├── .env              # Your credentials (git-ignored)
├── .last-sync        # Auto-generated: timestamp of last successful run
└── README.md         # This file
```

---

## Notion database schema expected

The script reads these properties from the **Session Log** database:

| Property name | Notion type | Notes |
|---|---|---|
| Session | title | Page title — used as the content header |
| What We Did | rich_text | Summary of work done |
| Decisions Made | rich_text | Key decisions from the session |
| Next Steps | rich_text | Action items / follow-ups |

Additional text content is pulled from the page body blocks (paragraphs, headings, lists, callouts).

If a property is missing or empty it is simply omitted from the combined content — the sync won't fail.
