# Open Brain — MCP Setup Guide for Claude Desktop on Windows 11

This guide walks you through connecting Claude Desktop to your Open Brain Supabase backend using the Model Context Protocol (MCP). You have two options depending on how much capability you need:

| Option | Best for | What you get |
|---|---|---|
| **Option A — Generic Supabase MCP** | Quick start, SQL access | Full SQL access to your database via natural language |
| **Option B — Custom MCP Server** | Full Open Brain integration | Semantic search, memory ingestion, tag search |

Start with Option A to verify the connection is working, then move to Option B for the full experience.

---

## Prerequisites

### 1. Install Node.js

The MCP servers run via Node.js (npx / node). You need Node.js 18 or later.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** installer for Windows.
2. Run the installer, accepting all defaults (make sure "Add to PATH" is checked).
3. Open a new Command Prompt and verify:

```
node -v
```

You should see something like `v20.11.0`. If you get `'node' is not recognized`, restart your computer and try again — the PATH update sometimes requires a reboot.

4. Verify npx is also available:

```
npx -v
```

---

## Option A — Generic Supabase MCP (Quick Start)

This uses the official `@supabase/mcp-server-supabase` package. It gives Claude full SQL access to your Supabase database, which is enough to query the `open_brain` table directly.

### Step 1: Create a Supabase Personal Access Token

1. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. Click **Generate new token**
3. Give it a name like `claude-desktop`
4. Copy the token — **you will not be able to see it again**

### Step 2: Find your Project Ref

1. Open your project in the [Supabase dashboard](https://supabase.com/dashboard)
2. Go to **Project Settings** → **General**
3. The **Project ID** (e.g. `abcdefghijklmnop`) is your project ref

### Step 3: Edit the Claude Desktop config file

Claude Desktop's configuration lives at:

```
%APPDATA%\Claude\claude_desktop_config.json
```

To open it:
1. Press `Win + R`, type `%APPDATA%\Claude` and press Enter
2. If the `Claude` folder doesn't exist, create it
3. Open (or create) `claude_desktop_config.json` in Notepad or VS Code

Paste in the following, replacing the placeholder values:

```json
{
  "mcpServers": {
    "open_brain": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--project-ref=YOUR_PROJECT_REF"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "YOUR_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

Replace:
- `YOUR_PROJECT_REF` → your Project ID from Step 2 (e.g. `abcdefghijklmnop`)
- `YOUR_PERSONAL_ACCESS_TOKEN` → the token you copied in Step 1

> The ready-to-edit version of this config is also saved as `claude-desktop-config.json` in this folder.

### Step 4: Restart Claude Desktop

1. Right-click the Claude icon in the system tray → **Quit**
2. Relaunch Claude Desktop from the Start Menu or desktop shortcut

### Step 5: Verify it's working

After restarting, look for the **MCP tools icon** (a hammer/wrench icon) in the Claude Desktop input bar. Clicking it will show the list of available tools.

**Test prompts to try:**

```
List the tables in my Supabase database
```

```
Run: SELECT count(*) FROM open_brain
```

```
Show me the 5 most recently added rows in the open_brain table
```

If Claude returns results from your database, the connection is working.

---

## Option B — Custom MCP Server (Full Open Brain Integration)

The custom server exposes eight dedicated tools:

| Tool | What it does |
|---|---|
| `semantic_search` | Embeds your query with OpenAI and finds semantically similar memories |
| `list_recent` | Returns the N most recently added memories |
| `add_memory` | Ingests new content with auto-embedding and metadata extraction |
| `search_by_tag` | Returns all memories with a specific tag |
| `brain_stats` | Returns memory count, source breakdown, top tags, and date range |
| `update_memory` | Updates a memory's content, re-embeds, and auto-extracts new metadata (v1.5) |
| `deprecate_memory` | Soft-deletes a memory with a reason; optionally links to a replacement (v1.5) |
| `merge_memories` | Combines multiple memories into one new memory, deprecates the originals (v1.5) |

### Step 1: Install the custom server dependencies

1. Open Command Prompt or PowerShell
2. Navigate to the `custom-mcp-server` folder:

```
cd C:\path\to\open-brain\mcp-config\custom-mcp-server
```

3. Install dependencies:

```
npm install
```

This installs `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, and `openai`.

### Step 2: Gather your credentials

You need four values:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → `service_role` key |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `OPEN_BRAIN_INGEST_URL` | Supabase Dashboard → Edge Functions → ingest → URL |

> **Security note:** The `service_role` key has full database access. Do not share it or commit it to source control. It only lives in your local Claude Desktop config.

### Step 3: Edit the Claude Desktop config file

Open `%APPDATA%\Claude\claude_desktop_config.json` (same path as Option A).

Use the contents of `custom-mcp-config.json` from this folder, replacing all placeholder values:

```json
{
  "mcpServers": {
    "open_brain": {
      "command": "cmd",
      "args": [
        "/c",
        "node",
        "C:\\path\\to\\custom-mcp-server\\index.js"
      ],
      "env": {
        "SUPABASE_URL": "YOUR_SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR_SERVICE_ROLE_KEY",
        "OPENAI_API_KEY": "YOUR_OPENAI_API_KEY",
        "OPEN_BRAIN_INGEST_URL": "YOUR_EDGE_FUNCTION_URL"
      }
    }
  }
}
```

Replace `C:\\path\\to\\custom-mcp-server\\index.js` with the actual absolute path to `index.js` on your machine. Use double backslashes in JSON strings.

**Example:**
```json
"args": ["/c", "node", "C:\\Users\\Brian\\Projects\\open-brain\\mcp-config\\custom-mcp-server\\index.js"]
```

### Step 4: Restart Claude Desktop

Same as Option A — quit from the system tray and relaunch.

### Step 5: Verify it's working

After restarting, the MCP tools icon should appear. Click it to confirm `open_brain` tools are listed.

**Test prompts to try:**

```
List the tables in my Supabase database
```

```
Run: SELECT count(*) FROM open_brain
```

```
Search my brain for thoughts about product strategy
```

```
Show me my most recent memories
```

```
Add a memory: "Reviewed Q1 roadmap priorities with the team. Top focus is retention."
```

```
Search my brain for entries tagged "product-strategy"
```

> Note: `Search my brain for thoughts about product strategy` uses semantic vector search and requires your `match_brain` RPC function to exist in Supabase. If it's not yet deployed, use the SQL queries instead.

---

## Troubleshooting

### `'node' is not recognized as an internal or external command`

Node.js is not on your PATH. Solutions:
1. Restart your computer after installing Node.js (PATH changes require a restart)
2. Reinstall Node.js and make sure "Add to PATH" is selected during installation
3. Manually add `C:\Program Files\nodejs\` to your system PATH in Settings → System → Advanced system settings → Environment Variables

### `'npx' is not recognized`

npx ships with npm, which comes with Node.js. If npx is missing, reinstall Node.js. You can also try:

```
npm install -g npx
```

### Claude Desktop shows no MCP tools icon

- Confirm `claude_desktop_config.json` is valid JSON (no trailing commas, no missing quotes). Paste it into [jsonlint.com](https://jsonlint.com) to validate.
- Confirm the file is in the correct location: `%APPDATA%\Claude\claude_desktop_config.json`
- Try fully quitting Claude Desktop (system tray → Quit) and relaunching

### `Error: Missing required env var: SUPABASE_URL` (Option B)

The environment variables in `custom-mcp-config.json` are not set correctly. Double-check that all four env vars have real values (not placeholder text).

### `match_brain RPC error` on semantic search

The `match_brain` Postgres function hasn't been deployed to your Supabase project yet. Basic SQL queries via `SELECT` will still work. Deploy the RPC function from your Open Brain migrations to enable semantic search.

### The server starts but Claude can't call tools

Check the Claude Desktop logs for MCP errors. On Windows:
```
%APPDATA%\Claude\logs\
```
Look for any lines containing `[open-brain]` or `mcp`.

---

## Next Steps

Once Option A is working:
1. Move to Option B for semantic search capabilities
2. Deploy the `match_brain`, `list_recent`, and `search_by_tag` RPC functions to Supabase if not already present
3. Test the ingest Edge Function endpoint before adding it to the config

Once Option B is working, you can ask Claude things like:
- *"What did I save about the onboarding redesign?"*
- *"Add a memory: the new API rate limit is 1000 req/min"*
- *"Show me everything tagged 'meeting-notes'"*
- *"Update memory 42 — the rate limit was changed to 2000 req/min"*
- *"Deprecate memory 15 — that project was cancelled"*
- *"Merge memories 38 and 39 into one combined summary"*
- *"Give me brain stats"*
