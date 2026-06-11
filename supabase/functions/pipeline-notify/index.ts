import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function getWebhookUrl(): Promise<string | null> {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from("config")
    .select("value")
    .eq("key", "SLACK_WEBHOOK_URL")
    .single();
  if (error || !data) {
    console.error("Failed to get webhook URL from config:", error);
    return null;
  }
  return data.value;
}

function getIdeaText(record: any): string {
  return record.idea || record.idea_text || record.name || 'No description';
}

function getProductType(record: any): string {
  return record.type || record.product_type || 'Unclassified';
}

function formatNewIdea(record: any): any {
  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "\ud83d\udca1 New Idea Submitted",
          emoji: true
        }
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Idea:*\n${getIdeaText(record)}`
          },
          {
            type: "mrkdwn",
            text: `*Stage:*\n${record.stage || 'new'}`
          }
        ]
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Product Type:*\n${getProductType(record)}`
          },
          {
            type: "mrkdwn",
            text: `*Source:*\n${record.source || 'dashboard'}`
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Pipeline ID: ${record.id} | ${new Date().toLocaleDateString()}`
          }
        ]
      }
    ]
  };
}

function formatStageChange(record: any, oldRecord: any): any {
  const oldStage = oldRecord?.stage || 'unknown';
  const newStage = record.stage;
  
  let emoji = "\u27a1\ufe0f";
  if (newStage === 'approved') emoji = "\u2705";
  if (newStage === 'killed') emoji = "\u274c";
  if (newStage === 'scoring') emoji = "\ud83d\udcca";
  if (newStage === 'validating') emoji = "\ud83d\udd0d";
  if (newStage === 'branding') emoji = "\ud83c\udfa8";
  
  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} Pipeline Stage Change`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${getIdeaText(record)}*\n${oldStage} \u2192 *${newStage}*`
        }
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Product Type:*\n${getProductType(record)}`
          },
          {
            type: "mrkdwn",
            text: `*Score:*\n${record.weighted_score ?? 'N/A'}`
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Pipeline ID: ${record.id} | ${new Date().toLocaleDateString()}`
          }
        ]
      }
    ]
  };
}

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();
    const { type, table, record, old_record } = payload;
    
    if (table !== 'pipeline') {
      return new Response(JSON.stringify({ ok: true, skipped: 'not pipeline table' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const webhookUrl = await getWebhookUrl();
    if (!webhookUrl) {
      return new Response(JSON.stringify({ ok: false, error: 'No webhook URL configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    let slackPayload;
    if (type === 'INSERT') {
      slackPayload = formatNewIdea(record);
    } else if (type === 'UPDATE' && old_record?.stage !== record.stage) {
      slackPayload = formatStageChange(record, old_record);
    } else {
      return new Response(JSON.stringify({ ok: true, skipped: 'no relevant change' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const slackRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload)
    });
    
    const slackText = await slackRes.text();
    console.log(`Slack response: ${slackRes.status} ${slackText}`);
    
    return new Response(JSON.stringify({ ok: true, slack_status: slackRes.status }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('pipeline-notify error:', err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
