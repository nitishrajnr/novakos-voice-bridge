// Integration smoke test for the new /agents/cos-cars24 pipeline.
// Runs:
//   1. Fetch live Cars24 snapshot from Supabase
//   2. Build preamble
//   3. Ask Claude a realistic CoS question
//   4. Render Cartesia TTS of the reply in Sunil
// Writes: cos-greeting.mp3 + cos-reply.mp3
// Usage: ANTHROPIC_API_KEY=... CARTESIA_API_KEY=... \
//        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//        node test-cos-integration.js

const fs = require("fs");
require("dotenv").config();

const AGENT_CONFIGS = {
  "cos-cars24": null,
};

async function main() {
  const brain = require("./agent-brain");
  const agent = brain.AGENT_CONFIGS["cos-cars24"];
  if (!agent) throw new Error("cos-cars24 agent not registered");
  console.log("Agent:", agent.display_name, "voice=" + agent.voice_id, "model=" + agent.model);

  // 1. Snapshot
  console.log("\n[1] Fetching Cars24 snapshot from Supabase…");
  // agent-brain doesn't export fetchCars24Snapshot — replicate a minimal call here.
  const SB = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  async function sbGET(path) {
    const r = await fetch(SB + "/rest/v1/" + path, {
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, Accept: "application/json" },
    });
    if (!r.ok) throw new Error("sb " + r.status + ": " + (await r.text()).slice(0, 160));
    return r.json();
  }
  const inv = await sbGET("cars24_inventory?select=hub,status");
  const ops = await sbGET("cars24_operations?select=hub,backlog_cars,date&order=date.desc&limit=6");
  const fin = await sbGET("cars24_finance_metrics?select=*&order=month.desc&limit=1");
  console.log("  inventory rows:", inv.length, "  latest ops:", ops.length, "  finance months:", fin.length);

  // 2. Preamble (trim version — we invoke the real code via the mount path ideally,
  //    but here we just want to prove Claude answers with data.)
  const preamble =
    "CARS24 CONTEXT (live snapshot):\n" +
    `Latest finance month ${fin[0]?.month}: revenue ₹${(Number(fin[0]?.revenue) / 1e7).toFixed(1)} Cr, EBITDA ₹${(Number(fin[0]?.ebitda) / 1e7).toFixed(1)} Cr, cars sold ${fin[0]?.cars_sold}.\n` +
    "Inventory by hub: " + Object.entries(inv.reduce((a, r) => { a[r.hub] = (a[r.hub] || 0) + 1; return a; }, {})).map(([h, n]) => `${h} ${n}`).join(", ") + ".\n" +
    "Today's backlog per hub: " + ops.map(o => `${o.hub} ${o.backlog_cars}`).join(", ") + ".";
  console.log("\n[2] Preamble preview:\n", preamble);

  // 3. Claude
  console.log("\n[3] Asking Claude 'Give me a 30-second briefing on where we are today.'");
  const messages = [
    {
      role: "user",
      content: "Give me a 30-second briefing on where we are today. What's the single biggest red flag I should act on?",
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
  const reply = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
  console.log("\n[3] Claude (Arjun) reply:\n" + reply);

  // 4. Cartesia TTS — greeting + reply
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

  console.log("\n[4] Rendering Cartesia TTS…");
  await tts(agent.greeting, "cos-greeting.mp3");
  await tts(reply, "cos-reply.mp3");

  console.log("\n✓ Integration smoke PASSED.");
}

main().catch((e) => {
  console.error("✗ FAILED:", e.message);
  process.exit(1);
});
