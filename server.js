/**
 * Twilio ↔ Cartesia Line Voice Agent Bridge
 * Deployed on Render.com (free tier, supports WebSockets)
 * 
 * Flow:
 * 1. Twilio calls Indian number
 * 2. When connected, Twilio streams audio here via WebSocket
 * 3. This server connects to Cartesia Line agent
 * 4. Bidirectional audio: caller ↔ AI agent (with Nitish's cloned voice)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Health Check ────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'NovakOS Voice Bridge',
        agent: process.env.CARTESIA_AGENT_ID 
    });
});

// ─── Twilio Voice Webhook ────────────────────────────────────────
// When Twilio connects a call, it hits this endpoint
// We respond with TwiML that opens a bidirectional media stream
app.post('/voice', (req, res) => {
    const host = req.headers.host;
    console.log(`📞 Call webhook hit. Host: ${host}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Aditi" language="hi-IN">Ek second, connect kar rahe hain.</Say>
    <Connect>
        <Stream url="wss://${host}/media-stream" />
    </Connect>
</Response>`;
    
    res.type('text/xml').send(twiml);
});

// ─── HTTP Server + WebSocket ─────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
    console.log('🔗 Twilio media stream connected');
    
    let streamSid = null;
    let cartesiaWs = null;
    let callActive = true;
    
    // Connect to Cartesia Line agent
    const agentId = process.env.CARTESIA_AGENT_ID;
    const cartesiaUrl = `wss://api.cartesia.ai/agents/${agentId}/ws`;
    
    console.log(`🤖 Connecting to Cartesia agent: ${agentId}`);
    
    cartesiaWs = new WebSocket(cartesiaUrl, {
        headers: {
            'Authorization': `Bearer ${process.env.CARTESIA_API_KEY}`,
            'Cartesia-Version': '2026-03-01',
        }
    });
    
    cartesiaWs.on('open', () => {
        console.log('✅ Connected to Cartesia agent');
        // Initialize the session with Twilio's audio format
        cartesiaWs.send(JSON.stringify({
            type: 'session.start',
            input_format: {
                encoding: 'pcm_mulaw',
                sample_rate: 8000,
                channels: 1,
            },
            output_format: {
                encoding: 'pcm_mulaw', 
                sample_rate: 8000,
                channels: 1,
            },
        }));
    });
    
    cartesiaWs.on('message', (data) => {
        if (!callActive || !streamSid) return;
        
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'audio' && msg.data) {
                // Send AI audio back to caller via Twilio
                twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.data }
                }));
            } else if (msg.type === 'transcript') {
                console.log(`🤖 Agent: ${msg.text}`);
            } else if (msg.type === 'user_transcript') {
                console.log(`👤 Caller: ${msg.text}`);
            } else if (msg.type === 'call.ended') {
                console.log('📴 Agent ended call');
                callActive = false;
            } else if (msg.type === 'error') {
                console.error('❌ Cartesia error:', msg);
            }
        } catch (e) {
            // Could be binary audio
            if (streamSid && data instanceof Buffer) {
                twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: data.toString('base64') }
                }));
            }
        }
    });
    
    cartesiaWs.on('error', (err) => {
        console.error('❌ Cartesia error:', err.message);
    });
    
    cartesiaWs.on('close', (code, reason) => {
        console.log(`📴 Cartesia closed (${code}): ${reason}`);
    });
    
    // Handle Twilio media stream
    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            
            switch (msg.event) {
                case 'connected':
                    console.log('🎙️ Twilio stream connected');
                    break;
                    
                case 'start':
                    streamSid = msg.start.streamSid;
                    console.log(`🎙️ Stream started: ${streamSid}`);
                    break;
                    
                case 'media':
                    // Forward caller audio to Cartesia for STT
                    if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
                        cartesiaWs.send(JSON.stringify({
                            type: 'audio',
                            data: msg.media.payload,
                        }));
                    }
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    callActive = false;
                    if (cartesiaWs) cartesiaWs.close();
                    break;
            }
        } catch (error) {
            console.error('Error:', error.message);
        }
    });
    
    twilioWs.on('close', () => {
        console.log('📴 Twilio disconnected');
        callActive = false;
        if (cartesiaWs) cartesiaWs.close();
    });
});

// ─── Start ───────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n🚀 NovakOS Voice Bridge running on port ${PORT}`);
    console.log(`   Agent: ${process.env.CARTESIA_AGENT_ID}`);
    console.log(`   Ready for Twilio webhook calls\n`);
});
