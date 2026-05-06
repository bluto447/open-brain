import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Logs task state transitions to open_brain table as semantic memories.
// Called by the `tasks_state_change_notify` database trigger via pg_net.
//
// This is the task-side sibling of `pipeline-log`. The audit shape mirrors
// it but adds agent/human differentiation per the substrate decision (2026-05).
//
// Logging policy:
//   INSERT: SKIP. Tasks are higher-volume than pipeline ideas; the audit story
//           is about transitions, not existence. Flip this if you change your mind.
//   UPDATE where state changed: LOG. The core audit event.
//   UPDATE where only notes/priority/etc changed: SKIP. Noise.
//
// memory_type:
//   'decision' for terminal/notable states: done, blocked, in_review.
//   'episodic' for routine transitions (backlog→ready, ready→in_progress).

interface TaskRecord {
  id: string;
  project_id: string | null;
  title: string;
  state: string;
  status: string; // legacy
  priority: string | null;
  category: string | null;
  assignee_kind: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  is_claude_code_task: boolean | null; // legacy
  sprint: string | null;
}

interface TriggerPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  record: TaskRecord;
  old_record: TaskRecord | null;
}

const DECISION_STATES = new Set(["done", "blocked", "in_review"]);

Deno.serve(async (req: Request) => {
  try {
    const payload = (await req.json()) as TriggerPayload;
    const { type, record, old_record } = payload;

    // Skip INSERTs and any UPDATE that didn't change state.
    if (type !== "UPDATE" || !old_record || old_record.state === record.state) {
      return new Response(JSON.stringify({ skipped: true, reason: "not a state transition" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Look up project for human-readable context (not in trigger payload).
    let projectSlug: string | null = null;
    let projectName: string | null = null;
    if (record.project_id) {
      const { data: proj } = await supabase
        .from("projects")
        .select("slug, name")
        .eq("id", record.project_id)
        .single();
      projectSlug = proj?.slug ?? null;
      projectName = proj?.name ?? null;
    }

    // Build content. Match pipeline-log's narrative shape but with task vocabulary.
    const transition = `${old_record.state} → ${record.state}`;
    const projectLabel = projectName ? `${projectName} (${projectSlug ?? "unknown"})` : "unassigned project";
    const decidedBy = record.decided_by ?? "system";

    const lines: string[] = [
      `Task: State transition for "${record.title}".`,
      "",
      `Transition: ${transition}`,
      `Project: ${projectLabel}`,
      `Decided by: ${decidedBy} (${record.assignee_kind})`,
      `Priority: ${record.priority ?? "unset"}`,
    ];
    if (record.category) lines.push(`Category: ${record.category}`);
    if (record.sprint) lines.push(`Sprint: ${record.sprint}`);
    if (record.decision_notes) lines.push("", `Notes: ${record.decision_notes}`);
    lines.push("", `Task ID: ${record.id}`);

    // Tags. Per the agent/human differentiated audit-shape decision.
    const tags: string[] = [
      "task",
      "auto-log",
      "state-change",
      `state:${record.state}`,
      `assignee:${record.assignee_kind}`,
    ];
    if (record.decided_by) tags.push(`decided-by:${record.decided_by}`);
    if (DECISION_STATES.has(record.state)) tags.push("decision");
    if (projectSlug) tags.push(`project:${projectSlug}`);
    if (record.category) tags.push(`cat:${record.category}`);

    const memory_type = DECISION_STATES.has(record.state) ? "decision" : "episodic";

    const { data, error } = await supabase
      .from("open_brain")
      .insert({
        content: lines.join("\n"),
        source: "task_trigger",
        memory_type,
        metadata: {
          tags,
          task_id: record.id,
          title: record.title,
          state: record.state,
          previous_state: old_record.state,
          project_id: record.project_id,
          project_slug: projectSlug,
          project_name: projectName,
          priority: record.priority,
          category: record.category,
          assignee_kind: record.assignee_kind,
          decided_by: record.decided_by,
          decided_at: record.decided_at,
          decision_notes: record.decision_notes,
          auto_generated: true,
        },
      })
      .select("id")
      .single();

    if (error) {
      console.error("Open Brain insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, open_brain_id: data.id, memory_type }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("task-log error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
