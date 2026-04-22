// Integration smoke test for the new /agents/finance-cars24 pipeline (Vikram).
// Runs:
//   1. Fetch 6-mo finance + 18 ops rows + 50 pipeline rows
//   2. Build Vikram's preamble
//   3. Ask Claude a realistic CFO question
//   4. Render Cartesia TTS in Vishal voice
// Writes: vikram-greeting.mp3 + vikram-reply.mp3

const fs = require("fs");
require("dotenv").config();

async function main() {
  const brain = require("./agent-brain");
  const agent = brain.AGENT_CONFIGS["finance-cars24"];
  if (!agent) throw new Error("finance-cars24 agent not registered");
  console.log(
    "Agent:",
    agent.display_name,
    "voice=" + agent.voice_id,
    "model=" + agent.model
  );

  // 1. Context
  console.log("\n[1] Fetching finance context from Supabase…");
  const SB = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).replace(
    /\/+$/,
    ""
  );
  const SB_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  async function sbGET(path) {
    const r = await fetch(SB + "/rest/v1/" + path, {
      headers: {
        apikey: SB_KEY,
        Authorization: "Bearer " + SB_KEY,
        Accept: "application/json",
      },
    });
    if (!r.ok) throw new Error("sb " + r.status + ": " + (await r.text()).slice(0, 160));
    return r.json();
  }
  const fin = await sbGET(
    "cars24_finance_metrics?select=*&order=month.desc&limit=6"
  );
  const ops = await sbGET(
    "cars24_operations?select=hub,date,cars_sold,cars_procured,deliveries&order=date.desc&limit=18"
  );
  const pipe = await sbGET("cars24_sales_pipeline?select=stage,deal_value&limit=50");
  console.log(
    "  finance months:",
    fin.length,
    "  ops rows:",
    ops.length,
    "  pipeline deals:",
    pipe.length
  );

  // 2. Preamble (abbreviated — real mount path uses full generator)
  function inr(n) {
    if (n == null || isNaN(n)) return "—";
    const v = Number(n);
    if (Math.abs(v) >= 1e7) return "₹" + (v / 1e7).toFixed(1) + " Cr";
    if (Math.abs(v) >= 1e5) return "₹" + (v / 1e5).toFixed(1) + " L";
    return "₹" + Math.round(v);
  }
  const lines = ["CARS24 FINANCE CONTEXT (last 6 months, newest first):"];
  for (const m of fin) {
    const monthLabel = String(m.month || "").slice(0, 7);
    lines.push(
      `  ${monthLabel}: revenue ${inr(m.revenue)} · EBITDA ${inr(m.ebitda)} · cash ${inr(m.cash_position)} · cars sold ${m.cars_sold} · ASP ${inr(m.avg_selling_price)}`
    );
  }
  if (fin.length >= 2) {
    const d = Number(fin[0].ebitda) - Number(fin[1].ebitda);
    lines.push(
      `  EBITDA MoM delta: ${d >= 0 ? "+" : ""}${inr(Math.abs(d))}${d < 0 ? " (worsened)" : " (improved)"}`
    );
  }
  const preamble = lines.join("\n");
  console.log("\n[2] Preamble preview:\n", preamble);

  // 3. Claude
  console.log(
    "\n[3] Asking Vikram: 'Give me a 30-second finance briefing — what was last month's P&L, and what's the biggest variance?'"
  );
  const messages = [
    {
      role: "user",
      content:
        "Give me a 30-second finance briefing — what was last month's P&L, and what's the biggest variance I should know about?",
    },
  ];
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 220,
      system: agent.system_prompt + "\n\n" + preamble,
      messages,
    }),
  });
  if (!resp.ok) throw new Error("Claude " + resp.status + ": " + (await resp.text()));
  const data = await resp.json();
  const reply = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .trim();
  console.log("\n[3] Vikram reply:\n" + reply);

  // 4. Cartesia TTS
  async function tts(text, outfile) {
    const r = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cartesia-Version": "2025-04-16",
        "X-API-Key": process.env.CARTESIA_API_KEY,
      },
      body: JSON.stringify({
        model_id: "sonic-2",
        transcript: text,
        voice: { mode: "id", id: agent.voice_id },
        language: "en",
        output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
      }),
    });
    if (!r.ok) throw new Error("Cartesia " + r.status + ": " + (await r.text()));
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(outfile, buf);
    console.log("  wrote " + outfile + " (" + buf.length + " bytes)");
  }

  console.log("\n[4] Rendering Cartesia TTS in Vishal voice…");
  await tts(agent.greeting, "vikram-greeting.mp3");
  await tts(reply, "vikram-reply.mp3");

  console.log("\n✓ Vikram integration smoke PASSED.");
}

main().catch((e) => {
  console.error("✗ FAILED:", e.message);
  process.exit(1);
});
