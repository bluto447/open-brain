# Create Notebook — Tool Reference

## notebook_create

Creates a new NotebookLM notebook.

**Parameters:**
- `name` (string, required) — Descriptive name for the notebook

**Returns:** Notebook object with `id`, `name`, `created_at`

**Notes:**
- Names should be descriptive for later retrieval
- No duplicate name enforcement — use unique names to avoid confusion

## source_add

Adds a source to an existing notebook.

**Parameters:**
- `notebook_id` (string, required) — Target notebook ID
- `type` (string, required) — One of: `url`, `youtube`, `text`, `drive`
- `url` (string) — Required for `url` and `youtube` types
- `content` (string) — Required for `text` type
- `title` (string) — Optional display name for the source
- `file_id` (string) — Required for `drive` type

**Returns:** Source object with `id`, `type`, `title`, `status`

**Notes:**
- YouTube sources are automatically transcribed
- URL sources are fetched and parsed (may fail for paywalled content)
- Text sources should include a `title` for identification
- Large sources may take a few seconds to process

## notebook_get

Retrieves notebook details including source list.

**Parameters:**
- `notebook_id` (string, required)

**Returns:** Full notebook object with sources array

## source_list_drive

Lists Google Drive files matching a query.

**Parameters:**
- `query` (string, required) — Search query for Drive files

**Returns:** Array of Drive files with `file_id`, `name`, `mime_type`, `modified_time`

## source_sync_drive

Syncs Drive-linked sources with their latest content.

**Parameters:**
- `notebook_id` (string, required)

**Returns:** Sync status for each Drive source

**Notes:**
- Only affects sources originally added from Drive
- Useful for documents that change frequently
