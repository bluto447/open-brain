import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Logs pipeline transitions to open_brain table as semantic memories
// Called by database trigger alongside pipeline-notify

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();
    const { type, record, old_record } = payload;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let content = "";
    let tags: string[] = ["pipeline", "auto-log"];
    let source = "pipeline_trigger";

    if (type === "INSERT") {
      content = `Pipeline: New idea captured.\n\nIdea: ${record.idea}\nType: ${record.type || "unclassified"}\nSource: ${record.source || "manual"}\nStage: ${record.stage}\nDate: ${record.date_added || new Date().toISOString().split("T")[0]}\nID: ${record.id}`;
      tags.push("new-idea");
      if (record.type) tags.push(record.type.toLowerCase().replace(/\s+/g, "-"));
    } else if (type === "UPDATE" && old_record && old_record.stage !== record.stage) {
      const score = parseFloat(record.weighted_score) > 0 ? record.weighted_score : "pending";
      content = `Pipeline: Stage transition for "${record.idea}".\n\nTransition: ${old_record.stage} \u2192 ${record.stage}\nWeighted Score: ${score}\nType: ${record.type || "unclassified"}\nDate: ${new Date().toISOString().split("T")[0]}\nID: ${record.id}`;
      tags.push("stage-change", record.stage);
      if (record.type) tags.push(record.type.toLowerCase().replace(/\s+/g, "-"));

      // Add decision context for key transitions
      if (record.stage === "approved") {
        content += `\n\nDecision: Idea approved for build pipeline. Score: ${score}.`;
        tags.push("decision");
      } else if (record.stage === "killed") {
        content += `\n\nDecision: Idea killed. ${record.notes ? "Notes: " + record.notes : "No notes provided."}`;
        tags.push("decision");
      }
    } else {
      // Not a loggable event
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Insert into open_brain
    const { data, error } = await supabase.from("open_brain").insert({
      content,
      source,
      metadata: {
        tags,
        pipeline_id: record.id,
        idea: record.idea,
        stage: record.stage,
        previous_stage: old_record?.stage || null,
        type: record.type,
        weighted_score: record.weighted_score,
        auto_generated: true,
      },
      memory_type: record.stage === "approved" || record.stage === "killed" ? "decision" : "episodic",
    }).select("id").single();

    if (error) {
      console.error("Open Brain insert error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, open_brain_id: data.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("pipeline-log error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
