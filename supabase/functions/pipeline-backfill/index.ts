/**
 * pipeline-backfill — Edge Function (v1)
 *
 * One-off backfill utility for the demand-validator upstream fixes
 * (HANDOFF-upstream-fixes-demand-validator.md, UP-04 + UP-05, 2026-06-10).
 * Safe to keep deployed: both modes are idempotent and no-op when there is
 * nothing left to backfill. Driven manually in batches via net.http_post.
 *
 * Modes:
 *   POST { mode: "classify_types", limit?: 30, dry_run?: boolean }
 *     UP-04. For ideas with research_result but NULL pipeline.type, classify
 *     into the ADR/handoff enum via OpenRouter (deepseek) using the idea's own
 *     fields + its existing research. Writes pipeline.type only — never
 *     touches research_result or any hand-set type (WHERE type IS NULL).
 *
 *   POST { mode: "parse_estimates", limit?: 100, dry_run?: boolean }
 *     UP-05. For researched ideas whose research_result.competitors[] entries
 *     lack users_estimate_numeric, parse the existing users_estimate text
 *     deterministically ("50k+" -> 50000, "10M users" -> 10000000,
 *     "~2,000" -> 2000). No LLM. Unparseable -> null (key still written so
 *     re-runs skip the row). Merges into research_result JSONB.
 *
 * Secrets: OPENROUTER_API_KEY (classify mode), SUPABASE_URL,
 *          SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const CLASSIFY_MODEL = "deepseek/deepseek-chat-v3-0324";

const PRODUCT_TYPES = [
  "saas",
  "chrome_extension",
  "mobile_app",
  "marketplace",
  "directory",
  "digital_product",
  "productized_service",
  "api",
  "other",
] as const;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- UP-04: TYPE CLASSIFICATION ----------

const CLASSIFY_SYSTEM = `You classify micro-SaaS product ideas into exactly one product type. Respond with ONLY a JSON object: {"product_type": "<value>"}.

Values:
- saas: Web-based software with recurring revenue
- chrome_extension: Browser extension distributed via Chrome Web Store
- mobile_app: iOS/Android native or hybrid app
- marketplace: Two-sided platform connecting buyers and sellers
- directory: Curated listing/database product
- digital_product: One-time purchase (templates, courses, tools)
- productized_service: Service delivered with software wrapper
- api: Developer-facing API product
- other: Doesn't fit above categories

Base the classification on what the product IS, not what it integrates with. A web dashboard that reads a platform API is saas, not api. Default to saas only when the evidence genuinely points at a recurring web product; use other when truly ambiguous.`;

function buildClassifyPrompt(idea: Record<string, unknown>): string {
  const rr = (idea.research_result ?? {}) as Record<string, unknown>;
  const competitors = (rr.competitors as Array<Record<string, unknown>> | undefined) ?? [];
  const parts = [
    `Title: ${idea.idea || idea.title || "Untitled"}`,
    idea.description ? `Description: ${idea.description}` : "",
    idea.target_user ? `Target user: ${idea.target_user}` : "",
    idea.monetization ? `Monetization: ${idea.monetization}` : "",
    rr.market_summary ? `Research market summary: ${String(rr.market_summary).slice(0, 600)}` : "",
    competitors.length > 0
      ? `Competitors found: ${competitors.map((c) => c.name).filter(Boolean).slice(0, 8).join(", ")}`
      : "",
  ];
  return parts.filter(Boolean).join("\n");
}

async function classifyOne(
  openrouterKey: string,
  idea: Record<string, unknown>
): Promise<{ id: string; type: string | null; error: string | null }> {
  const id = idea.id as string;
  try {
    const resp = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yonasol.com",
        "X-Title": "Yonasol Pipeline Type Backfill",
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: buildClassifyPrompt(idea) },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 50,
      }),
    });
    if (!resp.ok) {
      return { id, type: null, error: `openrouter_${resp.status}: ${(await resp.text()).slice(0, 150)}` };
    }
    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content);
    const t = parsed.product_type;
    if (typeof t === "string" && (PRODUCT_TYPES as readonly string[]).includes(t)) {
      return { id, type: t, error: null };
    }
    return { id, type: null, error: `invalid_type: ${String(t).slice(0, 50)}` };
  } catch (err) {
    return { id, type: null, error: `exception: ${String(err).slice(0, 150)}` };
  }
}

async function runClassifyTypes(
  supabase: ReturnType<typeof createClient>,
  openrouterKey: string,
  limit: number,
  dryRun: boolean
): Promise<Response> {
  const { data: ideas, error } = await supabase
    .from("pipeline")
    .select("id, idea, description, target_user, monetization, research_result")
    .is("type", null)
    .not("research_result", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return json({ ok: false, error: `select_failed: ${error.message}` }, 500);
  if (!ideas || ideas.length === 0) return json({ ok: true, mode: "classify_types", processed: 0, remaining: 0, done: true });

  // Chunked concurrency (Codex P2): at most CHUNK parallel OpenRouter calls,
  // and each chunk's successes are written before the next chunk starts — an
  // Edge timeout or rate-limit burst loses at most one chunk of progress.
  const CHUNK = 10;
  const results: Array<{ id: string; type: string | null; error: string | null }> = [];
  let classified = 0, failed = 0;
  const failures: Array<{ id: string; error: string | null }> = [];
  for (let i = 0; i < ideas.length; i += CHUNK) {
    const chunk = await Promise.all(ideas.slice(i, i + CHUNK).map((x) => classifyOne(openrouterKey, x)));
    results.push(...chunk);
    if (dryRun) continue;
    for (const r of chunk) {
      if (!r.type) { failed++; failures.push({ id: r.id, error: r.error }); continue; }
      // Guard type IS NULL again at write time so a concurrent v5 research
      // pass or hand-set value is never clobbered.
      const { error: upErr } = await supabase
        .from("pipeline")
        .update({ type: r.type })
        .eq("id", r.id)
        .is("type", null);
      if (upErr) { failed++; failures.push({ id: r.id, error: `update_failed: ${upErr.message}` }); }
      else classified++;
    }
  }

  const { count: remaining } = await supabase
    .from("pipeline")
    .select("id", { count: "exact", head: true })
    .is("type", null)
    .not("research_result", "is", null);

  return json({
    ok: true,
    mode: "classify_types",
    dry_run: dryRun,
    processed: results.length,
    classified,
    failed,
    failures: failures.slice(0, 5),
    sample: dryRun ? results.slice(0, 5) : undefined,
    remaining: remaining ?? -1,
    done: (remaining ?? 1) === 0,
  });
}

// ---------- UP-05: NUMERIC ESTIMATE PARSING ----------

/**
 * Parse a human-readable user estimate into an integer, or null.
 *  "50k+ builders (claimed)" -> 50000      "10M+ users" -> 10000000
 *  "~2,000 clinics"          -> 2000       "500+"       -> 500
 *  "thousands"               -> 5000       "millions"   -> 5000000
 *  "unknown" / "" / no digit -> null
 */
function parseEstimate(text: unknown): number | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const t = text.toLowerCase();
  if (/\bunknown\b|\bn\/a\b|\bnone\b/.test(t)) return null;
  const m = t.match(/([\d][\d,.]*)\s*(k|m|b|thousand|million|billion)?\b/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) return null;
    const mult = m[2];
    const factor =
      mult === "k" || mult === "thousand" ? 1_000 :
      mult === "m" || mult === "million" ? 1_000_000 :
      mult === "b" || mult === "billion" ? 1_000_000_000 : 1;
    return Math.round(num * factor);
  }
  // Word-only magnitudes with no digits.
  if (/\bbillions\b/.test(t)) return 5_000_000_000;
  if (/\bmillions\b/.test(t)) return 5_000_000;
  if (/\b(thousands|several thousand)\b/.test(t)) return 5_000;
  if (/\bhundreds\b/.test(t)) return 500;
  if (/\bdozens\b/.test(t)) return 50;
  return null;
}

function competitorsNeedParsing(rr: Record<string, unknown>): boolean {
  const comps = rr.competitors as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(comps) || comps.length === 0) return false;
  return comps.some((c) => !("users_estimate_numeric" in c));
}

async function runParseEstimates(
  supabase: ReturnType<typeof createClient>,
  limit: number,
  dryRun: boolean
): Promise<Response> {
  // Fetch a window of researched ideas and filter client-side for missing
  // users_estimate_numeric keys (JSONB-array key checks don't translate to
  // PostgREST filters). Paginate until `limit` rows needing work are found.
  const PAGE = 200;
  const targets: Array<{ id: string; rr: Record<string, unknown> }> = [];
  for (let offset = 0; targets.length < limit; offset += PAGE) {
    const { data: rows, error } = await supabase
      .from("pipeline")
      .select("id, research_result")
      .not("research_result", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return json({ ok: false, error: `select_failed: ${error.message}` }, 500);
    if (!rows || rows.length === 0) break;
    for (const row of rows) {
      const rr = row.research_result as Record<string, unknown>;
      if (competitorsNeedParsing(rr)) {
        targets.push({ id: row.id as string, rr });
        if (targets.length >= limit) break;
      }
    }
    if (rows.length < PAGE) break;
  }

  if (targets.length === 0) return json({ ok: true, mode: "parse_estimates", processed: 0, done: true });

  let updated = 0, failed = 0, skippedConcurrent = 0, parsedCount = 0, nullCount = 0;
  const sample: Array<{ text: unknown; parsed: number | null }> = [];
  for (const t of targets) {
    const comps = (t.rr.competitors as Array<Record<string, unknown>>).map((c) => {
      if ("users_estimate_numeric" in c) return c;
      const parsed = parseEstimate(c.users_estimate);
      if (parsed === null) nullCount++; else parsedCount++;
      if (sample.length < 8) sample.push({ text: c.users_estimate, parsed });
      return { ...c, users_estimate_numeric: parsed, _numeric_backfilled: true };
    });
    if (dryRun) { updated++; continue; }
    const newRr = { ...t.rr, competitors: comps };
    // Optimistic concurrency guard (Codex P1): this is a read-modify-write of
    // the whole research_result column, and a concurrent re-research (UP-06 /
    // researcher v5) would be lost to last-writer-wins. Only update if the
    // run_id we read is still the run_id in the row; a lost race means the
    // row was freshly re-researched (v5 already writes users_estimate_numeric)
    // and is skipped, not corrupted.
    const runId = typeof t.rr.run_id === "string" ? (t.rr.run_id as string) : null;
    let query = supabase.from("pipeline").update({ research_result: newRr }).eq("id", t.id);
    query = runId !== null
      ? query.eq("research_result->>run_id", runId)
      : query.is("research_result->>run_id", null);
    const { data: touched, error: upErr } = await query.select("id");
    if (upErr) failed++;
    else if (!touched || touched.length === 0) skippedConcurrent++;
    else updated++;
  }

  return json({
    ok: true,
    mode: "parse_estimates",
    dry_run: dryRun,
    processed: targets.length,
    updated,
    failed,
    skipped_concurrent: skippedConcurrent,
    competitors_parsed: parsedCount,
    competitors_null: nullCount,
    sample,
    done: targets.length < limit,
  });
}

// ---------- HANDLER ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: { mode?: string; limit?: number; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const dryRun = body.dry_run === true;

  if (body.mode === "classify_types") {
    const openrouterKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!openrouterKey) return json({ error: "missing_secret", detail: "OPENROUTER_API_KEY" }, 500);
    const limit = Math.min(Math.max(body.limit ?? 30, 1), 60);
    return await runClassifyTypes(supabase, openrouterKey, limit, dryRun);
  }

  if (body.mode === "parse_estimates") {
    const limit = Math.min(Math.max(body.limit ?? 100, 1), 200);
    return await runParseEstimates(supabase, limit, dryRun);
  }

  return json({ error: "provide mode: classify_types | parse_estimates" }, 400);
});
