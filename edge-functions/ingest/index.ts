/**
 * Open Brain — Ingest Edge Function
 *
 * Receives a plain-text note via POST, then:
 *   1. Generates a 1536-dim embedding with OpenAI text-embedding-3-small
 *   2. Extracts structured metadata with OpenAI gpt-4o-mini
 *   3. Inserts the content, embedding, and metadata into the `open_brain` table
 *
 * Environment variables required:
 *   - OPENAI_API_KEY          — OpenAI secret key
 *   - SUPABASE_URL            — Your Supabase project URL (auto-set in Edge Functions)
 *   - SUPABASE_SERVICE_ROLE_KEY — Service-role key for server-side writes (auto-set)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestRequest {
  content: string;
  source?: string;
  memory_type?: string;
}

interface ExtractedMetadata {
  tags: string[];
  people: string[];
  topics: string[];
  sentiment: "positive" | "neutral" | "negative";
  action_items: string[];
}

interface OpenBrainRow {
  id: string;
  content: string;
  source: string;
  embedding: number[];
  metadata: ExtractedMetadata;
  created_at: string;
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function corsResponse(body: string, status: number, extra?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

const OPENAI_BASE = "https://api.openai.com/v1";

/**
 * Generate a 1536-dimensional embedding for the given text using
 * OpenAI's text-embedding-3-small model.
 */
async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 1536,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embeddings error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.data[0].embedding as number[];
}

/**
 * Extract structured metadata from the given text using gpt-4o-mini.
 * Returns tags, people, topics, sentiment, and action_items.
 */
async function extractMetadata(text: string, apiKey: string): Promise<ExtractedMetadata> {
  const systemPrompt = `You are a metadata extraction assistant. Given a piece of text, extract the following fields and return ONLY valid JSON — no markdown, no commentary.

Fields to extract:
- tags: array of concise keyword tags (max 10) that describe the content
- people: array of full or partial names of any people mentioned
- topics: array of broader subject areas covered (e.g. "machine learning", "project management")
- sentiment: overall tone — exactly one of "positive", "neutral", or "negative"
- action_items: array of any tasks, to-dos, or follow-ups mentioned in the text

Example output shape:
{
  "tags": ["supabase", "edge functions"],
  "people": ["Alice Smith"],
  "topics": ["backend development"],
  "sentiment": "positive",
  "action_items": ["Deploy the edge function by Friday"]
}`;

  const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI chat error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content as string;

  let parsed: ExtractedMetadata;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse metadata JSON from gpt-4o-mini: ${raw}`);
  }

  // Normalise and provide safe defaults in case any field is missing
  return {
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    people: Array.isArray(parsed.people) ? parsed.people : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment)
      ? parsed.sentiment
      : "neutral",
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
  };
}

// ---------------------------------------------------------------------------
// Memory type classification
// ---------------------------------------------------------------------------

const VALID_MEMORY_TYPES = ["episodic", "semantic", "procedural", "preference", "decision"] as const
type MemoryType = typeof VALID_MEMORY_TYPES[number]

/**
 * Classify the memory type using gpt-4o-mini.
 * Returns one of: episodic, semantic, procedural, preference, decision.
 */
async function classifyMemoryType(text: string, apiKey: string): Promise<MemoryType> {
  const systemPrompt = `You are a memory classification assistant. Given a piece of text, classify it into exactly one memory type. Return ONLY valid JSON with a single "memory_type" field.

Memory types:
- episodic: A specific event, session, meeting, or experience with a time/place context. Example: "Met with Alice on Tuesday to discuss the roadmap."
- semantic: A fact, concept, or general knowledge not tied to a specific event. Example: "Supabase uses PostgreSQL under the hood."
- procedural: A how-to, process, workflow, or set of steps. Example: "To deploy, run supabase functions deploy."
- preference: A personal preference, opinion, or value judgment. Example: "I prefer dark mode for coding."
- decision: A choice that was made, with or without rationale. Example: "We decided to use pgvector instead of Pinecone."

Example output: {"memory_type": "semantic"}`

  const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  })

  if (!response.ok) {
    console.error(`Memory type classification failed (${response.status}), defaulting to 'semantic'`)
    return "semantic"
  }

  const data = await response.json()
  const raw = data.choices[0].message.content as string

  try {
    const parsed = JSON.parse(raw)
    if (VALID_MEMORY_TYPES.includes(parsed.memory_type)) {
      return parsed.memory_type as MemoryType
    }
  } catch {
    // fall through to default
  }

  return "semantic"
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return corsResponse(
      JSON.stringify({ error: "Method not allowed. Use POST." }),
      405,
    );
  }

  // ---------------------------------------------------------------------------
  // Read environment variables
  // ---------------------------------------------------------------------------
  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!openAiKey || !supabaseUrl || !supabaseServiceKey) {
    console.error("Missing required environment variables");
    return corsResponse(
      JSON.stringify({ error: "Server misconfiguration: missing environment variables." }),
      500,
    );
  }

  // ---------------------------------------------------------------------------
  // Parse and validate request body
  // ---------------------------------------------------------------------------
  let body: IngestRequest;
  try {
    body = await req.json();
  } catch {
    return corsResponse(
      JSON.stringify({ error: "Invalid JSON body." }),
      400,
    );
  }

  const { content, source = "manual", memory_type: requestedType } = body;

  // Check for force_insert query param (bypasses dedup check)
  const url = new URL(req.url)
  const forceInsert = url.searchParams.get("force_insert") === "true"

  if (!content || typeof content !== "string") {
    return corsResponse(
      JSON.stringify({ error: "Missing or invalid 'content' field. Must be a non-empty string." }),
      400,
    );
  }

  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return corsResponse(
      JSON.stringify({ error: "'content' must not be blank." }),
      400,
    );
  }

  if (trimmedContent.length > 100_000) {
    return corsResponse(
      JSON.stringify({ error: "'content' exceeds maximum length of 100,000 characters." }),
      400,
    );
  }

  if (typeof source !== "string") {
    return corsResponse(
      JSON.stringify({ error: "'source' must be a string when provided." }),
      400,
    );
  }

  // ---------------------------------------------------------------------------
  // Step 1, 2, 3: Generate embedding, extract metadata, classify type in parallel
  // ---------------------------------------------------------------------------
  let embedding: number[];
  let metadata: ExtractedMetadata;
  let memoryType: MemoryType;

  try {
    // If caller provided a valid memory_type, skip classification
    const skipClassification = requestedType && VALID_MEMORY_TYPES.includes(requestedType as MemoryType)

    const [embeddingResult, metadataResult, typeResult] = await Promise.all([
      generateEmbedding(trimmedContent, openAiKey),
      extractMetadata(trimmedContent, openAiKey),
      skipClassification
        ? Promise.resolve(requestedType as MemoryType)
        : classifyMemoryType(trimmedContent, openAiKey),
    ]);

    embedding = embeddingResult;
    metadata = metadataResult;
    memoryType = typeResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("OpenAI pipeline error:", message);
    return corsResponse(
      JSON.stringify({ error: "Failed to process content with AI.", detail: message }),
      500,
    );
  }

  // ---------------------------------------------------------------------------
  // Step 4: Check for duplicates (unless force_insert=true)
  // ---------------------------------------------------------------------------
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (!forceInsert) {
    const { data: duplicates, error: dupError } = await supabase.rpc("find_duplicates", {
      p_embedding: embedding,
      p_threshold: 0.92,
      p_limit: 1,
    });

    if (dupError) {
      console.error("Dedup check error:", dupError);
      // Non-fatal: proceed with insert if dedup check fails
    } else if (duplicates && duplicates.length > 0) {
      const match = duplicates[0];
      return corsResponse(
        JSON.stringify({
          duplicate: true,
          existing_id: match.id,
          similarity: match.similarity,
          existing_content_preview: match.content.substring(0, 200),
          message: "A similar memory already exists. Use ?force_insert=true to insert anyway, or call update_memory to update the existing one.",
        }),
        200,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: Insert into Supabase
  // ---------------------------------------------------------------------------
  const { data, error } = await supabase
    .from("open_brain")
    .insert({
      content: trimmedContent,
      source: source.trim() || "manual",
      embedding,
      metadata,
      memory_type: memoryType,
    })
    .select()
    .single<OpenBrainRow>();

  if (error) {
    console.error("Supabase insert error:", error);
    return corsResponse(
      JSON.stringify({ error: "Failed to save to database.", detail: error.message }),
      500,
    );
  }

  // ---------------------------------------------------------------------------
  // Success — return the inserted row
  // ---------------------------------------------------------------------------
  return corsResponse(JSON.stringify({ success: true, data }), 201);
});
