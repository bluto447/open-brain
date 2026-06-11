/**
 * scoring-agent — Edge Function (v3)
 *
 * Extracts v2 rubric scores from research_result into top-level pipeline columns.
 * weighted_score is a GENERATED column computed by Postgres.
 *
 * v2 Rubric dimensions:
 *   pain_signal (0.25)             → pipeline.painful_problem
 *   willingness_to_pay (0.20)      → pipeline.willingness_to_pay
 *   distribution_clarity (0.20)    → pipeline.distribution_clarity
 *   niche_leverage (0.15)          → pipeline.niche_leverage
 *   compounding_asset_score (0.10) → pipeline.compounding_asset_score
 *   platform_independence (0.10)   → pipeline.platform_independence_score
 *
 * Modes:
 *   POST { idea_id: UUID }          — Extract scores for one idea
 *   POST { batch: true, limit: N }  — Extract for unscored ideas
 *   POST { rescore: true, limit: N } — Re-extract all researched ideas
 *
 * Pure extraction. No LLM calls. weighted_score auto-computes via Postgres.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------- SAFE PARSERS ----------

function safeInt(val: unknown, fallback: number): number {
  if (val === null || val === undefined) return fallback;
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(1, Math.min(5, n)));
}

function safeCount(val: unknown, fallback: number): number {
  if (val === null || val === undefined) return fallback;
  const n = typeof val === "number" ? val : Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

// ---------- EXTRACT + WRITE ----------

interface ExtractResult {
  ok: boolean;
  idea_id: string;
  rubric_version?: string;
  extracted?: Record<string, unknown>;
  weighted_score?: number;
  error?: string;
}

async function extractScores(
  supabase: ReturnType<typeof createClient>,
  ideaId: string
): Promise<ExtractResult> {
  const { data: idea, error: fetchErr } = await supabase
    .from("pipeline")
    .select("id, research_result, stage")
    .eq("id", ideaId)
    .single();

  if (fetchErr || !idea) {
    return { ok: false, idea_id: ideaId, error: fetchErr?.message || "not_found" };
  }

  const rr = idea.research_result as Record<string, unknown> | null;
  if (!rr) {
    return { ok: false, idea_id: ideaId, error: "no_research_result" };
  }

  // Detect rubric version from research_result
  const rubricVersion = (rr.rubric_version as string) || "v1";

  // v2 rubric has pain_signal, willingness_to_pay, distribution_clarity, niche_leverage
  // v1 rubric has pain_validated, pain_evidence_count, competitor_density
  const isV2 = rubricVersion === "v2" || rr.pain_signal !== undefined;

  let updatePayload: Record<string, unknown>;

  if (isV2) {
    updatePayload = {
      // v2 direct fields
      painful_problem: safeInt(rr.pain_signal, 3),
      willingness_to_pay: safeInt(rr.willingness_to_pay, 3),
      distribution_clarity: safeInt(rr.distribution_clarity, 3),
      niche_leverage: safeInt(rr.niche_leverage, 3),
      compounding_asset_score: safeInt(rr.compounding_asset_score, 3),
      platform_independence_score: safeInt(rr.platform_independence_score, 3),
      pain_evidence_count: safeCount(rr.pain_evidence_count, 0),
      simplicity: safeInt(rr.simplicity_score, 3),
      kill_reason: typeof rr.kill_reason === "string" && rr.kill_reason.length > 0 ? rr.kill_reason : null,
    };
  } else {
    // v1 fallback: derive what we can, default the rest
    const painVal = rr.pain_validated === true;
    const pec = safeCount(rr.pain_evidence_count, 0);
    // Map pain_evidence_count to a 1-5 pain_signal score
    let painSignal = 3;
    if (!painVal || pec === 0) painSignal = 1;
    else if (pec <= 2) painSignal = 2;
    else if (pec <= 5) painSignal = 3;
    else if (pec <= 10) painSignal = 4;
    else painSignal = 5;

    updatePayload = {
      painful_problem: painSignal,
      willingness_to_pay: 3, // unknown for v1, default to neutral
      distribution_clarity: 3,
      niche_leverage: 3,
      compounding_asset_score: safeInt(rr.compounding_asset_score, 3),
      platform_independence_score: safeInt(rr.platform_independence_score, 3),
      pain_evidence_count: pec,
      simplicity: safeInt(rr.simplicity_score, 3),
      kill_reason: typeof rr.kill_reason === "string" && rr.kill_reason.length > 0 ? rr.kill_reason : null,
    };
  }

  const { error: updateErr } = await supabase
    .from("pipeline")
    .update(updatePayload)
    .eq("id", ideaId);

  if (updateErr) {
    return { ok: false, idea_id: ideaId, rubric_version: isV2 ? "v2" : "v1", extracted: updatePayload, error: updateErr.message };
  }

  // Fetch the auto-computed weighted_score
  const { data: scored } = await supabase
    .from("pipeline")
    .select("weighted_score")
    .eq("id", ideaId)
    .single();

  return {
    ok: true,
    idea_id: ideaId,
    rubric_version: isV2 ? "v2" : "v1",
    extracted: updatePayload,
    weighted_score: scored?.weighted_score ?? undefined,
  };
}

// ---------- HANDLER ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: { idea_id?: string; batch?: boolean; rescore?: boolean; limit?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid_json" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- Single idea ---
  if (body.idea_id) {
    const result = await extractScores(supabase, body.idea_id);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Batch / rescore ---
  if (body.batch || body.rescore) {
    const limit = Math.min(body.limit || 50, 200);

    let query = supabase
      .from("pipeline")
      .select("id")
      .not("research_result", "is", null)
      .limit(limit);

    if (body.batch && !body.rescore) {
      // Only ideas missing the new v2 columns
      query = query.is("willingness_to_pay", null);
    }

    const { data: ideas, error: queryErr } = await query;

    if (queryErr) {
      return new Response(
        JSON.stringify({ error: "batch_query_failed", detail: queryErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!ideas || ideas.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "no_ideas_to_score", scored: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: ExtractResult[] = [];
    let scored = 0;
    let failed = 0;

    for (const idea of ideas) {
      const result = await extractScores(supabase, idea.id);
      results.push(result);
      if (result.ok) scored++;
      else failed++;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mode: body.rescore ? "rescore" : "batch",
        scored,
        failed,
        total: ideas.length,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ error: "provide idea_id, batch:true, or rescore:true" }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
