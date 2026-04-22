// agent-brain.js — Generic multi-agent voice brain (v8.0, 2026-04-22)
//
// Parallel to ai-brain.js. Whereas ai-brain.js hard-codes the GarmentBridge
// assistant at /ai/*, this module exposes a config-driven router at
//   /agents/:agentId/{context,voice,turn,status}
// where each agentId has its own:
//   - name, voice_id, model, greeting, system_prompt
//   - optional complete_url + shared secret header (POST transcript on hangup)
//   - optional tools registry (for Claude function-calling — not used by CoS v1
//     which gets the full Cars24 snapshot injected into the system prompt)
//
// The audio cache and `/ai/audio/:id.mp3` endpoint from ai-brain.js are REUSED
// by passing an `audioRenderer` in. Session state is agent-scoped so two
// concurrent calls to different agents share nothing.

const crypto = require("crypto");

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_MODEL = process.env.CARTESIA_MODEL || "sonic-2";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_SECONDS || "360", 10);
const MAX_EMPTY_GATHERS = 2;

function tlog(tag, msg) {
  console.log(
    "[AG " + new Date().toISOString().slice(11, 23) + "][" + tag + "] " + msg
  );
}

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ===== AGENT CONFIGS =====
// Add new agents here. Each config is self-contained.
const AGENT_CONFIGS = {
  "cos-cars24": {
    id: "cos-cars24",
    display_name: "Arjun — Chief of Staff",
    voice_id: "be79f378-47fe-4f9c-b92b-f02cefa62ccf", // Sunil - Official Announcer
    model: process.env.COS_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Hi, this is Arjun, your Chief of Staff for Cars24. What would you like a read on?",
    closing: "Thanks. I'll be here whenever you need a pulse check. Goodbye.",
    complete_url:
      (process.env.COS_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/cos/complete",
    complete_secret_env: "COS_SHARED_SECRET",
    system_prompt: [
      "You are Arjun, Chief of Staff to the CEO and executive leadership of Cars24 (India's largest used-car platform).",
      "Your role: deliver McKinsey-analyst precision with warm Indian executive gravitas.",
      "Speak plain English. Executive tone. Never robotic, never sycophantic.",
      "Responses must be SHORT: 1-3 sentences for voice turns. If asked for a one-minute summary, you may go to 5 sentences.",
      "You have access to a live Cars24 operating snapshot in the CARS24 CONTEXT block below — always ground answers in those actual numbers.",
      "Cite specific hubs, campaign codes, deal counts, or EBITDA figures from the context. Never invent numbers.",
      "If asked about something NOT in the context (a specific customer name, a policy decision), say you will get it triangulated and suggest the right desk to reach.",
      "HARD RULES:",
      "  - Never quote car prices or confirm commercial actions. Those need the sales desk.",
      "  - Never commit to a legal interpretation. Loop in the Legal agent.",
      "  - Do not read raw numbers like rupees without rounding to Cr/Lakh (e.g., '₹552 crore').",
      "  - No markdown, no emojis, no lists, no stage directions. Plain speakable sentences only.",
      "  - If the caller opens with a generic 'brief me', lead with (a) the single biggest red flag and (b) the one number they should internalise today.",
      "End every non-closing reply with a soft handoff — 'anything else?' or 'do you want me to pull marketing next?'.",
    ].join(" "),
  },

  // ========== Sprint-2 agents (config staged; Option A voices approved 2026-04-22) ==========
  // To activate: enable the corresponding `/api/voice/<agent>/*` routes on NovakOS (copy from cos/*)
  // and set SPRINT2_ENABLED=true on Render to turn on routing for these agents.

  "sales-cars24": {
    id: "sales-cars24",
    display_name: "Priya — Sales",
    voice_id: "bec003e2-3cb3-429c-8468-206a393c67ad", // Parvati - Friendly Supporter
    model: process.env.SALES_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Hi, I'm Priya from Cars24 Sales. Are you looking to buy a car, sell one, or something else?",
    closing: "Thanks for calling. Drive safe!",
    complete_url:
      (process.env.SALES_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/sales/complete",
    complete_secret_env: "SALES_SHARED_SECRET",
    system_prompt: [
      "You are Priya, a Cars24 sales agent. Warm, energetic, consultative, and a practiced negotiator — you qualify buyers, hold price anchors, deflect pushback smoothly, and close toward a next step.",
      "CRITICAL RULE: This is a VOICE CALL. Reply in ONE OR TWO SHORT SENTENCES — never more than 25 words per reply. Never list more than one car unless the caller explicitly asks for options.",
      "NEVER address the caller by a name from the RECENT LEADS list — those are other customers, not this caller. If you don't have the caller's name, just say 'yes' or 'sure' or their question back, never guess a name.",
      "You have access to the caller's lead history and matching inventory in the CARS24 SALES CONTEXT block, and a PRE-CALL STRATEGIST PLAYBOOK with scene-specific tactics (ANCHOR, PUSHBACK-MOVES, CLOSE, HARD-LINES).",
      "BEHAVIOR: read the playbook before your first reply. Follow ANCHOR to lead with the right car. When the buyer pushes back, pick the matching PUSHBACK-MOVE; don't repeat yourself. Drive toward the CLOSE.",
      "NEGOTIATION INSTINCTS:",
      "  - When asked 'can you do better?' — don't drop price; pivot to value (finance structure, warranty, trade-in offset, priority inspection slot).",
      "  - When asked 'what about cash?' — acknowledge but don't promise a discount; offer priority handling instead.",
      "  - When asked about trade-in — give a rough price band based on make/model/year and offer an appraisal booking; never commit a firm number.",
      "  - When buyer hesitates with 'I'll think about it' — offer a small, reversible commitment (saved listing, a no-obligation test drive).",
      "  - When buyer's budget is below all inventory — show the closest match anyway and offer EMI framing; if nothing fits, flag to stock team.",
      "Voice-call rules: 1-3 sentences per reply, up to 4 when listing car options. Conversational, warm, never pushy or scripted-sounding. Mirror the buyer's energy.",
      "HARD RULES:",
      "  - Never give a firm final price — always say 'our valuation team will confirm exact numbers after inspection'.",
      "  - Never promise loan approval (that's finance's call) or delivery dates beyond what the data shows.",
      "  - Use loan-words the caller uses (haan, bilkul) but default to English.",
      "  - If the caller wants to escalate, offer to schedule a callback with a human rep.",
      "  - No markdown, no asterisks, no bullet lists, no emojis, no stage directions. Plain speakable sentences only — this is audio.",
      "  - Read money as 'six point eight lakh' not '6.8L'. Round politely: '₹680,000' → 'around six point eight lakh'.",
      "End each turn with a next-step offer or a question that moves the buyer forward.",
    ].join(" "),
  },

  "marketing-cars24": {
    id: "marketing-cars24",
    display_name: "Rohan — Marketing",
    voice_id: "4877b818-c7fe-4c89-b1cf-eadf8e23da72", // Rohan - Steady Communicator
    model: process.env.MARKETING_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Rohan here from the Cars24 marketing desk. Want a campaign read or a channel breakdown?",
    closing: "Alright, I'll be here when the next brief needs heat. Thanks.",
    complete_url:
      (process.env.MARKETING_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/marketing/complete",
    complete_secret_env: "MARKETING_SHARED_SECRET",
    system_prompt: [
      "You are Rohan, Cars24 Marketing. Corporate-clear, data-driven, campaign-literate. You speak like a CMO's right hand.",
      "Scope: campaign performance (Google/Meta/YouTube/offline), CAC trends, audience insights, ad-copy angle suggestions.",
      "Ground every claim in the CARS24 CONTEXT — cite campaign_code, channel, spend, leads, conversions, ROI, CAC deltas.",
      "Voice-call: 1-3 sentences per turn. Crisp, not preachy.",
      "HARD RULES: no promising channel magic, no guaranteed CPLs, no creative locks (just directional takes). End with 'want me to dig deeper on X?'.",
    ].join(" "),
  },

  "finance-cars24": {
    id: "finance-cars24",
    display_name: "Vikram — Finance",
    voice_id: "098fb15d-2597-4186-8b74-25340050b6e7", // Vishal - Assured Expert
    model: process.env.FINANCE_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Vikram from Finance. Do you want the monthly P&L, cash position, or a deal-specific read?",
    closing: "Noted. I'll stay on the numbers.",
    complete_url:
      (process.env.FINANCE_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/finance/complete",
    complete_secret_env: "FINANCE_SHARED_SECRET",
    system_prompt: [
      "You are Vikram, Finance at Cars24. Analytical gravitas, precise, risk-aware — a CFO-office operator, not an accountant.",
      "CRITICAL RULE: This is a VOICE CALL. Reply in ONE OR TWO SHORT SENTENCES — never more than 30 words per reply. Stop at one key number + one conclusion. If the exec wants more, they'll ask.",
      "NEVER address the caller by any name. Do not infer a name from any context data. If uncertain, address them by role ('sir' or 'you') or just begin with the answer.",
      "NEVER use bullets, asterisks, markdown, or tag labels. Plain conversational English that a person would say in a hallway brief.",
      "You have access to the CARS24 FINANCE CONTEXT (live P&L, pipeline, ops) and a PRE-CALL STRATEGIST BRIEF with TODAY-STATE, RED-FLAG, TOP-3-RECOMMENDATIONS, LOAN-ATTACH-LENS, and HARD-LINES.",
      "BEHAVIOR: read the strategist brief before your first reply. When the executive asks a general question, lead with the RED-FLAG and the single most important number. When asked 'what should we do?' — deliver the TOP-3-RECOMMENDATIONS in ranked order. When asked about loan attach or revenue growth, use the LOAN-ATTACH-LENS framing.",
      "DIAGNOSTIC FRAMEWORK (for every recommendation you give):",
      "  1. State the variance with direction ('worsened' or 'improved') and month-over-month delta.",
      "  2. Name the likely root cause, grounded in the context numbers.",
      "  3. Recommend ONE specific action.",
      "  4. Quantify expected ₹ Cr impact and time-to-see-result.",
      "Example shape: 'EBITDA worsened 22 crore MoM, driven by a 40% marketing opex spike in Bangalore; recommend capping Google brand spend at February levels for 30 days; expected savings 8 crore by end-month.'",
      "Voice-call: 1-3 sentences per turn. Deliberate, confident, never hesitant. Speak like someone who has already reviewed the deck.",
      "HARD RULES:",
      "  - Never make forward-looking forecasts beyond 1 month.",
      "  - Never disclose competitor financials.",
      "  - Never reveal customer-level credit data.",
      "  - On tax/audit queries, punt to Legal.",
      "  - Never speculate on IPO valuation.",
      "  - No markdown, no asterisks, no bullet lists, no emojis, no stage directions. Plain speakable sentences only — this is audio.",
      "  - Read rupee figures naturally: 'five thousand four hundred ninety-one crore' → say 'roughly fifty-five hundred crore'. Round for the ear. Never read the minus sign; say 'negative' instead.",
      "If asked a question the data doesn't support, say so plainly and offer to circulate a follow-up note.",
    ].join(" "),
  },

  "pm-cars24": {
    id: "pm-cars24",
    display_name: "Sneha — Operations / PM",
    voice_id: "6b02ffe5-e3cb-48c0-a023-c72f85953375", // Sneha - Empathetic Voice
    model: process.env.PM_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "This is Sneha from Cars24 Operations. Want the hub snapshot or a specific car's refurb status?",
    closing: "Okay, I've got it noted. Thanks.",
    complete_url:
      (process.env.PM_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/pm/complete",
    complete_secret_env: "PM_SHARED_SECRET",
    system_prompt: [
      "You are Sneha, Cars24 Operations. Practical, organized, no-drama.",
      "Scope: inventory flow (procurement, inspection, refurbishment, listing, sale), hub-level KPIs, test-drive schedules, delivery tracking, backlog alerts.",
      "Use CARS24 CONTEXT numbers directly — cite hub names (Gurgaon, Noida, Mumbai, Bangalore, Pune, Hyderabad) and actual daily metrics.",
      "Voice-call: 1-3 sentences per turn. Clear and fact-first.",
      "HARD RULES: never promise delivery dates without checking inventory status, never bypass inspection protocol, never commit to refurb timelines. Flag bottlenecks fast.",
    ].join(" "),
  },

  "legal-cars24": {
    id: "legal-cars24",
    display_name: "Kabir — Legal",
    voice_id: "910fb75e-1d20-4840-ac63-ac6b26a71bdc", // Dev - Friendly Host
    model: process.env.LEGAL_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Hi, Kabir here from Cars24 Legal. Is this about an RC transfer, a dispute, or something else?",
    closing: "Understood. I'll flag it to the desk.",
    complete_url:
      (process.env.LEGAL_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/legal/complete",
    complete_secret_env: "LEGAL_SHARED_SECRET",
    system_prompt: [
      "You are Kabir, Cars24 Legal. Measured, formal but warm, risk-aware.",
      "Scope: RC transfer process guidance, insurance claim triage, buyer/seller dispute intake, consumer-protection basics, GST/compliance queries at a high level.",
      "Voice-call: 1-3 sentences per turn. Precise wording matters — never speak loosely about law.",
      "HARD RULES: you do NOT give binding legal advice — always frame as 'general guidance' and escalate to human counsel for any specific matter. Never name courts, judges, or specific statutes you're not 100% sure of. Capture dispute details for the desk and promise a written follow-up.",
    ].join(" "),
  },

  "cto-cars24": {
    id: "cto-cars24",
    display_name: "Aditi — CTO",
    voice_id: "95d51f79-c397-46f9-b49a-23763d3eaa2d", // Arushi - Hinglish Speaker
    model: process.env.CTO_MODEL || "claude-haiku-4-5-20251001",
    greeting:
      "Aditi here, engineering desk. Platform status, incident, or API question — which one?",
    closing: "Cool, pinging the on-call if needed. Bye.",
    complete_url:
      (process.env.CTO_COMPLETE_URL || "").trim() ||
      "https://novakos-sable.vercel.app/api/voice/cto/complete",
    complete_secret_env: "CTO_SHARED_SECRET",
    system_prompt: [
      "You are Aditi, Cars24 CTO's voice. Technical, crisp, incident-report mindset.",
      "Scope: platform uptime, API health, release status, ongoing incidents, capacity/scale concerns, integration issues with dealer partners.",
      "You may mix English with tech terms naturally (the Arushi Hinglish voice makes this sound native). Still default to English.",
      "Voice-call: 1-3 sentences per turn. Engineer-to-engineer tone, not customer-support.",
      "HARD RULES: no production secrets, no customer PII in audio, no commitments on engineering timelines without PM sign-off. On incidents, follow the severity-severity-mitigation-ETA pattern.",
    ].join(" "),
  },
};

// Basic sessions store keyed by `${agentId}:${call_id}`
const sessions = new Map();

function sessionKey(agentId, callId) {
  return agentId + ":" + callId;
}

function getOrCreateSession(agentId, callId) {
  const key = sessionKey(agentId, callId);
  let s = sessions.get(key);
  if (!s) {
    s = {
      agentId,
      callId,
      context: null,
      preamble: "",
      playbook: "",
      turns: [],
      startedAt: Date.now(),
      emptyGathers: 0,
      completedPosted: false,
      twilioSid: null,
    };
    sessions.set(key, s);
  }
  return s;
}

function callAtCap(s) {
  return (Date.now() - s.startedAt) / 1000 >= MAX_CALL_SECONDS;
}

// ===== Cars24 snapshot fetcher =====
// Uses Supabase REST API with service key. Pulls the aggregates Arjun needs.
const SUPABASE_URL =
  (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

async function sbGET(path) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const resp = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("sb " + resp.status + ": " + t.slice(0, 160));
  }
  return await resp.json();
}

function inr(n) {
  if (n == null || isNaN(n)) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e7) return "₹" + (v / 1e7).toFixed(1) + " Cr";
  if (Math.abs(v) >= 1e5) return "₹" + (v / 1e5).toFixed(1) + " L";
  if (Math.abs(v) >= 1000) return "₹" + (v / 1000).toFixed(0) + "K";
  return "₹" + Math.round(v);
}

async function fetchCars24Snapshot() {
  try {
    const [inventory, leads, deals, opsToday, campaigns, finance] = await Promise.all([
      sbGET("cars24_inventory?select=hub,status"),
      sbGET("cars24_leads?select=status,intent,city"),
      sbGET("cars24_sales_pipeline?select=stage,deal_value,expected_close_date"),
      sbGET("cars24_operations?select=hub,date,cars_sold,test_drives,backlog_cars,avg_inspection_hours&order=date.desc&limit=36"),
      sbGET("cars24_marketing_campaigns?select=name,channel,status,spend,leads,conversions,cac,roi"),
      sbGET("cars24_finance_metrics?select=*&order=month.desc&limit=3"),
    ]);

    // Inventory by hub and status
    const invByHub = {};
    const invByStatus = {};
    for (const r of inventory || []) {
      invByHub[r.hub] = (invByHub[r.hub] || 0) + 1;
      invByStatus[r.status] = (invByStatus[r.status] || 0) + 1;
    }

    // Lead funnel
    const leadByStatus = {};
    const leadByIntent = {};
    for (const r of leads || []) {
      leadByStatus[r.status] = (leadByStatus[r.status] || 0) + 1;
      leadByIntent[r.intent] = (leadByIntent[r.intent] || 0) + 1;
    }

    // Pipeline by stage
    const pipeByStage = {};
    let pipelineValueOpen = 0;
    for (const r of deals || []) {
      pipeByStage[r.stage] = (pipeByStage[r.stage] || 0) + 1;
      if (!["delivered", "dropped"].includes(r.stage)) {
        pipelineValueOpen += Number(r.deal_value || 0);
      }
    }

    // Ops — latest date across all hubs for "today", plus red-flag backlog
    const latestDate = (opsToday || [])[0]?.date;
    const todayOps = (opsToday || []).filter((r) => r.date === latestDate);
    const hubBacklogs = todayOps.map((r) => ({
      hub: r.hub,
      backlog: r.backlog_cars,
      inspection_hrs: r.avg_inspection_hours,
    }));
    const redFlagHub = hubBacklogs.find((h) => h.backlog >= 20);

    // Marketing
    const activeCampaigns = (campaigns || []).filter((c) => c.status === "active");
    const totalSpend = (campaigns || []).reduce((a, c) => a + Number(c.spend || 0), 0);
    const totalLeads = (campaigns || []).reduce((a, c) => a + Number(c.leads || 0), 0);
    const totalConv = (campaigns || []).reduce((a, c) => a + Number(c.conversions || 0), 0);
    const blendedCAC = totalConv > 0 ? Math.round(totalSpend / totalConv) : null;
    const underperformer = (campaigns || []).find((c) => Number(c.roi) < 0 && c.status === "active");

    const latestFin = (finance || [])[0] || null;
    const priorFin = (finance || [])[1] || null;

    return {
      date: latestDate || "unknown",
      inventory: {
        total: (inventory || []).length,
        by_hub: invByHub,
        by_status: invByStatus,
      },
      leads: {
        total: (leads || []).length,
        by_status: leadByStatus,
        by_intent: leadByIntent,
      },
      pipeline: {
        by_stage: pipeByStage,
        open_value: pipelineValueOpen,
      },
      ops_today: {
        hubs: hubBacklogs,
        red_flag_hub: redFlagHub || null,
      },
      marketing: {
        active_campaigns: activeCampaigns.length,
        total_spend: totalSpend,
        total_leads: totalLeads,
        total_conversions: totalConv,
        blended_cac: blendedCAC,
        underperformer: underperformer
          ? {
              name: underperformer.name,
              channel: underperformer.channel,
              roi: Number(underperformer.roi),
            }
          : null,
      },
      finance: {
        latest_month: latestFin?.month || null,
        revenue: latestFin?.revenue ? Number(latestFin.revenue) : null,
        ebitda: latestFin?.ebitda ? Number(latestFin.ebitda) : null,
        cash_position: latestFin?.cash_position ? Number(latestFin.cash_position) : null,
        cars_sold: latestFin?.cars_sold || null,
        avg_selling_price: latestFin?.avg_selling_price
          ? Number(latestFin.avg_selling_price)
          : null,
        mom_revenue_delta:
          latestFin && priorFin
            ? Number(latestFin.revenue) - Number(priorFin.revenue)
            : null,
      },
    };
  } catch (e) {
    tlog("cos-cars24", "[SNAPSHOT ERR] " + e.message);
    return null;
  }
}

// ===== Sales (Priya) context =====
// Priya needs concrete rows, not aggregates — so she can cite a specific
// 2022 Maruti Swift VXI in Gurgaon hub, 18,000 km, ₹6.8L.
async function fetchSalesContext() {
  try {
    const [recentLeads, hotInventory, activeDeals] = await Promise.all([
      sbGET(
        "cars24_leads?select=lead_code,customer_name,city,intent,budget_min,budget_max,status,created_at&order=created_at.desc&limit=10"
      ),
      sbGET(
        "cars24_inventory?select=stock_id,make,model,variant,year,km_driven,fuel_type,transmission,hub,price_listed,listed_at&status=eq.listed&order=listed_at.desc&limit=15"
      ),
      sbGET(
        "cars24_sales_pipeline?select=deal_code,stage,expected_close_date,deal_value,salesperson&stage=in.(test_drive,negotiation,financing)&order=updated_at.desc&limit=10"
      ),
    ]);
    return {
      recent_leads: recentLeads || [],
      hot_inventory: hotInventory || [],
      active_deals: activeDeals || [],
    };
  } catch (e) {
    tlog("sales-cars24", "[CTX ERR] " + e.message);
    return null;
  }
}

function salesPreamble(ctx, buyerIntent) {
  if (!ctx) return "";
  const lines = [];
  lines.push(
    "CARS24 SALES CONTEXT (live rows — cite stock IDs and exact prices when helpful):"
  );
  if (buyerIntent) {
    lines.push(`• Caller's stated intent (from form): "${buyerIntent}"`);
    lines.push("");
  }
  lines.push("HOT INVENTORY (recently listed, available to sell):");
  for (const c of ctx.hot_inventory.slice(0, 15)) {
    const km = c.km_driven
      ? `${Math.round(c.km_driven / 1000)}k km`
      : "— km";
    lines.push(
      `  ${c.stock_id}: ${c.year} ${c.make} ${c.model} ${c.variant || ""} · ${km} · ${c.fuel_type}/${c.transmission} · ${c.hub} hub · ${inr(c.price_listed)}`
    );
  }
  lines.push("");
  lines.push("RECENT LEADS (last 10) — DO NOT address the current caller by any of these names; they are past leads, not this caller:");
  for (const l of ctx.recent_leads.slice(0, 10)) {
    const budget =
      l.budget_min && l.budget_max
        ? `${inr(l.budget_min)}–${inr(l.budget_max)}`
        : "—";
    // Strip customer_name; only lead_code + city + intent + budget
    lines.push(
      `  ${l.lead_code}: ${l.city} — ${l.intent}, budget ${budget}, status ${l.status}`
    );
  }
  lines.push("");
  lines.push("ACTIVE DEALS (stage: test_drive / negotiation / financing):");
  for (const d of ctx.active_deals.slice(0, 10)) {
    lines.push(
      `  ${d.deal_code}: ${d.stage}, ${inr(d.deal_value)}, expected close ${d.expected_close_date}, owner ${d.salesperson}`
    );
  }
  lines.push("");
  lines.push(
    "RULE: if buyer asks for something NOT in HOT INVENTORY above, say exactly: 'let me flag that to our stock team — they'll call you back within 2 hours'. Never invent a car."
  );
  return lines.join("\n");
}

// ===== Finance (Vikram) context =====
async function fetchFinanceContext() {
  try {
    const [finance6mo, latestOps, pipelineDeals] = await Promise.all([
      sbGET("cars24_finance_metrics?select=*&order=month.desc&limit=6"),
      sbGET(
        "cars24_operations?select=hub,date,cars_sold,cars_procured,deliveries&order=date.desc&limit=18"
      ),
      sbGET("cars24_sales_pipeline?select=stage,deal_value&limit=50"),
    ]);
    return {
      finance_6mo: finance6mo || [],
      latest_ops: latestOps || [],
      pipeline_deals: pipelineDeals || [],
    };
  } catch (e) {
    tlog("finance-cars24", "[CTX ERR] " + e.message);
    return null;
  }
}

function financePreamble(ctx) {
  if (!ctx) return "";
  const lines = [];
  lines.push(
    "CARS24 FINANCE CONTEXT (live — cite specific months and round to ₹ Cr/L):"
  );
  lines.push("");
  lines.push("FINANCE METRICS (last 6 months, newest first):");
  for (const m of ctx.finance_6mo) {
    const monthLabel = String(m.month || "").slice(0, 7);
    lines.push(
      `  ${monthLabel}: revenue ${inr(m.revenue)} · COGS ${inr(m.cogs)} · gross margin ${inr(m.gross_margin)} · opex ${inr(m.opex)} · EBITDA ${inr(m.ebitda)} · cash ${inr(m.cash_position)} · loan book ${inr(m.loan_portfolio)} · insurance rev ${inr(m.insurance_revenue)} · refurb rev ${inr(m.refurb_revenue)} · cars sold ${m.cars_sold} · ASP ${inr(m.avg_selling_price)}`
    );
  }
  // EBITDA trend — state direction unambiguously so the model can't mis-read
  if (ctx.finance_6mo.length >= 2) {
    const cur = Number(ctx.finance_6mo[0].ebitda);
    const prior = Number(ctx.finance_6mo[1].ebitda);
    const delta = cur - prior;
    const direction = delta < 0 ? "WORSENED" : "IMPROVED";
    lines.push(
      `  EBITDA direction MoM: ${direction}. EBITDA moved from ${inr(prior)} (prior month) to ${inr(cur)} (current month). Net change ${inr(delta)} (negative means worse).`
    );
  }
  lines.push("");
  lines.push("PIPELINE SNAPSHOT (50 most recent deals):");
  const stageAgg = {};
  for (const d of ctx.pipeline_deals) {
    const row = stageAgg[d.stage] || { count: 0, value: 0 };
    row.count += 1;
    row.value += Number(d.deal_value || 0);
    stageAgg[d.stage] = row;
  }
  for (const [stage, row] of Object.entries(stageAgg)) {
    lines.push(
      `  ${stage}: ${row.count} deals · total value ${inr(row.value)}`
    );
  }
  lines.push("");
  lines.push("OPERATIONS (last 18 hub-days, for unit-economics context):");
  const byHub = {};
  for (const o of ctx.latest_ops) {
    byHub[o.hub] = byHub[o.hub] || { sold: 0, procured: 0, deliveries: 0 };
    byHub[o.hub].sold += Number(o.cars_sold || 0);
    byHub[o.hub].procured += Number(o.cars_procured || 0);
    byHub[o.hub].deliveries += Number(o.deliveries || 0);
  }
  for (const [hub, agg] of Object.entries(byHub)) {
    lines.push(
      `  ${hub}: sold ${agg.sold} · procured ${agg.procured} · delivered ${agg.deliveries}`
    );
  }
  lines.push("");
  lines.push(
    "RULE: never forecast beyond 1 month. Never disclose competitor financials. Never reveal customer-level credit data."
  );
  return lines.join("\n");
}

function cars24PreambleFromSnapshot(snap) {
  if (!snap) return "";
  const lines = [];
  lines.push("CARS24 CONTEXT (live operating snapshot — do not read aloud; ground your answers in these figures):");
  lines.push(`• Snapshot date: ${snap.date}`);
  lines.push("");
  lines.push("INVENTORY:");
  lines.push(`  Total in system: ${snap.inventory.total} cars`);
  lines.push(`  By hub: ${Object.entries(snap.inventory.by_hub).map(([h, n]) => `${h} ${n}`).join(" · ")}`);
  lines.push(`  By status: ${Object.entries(snap.inventory.by_status).map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  lines.push("");
  lines.push("LEADS:");
  lines.push(`  Total last-30-day: ${snap.leads.total}`);
  lines.push(`  By status: ${Object.entries(snap.leads.by_status).map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  lines.push(`  By intent: ${Object.entries(snap.leads.by_intent).map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  lines.push("");
  lines.push("SALES PIPELINE:");
  lines.push(`  By stage: ${Object.entries(snap.pipeline.by_stage).map(([s, n]) => `${s} ${n}`).join(" · ")}`);
  lines.push(`  Open deal value: ${inr(snap.pipeline.open_value)}`);
  lines.push("");
  lines.push("OPERATIONS TODAY (per hub):");
  for (const h of snap.ops_today.hubs) {
    lines.push(`  ${h.hub}: backlog ${h.backlog} · inspection avg ${h.inspection_hrs}h`);
  }
  if (snap.ops_today.red_flag_hub) {
    lines.push(`  ⚠ RED FLAG — ${snap.ops_today.red_flag_hub.hub} backlog ${snap.ops_today.red_flag_hub.backlog} cars (target <15), inspection time ${snap.ops_today.red_flag_hub.inspection_hrs}h`);
  }
  lines.push("");
  lines.push("MARKETING:");
  lines.push(`  Active campaigns: ${snap.marketing.active_campaigns}`);
  lines.push(`  Total spend (all campaigns): ${inr(snap.marketing.total_spend)}`);
  lines.push(`  Leads: ${snap.marketing.total_leads} · Conversions: ${snap.marketing.total_conversions} · Blended CAC: ${inr(snap.marketing.blended_cac)}`);
  if (snap.marketing.underperformer) {
    const u = snap.marketing.underperformer;
    lines.push(`  ⚠ Underperforming campaign: ${u.name} (${u.channel}) — ROI ${u.roi}`);
  }
  lines.push("");
  lines.push("FINANCE (latest month " + (snap.finance.latest_month || "?") + "):");
  lines.push(`  Revenue: ${inr(snap.finance.revenue)}`);
  lines.push(`  EBITDA: ${inr(snap.finance.ebitda)} ${snap.finance.ebitda < 0 ? "(loss — expected for growth phase)" : ""}`);
  lines.push(`  Cash position: ${inr(snap.finance.cash_position)}`);
  lines.push(`  Cars sold: ${snap.finance.cars_sold} · ASP: ${inr(snap.finance.avg_selling_price)}`);
  if (snap.finance.mom_revenue_delta != null) {
    const d = snap.finance.mom_revenue_delta;
    lines.push(`  MoM revenue delta: ${d >= 0 ? "+" : ""}${inr(Math.abs(d))}`);
  }
  return lines.join("\n");
}

// ===== Sonnet Strategist (pre-call) =====
// Runs ONCE per call at /agents/:id/context.
// Uses Sonnet 4.5 to produce a compact tactical playbook, which is injected
// into the live Haiku system prompt — gives "Sonnet-grade intelligence at
// Haiku-grade latency" per the Apr-22 Nitish directive.
const STRATEGIST_MODEL = process.env.STRATEGIST_MODEL || "claude-sonnet-4-5-20250929";

async function runStrategist(agentId, preamble, extraContext) {
  if (!ANTHROPIC_API_KEY) return "";
  let brief = "";
  let systemPromptForStrategist = "";

  if (agentId === "sales-cars24") {
    const intent = (extraContext && extraContext.buyer_intent) || "(no specific intent captured)";
    systemPromptForStrategist = [
      "You are a senior Cars24 sales-coach who writes TACTICAL PLAYBOOKS for a voice AI sales agent named Priya.",
      "Your playbook will be used in real-time by a lower-latency model to hold a phone conversation with a buyer.",
      "Output format: plain text only, under 300 tokens total. NO markdown formatting of any kind — no asterisks, no hashes, no underscores, no code fences, no hyphens-as-bullets. Use line breaks between sections.",
      "ABSOLUTELY NO customer names from any lead data — the playbook is advice for Priya, not a script that addresses the caller.",
      "Structure the playbook with these five tagged blocks, in this order, each starting with the tag in ALL CAPS on its own line:",
      "  CALLER-READ: 1-2 lines inferring caller situation from the intent and inventory match.",
      "  ANCHOR: which specific stock_id to lead with and why; which to hold in reserve as fallback.",
      "  PUSHBACK-MOVES: 3 concrete one-line counters to 'can you do better?' / 'that's too expensive' / 'I'll think about it' / 'what if I pay cash?' / 'what about trade-in?'",
      "  CLOSE: the specific next step to push for (test drive, site visit, finance pre-approval), in one line.",
      "  HARD-LINES: 2-3 things Priya must never say or promise.",
      "Ground every car reference in stock_ids from HOT INVENTORY in the context. Never invent.",
    ].join(" ");
    brief = "BUYER INTENT (from web form): " + intent + "\n\n" + (preamble || "");
  } else if (agentId === "finance-cars24") {
    systemPromptForStrategist = [
      "You are a senior Cars24 finance strategist who writes DIAGNOSTIC RECOMMENDATION BRIEFS for a voice AI named Vikram.",
      "Your brief is used in real-time by a lower-latency model when an executive calls asking about P&L, EBITDA, loan book, or strategy.",
      "Output format: plain text only, under 350 tokens total. NO markdown formatting of any kind — no asterisks, no hashes, no underscores, no code fences, no hyphens-as-bullets. Use line breaks between sections.",
      "ABSOLUTELY NO customer names from any context data — the brief is advice for Vikram, not a script that addresses a specific caller.",
      "Structure with these tagged blocks, each starting with the tag in ALL CAPS on its own line:",
      "  TODAY-STATE: 3 lines of the biggest operating numbers from the context, rounded to ₹Cr/L.",
      "  RED-FLAG: the single most important variance, with month-over-month direction and the likely root cause.",
      "  TOP-3-RECOMMENDATIONS: three specific, ranked, actionable moves; each one: action + expected impact in ₹ Cr + time-to-see-result.",
      "  LOAN-ATTACH-LENS: quantify the gap between current attach and 30% target using the caller\u2019s context numbers; frame the ₹ opportunity. (This is the #1 pitch lever per the Cars24 CBO's own post.)",
      "  HARD-LINES: 3 things Vikram must never say (no forecasts >30 days; no competitor financials; no customer-level credit data).",
      "Ground every figure in the CARS24 FINANCE CONTEXT numbers. Never invent. Always say direction (worsened / improved) unambiguously.",
    ].join(" ");
    brief = preamble || "";
  } else {
    return "";
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: STRATEGIST_MODEL,
        max_tokens: 700,
        system: systemPromptForStrategist,
        messages: [{ role: "user", content: brief }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const t = await resp.text();
      tlog(agentId, "[STRATEGIST ERR " + resp.status + "] " + t.slice(0, 200));
      return "";
    }
    const data = await resp.json();
    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    tlog(agentId, "[STRATEGIST OK] " + text.length + " chars");
    return text;
  } catch (e) {
    tlog(agentId, "[STRATEGIST THROW] " + e.message);
    return "";
  }
}

// ===== Claude + Cartesia =====
async function callClaude(session, agent, userText) {
  const messages = session.turns
    .filter((t) => t.role === "user" || t.role === "assistant")
    .map((t) => ({ role: t.role, content: t.text }));
  messages.push({ role: "user", content: userText });

  let system = agent.system_prompt;
  if (session.preamble) system += "\n\n" + session.preamble;
  if (session.playbook) {
    system += "\n\n===== PRE-CALL STRATEGIST PLAYBOOK (authoritative — ground all answers here) =====\n" + session.playbook;
  }

  const body = {
    model: agent.model,
    // Voice turns must be brief. 120 tokens ≈ 2-3 tight sentences, matches the "SHORT" rule.
    max_tokens: 120,
    system,
    messages,
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Claude " + resp.status + ": " + t.slice(0, 300));
  }
  const data = await resp.json();
  const rawText = (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .trim();
  // Defensive sanitizer — strip markdown/formatting artifacts that TTS would read aloud.
  // Covers: bold (**text**), italics (*text* and _text_), bullets, headers, code fences, ALL-CAPS tag blocks that leaked from strategist.
  const text = rawText
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // **bold**
    .replace(/(^|\s)\*(\S[^*]*?\S)\*/g, "$1$2") // *italic*
    .replace(/(^|\s)_([^_]+)_(\s|$)/g, "$1$2$3") // _italic_
    .replace(/^#{1,6}\s+/gm, "")              // # headers
    .replace(/^[-*•]\s+/gm, "")              // leading bullets
    .replace(/```[^`]*```/g, "")              // code fences
    .replace(/`([^`]+)`/g, "$1")              // inline code
    .replace(/\n{2,}/g, ". ")                 // collapse paragraph breaks into sentence breaks
    .replace(/\s*\n\s*/g, " ")                // all other newlines to spaces
    .replace(/\s{2,}/g, " ")                  // collapse whitespace
    .replace(/^(CALLER-READ|ANCHOR|PUSHBACK-MOVES|CLOSE|HARD-LINES|TODAY-STATE|RED-FLAG|TOP-3-RECOMMENDATIONS|LOAN-ATTACH-LENS)[:\s].*$/gm, "") // strip any leaked strategist tag lines
    .trim();
  return text || "Sorry, I did not catch that. Could you repeat?";
}

async function cartesiaTTS(text, voiceId) {
  const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cartesia-Version": "2025-04-16",
      "X-API-Key": CARTESIA_API_KEY,
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      language: "en",
      output_format: {
        container: "mp3",
        bit_rate: 128000,
        sample_rate: 44100,
      },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Cartesia TTS " + resp.status + ": " + t.slice(0, 300));
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ===== TwiML helpers =====
function hangupTwiml(text) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">' +
    xmlEscape(text || "Thanks for calling. Goodbye.") +
    "</Say><Hangup/></Response>"
  );
}

function playAndHangupTwiml(host, audioId) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response><Play>https://' +
    host +
    "/ai/audio/" +
    audioId +
    ".mp3</Play><Hangup/></Response>"
  );
}

function gatherTwiml({ host, agentId, call_id, playAudioId, fallbackSpeak }) {
  const actionUrl =
    "/agents/" + encodeURIComponent(agentId) + "/turn?call_id=" + encodeURIComponent(call_id);
  // STT tuning: `phone_call` model handles Indian English accents more reliably than
  // `experimental_conversations`. Fixed speechTimeout avoids premature cutoffs.
  const gatherOpen =
    '<Gather input="speech" action="' +
    actionUrl +
    '" method="POST" language="en-IN" speechTimeout="2" ' +
    'speechModel="phone_call" actionOnEmptyResult="true" timeout="8" enhanced="true">';
  let inner = "";
  if (playAudioId) {
    inner = "<Play>https://" + host + "/ai/audio/" + playAudioId + ".mp3</Play>";
  } else if (fallbackSpeak) {
    inner = '<Say voice="alice">' + xmlEscape(fallbackSpeak) + "</Say>";
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    gatherOpen +
    inner +
    "</Gather></Response>"
  );
}

// Resolve the shared secret for a given agent.
// Priority: the agent's own secret env var → COS_SHARED_SECRET (fallback, shared across Cars24 agents).
function resolveAgentSecret(agent) {
  if (agent.complete_secret_env) {
    const own = process.env[agent.complete_secret_env];
    if (own) return own;
  }
  return process.env.COS_SHARED_SECRET || "";
}

async function postCompleteIfNeeded(agent, session, reason) {
  if (session.completedPosted) return;
  session.completedPosted = true;
  const secret = resolveAgentSecret(agent);
  if (!agent.complete_url) return;
  const duration = Math.round((Date.now() - session.startedAt) / 1000);
  const payload = {
    agent_id: agent.id,
    call_id: session.callId,
    twilio_call_sid: session.twilioSid,
    duration_seconds: duration,
    transcript: session.turns,
    ended_reason: reason,
  };
  try {
    const r = await fetch(agent.complete_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Secret": secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    tlog(agent.id, "[COMPLETE] POST " + agent.complete_url + " → " + r.status);
  } catch (e) {
    tlog(agent.id, "[COMPLETE ERR] " + e.message);
  }
}

// ===== Express mount =====
// Depends on ai-brain's audio cache; we pass in cacheAudio + audioEndpointPath.
function mount(app, { cacheAudio }) {
  if (typeof cacheAudio !== "function") {
    throw new Error("agent-brain.mount requires { cacheAudio } from ai-brain");
  }

  async function renderAndCache(text, voiceId) {
    const buf = await cartesiaTTS(text, voiceId);
    return cacheAudio(buf, "audio/mpeg");
  }

  // List configured agents
  app.get("/agents", (req, res) => {
    res.json({
      agents: Object.values(AGENT_CONFIGS).map((a) => ({
        id: a.id,
        display_name: a.display_name,
        voice_id: a.voice_id,
        model: a.model,
      })),
    });
  });

  app.get("/agents/:agentId/health", (req, res) => {
    const agent = AGENT_CONFIGS[req.params.agentId];
    if (!agent) return res.status(404).json({ error: "unknown agent" });
    res.json({
      id: agent.id,
      model: agent.model,
      voice_id: agent.voice_id,
      anthropic: ANTHROPIC_API_KEY ? "set" : "missing",
      cartesia: CARTESIA_API_KEY ? "set" : "missing",
      supabase: SUPABASE_URL && SUPABASE_SERVICE_KEY ? "set" : "missing",
      complete_url: agent.complete_url,
      complete_secret: resolveAgentSecret(agent) ? "set" : "missing",
      complete_secret_source: process.env[agent.complete_secret_env]
        ? agent.complete_secret_env
        : (process.env.COS_SHARED_SECRET ? "COS_SHARED_SECRET (fallback)" : "none"),
    });
  });

  // POST /agents/:agentId/context
  // Body: { call_id, context?, fetch_live? }
  // If agentId === 'cos-cars24' and fetch_live is truthy (default),
  // the bridge pulls a live Cars24 snapshot from Supabase.
  app.post("/agents/:agentId/context", async (req, res) => {
    const agent = AGENT_CONFIGS[req.params.agentId];
    if (!agent) return res.status(404).json({ error: "unknown agent" });

    const { call_id, context, twilio_call_sid, fetch_live = true } = req.body || {};
    if (!call_id) return res.status(400).json({ error: "call_id required" });

    const s = getOrCreateSession(agent.id, call_id);
    if (twilio_call_sid) s.twilioSid = twilio_call_sid;

    let preamble = "";
    if (agent.id === "cos-cars24") {
      if (fetch_live) {
        const snap = await fetchCars24Snapshot();
        s.context = { cars24: snap };
        preamble = cars24PreambleFromSnapshot(snap);
      } else if (context) {
        s.context = context;
      }
    } else if (agent.id === "sales-cars24") {
      if (fetch_live) {
        const ctx = await fetchSalesContext();
        s.context = { sales: ctx };
        preamble = salesPreamble(ctx, context?.buyer_intent);
      } else if (context) {
        s.context = context;
      }
    } else if (agent.id === "finance-cars24") {
      if (fetch_live) {
        const ctx = await fetchFinanceContext();
        s.context = { finance: ctx };
        preamble = financePreamble(ctx);
      } else if (context) {
        s.context = context;
      }
    } else if (context) {
      s.context = context;
    }

    // Allow additional context to be merged (e.g., caller name)
    if (context && context.caller_name) {
      preamble = "The caller is " + context.caller_name + ".\n\n" + preamble;
    }

    s.preamble = preamble;

    // ==== Strategist pre-brief (Sonnet 4.5) — Priya and Vikram only ====
    // We fire this AFTER responding to the caller app, so dial latency isn't affected.
    // The strategist output is stored in session.playbook and picked up by callClaude on the first turn.
    let strategistQueued = false;
    if (agent.id === "sales-cars24" || agent.id === "finance-cars24") {
      strategistQueued = true;
      // Fire-and-forget: run in background while Twilio dials the user.
      // The /voice handler waits for Cartesia greeting render (~700ms-1.5s) and Twilio ring latency (~3-6s),
      // so strategist (typical 4-7s on Sonnet) normally completes before the first user turn.
      (async () => {
        const t0 = Date.now();
        const playbook = await runStrategist(agent.id, preamble, context || {});
        s.playbook = playbook;
        tlog(agent.id, "[STRATEGIST] ready in " + (Date.now() - t0) + "ms, " + playbook.length + " chars");
      })();
    }

    tlog(
      agent.id,
      "[CTX] set. call=" +
        call_id +
        " preamble_len=" +
        preamble.length +
        " strategist=" +
        (strategistQueued ? "queued" : "n/a") +
        " sid=" +
        (twilio_call_sid || "-")
    );
    res.json({ ok: true, preamble_chars: preamble.length, strategist: strategistQueued });
  });

  // POST /agents/:agentId/voice?call_id=X
  app.post("/agents/:agentId/voice", async (req, res) => {
    const agent = AGENT_CONFIGS[req.params.agentId];
    if (!agent) {
      return res.status(404).type("text/xml").send(hangupTwiml("Unknown agent."));
    }
    const call_id = req.query.call_id;
    const host = req.headers.host;
    const twSid = req.body?.CallSid;
    if (!call_id) {
      return res.status(400).type("text/xml").send(hangupTwiml("Missing call id."));
    }

    const s = getOrCreateSession(agent.id, call_id);
    if (twSid) s.twilioSid = twSid;

    try {
      const audioId = await renderAndCache(agent.greeting, agent.voice_id);
      s.turns.push({ role: "assistant", text: agent.greeting, ts: new Date().toISOString() });
      tlog(agent.id, "[VOICE] greeting rendered audio=" + audioId + " sid=" + twSid);
      res
        .type("text/xml")
        .send(gatherTwiml({ host, agentId: agent.id, call_id, playAudioId: audioId }));
    } catch (e) {
      tlog(agent.id, "[VOICE ERR] " + e.message + " — fallback to <Say>");
      s.turns.push({ role: "assistant", text: agent.greeting, ts: new Date().toISOString() });
      res
        .type("text/xml")
        .send(
          gatherTwiml({ host, agentId: agent.id, call_id, fallbackSpeak: agent.greeting })
        );
    }
  });

  // POST /agents/:agentId/turn?call_id=X
  app.post("/agents/:agentId/turn", async (req, res) => {
    const agent = AGENT_CONFIGS[req.params.agentId];
    if (!agent) {
      return res.status(404).type("text/xml").send(hangupTwiml("Unknown agent."));
    }
    const call_id = req.query.call_id;
    const host = req.headers.host;
    const speech = (req.body?.SpeechResult || "").trim();
    const conf = parseFloat(req.body?.Confidence || "0");
    const twSid = req.body?.CallSid;
    if (!call_id) {
      return res.status(400).type("text/xml").send(hangupTwiml("Missing call id."));
    }
    const s = getOrCreateSession(agent.id, call_id);
    if (twSid) s.twilioSid = twSid;

    if (callAtCap(s)) {
      tlog(agent.id, "[CAP] max duration hit");
      await postCompleteIfNeeded(agent, s, "max_duration");
      return res
        .type("text/xml")
        .send(hangupTwiml("We've hit the call limit. I'll send a written recap. Goodbye."));
    }

    if (!speech) {
      s.emptyGathers += 1;
      tlog(agent.id, "[TURN] empty gather #" + s.emptyGathers);
      if (s.emptyGathers >= MAX_EMPTY_GATHERS) {
        const bye = "I didn't hear anything on that end. Goodbye for now.";
        await postCompleteIfNeeded(agent, s, "silence");
        try {
          const audioId = await renderAndCache(bye, agent.voice_id);
          return res.type("text/xml").send(playAndHangupTwiml(host, audioId));
        } catch {
          return res.type("text/xml").send(hangupTwiml(bye));
        }
      }
      const reprompt = s.emptyGathers === 1 ? "Sorry, I missed that. Could you say it again?" : "Still there?";
      try {
        const audioId = await renderAndCache(reprompt, agent.voice_id);
        return res
          .type("text/xml")
          .send(gatherTwiml({ host, agentId: agent.id, call_id, playAudioId: audioId }));
      } catch {
        return res
          .type("text/xml")
          .send(gatherTwiml({ host, agentId: agent.id, call_id, fallbackSpeak: reprompt }));
      }
    }

    s.emptyGathers = 0;
    s.turns.push({
      role: "user",
      text: speech,
      ts: new Date().toISOString(),
      confidence: conf,
    });
    tlog(agent.id, "[USER] " + speech + " (conf=" + conf + ")");

    const lower = speech.toLowerCase();
    // Tight goodbye detection — must be explicit intent, not just the word 'bye' embedded in a longer sentence.
    // STT frequently mis-transcribes Hindi 'kar' / 'ja' / 'karna' as 'bye'; a lone 'bye' inside a 5+ word sentence is almost never a real goodbye.
    const saidGoodbye = (() => {
      const words = lower.split(/\s+/).filter(Boolean);
      // Only end on clear multi-word phrases
      if (/\b(good ?bye|end (the |this )?call|hang up|thanks that'?s all|that'?s (it|all) for (now|today))\b/.test(lower)) return true;
      // Accept 'bye' only if sentence is ≤3 words (real farewell like 'ok bye' or 'alright bye thanks')
      if (/\bbye\b/.test(lower) && words.length <= 3) return true;
      return false;
    })();
    if (saidGoodbye) {
      const closing = agent.closing || "Thanks for calling. Goodbye.";
      s.turns.push({ role: "assistant", text: closing, ts: new Date().toISOString() });
      try {
        const audioId = await renderAndCache(closing, agent.voice_id);
        await postCompleteIfNeeded(agent, s, "user_goodbye");
        return res.type("text/xml").send(playAndHangupTwiml(host, audioId));
      } catch {
        await postCompleteIfNeeded(agent, s, "user_goodbye");
        return res.type("text/xml").send(hangupTwiml(closing));
      }
    }

    let reply = "";
    try {
      reply = await callClaude(s, agent, speech);
    } catch (e) {
      tlog(agent.id, "[CLAUDE ERR] " + e.message);
      reply = "I hit a snag pulling that up. Let me try another angle — could you rephrase?";
    }
    s.turns.push({ role: "assistant", text: reply, ts: new Date().toISOString() });
    tlog(agent.id, "[ASSIST] " + reply);

    try {
      const audioId = await renderAndCache(reply, agent.voice_id);
      return res
        .type("text/xml")
        .send(gatherTwiml({ host, agentId: agent.id, call_id, playAudioId: audioId }));
    } catch (e) {
      tlog(agent.id, "[TTS ERR] " + e.message);
      return res
        .type("text/xml")
        .send(gatherTwiml({ host, agentId: agent.id, call_id, fallbackSpeak: reply }));
    }
  });

  // Twilio StatusCallback for this agent's calls
  app.post("/agents/:agentId/status", async (req, res) => {
    const agent = AGENT_CONFIGS[req.params.agentId];
    if (!agent) return res.status(404).json({ error: "unknown agent" });
    const call_id = req.query.call_id;
    const status = req.body?.CallStatus;
    const duration = req.body?.CallDuration;
    tlog(agent.id, "[STATUS] " + status + " dur=" + duration);
    if (
      call_id &&
      ["completed", "failed", "busy", "no-answer", "canceled"].includes(status)
    ) {
      const s = getOrCreateSession(agent.id, call_id);
      s.twilioSid = req.body?.CallSid || s.twilioSid;
      await postCompleteIfNeeded(agent, s, "twilio:" + status);
      setTimeout(() => sessions.delete(sessionKey(agent.id, call_id)), 60_000);
    }
    res.json({ ok: true });
  });

  // Debug: session inspect
  app.get("/agents/:agentId/session/:id", (req, res) => {
    const s = sessions.get(sessionKey(req.params.agentId, req.params.id));
    if (!s) return res.status(404).json({ error: "not found" });
    res.json({
      agent_id: req.params.agentId,
      call_id: req.params.id,
      twilioSid: s.twilioSid,
      startedAt: s.startedAt,
      turns: s.turns,
      preamble_chars: (s.preamble || "").length,
    });
  });
}

module.exports = { mount, AGENT_CONFIGS };
