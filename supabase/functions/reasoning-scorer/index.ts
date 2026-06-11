/**
 * reasoning-scorer — Edge Function (v7)
 *
 * Multi-model debiasing layer for the idea pipeline. Scores ideas through
 * multiple reasoning models via OpenRouter, computes cross-model consensus,
 * and auto-transitions ideas based on consensus recommendation.
 *
 * v7 changes (2026-06-10):
 *   - FIX: findNextMissing paginates through ALL researched ideas. v6 scanned
 *     only the oldest 200 (.limit(200)); once those were fully scored the
 *     scorer reported "all_ideas_fully_scored" forever while newer ideas piled
 *     up unscored. Silent stall began 2026-04-14 when the pipeline crossed
 *     200 researched rows; 267 ideas were stuck in researching by 2026-06-10.
 *   - Scan errors surface as scan_failed (HTTP 500) instead of being
 *     collapsed into "all_ideas_fully_scored" (Codex review finding).
 *   - First version with a repo home: open-brain/supabase/functions/reasoning-scorer.
 *
 * v6 changes:
 *   - Writes decision metadata for ALL recommendations including 'advance'
 *     (previously only wrote for kill/park). Fixes audit gap.
 *
 * v4/v5 changes:
 *   - Auto-transition: after consensus, moves idea to killed/parked/validating
 *   - Override: skips auto-transition if `decision` column is non-null (manual override)
 *   - Audit: sets _pending_transition for trigger-based audit logging (ADR-010/013)
 *
 * Modes:
 *   POST { idea_id, model? }            — Score one idea with one model
 *   POST { idea_id, model?, dry_run }   — Score without writing
 *   POST { next: true }                 — Pick next missing idea-model pair (for cron)
 *   POST { batch: true, limit? }        — Score all missing idea-model pairs
 *
 * Config (public.config table):
 *   REASONING_SCORER_MODELS  — Comma-separated OpenRouter model IDs
 *   REASONING_SCORER_MODEL   — Legacy single-model fallback
 *
 * Secrets: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------- MODEL ALIAS ----------

const ALIAS_MAP: Record<string, string> = {
  "deepseek/deepseek-chat-v3-0324": "deepseek-v3",
  "google/gemini-2.5-flash": "gemini-flash",
};

function modelAlias(modelId: string): string {
  if (ALIAS_MAP[modelId]) return ALIAS_MAP[modelId];
  const parts = modelId.split("/");
  return parts[parts.length - 1].replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
}

// ---------- SYSTEM PROMPT ----------

const SYSTEM_PROMPT = `You are a scoring analyst for a solo micro-SaaS operator's idea pipeline. You receive research evidence gathered by a separate search agent. Your job is to independently score the idea based ONLY on the evidence provided.

You are a second opinion. The search agent already scored this idea. Your job is to catch bias, over-optimism, or missed red flags by evaluating the same evidence with fresh eyes.

SCORING RUBRIC (v2):

1. pain_signal (1-5, weight 0.25)
   1 = No evidence of pain found in the research
   2 = Vague mentions, "would be nice" sentiment
   3 = Some forum posts but mild frustration
   4 = Multiple passionate threads, clear frustration
   5 = Hair-on-fire, people begging for a solution, spending time on workarounds

2. willingness_to_pay (1-5, weight 0.20)
   1 = Everything in this space is free/open source, no pricing found
   2 = Competitors exist but all under $10/mo
   3 = Some paid tools at $20-50/mo range
   4 = Healthy market at $50-150/mo with paying customers
   5 = Established spend at $100+/mo, low churn signals, enterprise buyers

3. distribution_clarity (1-5, weight 0.20)
   1 = Vague audience, no specific channels identified in evidence
   2 = Broad category ("small businesses") but no named communities
   3 = Identifiable communities found but competitive channels
   4 = Specific subreddits/groups/marketplaces named with active discussion
   5 = Multiple specific channels with plausible organic CAC under $50

4. niche_leverage (1-5, weight 0.15)
   1 = Hyper-specific to one niche, no abstraction path
   2 = Maybe 1 adjacent niche with significant work
   3 = Works for 2-3 adjacent niches with moderate customization
   4 = Clear path to 3-5 verticals with the same core
   5 = Core product serves 5+ verticals with <20% customization

5. compounding_asset_score (1-5, weight 0.10)
   1 = Stateless utility, zero switching cost
   2 = Some configuration but easily exportable
   3 = Moderate data/config lock-in after months of use
   4 = Significant workflow integration, painful to switch
   5 = Deep data moat, network effects, or accumulated intelligence

6. platform_independence_score (1-5, weight 0.10)
   1 = Entirely dependent on one platform (Chrome store, single API)
   2 = Primary distribution is one platform but could survive without it
   3 = Uses a platform but has alternative distribution paths
   4 = Multi-platform or platform-optional
   5 = Standalone product, fully owns its distribution

PENALTY FLAGS:
- commodity_trap: true if willingness_to_pay <= 1 AND compounding_asset_score <= 2
- single_platform: true if platform_independence_score = 1
- easy_clone_trap: true if the evidence suggests the product is trivially replicable AND compounding_asset_score <= 2

CONFIDENCE (0.0 to 1.0):
Your overall confidence in the idea's viability. Derive it from your scores:
- If most scores are 4-5 with no penalty flags: 0.7-0.9
- If scores are mixed (some 3s, some 4s): 0.5-0.7
- If most scores are 1-2 or any penalty flag is true: 0.2-0.5
- If multiple penalty flags or most scores are 1: below 0.3

RECOMMENDATION:
- "advance" if confidence >= 0.7 and no penalty flags
- "park" if confidence 0.4-0.7 or mixed signals
- "kill" if confidence < 0.4 or multiple penalty flags

SCORING RULES:
- Score ONLY based on evidence provided. If evidence is thin on a dimension, score it 2-3 (uncertain), never inflate.
- If no competitor pricing was found, willingness_to_pay should be 2 or below.
- If no specific distribution channels were named, distribution_clarity should be 2 or below.
- Be skeptical of high scores. The search agent may have been optimistic.

RESPONSE FORMAT:
Respond with ONLY a valid JSON object. No markdown, no code fences, no explanation outside the JSON.
You MUST include ALL of these fields in your response:
- pain_signal (number 1-5)
- willingness_to_pay (number 1-5)
- distribution_clarity (number 1-5)
- niche_leverage (number 1-5)
- compounding_asset_score (number 1-5)
- platform_independence_score (number 1-5)
- confidence (number 0.0-1.0)
- recommendation (string: "advance", "park", or "kill")
- commodity_trap (boolean)
- single_platform (boolean)
- easy_clone_trap (boolean)
- scoring_notes (string: 2-3 sentences on where you agree or disagree with the search agent)
- divergence_flags (array of strings: dimensions where your score differs by 2+ from search agent, empty array if aligned)

Do NOT omit any field. Every field listed above is required.`;

// ---------- EVIDENCE BUILDER ----------

function buildEvidencePrompt(
  idea: Record<string, unknown>,
  rr: Record<string, unknown>
): string {
  const parts: string[] = [];
  parts.push(`## Idea`);
  parts.push(`**Title:** ${idea.idea || idea.title || "Untitled"}`);
  if (idea.type) parts.push(`**Type:** ${idea.type}`);
  if (idea.target_user) parts.push(`**Target User:** ${idea.target_user}`);
  if (idea.monetization) parts.push(`**Monetization:** ${idea.monetization}`);
  parts.push(``);
  parts.push(`## Search Agent's Evidence`);
  if (rr.market_summary) parts.push(`**Market Summary:** ${rr.market_summary}`);
  const competitors = rr.competitors as Array<Record<string, unknown>> | undefined;
  if (competitors && competitors.length > 0) {
    parts.push(``);
    parts.push(`**Competitors Found (${competitors.length}):**`);
    for (const c of competitors) {
      parts.push(`- ${c.name}${c.url ? ` (${c.url})` : ''}: pricing=${c.pricing || 'unknown'}, users=${c.users_estimate || 'unknown'}, gap=${c.gap || 'none noted'}`);
    }
  } else {
    parts.push(`**Competitors:** None found by search agent.`);
  }
  const channels = rr.distribution_channels as string[] | undefined;
  if (channels && channels.length > 0) {
    parts.push(``);
    parts.push(`**Distribution Channels Found:** ${channels.join(', ')}`);
  } else {
    parts.push(`**Distribution Channels:** None specifically identified.`);
  }
  if (rr.pain_evidence_count) parts.push(`**Pain Evidence Count:** ${rr.pain_evidence_count} distinct signals`);
  if (rr.pain_evidence) parts.push(`**Pain Evidence:** ${rr.pain_evidence}`);
  if (rr.niche_leverage_notes) parts.push(`**Niche Leverage Notes:** ${rr.niche_leverage_notes}`);
  if (rr.kill_reason && String(rr.kill_reason).length > 0) parts.push(`**Kill Reason (from search agent):** ${rr.kill_reason}`);
  const gaps = rr.gaps as string[] | undefined;
  if (gaps && gaps.length > 0) parts.push(`**Gaps (unanswered questions):** ${gaps.join('; ')}`);
  const sources = rr.sources as Array<Record<string, unknown>> | undefined;
  if (sources && sources.length > 0) {
    parts.push(``);
    parts.push(`**Sources (${sources.length} citations):**`);
    for (const s of sources.slice(0, 10)) parts.push(`- ${s.title || s.url}`);
  }
  parts.push(``);
  parts.push(`## Search Agent's Scores (for comparison -- form your own independent opinion)`);
  parts.push(`pain_signal: ${rr.pain_signal ?? 'not scored'}`);
  parts.push(`willingness_to_pay: ${rr.willingness_to_pay ?? 'not scored'}`);
  parts.push(`distribution_clarity: ${rr.distribution_clarity ?? 'not scored'}`);
  parts.push(`niche_leverage: ${rr.niche_leverage ?? 'not scored'}`);
  parts.push(`compounding_asset_score: ${rr.compounding_asset_score ?? 'not scored'}`);
  parts.push(`platform_independence_score: ${rr.platform_independence_score ?? 'not scored'}`);
  parts.push(`confidence: ${rr.confidence ?? 'not scored'}`);
  parts.push(`recommendation: ${rr.recommendation ?? 'not scored'}`);
  parts.push(``);
  parts.push(`Score this idea independently. Respond with ONLY a JSON object containing ALL required fields. No markdown, no code fences.`);
  return parts.join('\n');
}

// ---------- CONFIG ----------

async function getConfig(supabase: ReturnType<typeof createClient>, key: string, fallback: string): Promise<string> {
  const { data } = await supabase.from("config").select("value").eq("key", key).single();
  return data?.value || fallback;
}

async function getConfiguredModels(supabase: ReturnType<typeof createClient>): Promise<string[]> {
  const multi = await getConfig(supabase, "REASONING_SCORER_MODELS", "");
  if (multi.trim()) return multi.split(",").map((m: string) => m.trim()).filter(Boolean);
  const single = await getConfig(supabase, "REASONING_SCORER_MODEL", "deepseek/deepseek-chat-v3-0324");
  return [single];
}

// ---------- WEIGHTED SCORE ----------

function computeWeightedScore(s: Record<string, unknown>): number {
  const ps = Math.max(1, Math.min(5, Number(s.pain_signal) || 3));
  const wtp = Math.max(1, Math.min(5, Number(s.willingness_to_pay) || 3));
  const dc = Math.max(1, Math.min(5, Number(s.distribution_clarity) || 3));
  const nl = Math.max(1, Math.min(5, Number(s.niche_leverage) || 3));
  const cas = Math.max(1, Math.min(5, Number(s.compounding_asset_score) || 3));
  const pis = Math.max(1, Math.min(5, Number(s.platform_independence_score) || 3));
  const simp = Math.max(1, Math.min(5, Number(s.simplicity_score) || 3));
  let base = ps * 0.25 + wtp * 0.20 + dc * 0.20 + nl * 0.15 + cas * 0.10 + pis * 0.10;
  if (wtp <= 1 && cas <= 2) base -= Math.max(0, base) * 0.15;
  if (pis === 1) base -= Math.max(0, base) * 0.10;
  if (simp >= 4 && cas <= 2) base -= Math.max(0, base) * 0.10;
  return Math.round(Math.max(0, Math.min(5, base)) * 100) / 100;
}

// ---------- FALLBACKS ----------

function deriveConfidence(s: Record<string, unknown>): number {
  const ws = computeWeightedScore(s);
  return Math.round(Math.max(0, Math.min(1, ws / 5)) * 100) / 100;
}

function deriveRecommendation(confidence: number, flags: Record<string, unknown>): string {
  if (confidence >= 0.7 && !flags.commodity_trap && !flags.single_platform && !flags.easy_clone_trap) return "advance";
  if (confidence < 0.4 || (flags.commodity_trap && flags.single_platform)) return "kill";
  return "park";
}

function detectDivergence(parsed: Record<string, unknown>, rr: Record<string, unknown>): string[] {
  const dims = ["pain_signal", "willingness_to_pay", "distribution_clarity", "niche_leverage", "compounding_asset_score", "platform_independence_score"];
  const flags: string[] = [];
  for (const dim of dims) {
    const ours = Number(parsed[dim]);
    const theirs = Number(rr[dim]);
    if (Number.isFinite(ours) && Number.isFinite(theirs) && Math.abs(ours - theirs) >= 2) flags.push(dim);
  }
  return flags;
}

// ---------- CONSENSUS ----------

function computeConsensus(modelResults: Record<string, Record<string, unknown>>, rr: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(modelResults).filter(k => !k.startsWith("_"));
  if (keys.length < 2) return {};
  const dims = ["pain_signal", "willingness_to_pay", "distribution_clarity", "niche_leverage", "compounding_asset_score", "platform_independence_score"];
  const consensus: Record<string, unknown> = { model_count: keys.length, models_used: keys, computed_at: new Date().toISOString() };
  for (const dim of dims) {
    const values = keys.map(k => Number(modelResults[k][dim])).filter(Number.isFinite);
    if (values.length > 0) consensus[dim] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 2) / 2;
  }
  const confidences = keys.map(k => Number(modelResults[k].confidence)).filter(Number.isFinite);
  if (confidences.length > 0) consensus.confidence = Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100;
  consensus.weighted_score = computeWeightedScore(consensus);
  consensus.commodity_trap = keys.some(k => modelResults[k].commodity_trap === true);
  consensus.single_platform = keys.some(k => modelResults[k].single_platform === true);
  consensus.easy_clone_trap = keys.some(k => modelResults[k].easy_clone_trap === true);
  consensus.recommendation = deriveRecommendation(consensus.confidence as number, consensus);
  const crossModelDivergence: string[] = [];
  for (const dim of dims) {
    const values = keys.map(k => Number(modelResults[k][dim])).filter(Number.isFinite);
    if (values.length >= 2) {
      const max = Math.max(...values), min = Math.min(...values);
      if (max - min >= 2) crossModelDivergence.push(`${dim}: ${keys.map(k => `${k}=${modelResults[k][dim]}`).join(', ')} (spread=${max - min})`);
    }
  }
  consensus.cross_model_divergence = crossModelDivergence;
  const vsSearchDivergence: string[] = [];
  for (const dim of dims) {
    const cv = Number(consensus[dim]), sv = Number(rr[dim]);
    if (Number.isFinite(cv) && Number.isFinite(sv) && Math.abs(cv - sv) >= 2) vsSearchDivergence.push(`${dim}: consensus=${cv} search=${sv}`);
  }
  consensus.vs_search_divergence = vsSearchDivergence;
  consensus.search_agent_confidence = rr.confidence;
  consensus.search_agent_recommendation = rr.recommendation;
  return consensus;
}

// ---------- AUTO-TRANSITION ----------

const RECOMMENDATION_TO_STAGE: Record<string, string> = { kill: "killed", park: "parked", advance: "validating" };
const AUTO_TRANSITION_FROM_STAGES = new Set(["researching", "new", "parked", "killed"]);

interface TransitionResult { transitioned: boolean; from_stage?: string; to_stage?: string; skipped_reason?: string; }

async function maybeAutoTransition(
  supabase: ReturnType<typeof createClient>,
  ideaId: string,
  idea: Record<string, unknown>,
  consensus: Record<string, unknown>
): Promise<TransitionResult> {
  const recommendation = consensus.recommendation as string;
  const targetStage = RECOMMENDATION_TO_STAGE[recommendation];
  if (!targetStage) return { transitioned: false, skipped_reason: `unknown_recommendation: ${recommendation}` };

  // Override: if decision is manually set, skip auto-transition
  if (idea.decision != null && String(idea.decision).length > 0) {
    return { transitioned: false, skipped_reason: `manual_override: decision=${idea.decision}`, from_stage: idea.stage as string, to_stage: targetStage };
  }

  const currentStage = idea.stage as string;
  if (currentStage === targetStage) return { transitioned: false, skipped_reason: "already_in_target_stage", from_stage: currentStage, to_stage: targetStage };
  if (!AUTO_TRANSITION_FROM_STAGES.has(currentStage)) return { transitioned: false, skipped_reason: `stage_not_eligible: ${currentStage}`, from_stage: currentStage, to_stage: targetStage };

  const modelsUsed = (consensus.models_used as string[])?.join('+') || 'unknown';
  const pendingTransition = {
    reason: `reasoning-scorer consensus: ${recommendation} (confidence=${consensus.confidence}, weighted_score=${consensus.weighted_score}, models=${modelsUsed})`,
    triggered_by: "agent",
    evidence: {
      consensus_recommendation: recommendation,
      consensus_confidence: consensus.confidence,
      consensus_weighted_score: consensus.weighted_score,
      cross_model_divergence: consensus.cross_model_divergence,
      model_count: consensus.model_count,
    },
  };

  const updatePayload: Record<string, unknown> = {
    stage: targetStage,
    _pending_transition: pendingTransition,
  };

  // v6: Write decision metadata for ALL recommendations (kill, park, AND advance)
  const divergenceNote = (consensus.cross_model_divergence as string[])?.length > 0
    ? 'Cross-model divergence: ' + (consensus.cross_model_divergence as string[]).join('; ')
    : 'No cross-model divergence.';
  updatePayload.decision = recommendation;
  updatePayload.decision_confidence = consensus.confidence;
  updatePayload.decided_by = "agent";
  updatePayload.decision_notes = `Auto-${recommendation} by reasoning-scorer consensus (${modelsUsed}). Weighted score: ${consensus.weighted_score}. ${divergenceNote}`;

  const { error } = await supabase.from("pipeline").update(updatePayload).eq("id", ideaId);
  if (error) return { transitioned: false, skipped_reason: `db_error: ${error.message}`, from_stage: currentStage, to_stage: targetStage };
  return { transitioned: true, from_stage: currentStage, to_stage: targetStage };
}

// ---------- MIGRATION ----------

function migrateV2ToV3(existing: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (existing.scorer === "reasoning-scorer" && typeof existing.model === "string") {
    return { [modelAlias(existing.model as string)]: existing };
  }
  return existing as Record<string, Record<string, unknown>>;
}

// ---------- SCORE ONE IDEA ----------

interface ScoreResult {
  ok: boolean; idea_id: string; dry_run?: boolean; model?: string; model_alias?: string;
  reasoning_score?: Record<string, unknown>; consensus_computed?: boolean;
  transition?: TransitionResult; latency_ms?: number; error?: string;
}

async function scoreIdea(
  supabase: ReturnType<typeof createClient>, openrouterKey: string, model: string,
  ideaId: string, dryRun: boolean, allConfiguredModels: string[]
): Promise<ScoreResult> {
  const startTime = Date.now();
  const alias = modelAlias(model);
  const { data: idea, error: fetchErr } = await supabase.from("pipeline").select("*").eq("id", ideaId).single();
  if (fetchErr || !idea) return { ok: false, idea_id: ideaId, error: fetchErr?.message || "not_found" };
  const rr = idea.research_result as Record<string, unknown> | null;
  if (!rr) return { ok: false, idea_id: ideaId, error: "no_research_result" };

  const evidencePrompt = buildEvidencePrompt(idea, rr);
  let orResponse: Response;
  try {
    orResponse = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${openrouterKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://yonasol.com", "X-Title": "Yonasol Reasoning Scorer" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: evidencePrompt }], response_format: { type: "json_object" }, temperature: 0.1, max_tokens: 2000 }),
    });
  } catch (err) { return { ok: false, idea_id: ideaId, error: `openrouter_network: ${err}` }; }
  if (!orResponse.ok) { const detail = await orResponse.text(); return { ok: false, idea_id: ideaId, model, error: `openrouter_${orResponse.status}: ${detail.slice(0, 300)}` }; }

  const orResult = await orResponse.json();
  const content = orResult.choices?.[0]?.message?.content || "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch { return { ok: false, idea_id: ideaId, error: "json_parse_failed", model }; } }
    else return { ok: false, idea_id: ideaId, error: "no_json_in_response", model };
  }

  // Fill missing fields
  const hasPenalties = {
    commodity_trap: parsed.commodity_trap === true || (Number(parsed.willingness_to_pay) <= 1 && Number(parsed.compounding_asset_score) <= 2),
    single_platform: parsed.single_platform === true || Number(parsed.platform_independence_score) === 1,
    easy_clone_trap: parsed.easy_clone_trap === true,
  };
  if (typeof parsed.commodity_trap !== "boolean") parsed.commodity_trap = hasPenalties.commodity_trap;
  if (typeof parsed.single_platform !== "boolean") parsed.single_platform = hasPenalties.single_platform;
  if (typeof parsed.easy_clone_trap !== "boolean") parsed.easy_clone_trap = hasPenalties.easy_clone_trap;
  let confDerived = false, recDerived = false;
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence as number)) { parsed.confidence = deriveConfidence(parsed); confDerived = true; }
  if (typeof parsed.recommendation !== "string" || !["advance", "park", "kill"].includes(parsed.recommendation as string)) { parsed.recommendation = deriveRecommendation(parsed.confidence as number, hasPenalties); recDerived = true; }
  if (!parsed.scoring_notes || typeof parsed.scoring_notes !== "string") parsed.scoring_notes = "Model did not provide scoring notes.";
  if (!Array.isArray(parsed.divergence_flags)) parsed.divergence_flags = detectDivergence(parsed, rr);

  const latency = Date.now() - startTime;
  const modelResult: Record<string, unknown> = {
    scorer: "reasoning-scorer", scorer_version: "v7", model, model_alias: alias, provider: "openrouter",
    scored_at: new Date().toISOString(), latency_ms: latency, usage: orResult.usage || {},
    pain_signal: parsed.pain_signal, willingness_to_pay: parsed.willingness_to_pay, distribution_clarity: parsed.distribution_clarity,
    niche_leverage: parsed.niche_leverage, compounding_asset_score: parsed.compounding_asset_score, platform_independence_score: parsed.platform_independence_score,
    confidence: parsed.confidence, recommendation: parsed.recommendation, weighted_score_reasoning: computeWeightedScore(parsed),
    commodity_trap: parsed.commodity_trap, single_platform: parsed.single_platform, easy_clone_trap: parsed.easy_clone_trap,
    scoring_notes: parsed.scoring_notes, divergence_flags: parsed.divergence_flags,
    _confidence_derived: confDerived, _recommendation_derived: recDerived,
    search_agent_confidence: rr.confidence, search_agent_recommendation: rr.recommendation,
    confidence_delta: typeof parsed.confidence === "number" && typeof rr.confidence === "number" ? Math.round(((parsed.confidence as number) - (rr.confidence as number)) * 100) / 100 : null,
  };

  if (dryRun) return { ok: true, idea_id: ideaId, dry_run: true, model, model_alias: alias, reasoning_score: modelResult, latency_ms: latency };

  // Merge into existing reasoning_score
  let existing: Record<string, Record<string, unknown>> = {};
  if (idea.reasoning_score) existing = migrateV2ToV3(idea.reasoning_score as Record<string, unknown>);
  existing[alias] = modelResult;

  // Consensus
  let consensusComputed = false;
  let transition: TransitionResult | undefined;
  const allAliases = allConfiguredModels.map(modelAlias);
  if (allAliases.every(a => existing[a]) && allAliases.length >= 2) {
    const modelResultsOnly: Record<string, Record<string, unknown>> = {};
    for (const a of allAliases) modelResultsOnly[a] = existing[a];
    existing["_consensus"] = computeConsensus(modelResultsOnly, rr);
    consensusComputed = true;
  }

  const { error: updateErr } = await supabase.from("pipeline").update({ reasoning_score: existing }).eq("id", ideaId);
  if (updateErr) return { ok: false, idea_id: ideaId, model, model_alias: alias, reasoning_score: modelResult, latency_ms: latency, error: `db_write_failed: ${updateErr.message}` };

  // Auto-transition after consensus
  if (consensusComputed && existing["_consensus"]) {
    const { data: freshIdea } = await supabase.from("pipeline").select("id, stage, decision").eq("id", ideaId).single();
    if (freshIdea) transition = await maybeAutoTransition(supabase, ideaId, freshIdea, existing["_consensus"]);
  }

  return { ok: true, idea_id: ideaId, model, model_alias: alias, reasoning_score: modelResult, consensus_computed: consensusComputed, transition, latency_ms: latency };
}

// ---------- FIND NEXT MISSING ----------

const SCAN_PAGE_SIZE = 200;

interface NextMissingResult { pick: { ideaId: string; model: string } | null; scanError: string | null; }

async function findNextMissing(supabase: ReturnType<typeof createClient>, configuredModels: string[]): Promise<NextMissingResult> {
  // v7: paginate through ALL researched ideas, oldest first. v6 capped the
  // scan at the oldest 200 rows; once those were fully scored, every newer
  // idea was invisible and the scorer stalled silently ("all_ideas_fully_scored").
  // Offset pagination is stable here: ordering is (created_at, id) and rows
  // never change created_at, so pages are deterministic between calls.
  // A page-fetch error is surfaced as scanError — NOT collapsed into
  // "exhausted" — so the cron path fails loudly instead of going falsely green.
  for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
    const { data: ideas, error } = await supabase.from("pipeline")
      .select("id, reasoning_score")
      .not("research_result", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + SCAN_PAGE_SIZE - 1);
    if (error) return { pick: null, scanError: error.message };
    if (!ideas || ideas.length === 0) return { pick: null, scanError: null };
    for (const idea of ideas) {
      let existing: Record<string, Record<string, unknown>> = {};
      if (idea.reasoning_score) {
        const rs = idea.reasoning_score as Record<string, unknown>;
        existing = rs.scorer === "reasoning-scorer" ? migrateV2ToV3(rs) : rs as Record<string, Record<string, unknown>>;
      }
      for (const model of configuredModels) {
        if (!existing[modelAlias(model)]) return { pick: { ideaId: idea.id, model }, scanError: null };
      }
    }
    if (ideas.length < SCAN_PAGE_SIZE) return { pick: null, scanError: null };
  }
}

// ---------- HANDLER ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  let body: { idea_id?: string; model?: string; dry_run?: boolean; batch?: boolean; next?: boolean; limit?: number };
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

  const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openrouterKey) return new Response(JSON.stringify({ error: "missing_secret", detail: "OPENROUTER_API_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const configuredModels = await getConfiguredModels(supabase);

  if (body.next) {
    const { pick: missing, scanError } = await findNextMissing(supabase, configuredModels);
    if (scanError) return new Response(JSON.stringify({ ok: false, picked: false, error: `scan_failed: ${scanError}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!missing) return new Response(JSON.stringify({ ok: true, picked: false, reason: "all_ideas_fully_scored", configured_models: configuredModels.map(modelAlias) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const result = await scoreIdea(supabase, openrouterKey, missing.model, missing.ideaId, false, configuredModels);
    return new Response(JSON.stringify({ ...result, picked: true }), { status: result.ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (body.idea_id) {
    const model = body.model || configuredModels[0];
    const result = await scoreIdea(supabase, openrouterKey, model, body.idea_id, body.dry_run === true, configuredModels);
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (body.batch) {
    const limit = Math.min(body.limit || 20, 100);
    const results: ScoreResult[] = []; let scored = 0, failed = 0; let batchScanError: string | null = null;
    for (let i = 0; i < limit; i++) {
      const { pick: missing, scanError } = await findNextMissing(supabase, configuredModels);
      if (scanError) { batchScanError = scanError; break; }
      if (!missing) break;
      const result = await scoreIdea(supabase, openrouterKey, missing.model, missing.ideaId, false, configuredModels);
      results.push(result); if (result.ok) scored++; else failed++;
    }
    return new Response(JSON.stringify({ ok: batchScanError === null, ...(batchScanError ? { error: `scan_failed: ${batchScanError}` } : {}), configured_models: configuredModels.map(m => ({ id: m, alias: modelAlias(m) })), scored, failed, total: scored + failed, results }), { status: batchScanError ? 500 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "provide idea_id, next:true, or batch:true" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
