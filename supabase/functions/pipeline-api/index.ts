import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Criterion = {
  criterion: string;
  required: boolean;
  auto_checkable: boolean;
  threshold?: number;
  allowed?: string[];
  description?: string;
};

function checkCriterion(c: Criterion, current: any): string | null {
  switch (c.criterion) {
    case "idea_text_not_empty":
      return !current.idea || current.idea.trim().length === 0
        ? "Idea text cannot be empty"
        : null;

    case "all_5_dimensions_scored": {
      const dims = [
        current.painful_problem,
        current.reachable_user,
        current.validate_fast,
        current.buildable,
        current.low_opcost,
      ];
      return dims.some((d) => d === null || d === undefined)
        ? "All 5 scoring dimensions must be filled"
        : null;
    }

    case "product_type_assigned":
      return !current.type ? "Product type must be assigned" : null;

    case "research_result_present":
      return !current.research_result
        ? "research_result is empty; run research_synthesizer first"
        : null;

    case "research_confidence_met": {
      const threshold = c.threshold ?? 0.7;
      const conf = Number(current.research_result?.confidence ?? 0);
      return conf < threshold
        ? `research_result.confidence (${conf}) < ${threshold}`
        : null;
    }

    case "research_gaps_documented":
      return !Array.isArray(current.research_result?.gaps)
        ? "research_result.gaps must be an array"
        : null;

    case "validation_result_present":
      return !current.validation_result
        ? "validation_result is empty; run validation_signal.collect() first"
        : null;

    case "validation_signal_strength_met": {
      const allowed = c.allowed ?? ["strong", "moderate"];
      const strength = current.validation_result?.signal_strength;
      return !allowed.includes(strength)
        ? `validation_result.signal_strength (${strength}) not in ${JSON.stringify(allowed)}`
        : null;
    }

    case "decision_recorded":
      return !["go", "park", "kill"].includes(current.decision)
        ? "decision must be set to go, park, or kill"
        : null;

    case "decision_confidence_met": {
      if (current.decided_by !== "agent") return null;
      const threshold = c.threshold ?? 0.8;
      const conf = Number(current.decision_confidence ?? 0);
      return conf < threshold
        ? `decision_confidence (${conf}) < ${threshold} for agent-made decision`
        : null;
    }

    default:
      return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const pathAction = url.pathname.split("/").filter(Boolean).pop();

  try {
    if (req.method === "GET") {
      const queries: Record<string, any> = {
        pipeline: supabase.from("pipeline").select("*").order("date_added", { ascending: false, nullsFirst: false }),
        workflow_tracking: supabase.from("workflow_tracking").select("*").order("updated_at", { ascending: false }),
        projects: supabase.from("projects").select("*").order("status").order("name"),
        product_pulse: supabase.from("product_pulse").select("*").order("updated_at", { ascending: false }),
        stage_gates: supabase.from("stage_gates").select("*").order("stage_order"),
        stage_transitions: supabase.from("stage_transitions").select("*").order("created_at", { ascending: false }).limit(200),
      };

      const results = await Promise.all(
        Object.entries(queries).map(async ([key, query]) => [key, (await query).data])
      );

      const data = Object.fromEntries(results);
      data._meta = {
        fetched_at: new Date().toISOString(),
        counts: {
          pipeline: data.pipeline?.length || 0,
          workflow: data.workflow_tracking?.length || 0,
          projects: data.projects?.length || 0,
          gates: data.stage_gates?.length || 0,
          transitions: data.stage_transitions?.length || 0,
        },
      };

      return json(data);
    }

    if (req.method === "POST" && pathAction === "rollback") {
      const body = await req.json();
      const { transition_id, reason } = body;
      if (!transition_id) return json({ error: "transition_id is required" }, 400);

      const { data, error } = await supabase.rpc("rpc_state_transition_rollback", {
        p_transition_id: transition_id,
        p_reason: reason ?? null,
      });

      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    if (req.method === "POST" && pathAction === "reenter") {
      const body = await req.json();
      const { idea_id, to_stage, reset_fields, reason } = body;
      if (!idea_id || !to_stage) {
        return json({ error: "idea_id and to_stage are required" }, 400);
      }

      const { data, error } = await supabase.rpc("rpc_state_transition_reenter", {
        p_idea_id: idea_id,
        p_to_stage: to_stage,
        p_reset_fields: reset_fields ?? [],
        p_reason: reason ?? null,
      });

      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    if (req.method === "POST") {
      const contentType = req.headers.get("content-type") || "";
      let idea: string | null = null;
      let source = "manual";
      let type: string | null = null;
      let notes: string | null = null;
      let source_url: string | null = null;
      let target_user: string | null = null;
      let monetization: string | null = null;
      let pillar: string | null = null;
      let isSlack = false;

      if (contentType.includes("application/x-www-form-urlencoded")) {
        isSlack = true;
        const body = await req.text();
        const params = new URLSearchParams(body);
        const text = params.get("text") || "";
        const userName = params.get("user_name") || "unknown";

        const parts = text.split("|").map((s: string) => s.trim());
        idea = parts[0] || null;
        source = `slack:${userName}`;

        for (const part of parts.slice(1)) {
          const colonIdx = part.indexOf(":");
          if (colonIdx === -1) continue;
          const key = part.substring(0, colonIdx).trim().toLowerCase();
          const value = part.substring(colonIdx + 1).trim();
          if (key === "type") type = value;
          if (key === "source") source = value;
          if (key === "notes") notes = value;
          if (key === "target") target_user = value;
          if (key === "monetization") monetization = value;
          if (key === "pillar") pillar = value;
        }
      } else {
        const body = await req.json();
        idea = body.idea;
        source = body.source || "manual";
        type = body.type || null;
        notes = body.notes || null;
        source_url = body.source_url || null;
        target_user = body.target_user || null;
        monetization = body.monetization || null;
        pillar = body.pillar || null;
      }

      if (!idea || idea.trim().length === 0) {
        const msg = isSlack
          ? { response_type: "ephemeral", text: "Usage: /idea Your idea here | type: Chrome Extension | notes: optional context" }
          : { error: "idea is required" };
        return json(msg, isSlack ? 200 : 400);
      }

      const { data, error } = await supabase.from("pipeline").insert({
        idea: idea.trim(),
        stage: "new",
        source,
        source_type: "other",
        type,
        notes,
        source_url,
        target_user,
        monetization,
        pillar,
        date_added: new Date().toISOString().split("T")[0],
        _pending_transition: {
          reason: "intake",
          triggered_by: isSlack ? "human" : "agent",
        },
      }).select().single();

      if (error) {
        return json(isSlack ? { response_type: "ephemeral", text: `Error: ${error.message}` } : { error: error.message }, isSlack ? 200 : 500);
      }

      if (isSlack) {
        return json({
          response_type: "in_channel",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `:bulb: *New idea captured*` } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Idea:*\n${data.idea}` },
              { type: "mrkdwn", text: `*Stage:* new` },
              { type: "mrkdwn", text: `*Type:* ${data.type || "unclassified"}` },
              { type: "mrkdwn", text: `*Score:* pending` },
            ]},
            { type: "context", elements: [{ type: "mrkdwn", text: `ID: \`${data.id}\`` }] },
          ],
        });
      }

      return json({ success: true, data });
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      const {
        id,
        force,
        reason,
        triggered_by,
        evidence,
        ...updates
      } = body;

      if (!id) return json({ error: "id is required" }, 400);

      const { data: current } = await supabase.from("pipeline").select("*").eq("id", id).single();
      if (!current) return json({ error: "Pipeline item not found" }, 404);

      const isStageChange = updates.stage && current.stage !== updates.stage;

      if (isStageChange) {
        const { data: gate } = await supabase.from("stage_gates").select("*").eq("stage", current.stage).single();

        if (gate && !force) {
          const violations: string[] = [];

          for (const criterion of (gate.exit_criteria || []) as Criterion[]) {
            if (!criterion.required) continue;
            if (!criterion.auto_checkable) continue;

            const violation = checkCriterion(criterion, current);
            if (violation) violations.push(violation);
          }

          if (gate.human_gate && updates.stage !== "killed") {
            updates.notes = (current.notes || "") + `\n[${new Date().toISOString()}] Gate: ${current.stage} -> ${updates.stage} (human approved)`;
          }

          if (violations.length > 0) {
            return json({
              error: "Gate check failed",
              violations,
              gate: {
                stage: gate.stage,
                exit_criteria: gate.exit_criteria,
                ownership: gate.ownership,
              },
              hint: "Pass force: true to override gate checks",
            }, 422);
          }
        }

        if (!updates.notes) {
          updates.notes = (current.notes || "") + `\n[${new Date().toISOString()}] Stage: ${current.stage} -> ${updates.stage}`;
        }

        updates._pending_transition = {
          reason: reason ?? (force ? "forced" : null),
          triggered_by: triggered_by ?? "agent",
          evidence: evidence ?? null,
        };
      }

      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase.from("pipeline").update(updates).eq("id", id).select().single();
      if (error) return json({ error: error.message }, 500);

      const { data: fresh } = await supabase.from("pipeline").select("*").eq("id", id).single();
      return json({ success: true, data: fresh, transition_id: fresh?.last_transition_id ?? null });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
