// claude-researcher v2 — ARC-v2 prompt caching
// research_synthesizer binding for BLUEPRINT v2.2 pipeline.
// v2 change: moved static instructions into `system` block with cache_control,
// and cached the RESEARCH_TOOL definition. Cuts input token cost ~40-60% on cache hits.
//
// POST /claude-researcher  { "idea_id": "<uuid>", "dry_run": false }
// Auth: Supabase JWT required.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("CLAUDE_RESEARCHER_MODEL") ?? "claude-opus-4-6";
const MAX_SEARCH_USES = Number(Deno.env.get("CLAUDE_RESEARCHER_MAX_SEARCH") ?? "8");
const ADVANCE_THRESHOLD = 0.7;
const PARK_THRESHOLD = 0.4;
const BINDING_VERSION = "v2";

const RESEARCH_TOOL = {
  name: "record_research_finding",
  description:
    "Record structured research findings for a product idea. This is the ONLY way to return your final analysis. Do not return prose.",
  input_schema: {
    type: "object",
    properties: {
      confidence: {
        type: "number",
        description:
          "0.0-1.0 overall conviction. 0.0-0.4=kill, 0.4-0.7=park, 0.7-0.85=advance, 0.85-1.0=high conviction advance.",
      },
      pain_validated: { type: "boolean" },
      pain_evidence: {
        type: "string",
        description: "Specific quotes, threads, or data points proving (or disproving) the pain.",
      },
      complexity_assessment: {
        type: "string",
        description:
          "Is the PRODUCT itself simple or complex to ship, sell, and support? Simple wins. Note any hidden complexity.",
      },
      simplicity_score: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description: "Your recommended simplicity score 1-5 (5=dead simple, 1=gnarly). Can override operator's initial score.",
      },
      audience: {
        type: "object",
        properties: {
          icp: { type: "string" },
          reachability_channels: { type: "array", items: { type: "string" } },
          estimated_size: { type: "string" },
        },
        required: ["icp", "reachability_channels", "estimated_size"],
      },
      competitors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            url: { type: "string" },
            positioning: { type: "string" },
            pricing: { type: "string" },
            gap: { type: "string" },
          },
          required: ["name", "positioning", "gap"],
        },
      },
      competitor_density: { type: "string", enum: ["low", "medium", "high"] },
      monetization: {
        type: "object",
        properties: {
          models: { type: "array", items: { type: "string" } },
          pricing_signals: { type: "array", items: { type: "string" } },
          willingness_to_pay: { type: "string" },
        },
        required: ["models", "pricing_signals", "willingness_to_pay"],
      },
      differentiation: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      recommendation: { type: "string", enum: ["advance", "park", "kill"] },
      rationale: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            note: { type: "string" },
          },
          required: ["title", "url"],
        },
      },
    },
    required: [
      "confidence",
      "pain_validated",
      "pain_evidence",
      "complexity_assessment",
      "simplicity_score",
      "audience",
      "competitors",
      "competitor_density",
      "monetization",
      "differentiation",
      "risks",
      "recommendation",
      "rationale",
      "sources",
    ],
  },
  // Cache the tool definition — stable across every run
  cache_control: { type: "ephemeral" },
};

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: MAX_SEARCH_USES,
};

// STATIC system prompt — cached. Everything here is run-invariant.
const SYSTEM_PROMPT = `You are a senior product researcher for Yonasol, a solo-operator AI product portfolio. Your job is to rigorously research whether an idea deserves to advance to validation.

YONASOL SCORING PHILOSOPHY
--------------------------
High pain + simple execution beats moat-via-complexity. Real problems for reachable people, shipped simply. Complexity is a tax, not an asset, unless it creates a durable moat proven in the research.

RESEARCH MANDATE
----------------
Use web_search liberally (up to ${MAX_SEARCH_USES} queries) to investigate:
1. Pain validation - are target users actually complaining about this problem? Find real quotes from Reddit, X/Twitter, HN, Substack, forums. Name sources.
2. Audience reachability - where does the ICP hang out? What channels could reach them for a validation signal?
3. Competitors - who already sells this or something adjacent? Pricing, positioning, reviews, gaps. Chrome Web Store, Product Hunt, Gumroad, Substack top charts, GitHub stars.
4. Monetization signals - what are people paying for in this space? Real pricing, not assumptions.
5. Complexity check - would this product be simple or gnarly to build, ship, sell, and support for one solo operator?
6. Differentiation - what's the defensible angle?
7. Risks - what would kill this idea in 90 days?

SCORING ANCHORS (confidence 0.0-1.0)
------------------------------------
0.0-0.4: kill - no pain, saturated, or wrong audience
0.4-0.7: park - some signal but not enough; needs reframing
0.7-0.85: advance - solid pain and reachable audience; go validate
0.85-1.0: high conviction - advance and prioritize

OUTPUT
------
You MUST call the record_research_finding tool with your complete analysis. Do not return prose. Tool call only.`;

function buildUserMessage(idea: any): string {
  return `IDEA
----
Title: ${idea.idea}
Type: ${idea.type ?? "unspecified"}
Pillar: ${idea.pillar ?? "unspecified"}
Target user: ${idea.target_user ?? "not yet specified"}
Monetization hypothesis: ${idea.monetization ?? "not yet specified"}
Source: ${idea.source ?? "unspecified"}
Operator scoring: pain=${idea.painful_problem} simplicity=${idea.simplicity} reach=${idea.reachable_user} validate_fast=${idea.validate_fast} buildable=${idea.buildable} low_opcost=${idea.low_opcost} weighted=${idea.weighted_score}

Research this idea and call record_research_finding with your analysis.`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!ANTHROPIC_API_KEY) {
    return json(
      {
        error: "missing_secret",
        detail:
          "ANTHROPIC_API_KEY is not set in Supabase Edge Function secrets. Set it via `supabase secrets set ANTHROPIC_API_KEY=...`",
      },
      500,
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const ideaId: string | undefined = body?.idea_id;
  const dryRun: boolean = body?.dry_run === true;

  if (!ideaId) {
    return json({ error: "idea_id_required" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: idea, error: fetchErr } = await sb
    .from("pipeline")
    .select("*")
    .eq("id", ideaId)
    .single();

  if (fetchErr || !idea) {
    return json(
      { error: "idea_not_found", detail: fetchErr?.message },
      404,
    );
  }

  if (idea.stage !== "researching") {
    return json(
      {
        error: "wrong_stage",
        detail: `idea must be in researching stage, got: ${idea.stage}`,
      },
      409,
    );
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const anthropicReq = {
    model: MODEL,
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [WEB_SEARCH_TOOL, RESEARCH_TOOL],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: buildUserMessage(idea) }],
  };

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicReq),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return json(
      {
        error: "anthropic_api_error",
        status: anthropicRes.status,
        detail: errText,
      },
      502,
    );
  }

  const anthropicJson = await anthropicRes.json();

  const toolUse = (anthropicJson.content ?? []).find(
    (c: any) => c.type === "tool_use" && c.name === "record_research_finding",
  );

  if (!toolUse) {
    return json(
      {
        error: "no_structured_output",
        detail: "claude did not return a record_research_finding tool_use block",
        response_block_types: (anthropicJson.content ?? []).map(
          (c: any) => c.type,
        ),
        stop_reason: anthropicJson.stop_reason,
      },
      502,
    );
  }

  const finding = toolUse.input;
  const completedAt = new Date().toISOString();

  // Extract cache telemetry from usage block
  const usage = anthropicJson.usage ?? {};
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const regularInputTokens = usage.input_tokens ?? 0;
  const totalInputTokens = regularInputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheHitRatio = totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0;

  const researchResult = {
    binding: "claude-researcher",
    binding_version: BINDING_VERSION,
    model: MODEL,
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    stop_reason: anthropicJson.stop_reason,
    usage,
    cache_telemetry: {
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
      regular_input_tokens: regularInputTokens,
      total_input_tokens: totalInputTokens,
      cache_hit_ratio: cacheHitRatio,
    },
    ...finding,
  };

  // Decide next stage
  let nextStage = idea.stage;
  if (
    finding.recommendation === "advance" &&
    finding.confidence >= ADVANCE_THRESHOLD
  ) {
    nextStage = "validating";
  } else if (
    finding.recommendation === "park" ||
    (finding.confidence < ADVANCE_THRESHOLD &&
      finding.confidence >= PARK_THRESHOLD)
  ) {
    nextStage = "parked";
  } else if (
    finding.recommendation === "kill" ||
    finding.confidence < PARK_THRESHOLD
  ) {
    nextStage = "killed";
  }

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      idea_id: ideaId,
      run_id: runId,
      would_transition_to: nextStage,
      research_result: researchResult,
    });
  }

  const updatePayload: any = {
    research_result: researchResult,
    research_synthesizer_binding: "claude-researcher",
  };

  if (nextStage !== idea.stage) {
    updatePayload.stage = nextStage;
    updatePayload._pending_transition = {
      reason: `claude-researcher ${BINDING_VERSION}: confidence=${finding.confidence}, recommendation=${finding.recommendation}`,
      triggered_by: "agent",
      evidence: {
        binding: "claude-researcher",
        binding_version: BINDING_VERSION,
        run_id: runId,
        confidence: finding.confidence,
        recommendation: finding.recommendation,
        competitor_density: finding.competitor_density,
        pain_validated: finding.pain_validated,
        simplicity_score_recommended: finding.simplicity_score,
        cache_hit_ratio: cacheHitRatio,
      },
    };
  }

  // Optionally update operator-facing simplicity if claude disagrees significantly
  if (
    typeof finding.simplicity_score === "number" &&
    Math.abs((idea.simplicity ?? 3) - finding.simplicity_score) >= 2
  ) {
    updatePayload.simplicity = finding.simplicity_score;
  }

  const { error: updateErr } = await sb
    .from("pipeline")
    .update(updatePayload)
    .eq("id", ideaId);

  if (updateErr) {
    return json(
      {
        error: "pipeline_update_failed",
        detail: updateErr.message,
        research_result: researchResult,
      },
      500,
    );
  }

  return json({
    ok: true,
    idea_id: ideaId,
    run_id: runId,
    binding_version: BINDING_VERSION,
    from_stage: idea.stage,
    to_stage: nextStage,
    transitioned: nextStage !== idea.stage,
    confidence: finding.confidence,
    recommendation: finding.recommendation,
    simplicity_recommended: finding.simplicity_score,
    simplicity_updated: updatePayload.simplicity !== undefined,
    cache_hit_ratio: cacheHitRatio,
    research_result: researchResult,
  });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
