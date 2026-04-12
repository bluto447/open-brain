/**
 * perplexity-researcher — Edge Function
 *
 * Drop-in replacement for claude-researcher.
 * Uses Perplexity Sonar Pro for web research + structured output.
 *
 * Cost: ~$0.01-0.02/idea vs $1.20-5.00 with Opus
 * Latency: ~10-30s vs 90-150s
 *
 * Same interface contract:
 *   POST { idea_id: UUID, dry_run?: boolean }
 *   Returns { ok, idea_id, run_id, from_stage, to_stage, confidence, recommendation, research_result }
 *
 * Same auto-transition rules:
 *   confidence >= 0.7 AND recommendation = "advance" → validating
 *   recommendation = "park" OR 0.4 <= confidence < 0.7 → parked
 *   recommendation = "kill" OR confidence < 0.4 → killed
 *
 * Secrets required:
 *   PERPLEXITY_API_KEY — Sonar Pro API key
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------- SYSTEM PROMPT ----------

const SYSTEM_PROMPT = `You are a startup idea researcher for a solo micro-SaaS operator. Your job is to evaluate whether a product idea has real signal — meaning real people with real pain who would pay for a solution.

You have access to the live web. Search aggressively. Look for:
1. PAIN VALIDATION — Are people complaining about this problem on Reddit, forums, X, Product Hunt, app store reviews? Look for "is there a tool that..." and "I wish..." posts. Quantify: how many threads, how recent, how emotional.
2. COMPETITIVE LANDSCAPE — Who already solves this? What do they charge? Where are the gaps? Is this a crowded market with 10+ funded players, or an underserved niche?
3. REACHABLE BUYER — Can the operator reach buyers through SEO, communities, marketplaces, or cold outreach? Or is the buyer hidden behind enterprise procurement?
4. COMPOUNDING ASSET — Does usage generate data, network effects, or switching costs that make the product harder to replace over time? Or is it a utility that can be cloned in a weekend?
5. PLATFORM INDEPENDENCE — Does this idea depend on a single platform (Chrome Web Store, a specific API, a social media algorithm)? If that platform changes policy or launches a native feature, does the product die?

CRITICAL SCORING GUIDANCE:
- "Simple to build" is NOT a positive signal by itself. If it's simple to build, it's simple to clone. Score compounding_asset and platform_independence HIGHER than build simplicity.
- Chrome extensions, social media tools, and API wrappers that depend on a single platform score LOW on platform_independence regardless of other factors.
- If every competitor is free or <$5/mo, that's a red flag — the market doesn't value the solution.

Be brutally honest. The operator's time is the most expensive resource. A false positive (advancing a bad idea) costs weeks of build time. A false negative (killing a good idea) just means it comes back later with better signal.

Return your findings as structured JSON matching the required schema.`;

// ---------- OUTPUT SCHEMA (Perplexity structured output) ----------

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    confidence: {
      type: "number",
      description:
        "Overall confidence in this assessment, 0.0 to 1.0. Above 0.7 means strong signal found. Below 0.4 means idea should be killed.",
    },
    recommendation: {
      type: "string",
      enum: ["advance", "park", "kill"],
      description:
        "advance = strong signal, move to validation. park = mixed signal, revisit later. kill = no signal or fatal flaw.",
    },
    pain_validated: {
      type: "boolean",
      description:
        "True if you found concrete evidence of people experiencing this pain (forum posts, reviews, complaints).",
    },
    pain_evidence_count: {
      type: "integer",
      description:
        "Number of distinct pain signals found (forum threads, review complaints, social posts).",
    },
    competitor_density: {
      type: "number",
      description:
        "1-5 scale. 1 = no competitors found. 3 = a few competitors with gaps. 5 = saturated market with funded players.",
    },
    compounding_asset_score: {
      type: "number",
      description:
        "1-5 scale. Does usage generate data, network effects, or switching costs? 1 = pure utility, easily cloned. 5 = strong compounding moat.",
    },
    platform_independence_score: {
      type: "number",
      description:
        "1-5 scale. 1 = entirely dependent on one platform (Chrome store, single API). 5 = fully independent, owns its distribution.",
    },
    simplicity_score: {
      type: "number",
      description:
        "1-5 scale. How easy is this to build for a solo operator? 1 = massive undertaking. 5 = weekend project. NOTE: high simplicity + low compounding = commodity trap.",
    },
    market_summary: {
      type: "string",
      description:
        "2-4 sentence summary of what you found. Lead with the strongest signal (positive or negative).",
    },
    kill_reason: {
      type: "string",
      description:
        "If recommendation is kill or park, explain the primary reason in one sentence. Empty string if advance.",
    },
    competitors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" },
          pricing: { type: "string" },
          users_estimate: { type: "string" },
          gap: {
            type: "string",
            description: "What gap or weakness this competitor has that the idea could exploit.",
          },
        },
        required: ["name", "pricing", "gap"],
        additionalProperties: false,
      },
      description: "Top 3-5 competitors found. Empty array if none.",
    },
    gaps: {
      type: "array",
      items: { type: "string" },
      description:
        "What couldn't be answered or confirmed from web search. These become validation questions for the next stage.",
    },
  },
  required: [
    "confidence",
    "recommendation",
    "pain_validated",
    "pain_evidence_count",
    "competitor_density",
    "compounding_asset_score",
    "platform_independence_score",
    "simplicity_score",
    "market_summary",
    "kill_reason",
    "competitors",
    "gaps",
  ],
  additionalProperties: false,
};

// ---------- PROMPT BUILDER ----------

function buildResearchPrompt(idea: Record<string, unknown>): string {
  const parts = [
    `## Idea to Research`,
    `**Title:** ${idea.title || "Untitled"}`,
    idea.description ? `**Description:** ${idea.description}` : "",
    idea.type ? `**Product Type:** ${idea.type}` : "",
    idea.pillar ? `**Pillar:** ${idea.pillar}` : "",
    idea.target_user ? `**Target User:** ${idea.target_user}` : "",
    idea.monetization ? `**Monetization:** ${idea.monetization}` : "",
    idea.pain_point_verbatim
      ? `**Pain Point (verbatim):** ${idea.pain_point_verbatim}`
      : "",
    idea.notes ? `**Operator Notes:** ${idea.notes}` : "",
    idea.source ? `**Source:** ${idea.source}` : "",
    "",
    "## Research Instructions",
    "Search the web thoroughly for this idea. Focus on the 5 dimensions in your system prompt.",
    "Use recent data (last 6 months preferred). Look at Reddit, Product Hunt, Hacker News, G2, Capterra, app stores, and niche forums.",
    "If the idea involves a specific platform (Chrome, Shopify, etc.), check that platform's marketplace for existing solutions.",
    "Return your structured assessment.",
  ];
  return parts.filter(Boolean).join("\n");
}

// ---------- COST ESTIMATOR ----------

function estimateCost(usage: Record<string, number>): Record<string, unknown> {
  // Sonar Pro pricing: ~$3/M input, $15/M output (as of 2026-Q1)
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;
  const inputCost = (inputTokens / 1_000_000) * 3;
  const outputCost = (outputTokens / 1_000_000) * 15;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: Math.round((inputCost + outputCost) * 10000) / 10000,
    model_pricing: "sonar-pro: $3/M input, $15/M output",
  };
}

// ---------- HANDLER ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  // --- Parse request ---
  let body: { idea_id?: string; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid_json" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { idea_id, dry_run = false } = body;
  if (!idea_id) {
    return new Response(
      JSON.stringify({ error: "idea_id_required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Secrets ---
  const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return new Response(
      JSON.stringify({ error: "missing_secret", detail: "PERPLEXITY_API_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Supabase client ---
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // --- Fetch idea ---
  const { data: idea, error: fetchError } = await supabase
    .from("pipeline")
    .select("*")
    .eq("id", idea_id)
    .single();

  if (fetchError || !idea) {
    return new Response(
      JSON.stringify({ error: "idea_not_found", detail: fetchError?.message }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (idea.stage !== "researching") {
    return new Response(
      JSON.stringify({ error: "wrong_stage", current_stage: idea.stage }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Call Perplexity Sonar Pro ---
  const researchPrompt = buildResearchPrompt(idea);

  let pxResponse: Response;
  try {
    pxResponse = await fetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: researchPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "research_finding",
            strict: true,
            schema: RESEARCH_SCHEMA,
          },
        },
        search_recency_filter: "month",
        temperature: 0.1,
      }),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "perplexity_network_error", detail: String(err) }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!pxResponse.ok) {
    const detail = await pxResponse.text();
    return new Response(
      JSON.stringify({
        error: "perplexity_api_error",
        status: pxResponse.status,
        detail,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const pxResult = await pxResponse.json();

  // --- Parse structured output ---
  let finding: Record<string, unknown>;
  try {
    finding = JSON.parse(pxResult.choices[0].message.content);
  } catch {
    return new Response(
      JSON.stringify({
        error: "no_structured_output",
        raw_content: pxResult.choices[0]?.message?.content?.slice(0, 500),
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Build research_result JSONB ---
  const run_id = crypto.randomUUID();
  const research_result = {
    binding: "perplexity-researcher",
    binding_version: "v1",
    model: "sonar-pro",
    run_id,
    ...finding,
    sources: (pxResult.citations || []).map((url: string, i: number) => ({
      url,
      title: `Citation ${i + 1}`,
    })),
    usage: pxResult.usage || {},
    cost_estimate: estimateCost(pxResult.usage || {}),
    latency_ms: Date.now() - startTime,
  };

  // --- Determine transition ---
  const confidence = finding.confidence as number;
  const recommendation = finding.recommendation as string;

  let to_stage = idea.stage;
  if (confidence >= 0.7 && recommendation === "advance") {
    to_stage = "validating";
  } else if (
    recommendation === "park" ||
    (confidence >= 0.4 && confidence < 0.7)
  ) {
    to_stage = "parked";
  } else if (recommendation === "kill" || confidence < 0.4) {
    to_stage = "killed";
  }

  // --- Dry run: return without writing ---
  if (dry_run) {
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        idea_id,
        run_id,
        from_stage: "researching",
        would_transition_to: to_stage,
        confidence,
        recommendation,
        research_result,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Write research_result + transition ---
  const updatePayload: Record<string, unknown> = {
    research_result,
  };

  // Only set stage + transition metadata if stage actually changes
  if (to_stage !== idea.stage) {
    updatePayload.stage = to_stage;
    updatePayload._pending_transition = {
      reason: `perplexity-researcher: ${recommendation} (confidence: ${confidence.toFixed(2)})`,
      triggered_by: "agent",
      evidence: {
        run_id,
        binding: "perplexity-researcher",
        binding_version: "v1",
        model: "sonar-pro",
        cost_estimate: research_result.cost_estimate,
      },
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from("pipeline")
    .update(updatePayload)
    .eq("id", idea_id)
    .select("id, stage, last_transition_id")
    .single();

  if (updateError) {
    // Return the research_result even on DB failure so it's not lost
    return new Response(
      JSON.stringify({
        error: "pipeline_update_failed",
        detail: updateError.message,
        research_result,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      idea_id,
      run_id,
      from_stage: "researching",
      to_stage,
      transitioned: to_stage !== idea.stage,
      confidence,
      recommendation,
      research_result,
      last_transition_id: updated?.last_transition_id,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
