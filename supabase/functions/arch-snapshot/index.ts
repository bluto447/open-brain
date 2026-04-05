/**
 * Open Brain — Architecture Snapshot Edge Function
 *
 * GET endpoint that queries the live database and returns formatted markdown
 * for the Data Layer section of ARCHITECTURE.md.
 *
 * Queries:
 *   1. Table inventory with row counts
 *   2. Public RPC functions via list_public_rpcs()
 *   3. open_brain column schema via list_table_info()
 *
 * Environment variables (auto-set by Supabase):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
}

function corsResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  })
}

// ---------------------------------------------------------------------------
// pgvector/extension functions to exclude from RPC listing (exact names)
// ---------------------------------------------------------------------------

const EXTENSION_FUNCTIONS = new Set([
  "array_to_halfvec", "array_to_sparsevec", "array_to_vector",
  "binary_quantize", "cosine_distance", "halfvec", "halfvec_accum",
  "halfvec_add", "halfvec_avg", "halfvec_cmp", "halfvec_combine",
  "halfvec_concat", "halfvec_eq", "halfvec_ge", "halfvec_gt",
  "halfvec_in", "halfvec_l2_squared_distance", "halfvec_le",
  "halfvec_lt", "halfvec_mul", "halfvec_ne",
  "halfvec_negative_inner_product", "halfvec_out", "halfvec_recv",
  "halfvec_send", "halfvec_spherical_distance", "halfvec_sub",
  "halfvec_to_float4", "halfvec_to_sparsevec", "halfvec_to_vector",
  "halfvec_typmod_in", "hamming_distance", "hnsw_bit_support",
  "hnsw_halfvec_support", "hnsw_sparsevec_support", "hnswhandler",
  "inner_product", "ivfflat_bit_support", "ivfflat_halfvec_support",
  "ivfflathandler", "jaccard_distance", "l1_distance", "l2_distance",
  "l2_norm", "l2_normalize", "sparsevec", "sparsevec_cmp",
  "sparsevec_eq", "sparsevec_ge", "sparsevec_gt", "sparsevec_in",
  "sparsevec_l2_squared_distance", "sparsevec_le", "sparsevec_lt",
  "sparsevec_ne", "sparsevec_negative_inner_product", "sparsevec_out",
  "sparsevec_recv", "sparsevec_send", "sparsevec_to_halfvec",
  "sparsevec_to_vector", "sparsevec_typmod_in", "subvector",
  "vector", "vector_accum", "vector_add", "vector_avg", "vector_cmp",
  "vector_combine", "vector_concat", "vector_dims", "vector_eq",
  "vector_ge", "vector_gt", "vector_in", "vector_l2_squared_distance",
  "vector_le", "vector_lt", "vector_mul", "vector_ne",
  "vector_negative_inner_product", "vector_norm", "vector_out",
  "vector_recv", "vector_send", "vector_spherical_distance",
  "vector_sub", "vector_to_float4", "vector_to_halfvec",
  "vector_to_sparsevec", "vector_typmod_in",
])

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsResponse("", 204)
  if (req.method !== "GET") {
    return corsResponse(JSON.stringify({ error: "Method not allowed" }), 405)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !supabaseServiceKey) {
    return corsResponse(JSON.stringify({ error: "Missing env vars" }), 500)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    // 1. Discover tables dynamically + get row counts (parallel)
    const { data: tableInfo } = await supabase.rpc("list_table_info")
    const uniqueTables = [...new Set((tableInfo || []).map(
      (r: { table_name: string }) => r.table_name
    ))].sort()

    const countResults = await Promise.allSettled(
      uniqueTables.map(async (table) => {
        const { count, error } = await supabase
          .from(table)
          .select("*", { count: "exact", head: true })
        return { table, count: error ? "?" : count }
      })
    )
    const tableCounts = countResults.map((r, i) =>
      r.status === "fulfilled" ? r.value : { table: uniqueTables[i], count: "?" }
    )

    // 2. RPC functions (filter out pgvector/extension internals by exact name)
    const { data: allRpcs, error: rpcErr } = await supabase.rpc("list_public_rpcs")
    const rpcs = (allRpcs || []).filter(
      (fn: { function_name: string }) => !EXTENSION_FUNCTIONS.has(fn.function_name)
    )

    // 3. open_brain columns (reuse tableInfo from step 1)
    const obColumns = (tableInfo || []).filter(
      (c: { table_name: string }) => c.table_name === "open_brain"
    )

    // Format markdown
    const now = new Date().toISOString()
    let md = `## Data Layer (Auto-generated ${now.split("T")[0]})\n\n`

    // Table inventory
    md += `### Tables\n\n`
    md += `| Table | Rows |\n|-------|------|\n`
    for (const { table, count } of tableCounts) {
      md += `| \`${table}\` | ${count} |\n`
    }

    // RPC functions
    md += `\n### RPC Functions\n\n`
    if (rpcErr) {
      md += `> Error querying RPCs: ${rpcErr.message}\n`
    } else {
      md += `| Function | Arguments | Returns |\n|----------|-----------|--------|\n`
      for (const fn of rpcs || []) {
        md += `| \`${fn.function_name}\` | ${fn.argument_signature || "none"} | ${fn.return_type} |\n`
      }
    }

    // open_brain schema
    md += `\n### open_brain Schema\n\n`
    md += `| Column | Type | Nullable | Default |\n|--------|------|----------|---------|\n`
    for (const col of obColumns) {
      md += `| \`${col.column_name}\` | ${col.data_type} | ${col.is_nullable} | ${col.column_default || ""} |\n`
    }

    return corsResponse(JSON.stringify({ markdown: md, generated_at: now }), 200)
  } catch (err) {
    return corsResponse(
      JSON.stringify({ error: "Snapshot failed", detail: String(err) }),
      500
    )
  }
})
