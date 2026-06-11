import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req) => {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not found in env" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Use a cheap paid model to confirm billing works
  const model = "meta-llama/llama-3.1-8b-instruct";
  const start = Date.now();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://yonasol.com",
        "X-Title": "Yonasol OpenRouter Test",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OPENROUTER_OK" }],
        max_tokens: 10,
      }),
    });

    const data = await res.json();
    const latency = Date.now() - start;

    if (!res.ok) {
      return new Response(JSON.stringify({ status: "FAIL", http_status: res.status, error: data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const reply = data.choices?.[0]?.message?.content || "no content";
    const usage = data.usage || {};

    return new Response(JSON.stringify({
      status: "OK",
      model: data.model || model,
      reply: reply.trim(),
      latency_ms: latency,
      usage,
      key_prefix: apiKey.substring(0, 8) + "...",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ status: "ERROR", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});