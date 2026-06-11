/**
 * perplexity-researcher — Edge Function (v5)
 *
 * Micro-SaaS idea researcher for a solo operator running a product portfolio.
 * Uses Perplexity Sonar Pro for web research + structured output.
 *
 * v5 changes (2026-06-10, per HANDOFF-upstream-fixes-demand-validator.md §6):
 *   - product_type classification (saas | chrome_extension | mobile_app |
 *     marketplace | directory | digital_product | productized_service | api |
 *     other) in schema + prompt; extracted to pipeline.type when NULL.
 *   - Competitor entries gain users_estimate_numeric (integer|null),
 *     confidence (high|medium|low), pricing_url. Prompt forbids padding the
 *     list to a fixed count (Gap 5) and requires no_competitors_reason when
 *     the array is empty.
 *   - competitor_density qualitative enum (none|low|moderate|high|saturated)
 *     added alongside the existing competitor_count integer.
 *   - Sources fix (Gap 3 root cause): v4 built sources[] only from
 *     pxResult.citations, which the Perplexity API deprecated in favor of
 *     search_results — empty citations meant zero sources. v5 asks the model
 *     for typed key sources (url/title/type) in the schema AND merges in
 *     search_results ?? citations as ground truth, deduped by URL.
 *   - This repo copy replaces a stale v1 file; it now matches what is
 *     deployed (the prior deployed v4 had no repo home — drift fixed).
 *
 * v4 changes:
 *   - REMOVED auto-transition. Idea stays in 'researching' after research completes.
 *     Reasoning-scorer is now the sole transition authority (Gap 6 fix).
 *   - Added willingness_to_pay, distribution_clarity, niche_leverage to column
 *     extraction (absorbs scoring-agent's role for new ideas).
 *   - All 9 scoring columns now written in one pass.
 *
 * v3 changes:
 *   - New scoring rubric: pain_signal(0.25), willingness_to_pay(0.20),
 *     distribution_clarity(0.20), niche_leverage(0.15), compounding_asset(0.10),
 *     platform_independence(0.10)
 *   - Dropped simplicity_score from weighted calc (still collected for context)
 *   - Added willingness_to_pay, distribution_clarity, niche_leverage fields
 *   - Percentage-based penalties instead of flat
 *   - Pulls idea_sources.structured_extract for richer context
 *
 * Cost: ~$0.01-0.02/idea
 * Latency: ~10-30s
 *
 * Interface:
 *   POST { idea_id: UUID, dry_run?: boolean }
 *
 * Secrets: PERPLEXITY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------- SYSTEM PROMPT ----------

const SYSTEM_PROMPT = `You are a startup idea researcher for a solo micro-SaaS operator who runs a portfolio of small, profitable products. Your job is to evaluate whether a product idea has real signal — meaning real people with real pain who would pay for a solution.

CONTEXT: This operator targets $1K-10K MRR per product. They build vertical SaaS tools for specific niches, often with a "90% reusable core + niche-specific skin" architecture so one codebase can serve multiple verticals. A Chrome extension for one niche is less interesting than a workflow tool that can be reskinned for 5 niches.

You have access to the live web. Search aggressively. Evaluate these 6 dimensions:

1. PAIN SIGNAL — Are people complaining about this problem on Reddit, forums, X, Product Hunt, app store reviews? Look for "is there a tool that..." and "I wish..." posts. Quantify: how many threads, how recent, how emotional. "Hair on fire" problems score 5. Nice-to-haves score 1-2.

2. WILLINGNESS TO PAY — Are people ALREADY paying for solutions to this problem? Find competitor pricing. The sweet spot is $49-149/mo per seat. If every competitor is free or <$5/mo, the market doesn't value the solution — that's a red flag. If competitors charge $50+/mo with paying customers, that validates the market. Score based on existing spend in the market, not theoretical willingness.

3. DISTRIBUTION CLARITY — Can you name the SPECIFIC channel to reach buyers? Which subreddit, Facebook group, Slack community, marketplace, or keyword cluster? Is organic CAC plausibly under $50? "Small businesses" is a 1. "Independent yoga studio owners who post in r/yogateachers and search 'yoga studio scheduling software'" is a 5. The more specific the channel, the higher the score.

4. NICHE LEVERAGE — Can the core product be built once and reskinned for multiple verticals? A scheduling tool for yoga studios that also works for pilates studios, martial arts gyms, and dance schools scores high. A compliance tool for one specific regulation in one country scores low. Think: "How many niches can this serve with <20% customization?" 1 niche = score 1-2. 3-5 niches = score 3-4. 5+ clear niches = score 5.

5. COMPOUNDING ASSET — Does usage generate data, workflow lock-in, or switching costs? At micro-SaaS scale this is about retention, not network effects. A tool where customers upload their data and build workflows scores higher than a stateless utility. Score based on how hard it would be to switch away after 6 months of use.

6. PLATFORM INDEPENDENCE — Does this idea depend on a single platform's API, marketplace, or algorithm? Chrome extensions, social media tools, and single-API wrappers score 1-2. A standalone web app that owns its distribution scores 4-5.

PRODUCT TYPE CLASSIFICATION:
Classify this idea into exactly one type based on the product description and competitive landscape:
- saas: Web-based software with recurring revenue
- chrome_extension: Browser extension distributed via Chrome Web Store
- mobile_app: iOS/Android native or hybrid app
- marketplace: Two-sided platform connecting buyers and sellers
- directory: Curated listing/database product
- digital_product: One-time purchase (templates, courses, tools)
- productized_service: Service delivered with software wrapper
- api: Developer-facing API product
- other: Doesn't fit above categories

COMPETITOR DATA REQUIREMENTS:
- List every real competitor you found. Do NOT pad to a specific count. If you found 2, list 2. If you found 7, list 7.
- For each competitor, include the URL to their homepage if found. Also include a direct link to their pricing page if it exists (usually /pricing or /plans).
- Estimate total users as a single integer in users_estimate_numeric. If the source says "50k+", write 50000. If "thousands", write 5000. If truly unknown, write null.
- Rate your confidence in each competitor entry: high (verified from multiple sources), medium (single source or inferred), low (guessed).
- If no competitors exist, explain why in no_competitors_reason.

SOURCE URL REQUIREMENTS:
- You MUST return at least 3 source URLs from your research in the sources array. These must be actual web pages you found and referenced — never search queries, never descriptions, never fabricated URLs.
- Each source needs a type classification: competitor_page, review_site, community_thread, news, documentation.

CRITICAL SCORING GUIDANCE:
- $1K MRR is a valid success milestone. Don't penalize ideas for having a small TAM if the niche is deep and reachable.
- "Simple to build" is NOT a positive signal. If it's simple to build, it's simple to clone. Never let build ease inflate your confidence.
- If you can't find anyone paying for a solution to this problem, confidence should be below 0.5 regardless of how painful it seems.
- The competitor sweet spot is 4-12 existing players. Fewer = unproven market. 15+ with funded players = red flag.
- Always check for the "free alternative" trap: if there's a well-maintained open source or free tool that solves 80% of the problem, score willingness_to_pay lower.

When SOURCE INTELLIGENCE is provided below the idea, use it heavily. It contains curated pain points, business models, build strategies, and trend signals from newsletter analysis. Cross-reference these claims against what you find on the web. If the source intelligence contradicts web evidence, trust the web.

Be brutally honest. The operator's time is the most expensive resource. A false positive (advancing a bad idea) costs weeks of build time. A false negative (killing a good idea) just means it comes back later with better signal.

Return your findings as structured JSON matching the required schema.`;

// ---------- OUTPUT SCHEMA ----------

const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    confidence: {
      type: "number",
      description:
        "Overall confidence in this idea's viability, 0.0 to 1.0. Above 0.7 = strong signal, advance. 0.4-0.7 = mixed, park. Below 0.4 = kill.",
    },
    recommendation: {
      type: "string",
      enum: ["advance", "park", "kill"],
      description:
        "advance = strong signal, move to validation. park = mixed signal, revisit later. kill = no signal or fatal flaw.",
    },
    product_type: {
      type: "string",
      enum: [
        "saas",
        "chrome_extension",
        "mobile_app",
        "marketplace",
        "directory",
        "digital_product",
        "productized_service",
        "api",
        "other",
      ],
      description:
        "Exactly one product type, per the PRODUCT TYPE CLASSIFICATION guidance.",
    },
    pain_signal: {
      type: "number",
      description:
        "1-5. Strength of validated pain. 1 = no evidence of pain. 3 = some forum posts but mild. 5 = hair-on-fire, multiple passionate threads, people begging for a solution.",
    },
    pain_evidence_count: {
      type: "integer",
      description:
        "Number of distinct pain signals found (forum threads, review complaints, social posts, app store reviews).",
    },
    willingness_to_pay: {
      type: "number",
      description:
        "1-5. Evidence that people pay for solutions to this problem. 1 = everything is free/open source. 2 = competitors exist but all under $10/mo. 3 = some paid tools at $20-50/mo. 4 = healthy market at $50-150/mo. 5 = established spend at $100+/mo with low churn signals.",
    },
    distribution_clarity: {
      type: "number",
      description:
        "1-5. How specific and reachable is the buyer channel? 1 = vague audience, no clear channel. 3 = identifiable communities but competitive. 5 = can name specific subreddits, groups, marketplaces, or keyword clusters with plausible organic CAC under $50.",
    },
    niche_leverage: {
      type: "number",
      description:
        "1-5. Reusability across verticals. 1 = hyper-specific to one niche, no abstraction path. 3 = works for 2-3 adjacent niches with moderate customization. 5 = core product serves 5+ verticals with <20% customization per niche.",
    },
    compounding_asset_score: {
      type: "number",
      description:
        "1-5. Does usage generate switching costs? 1 = stateless utility, easy to switch. 3 = some data/config lock-in after months. 5 = deep workflow integration, uploaded data, accumulated config that makes switching painful.",
    },
    platform_independence_score: {
      type: "number",
      description:
        "1-5. 1 = entirely dependent on one platform (Chrome store, single API, social media algorithm). 3 = uses a platform but has alternative distribution. 5 = standalone product, owns its distribution.",
    },
    simplicity_score: {
      type: "number",
      description:
        "1-5. Build complexity for a solo operator. 1 = massive, multi-month effort. 5 = weekend MVP. NOT used in scoring — captured for context only.",
    },
    competitor_count: {
      type: "integer",
      description: "Approximate number of direct competitors found. Sweet spot is 4-12.",
    },
    competitor_density: {
      type: "string",
      enum: ["none", "low", "moderate", "high", "saturated"],
      description:
        "Qualitative competitive density. none = no competitors found. low = 1-3. moderate = 4-12 (sweet spot). high = 13-20. saturated = 20+ or multiple funded players.",
    },
    market_summary: {
      type: "string",
      description:
        "3-5 sentence summary. Must include: a market size indication (even rough), the competitive density assessment, and the specific distribution channels found. Lead with the strongest signal (positive or negative).",
    },
    kill_reason: {
      type: "string",
      description:
        "If recommendation is kill or park, explain the primary reason in one sentence. Empty string if advance.",
    },
    no_competitors_reason: {
      type: "string",
      description:
        "Required explanation when the competitors array is empty (e.g. market too nascent, problem solved by manual workarounds). Empty string when competitors were found.",
    },
    niche_leverage_notes: {
      type: "string",
      description:
        "Which specific adjacent niches could this serve? Name them. If none, say so.",
    },
    distribution_channels: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific channels identified: subreddit names, Facebook groups, Slack communities, marketplaces, keyword clusters. Be specific.",
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", description: "Valid URL of a page you actually referenced. Never a search query or description." },
          title: { anyOf: [{ type: "string" }, { type: "null" }], description: "Page title, or null if unknown." },
          type: {
            type: "string",
            enum: ["competitor_page", "review_site", "community_thread", "news", "documentation"],
          },
        },
        required: ["url", "title", "type"],
        additionalProperties: false,
      },
      description:
        "At least 3 real source URLs from your research, each classified by type.",
    },
    competitors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { anyOf: [{ type: "string" }, { type: "null" }], description: "Homepage URL, or null if not found." },
          pricing_url: { anyOf: [{ type: "string" }, { type: "null" }], description: "Direct link to the pricing page if it exists (usually /pricing or /plans), else null." },
          pricing: { type: "string" },
          users_estimate: { type: "string", description: "Human-readable estimate, e.g. '50k+ builders (claimed)'. Write 'unknown' if no estimate found." },
          users_estimate_numeric: {
            anyOf: [{ type: "number" }, { type: "null" }],
            description: "Total users as a single integer. '50k+' = 50000. 'thousands' = 5000. Unknown = null. No text qualifiers.",
          },
          gap: {
            type: "string",
            description: "What gap or weakness this competitor has that the idea could exploit.",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "high = verified from multiple sources. medium = single source or inferred. low = guessed.",
          },
        },
        required: ["name", "url", "pricing_url", "pricing", "users_estimate", "users_estimate_numeric", "gap", "confidence"],
        additionalProperties: false,
      },
      description:
        "EVERY real competitor found, with evidence. Do NOT pad to a fixed count — 2 real competitors beats 5 padded ones. Include pricing for every one. Empty array if none (then fill no_competitors_reason).",
    },
    gaps: {
      type: "array",
      items: { type: "string" },
      description:
        "What couldn't be answered from web search. These become validation questions for the next stage.",
    },
  },
  required: [
    "confidence",
    "recommendation",
    "product_type",
    "pain_signal",
    "pain_evidence_count",
    "willingness_to_pay",
    "distribution_clarity",
    "niche_leverage",
    "compounding_asset_score",
    "platform_independence_score",
    "simplicity_score",
    "competitor_count",
    "competitor_density",
    "market_summary",
    "kill_reason",
    "no_competitors_reason",
    "niche_leverage_notes",
    "distribution_channels",
    "sources",
    "competitors",
    "gaps",
  ],
  additionalProperties: false,
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

// ---------- SOURCES MERGE (v5, Gap 3 fix) ----------

interface SourceEntry { url: string; title: string | null; type: string | null; }

function isHttpUrl(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Dedup key: strip hash fragment and trailing slash so trivially-equivalent URLs collapse. */
function urlKey(url: string): string {
  return url.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Merge model-emitted typed sources with the API's grounded result URLs.
 * Model sources carry the type classification (Contract 2); BOTH API arrays
 * (search_results and the deprecated citations) are ground truth and backfill
 * anything the model omitted — merged entries carry type: null, which
 * downstream consumers (demand validator) filter on. Deduped by canonicalized
 * URL. v4's bug: it relied ONLY on pxResult.citations, which the Perplexity
 * API deprecated in favor of search_results — when citations came back empty,
 * research_result.sources was empty (Gap 3).
 */
function mergeSources(
  modelSources: unknown,
  pxResult: Record<string, unknown>
): SourceEntry[] {
  const out: SourceEntry[] = [];
  const seen = new Set<string>();

  if (Array.isArray(modelSources)) {
    for (const s of modelSources) {
      const url = (s as Record<string, unknown>)?.url;
      if (!isHttpUrl(url) || seen.has(urlKey(url))) continue;
      seen.add(urlKey(url));
      out.push({
        url,
        title: typeof (s as Record<string, unknown>).title === "string" ? (s as Record<string, unknown>).title as string : null,
        type: typeof (s as Record<string, unknown>).type === "string" ? (s as Record<string, unknown>).type as string : null,
      });
    }
  }

  const searchResults = pxResult.search_results as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(searchResults)) {
    for (const r of searchResults) {
      if (!isHttpUrl(r?.url) || seen.has(urlKey(r.url as string))) continue;
      seen.add(urlKey(r.url as string));
      out.push({ url: r.url as string, title: typeof r.title === "string" ? r.title : null, type: null });
    }
  }

  const citations = pxResult.citations as string[] | undefined;
  if (Array.isArray(citations)) {
    for (const url of citations) {
      if (!isHttpUrl(url) || seen.has(urlKey(url))) continue;
      seen.add(urlKey(url));
      out.push({ url, title: null, type: null });
    }
  }

  return out;
}

// ---------- PROMPT BUILDER ----------

function buildResearchPrompt(
  idea: Record<string, unknown>,
  sourceIntel: Record<string, unknown> | null
): string {
  const parts = [
    `## Idea to Research`,
    `**Title:** ${idea.title || idea.idea || "Untitled"}`,
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
  ];

  if (sourceIntel && Object.keys(sourceIntel).length > 0) {
    parts.push("");
    parts.push("## Source Intelligence (from newsletter/curated analysis)");

    if (sourceIntel.pain_point) {
      parts.push(`**Curated Pain Point:** ${sourceIntel.pain_point}`);
    }
    if (sourceIntel.solution) {
      parts.push(`**Proposed Solution:** ${sourceIntel.solution}`);
    }
    if (sourceIntel.build_strategy) {
      parts.push(`**Build Strategy:** ${sourceIntel.build_strategy}`);
    }
    if (sourceIntel.business_model) {
      parts.push(`**Business Model:** ${sourceIntel.business_model}`);
    }
    if (sourceIntel.idea_subtitle) {
      parts.push(`**Subtitle:** ${sourceIntel.idea_subtitle}`);
    }
    if (sourceIntel.founder_playbook_summary) {
      parts.push(`**Founder Playbook:** ${sourceIntel.founder_playbook_summary}`);
    }

    const trend = sourceIntel.trend_signal as Record<string, unknown> | undefined;
    if (trend && trend.topic) {
      const trendStr = trend.detail
        ? `${trend.topic} — ${trend.detail}`
        : String(trend.topic);
      parts.push(`**Trend Signal (${trend.type || "general"}):** ${trendStr}`);
    }

    const bonus = sourceIntel.bonus_ideas as Array<Record<string, unknown>> | undefined;
    if (bonus && bonus.length > 0) {
      const bonusStr = bonus.map((b) => b.title || b.url).join(", ");
      parts.push(`**Related Ideas:** ${bonusStr}`);
    }

    if (sourceIntel.idea_url) {
      parts.push(`**Source URL:** ${sourceIntel.idea_url}`);
    }

    parts.push("");
    parts.push(
      "Cross-reference the above source intelligence against live web evidence. " +
      "The source intel is curated but may be optimistic — validate the pain point, business model, and pricing claims."
    );
  }

  parts.push("");
  parts.push("## Research Instructions");
  parts.push(
    "Search the web thoroughly. Focus on the 6 scoring dimensions in your system prompt."
  );
  parts.push(
    "For WILLINGNESS TO PAY: Find actual competitor pricing pages. Report exact prices, not estimates."
  );
  parts.push(
    "For DISTRIBUTION CLARITY: Name specific subreddits, communities, marketplaces, or keyword clusters where buyers congregate."
  );
  parts.push(
    "For NICHE LEVERAGE: List the specific adjacent verticals this could serve with minimal customization."
  );
  parts.push(
    "Classify the PRODUCT TYPE, rate each competitor's confidence, convert user estimates to integers, and return at least 3 typed source URLs."
  );
  parts.push(
    "Use recent data (last 6 months preferred). Look at Reddit, Product Hunt, Hacker News, G2, Capterra, app stores, and niche forums."
  );
  parts.push("Return your structured assessment.");

  return parts.filter(Boolean).join("\n");
}

// ---------- COST ESTIMATOR ----------

function estimateCost(usage: Record<string, number>): Record<string, unknown> {
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

  const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    return new Response(
      JSON.stringify({ error: "missing_secret", detail: "PERPLEXITY_API_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

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

  // --- Fetch structured_extract ---
  let sourceIntel: Record<string, unknown> | null = null;
  const { data: sources } = await supabase
    .from("idea_sources")
    .select("structured_extract")
    .eq("pipeline_id", idea_id)
    .not("structured_extract", "eq", "{}")
    .order("created_at", { ascending: false })
    .limit(1);

  if (sources && sources.length > 0 && sources[0].structured_extract) {
    sourceIntel = sources[0].structured_extract as Record<string, unknown>;
  }

  // --- Call Perplexity Sonar Pro ---
  const researchPrompt = buildResearchPrompt(idea, sourceIntel);

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
  const mergedSources = mergeSources(finding.sources, pxResult);
  const research_result = {
    binding: "perplexity-researcher",
    binding_version: "v5",
    model: "sonar-pro",
    rubric_version: "v2",
    run_id,
    had_source_intel: sourceIntel !== null,
    ...finding,
    sources: mergedSources,
    usage: pxResult.usage || {},
    cost_estimate: estimateCost(pxResult.usage || {}),
    latency_ms: Date.now() - startTime,
  };

  const confidence = finding.confidence as number;
  const recommendation = finding.recommendation as string;

  // --- Dry run ---
  if (dry_run) {
    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: true,
        idea_id,
        run_id,
        stage: "researching",
        confidence,
        recommendation,
        research_result,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // --- Write research_result + extract ALL scoring columns in one pass ---
  // v4: No stage transition. Idea stays in 'researching'.
  // Reasoning-scorer is the sole transition authority.
  const updatePayload: Record<string, unknown> = {
    research_result,
    // All 9 scoring columns extracted here (absorbs scoring-agent's role)
    painful_problem: safeInt(finding.pain_signal, 3),
    willingness_to_pay: safeInt(finding.willingness_to_pay, 3),
    distribution_clarity: safeInt(finding.distribution_clarity, 3),
    niche_leverage: safeInt(finding.niche_leverage, 3),
    compounding_asset_score: safeInt(finding.compounding_asset_score, 3),
    platform_independence_score: safeInt(finding.platform_independence_score, 3),
    pain_evidence_count: safeCount(finding.pain_evidence_count, 0),
    simplicity: safeInt(finding.simplicity_score, 3),
    kill_reason: typeof finding.kill_reason === "string" && (finding.kill_reason as string).length > 0 ? finding.kill_reason : null,
  };

  // v5: extract product_type to pipeline.type, but never clobber an
  // existing (possibly hand-set) value.
  if (idea.type == null && typeof finding.product_type === "string") {
    updatePayload.type = finding.product_type;
  }

  const { data: updated, error: updateError } = await supabase
    .from("pipeline")
    .update(updatePayload)
    .eq("id", idea_id)
    .select("id, stage, weighted_score")
    .single();

  if (updateError) {
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
      stage: "researching",
      transitioned: false,
      confidence,
      recommendation,
      weighted_score: updated?.weighted_score,
      research_result,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
