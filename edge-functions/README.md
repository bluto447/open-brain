# Open Brain — Edge Functions

This directory contains Supabase Edge Functions for the Open Brain ingestion pipeline.

---

## Functions

### `ingest`

Receives a piece of text, runs it through OpenAI to generate a vector embedding and extract structured metadata, then persists everything to the `open_brain` Supabase table.

**Pipeline:**
1. `text-embedding-3-small` → 1536-dim vector embedding
2. `gpt-4o-mini` → JSON metadata (tags, people, topics, sentiment, action items)
3. Supabase insert into `open_brain` table

---

## Prerequisites

### 1. Supabase table

Run this migration in your Supabase SQL editor before deploying:

```sql
-- Enable the pgvector extension if not already enabled
create extension if not exists vector;

-- Create the open_brain table
create table if not exists open_brain (
  id          uuid primary key default gen_random_uuid(),
  content     text not null,
  source      text not null default 'manual',
  embedding   vector(1536),
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- Optional: index for fast vector similarity search
create index on open_brain using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

### 2. Supabase CLI

Install the [Supabase CLI](https://supabase.com/docs/guides/cli) if you haven't already:

```bash
npm install -g supabase
```

---

## Environment Variables

| Variable | Description | Where to set |
|---|---|---|
| `OPENAI_API_KEY` | Your OpenAI secret key | Supabase dashboard → Project Settings → Edge Functions → Secrets |
| `SUPABASE_URL` | Your project URL | **Auto-injected** by Supabase at runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for server-side DB writes | **Auto-injected** by Supabase at runtime |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically available inside every Edge Function — you only need to manually set `OPENAI_API_KEY`.

### Setting the OpenAI key via CLI

```bash
supabase secrets set OPENAI_API_KEY=sk-...your-key-here...
```

Or add it in the Supabase dashboard under **Project Settings → Edge Functions → Secrets**.

---

## Deployment

### 1. Link your project (first time only)

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

Find your project ref in the Supabase dashboard URL:
`https://supabase.com/dashboard/project/<your-project-ref>`

### 2. Deploy the function

From the repository root:

```bash
supabase functions deploy ingest --project-ref <your-project-ref>
```

Or deploy from inside the `edge-functions` directory:

```bash
cd open-brain/edge-functions
supabase functions deploy ingest --project-ref <your-project-ref>
```

### 3. Verify deployment

```bash
supabase functions list
```

---

## Testing with curl

Replace `<your-project-ref>` and `<your-anon-key>` with your actual values.
Your anon key is in **Project Settings → API → Project API keys**.

### Basic ingest

```bash
curl -X POST \
  https://<your-project-ref>.supabase.co/functions/v1/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-anon-key>" \
  -d '{
    "content": "Met with Sarah today to discuss the Q2 roadmap. We need to finalize the feature list by Friday and schedule a follow-up with the engineering team.",
    "source": "meeting-notes"
  }'
```

### Minimal request (source defaults to "manual")

```bash
curl -X POST \
  https://<your-project-ref>.supabase.co/functions/v1/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-anon-key>" \
  -d '{"content": "Remember to review the open-brain pull request before EOD."}'
```

### Local development

Start the function locally with:

```bash
supabase functions serve ingest --env-file .env.local
```

Create a `.env.local` file in the project root:

```
OPENAI_API_KEY=sk-...
```

Then test against localhost:

```bash
curl -X POST \
  http://localhost:54321/functions/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"content": "Test note for local development."}'
```

---

## Request Format

**Method:** `POST`  
**Content-Type:** `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | `string` | Yes | The text content to ingest. Max 100,000 characters. |
| `source` | `string` | No | Origin label (e.g. `"meeting-notes"`, `"slack"`, `"email"`). Defaults to `"manual"`. |

```json
{
  "content": "Your text content here",
  "source": "meeting-notes"
}
```

---

## Response Format

### Success — `201 Created`

```json
{
  "success": true,
  "data": {
    "id": "3f7a1c2e-84b0-4d9f-a123-000000000000",
    "content": "Your text content here",
    "source": "meeting-notes",
    "embedding": [0.012, -0.034, ...],
    "metadata": {
      "tags": ["roadmap", "Q2", "planning"],
      "people": ["Sarah"],
      "topics": ["product roadmap", "project management"],
      "sentiment": "positive",
      "action_items": [
        "Finalize the feature list by Friday",
        "Schedule a follow-up with the engineering team"
      ]
    },
    "created_at": "2026-03-02T20:52:00.000Z"
  }
}
```

### Error — `400 Bad Request`

```json
{
  "error": "Missing or invalid 'content' field. Must be a non-empty string."
}
```

### Error — `500 Internal Server Error`

```json
{
  "error": "Failed to process content with AI.",
  "detail": "OpenAI embeddings error (401): Incorrect API key provided"
}
```

---

## Error Reference

| HTTP Status | Cause |
|---|---|
| `400` | Missing `content`, empty string, content over 100k chars, or malformed JSON body |
| `405` | Non-POST request method |
| `500` | Missing env vars, OpenAI API failure, or Supabase insert failure |

---

## CORS

The function includes CORS headers that allow requests from any origin (`*`), making it safe to call from browser-based clients. Preflight `OPTIONS` requests are handled automatically.
