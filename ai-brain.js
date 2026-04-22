// ai-brain.js — Claude-as-brain voice loop for GarmentBridge
// Added in v7.0 (2026-04-21). Does NOT touch the existing Cartesia-agent routing.
//
// Flow (per call):
//   1. GarmentBridge /api/voice/initiate inserts a row in user_ai_calls,
//      POSTs to /ai/context with { call_id, context }, then dials Twilio
//      with URL = BRIDGE/ai/voice?call_id=X.
//   2. /ai/voice returns TwiML: <Play> greeting mp3 + <Gather speech> posting
//      to /ai/turn?call_id=X.
//   3. /ai/turn: receives SpeechResult from Twilio, appends user turn,
//      calls Claude, stores assistant turn, generates Cartesia TTS audio,
//      caches it under /ai/audio/<uuid>.mp3, returns TwiML to play + re-Gather.
//   4. On hard stop / 5-min cap / empty-gathers-max, /ai/turn returns
//      <Hangup/> and posts transcript to GB /api/voice/complete.
//   5. /ai/status (Twilio StatusCallback) closes the session on call end.

// Node 18+ has native fetch (server.js already uses it).
const crypto = require('crypto');

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || '3b59a3aa-f616-4501-a365-c1ba7ac37874';
const CARTESIA_MODEL = process.env.CARTESIA_MODEL || 'sonic-2';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Voice calls need low latency — Haiku 4.5 is ~40% faster than Sonnet for same quality on short-turn QA.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const GB_COMPLETE_URL = process.env.GB_COMPLETE_URL || 'https://garmentbridge.vercel.app/api/voice/complete';
const GB_SHARED_SECRET = process.env.GB_SHARED_SECRET || '';
const MAX_CALL_SECONDS = parseInt(process.env.MAX_CALL_SECONDS || '300', 10);
const MAX_EMPTY_GATHERS = 2;

// In-memory session store (call_id → { context, turns, startedAt, emptyGathers, completedPosted })
// OK for single-instance Render free tier. For scale, move to Redis.
const sessions = new Map();

// In-memory audio cache (audio_id → { buf, mime, createdAt }). TTL ~10 min.
const audioCache = new Map();

function mkAudioId() { return crypto.randomBytes(8).toString('hex'); }

function tlog(call_id, msg) {
  console.log('[AI ' + new Date().toISOString().slice(11, 23) + '][' + (call_id || '-') + '] ' + msg);
}

// Strip XML-unsafe chars for TwiML text
function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// System prompt per product brief
const SYSTEM_PROMPT = [
  'You are the GarmentBridge AI Assistant. GarmentBridge is a B2B apparel sourcing',
  'platform that connects global buyers with Indian manufacturing vendors.',
  'You help authenticated users with: (a) checking order status and production timelines,',
  '(b) answering questions about their vendors/factories, (c) quality inspection queries,',
  '(d) sourcing advice (fabric types, MOQ, lead times).',
  'IMPORTANT: You DO have real-time access to the caller\'s order data — it is provided in the',
  'USER CONTEXT block below. When asked about orders, ALWAYS check that context first and answer',
  'with the specific order numbers, styles, stages, factories, and delivery dates shown there.',
  'Never say "I don\'t have access to your database" — the data is right there in your context.',
  'If a caller mentions an order number that does NOT appear in the context, THEN politely say',
  'you can\'t locate that specific order and suggest they check the dashboard.',
  'Be professional, concise, warm. Speak naturally like a phone assistant — not like a chatbot.',
  'Responses MUST be SHORT (1-3 sentences) because this is a voice call over a phone line.',
  'Use Hindi loan-words if the user uses them (haan, theek hai, bilkul), but default to English.',
  'NEVER quote prices, confirm order changes, or make commercial commitments — if asked, say',
  '"that needs human confirmation, let me flag it for your account manager."',
  'If wrapping up, end with "anything else?"',
  'Do NOT use emojis, markdown, lists, or stage directions — plain speakable sentences only.',
].join(' ');

const GREETING = 'Hi, this is the GarmentBridge assistant. How can I help you with your orders today?';

function getSession(call_id) {
  let s = sessions.get(call_id);
  if (!s) {
    s = {
      context: null,
      turns: [],           // {role:'user'|'assistant', text, ts}
      startedAt: Date.now(),
      emptyGathers: 0,
      completedPosted: false,
      twilioSid: null,
    };
    sessions.set(call_id, s);
  }
  return s;
}

function buildContextPreamble(context) {
  if (!context) return '';
  const parts = [];
  if (context.user_name) parts.push('The caller is ' + context.user_name + '.');
  if (context.org_name) parts.push('Organisation: ' + context.org_name + '.');
  if (context.account_manager) parts.push('Account manager: ' + context.account_manager + '.');
  if (Array.isArray(context.orders) && context.orders.length) {
    parts.push('Recent orders (' + context.orders.length + '):');
    context.orders.slice(0, 5).forEach((o, i) => {
      parts.push('  ' + (i + 1) + '. ' + [
        o.po_number || o.order_number || o.id,
        o.style_name,
        o.category ? '(' + o.category + ')' : null,
        o.quantity ? 'qty: ' + o.quantity : null,
        'status: ' + (o.status || 'unknown'),
        o.current_stage ? 'stage: ' + o.current_stage : null,
        o.factory_name ? 'factory: ' + o.factory_name : null,
        o.expected_date ? 'delivery: ' + o.expected_date : null,
        o.quality_score !== null && o.quality_score !== undefined ? 'quality: ' + o.quality_score : null,
      ].filter(Boolean).join(' | '));
    });
  }
  if (Array.isArray(context.inspections) && context.inspections.length) {
    parts.push('Recent quality inspections:');
    context.inspections.slice(0, 3).forEach((q, i) => {
      parts.push('  ' + (i + 1) + '. ' + [q.order_number, q.result, q.note].filter(Boolean).join(' | '));
    });
  }
  if (!parts.length) return '';
  return 'USER CONTEXT (use this to answer accurately; do not read it aloud):\n' + parts.join('\n');
}

async function callClaude(session, userText) {
  const messages = session.turns
    .filter(t => t.role === 'user' || t.role === 'assistant')
    .map(t => ({ role: t.role, content: t.text }));
  messages.push({ role: 'user', content: userText });

  const system = SYSTEM_PROMPT + (session.context ? '\n\n' + buildContextPreamble(session.context) : '');

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 180,
    system,
    messages,
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Claude ' + resp.status + ': ' + t.slice(0, 300));
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join(' ')
    .trim();
  return text || 'Sorry, I did not catch that. Could you repeat?';
}

// Cartesia TTS → mp3 buffer. Using /tts/bytes, mp3_44100 output.
async function cartesiaTTS(text) {
  const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cartesia-Version': '2025-04-16',
      'X-API-Key': CARTESIA_API_KEY,
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: CARTESIA_VOICE_ID },
      language: 'en',
      output_format: {
        container: 'mp3',
        bit_rate: 128000,
        sample_rate: 44100,
      },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Cartesia TTS ' + resp.status + ': ' + t.slice(0, 300));
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf;
}

function cacheAudio(buf, mime) {
  const id = mkAudioId();
  audioCache.set(id, { buf, mime: mime || 'audio/mpeg', createdAt: Date.now() });
  // lazy eviction
  if (audioCache.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of audioCache) if (v.createdAt < cutoff) audioCache.delete(k);
  }
  return id;
}

// Shortcut: pre-rendered greeting cached per-session
async function renderAndCache(text) {
  const buf = await cartesiaTTS(text);
  return cacheAudio(buf, 'audio/mpeg');
}

async function postCompleteIfNeeded(call_id, reason) {
  const s = sessions.get(call_id);
  if (!s || s.completedPosted) return;
  s.completedPosted = true;
  const duration = Math.round((Date.now() - s.startedAt) / 1000);
  const payload = {
    call_id,
    twilio_call_sid: s.twilioSid,
    duration_seconds: duration,
    transcript: s.turns,
    ended_reason: reason,
  };
  try {
    const r = await fetch(GB_COMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': GB_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });
    tlog(call_id, '[COMPLETE] POST ' + GB_COMPLETE_URL + ' → ' + r.status);
  } catch (e) {
    tlog(call_id, '[COMPLETE ERR] ' + e.message);
  }
}

function callAtCap(session) {
  return (Date.now() - session.startedAt) / 1000 >= MAX_CALL_SECONDS;
}

function hangupTwiml(reason) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">' +
    xmlEscape(reason || 'Thanks for calling. Goodbye.') + '</Say><Hangup/></Response>';
}

function gatherTwiml({ host, call_id, playAudioId, fallbackSpeak }) {
  // Gather with speech input, POST back to /ai/turn.
  const actionUrl = '/ai/turn?call_id=' + encodeURIComponent(call_id);
  const gatherOpen =
    '<Gather input="speech" action="' + actionUrl + '" method="POST" ' +
    'language="en-IN" speechTimeout="auto" speechModel="experimental_conversations" ' +
    'actionOnEmptyResult="true" timeout="6">';
  let inner = '';
  if (playAudioId) {
    inner = '<Play>https://' + host + '/ai/audio/' + playAudioId + '.mp3</Play>';
  } else if (fallbackSpeak) {
    inner = '<Say voice="alice">' + xmlEscape(fallbackSpeak) + '</Say>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' + gatherOpen + inner + '</Gather></Response>';
}

// Wire into express app
function mount(app) {
  // JSON body for context POST
  // (express.json already mounted in server.js)

  // POST /ai/context — called by GB server before Twilio dials.
  app.post('/ai/context', (req, res) => {
    const { call_id, context, twilio_call_sid } = req.body || {};
    if (!call_id) return res.status(400).json({ error: 'call_id required' });
    const s = getSession(call_id);
    s.context = context || null;
    if (twilio_call_sid) s.twilioSid = twilio_call_sid;
    tlog(call_id, '[CTX] set. orders=' + (context?.orders?.length || 0) + ' user=' + (context?.user_name || '-'));
    res.json({ ok: true });
  });

  // POST /ai/voice?call_id=X — TwiML for answer. Pre-render greeting.
  app.post('/ai/voice', async (req, res) => {
    const call_id = req.query.call_id;
    const host = req.headers.host;
    const twSid = req.body?.CallSid;
    if (!call_id) return res.status(400).type('text/xml').send(hangupTwiml('Missing call id.'));
    const s = getSession(call_id);
    if (twSid) s.twilioSid = twSid;
    try {
      const audioId = await renderAndCache(GREETING);
      s.turns.push({ role: 'assistant', text: GREETING, ts: new Date().toISOString() });
      tlog(call_id, '[VOICE] greeting rendered. audio=' + audioId + ' sid=' + twSid);
      res.type('text/xml').send(gatherTwiml({ host, call_id, playAudioId: audioId }));
    } catch (e) {
      tlog(call_id, '[VOICE ERR] ' + e.message + ' — falling back to <Say>');
      // Fallback: use Twilio's TTS so the call still connects even if Cartesia is flaky.
      s.turns.push({ role: 'assistant', text: GREETING, ts: new Date().toISOString() });
      res.type('text/xml').send(gatherTwiml({ host, call_id, fallbackSpeak: GREETING }));
    }
  });

  // POST /ai/turn?call_id=X — each conversation turn.
  app.post('/ai/turn', async (req, res) => {
    const call_id = req.query.call_id;
    const host = req.headers.host;
    const speech = (req.body?.SpeechResult || '').trim();
    const conf = parseFloat(req.body?.Confidence || '0');
    const twSid = req.body?.CallSid;
    if (!call_id) return res.status(400).type('text/xml').send(hangupTwiml('Missing call id.'));
    const s = getSession(call_id);
    if (twSid) s.twilioSid = twSid;

    // Hard cap
    if (callAtCap(s)) {
      tlog(call_id, '[CAP] max duration hit');
      await postCompleteIfNeeded(call_id, 'max_duration');
      return res.type('text/xml').send(hangupTwiml('We have hit the five minute limit on this call. Goodbye.'));
    }

    if (!speech) {
      s.emptyGathers += 1;
      tlog(call_id, '[TURN] empty gather #' + s.emptyGathers);
      if (s.emptyGathers >= MAX_EMPTY_GATHERS) {
        const bye = 'I did not hear anything. Goodbye for now.';
        await postCompleteIfNeeded(call_id, 'silence');
        try {
          const audioId = await renderAndCache(bye);
          return res.type('text/xml').send(
            '<?xml version="1.0" encoding="UTF-8"?><Response>' +
            '<Play>https://' + host + '/ai/audio/' + audioId + '.mp3</Play><Hangup/></Response>'
          );
        } catch {
          return res.type('text/xml').send(hangupTwiml(bye));
        }
      }
      // Re-prompt with Cartesia voice (consistent voice throughout the call)
      const reprompt = s.emptyGathers === 1 ? 'Sorry, I did not catch that. Could you try again?' : 'Still there?';
      try {
        const audioId = await renderAndCache(reprompt);
        return res.type('text/xml').send(gatherTwiml({ host, call_id, playAudioId: audioId }));
      } catch {
        return res.type('text/xml').send(gatherTwiml({ host, call_id, fallbackSpeak: reprompt }));
      }
    }

    s.emptyGathers = 0;
    s.turns.push({ role: 'user', text: speech, ts: new Date().toISOString(), confidence: conf });
    tlog(call_id, '[USER] ' + speech + ' (conf=' + conf + ')');

    // Special: user says "goodbye" / "bye" / "end call" / "thank you that's all"
    const lower = speech.toLowerCase();
    if (/\b(good ?bye|bye|that'?s all|end (the )?call|hang up)\b/.test(lower)) {
      const closing = 'Thanks for calling GarmentBridge. Goodbye.';
      s.turns.push({ role: 'assistant', text: closing, ts: new Date().toISOString() });
      try {
        const audioId = await renderAndCache(closing);
        await postCompleteIfNeeded(call_id, 'user_goodbye');
        return res.type('text/xml').send(
          '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          '<Play>https://' + host + '/ai/audio/' + audioId + '.mp3</Play><Hangup/></Response>'
        );
      } catch (e) {
        await postCompleteIfNeeded(call_id, 'user_goodbye');
        return res.type('text/xml').send(hangupTwiml(closing));
      }
    }

    // Call Claude + Cartesia in parallel-ish (serial is fine, budget < 2s)
    let reply = '';
    try {
      reply = await callClaude(s, speech);
    } catch (e) {
      tlog(call_id, '[CLAUDE ERR] ' + e.message);
      reply = 'Sorry, I hit a snag processing that. Could you say it a different way?';
    }
    s.turns.push({ role: 'assistant', text: reply, ts: new Date().toISOString() });
    tlog(call_id, '[ASSIST] ' + reply);

    try {
      const audioId = await renderAndCache(reply);
      return res.type('text/xml').send(gatherTwiml({ host, call_id, playAudioId: audioId }));
    } catch (e) {
      tlog(call_id, '[TTS ERR] ' + e.message + ' — fallback to <Say>');
      return res.type('text/xml').send(gatherTwiml({ host, call_id, fallbackSpeak: reply }));
    }
  });

  // Serve cached mp3 audio for Twilio <Play>
  app.get('/ai/audio/:id.mp3', (req, res) => {
    const it = audioCache.get(req.params.id);
    if (!it) return res.status(404).send('not found');
    res.set('Content-Type', it.mime);
    res.set('Cache-Control', 'no-store');
    res.send(it.buf);
  });

  // Twilio StatusCallback to know when call really ends.
  app.post('/ai/status', async (req, res) => {
    const call_id = req.query.call_id;
    const status = req.body?.CallStatus;
    const duration = req.body?.CallDuration;
    tlog(call_id, '[STATUS] ' + status + ' dur=' + duration);
    if (call_id && ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
      const s = getSession(call_id);
      s.twilioSid = req.body?.CallSid || s.twilioSid;
      await postCompleteIfNeeded(call_id, 'twilio:' + status);
      // Cleanup after a grace period
      setTimeout(() => sessions.delete(call_id), 60_000);
    }
    res.json({ ok: true });
  });

  // Debug / health
  app.get('/ai/health', (req, res) => {
    res.json({
      status: 'ok',
      sessions: sessions.size,
      audio_cached: audioCache.size,
      model: CLAUDE_MODEL,
      voice: CARTESIA_VOICE_ID,
      anthropic: ANTHROPIC_API_KEY ? 'set' : 'missing',
      cartesia: CARTESIA_API_KEY ? 'set' : 'missing',
    });
  });

  app.get('/ai/session/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({
      call_id: req.params.id,
      twilioSid: s.twilioSid,
      startedAt: s.startedAt,
      turns: s.turns,
      contextHasOrders: !!(s.context?.orders?.length),
    });
  });
}

module.exports = { mount, cacheAudio };
