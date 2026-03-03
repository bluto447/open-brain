/**
 * Open Brain — Custom MCP Server
 *
 * Exposes Open Brain's Supabase backend as MCP tools that Claude Desktop
 * can call directly. Uses stdio transport, which is the standard mechanism
 * for local MCP servers launched by Claude Desktop.
 *
 * Tools exposed:
 *   - semantic_search   : Embed a query with OpenAI then call match_brain RPC
 *   - list_recent       : Return the N most recently added brain entries
 *   - add_memory        : Ingest a new memory via the Edge Function
 *   - search_by_tag     : Return entries matching a given tag
 *
 * Required environment variables:
 *   SUPABASE_URL              – e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY – Service role key (not the anon key)
 *   OPENAI_API_KEY            – Used to generate embeddings for semantic_search
 *   OPEN_BRAIN_INGEST_URL     – Full URL to the ingest Edge Function
 *
 * Usage (via Claude Desktop):
 *   See custom-mcp-config.json for the Claude Desktop configuration.
 *
 * Local dev / testing:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \
 *   OPEN_BRAIN_INGEST_URL=... node index.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "OPEN_BRAIN_INGEST_URL",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    // Write to stderr so Claude Desktop can surface the error without
    // corrupting the stdout-based MCP protocol stream.
    process.stderr.write(`[open-brain] Missing required env var: ${key}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Client initialisation
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Helper: generate an OpenAI text-embedding-3-small vector
// ---------------------------------------------------------------------------

async function embedText(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Tool definitions (schema + handler)
// ---------------------------------------------------------------------------

/**
 * semantic_search
 * Converts the user's query to a vector embedding, then calls the
 * match_brain Postgres RPC function to find semantically similar memories.
 */
async function semanticSearch({ query, match_count = 10, match_threshold = 0.5 }) {
  const embedding = await embedText(query);

  const { data, error } = await supabase.rpc("match_brain", {
    query_embedding: embedding,
    match_count: match_count,
    match_threshold: match_threshold,
  });

  if (error) throw new Error(`match_brain RPC error: ${error.message}`);

  return data;
}

/**
 * list_recent
 * Returns the N most recently added brain entries by calling the
 * list_recent RPC function.
 */
async function listRecent({ limit = 20 }) {
  const { data, error } = await supabase.rpc("list_recent", {
    row_limit: limit,
  });

  if (error) throw new Error(`list_recent RPC error: ${error.message}`);

  return data;
}

/**
 * add_memory
 * POSTs a new memory to the Open Brain ingest Edge Function, which
 * handles chunking, embedding, and storing in Supabase.
 */
async function addMemory({ content, source = "claude" }) {
  const response = await fetch(process.env.OPEN_BRAIN_INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The Edge Function should accept the service role key for server-side calls.
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ content, source }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ingest Edge Function error (${response.status}): ${text}`);
  }

  return await response.json();
}

/**
 * search_by_tag
 * Returns all brain entries that have a specific tag, by calling the
 * search_by_tag RPC function.
 */
async function searchByTag({ tag, limit = 50 }) {
  const { data, error } = await supabase.rpc("search_by_tag", {
    tag_query: tag,
    row_limit: limit,
  });

  if (error) throw new Error(`search_by_tag RPC error: ${error.message}`);

  return data;
}

// ---------------------------------------------------------------------------
// MCP tool schemas (JSON Schema format)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "semantic_search",
    description:
      "Search Open Brain using natural language. The query is embedded with OpenAI and matched against stored memories using vector similarity.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The natural language search query.",
        },
        match_count: {
          type: "number",
          description: "Maximum number of results to return (default: 10).",
        },
        match_threshold: {
          type: "number",
          description:
            "Minimum cosine similarity score, 0–1 (default: 0.5). Higher = stricter.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recently added memories in Open Brain.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many recent entries to return (default: 20).",
        },
      },
    },
  },
  {
    name: "add_memory",
    description:
      "Add a new memory to Open Brain. The content will be chunked, embedded, and stored.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text content to remember.",
        },
        source: {
          type: "string",
          description:
            'Where this memory came from (default: "claude"). Examples: "slack", "email", "notion".',
        },
      },
      required: ["content"],
    },
  },
  {
    name: "search_by_tag",
    description: "Return all Open Brain memories that have a specific tag.",
    inputSchema: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description: 'The tag to search for, e.g. "product-strategy".',
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 50).",
        },
      },
      required: ["tag"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const TOOL_HANDLERS = {
  semantic_search: semanticSearch,
  list_recent: listRecent,
  add_memory: addMemory,
  search_by_tag: searchByTag,
};

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "open-brain",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tools/list — tell Claude what tools are available
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tools/call — execute the requested tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await handler(args ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    process.stderr.write(`[open-brain] Tool "${name}" error: ${err.message}\n`);
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start the server using stdio transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[open-brain] MCP server started on stdio transport\n");
