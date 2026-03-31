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
 * update_memory
 * Updates an existing memory's content and metadata. Re-embeds the new
 * content via OpenAI, then calls the update_memory RPC and patches the
 * embedding column.
 */
async function updateMemory({ id, content, metadata }) {
  // 1. Re-embed the new content
  const embedding = await embedText(content);

  // 2. Update content + metadata via RPC
  const { data: updated, error: rpcError } = await supabase.rpc("update_memory", {
    p_id: id,
    p_content: content,
    p_metadata: metadata || {},
  });

  if (rpcError) throw new Error(`update_memory RPC error: ${rpcError.message}`);

  // 3. Patch the embedding column (RPC doesn't touch it)
  const { error: embedError } = await supabase
    .from("open_brain")
    .update({ embedding })
    .eq("id", id);

  if (embedError) throw new Error(`Embedding update error: ${embedError.message}`);

  return updated;
}

/**
 * deprecate_memory
 * Marks a memory as no longer valid by calling the deprecate_memory RPC.
 */
async function deprecateMemory({ id, reason, superseded_by = null }) {
  const params = { p_id: id, p_reason: reason };
  if (superseded_by) params.p_superseded_by = superseded_by;

  const { data, error } = await supabase.rpc("deprecate_memory", params);

  if (error) throw new Error(`deprecate_memory RPC error: ${error.message}`);

  return data;
}

/**
 * merge_memories
 * Merges multiple memories into one. Creates a new memory with the merged
 * content, deprecates the originals, then embeds the new content.
 */
async function mergeMemories({ ids, merged_content, source = "merge" }) {
  // 1. Call merge RPC (creates new row with embedding = NULL, deprecates sources)
  const { data, error } = await supabase.rpc("merge_memories", {
    p_ids: ids,
    p_merged_content: merged_content,
    p_source: source,
  });

  if (error) throw new Error(`merge_memories RPC error: ${error.message}`);

  // 2. Embed the merged content and update the new row
  if (data && data.length > 0) {
    const newId = data[0].id;
    const embedding = await embedText(merged_content);

    const { error: embedError } = await supabase
      .from("open_brain")
      .update({ embedding })
      .eq("id", newId);

    if (embedError) {
      process.stderr.write(`[open-brain] Warning: merge succeeded but embedding failed: ${embedError.message}\n`);
    }
  }

  return data;
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
    name: "update_memory",
    description:
      "Update an existing memory's content and metadata. Automatically re-embeds the new content.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The ID of the memory to update.",
        },
        content: {
          type: "string",
          description: "The new content text for the memory.",
        },
        metadata: {
          type: "object",
          description:
            "New metadata object (replaces existing). Should include tags, people, topics, sentiment, action_items.",
        },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "deprecate_memory",
    description:
      "Mark a memory as no longer valid (soft-delete). Sets valid_to and records the reason. Optionally links to a replacement memory.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "The ID of the memory to deprecate.",
        },
        reason: {
          type: "string",
          description: "Why this memory is being deprecated.",
        },
        superseded_by: {
          type: "number",
          description:
            "Optional ID of the memory that replaces this one.",
        },
      },
      required: ["id", "reason"],
    },
  },
  {
    name: "merge_memories",
    description:
      "Merge multiple memories into a single new memory. Deprecates all source memories and creates a new one with the merged content. Automatically embeds the merged content.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Array of memory IDs to merge.",
        },
        merged_content: {
          type: "string",
          description: "The combined/synthesized content for the new memory.",
        },
        source: {
          type: "string",
          description: 'Source label for the new memory (default: "merge").',
        },
      },
      required: ["ids", "merged_content"],
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
  update_memory: updateMemory,
  deprecate_memory: deprecateMemory,
  merge_memories: mergeMemories,
};

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "open-brain",
    version: "1.5.0",
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
