// Integration smoke test for the new /agents/sales-cars24 pipeline (Priya).
// Runs:
//   1. Fetch live sales context (hot inventory + recent leads + active deals) from Supabase
//   2. Build Priya's preamble
//   3. Ask Claude (Haiku 4.5) a realistic buyer question
//   4. Render Cartesia TTS in Parvati voice
// Writes: priya-greeting.mp3 + priya-reply.mp3
// Usage: ANTHROPIC_API_KEY=... CARTESIA_API_KEY=... \
//        SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//        node test-priya-integration.js

const fs = require("fs");
require("dotenv").config();

async function main() {
  const brain = require("./agent-brain");
  const agent = brain.AGENT_CONFIGS["sales-cars24"];
  if (!agent) throw new Error("sales-cars24 agent not registered");
  console.log(
    "Agent:",
    agent.display_name,
    "voice=" + agent.voice_id,
    "model=" + agent.model
  );

  // 1. Context
  console.log("\n[1] Fetching sales context from Supabase…");
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
  const leads = await sbGET(
    "cars24_leads?select=lead_code,customer_name,city,intent,budget_min,budget_max,status&order=created_at.desc&limit=10"
  );
  const hot = await sbGET(
    "cars24_inventory?select=stock_id,make,model,variant,year,km_driven,fuel_type,transmission,hub,price_listed&status=eq.listed&order=listed_at.desc&limit=15"
  );
  const deals = await sbGET(
    "cars24_sales_pipeline?select=deal_code,stage,expected_close_date,deal_value,salesperson&stage=in.(test_drive,negotiation,financing)&limit=10"
  );
  console.log(
    "  leads:",
    leads.length,
    "  hot inventory:",
    hot.length,
    "  active deals:",
    deals.length
  );

  // 2. Preamble (abbreviated — the real mount path uses the full generator)
  const preambleLines = [];
  preambleLines.push("CARS24 SALES CONTEXT (live rows):");
  preambleLines.push('Caller intent (from form): "Swift or similar hatchback under 6 lakh in Gurgaon"');
  preambleLines.push("\nHOT INVENTORY:");
  for (const c of hot.slice(0, 10)) {
    preambleLines.push(
      `  ${c.stock_id}: ${c.year} ${c.make} ${c.model} ${c.variant || ""} · ${Math.round((c.km_driven || 0) / 1000)}k km · ${c.fuel_type}/${c.transmission} · ${c.hub} · ₹${(c.price_listed / 100000).toFixed(1)}L`
    );
  }
  preambleLines.push(
    "\nRULE: if buyer asks for something NOT in HOT INVENTORY above, say 'let me flag that to our stock team — they'll call you back within 2 hours'."
  );
  const preamble = preambleLines.join("\n");
  console.log("\n[2] Preamble preview (first 400 chars):\n", preamble.slice(0, 400));

  // 3. Claude
  console.log(
    "\n[3] Asking Priya: 'Hi, I'm looking for a Swift or similar hatchback under 6 lakh, preferably in Gurgaon or Delhi. What do you have?'"
  );
  const messages = [
    {
      role: "user",
      content:
        "Hi, I'm looking for a Swift or similar hatchback under 6 lakh, preferably in Gurgaon or Delhi. What do you have?",
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
      max_tokens: 240,
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
  console.log("\n[3] Priya reply:\n" + reply);

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

  console.log("\n[4] Rendering Cartesia TTS in Parvati voice…");
  await tts(agent.greeting, "priya-greeting.mp3");
  await tts(reply, "priya-reply.mp3");

  console.log("\n✓ Priya integration smoke PASSED.");
}

main().catch((e) => {
  console.error("✗ FAILED:", e.message);
  process.exit(1);
});
