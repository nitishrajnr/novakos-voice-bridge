/**
 * Twilio ↔ Cartesia Line Voice Agent Bridge
 * 
 * This bridges Twilio phone calls to the Cartesia Line voice agent.
 * - Twilio handles telephony (dialing Indian +91 numbers)
 * - Cartesia Line handles AI (STT → LLM → TTS)
 * 
 * Flow: 
 *   Twilio dials number → caller picks up → audio streams to this server
 *   → this server connects to Cartesia agent WebSocket
 *   → bidirectional audio: caller voice → Cartesia STT → LLM → TTS → caller hears AI
 */

const twilio = require('twilio');
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────
const config = {
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    CARTESIA_API_KEY: process.env.CARTESIA_API_KEY,
    CARTESIA_AGENT_ID: process.env.CARTESIA_AGENT_ID || 'agent_tFwSH8DAwUMebv7LT6EGKz',
    TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER, // Your Twilio number
    PORT: process.env.PORT || 3000,
};

// Validate config
const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'CARTESIA_API_KEY'];
for (const key of required) {
    if (!config[key]) {
        console.error(`❌ Missing required config: ${key}`);
        process.exit(1);
    }
}

const twilioClient = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

// ─── Express Server for Twilio Webhooks ──────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', agent: config.CARTESIA_AGENT_ID });
});

// Dispatch outbound call
app.post('/dispatch', async (req, res) => {
    try {
        const { to_number, agent_id, script, rfq_id, callback_url } = req.body;

        // Validate to_number format
        if (!to_number || !/^\+\d+$/.test(to_number)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid to_number format. Must start with + followed by digits.'
            });
        }

        if (!agent_id) {
            return res.status(400).json({
                success: false,
                error: 'agent_id is required'
            });
        }

        // Force test number override if env var is set
        let finalToNumber = to_number;
        if (process.env.FP_FORCE_TEST_NUMBER === 'true') {
            finalToNumber = '+918826688102';
            console.log(`🧪 Test mode: forcing to_number to ${finalToNumber}`);
        }

        // Build voice webhook URL
        const renderUrl = process.env.RENDER_URL || `https://${req.headers.host}`;
        const voiceUrl = `${renderUrl}/voice?agent_id=${encodeURIComponent(agent_id)}`;

        // TODO: Add Authorization header support for callback_url when needed

        // Create Twilio call
        const callOptions = {
            to: finalToNumber,
            from: process.env.TWILIO_FROM_NUMBER || config.TWILIO_PHONE_NUMBER,
            url: voiceUrl,
        };

        if (callback_url) {
            callOptions.statusCallback = callback_url;
            callOptions.statusCallbackEvent = ['completed'];
        }

        console.log(`📞 Dispatching call to ${finalToNumber} with agent ${agent_id}`);
        const call = await twilioClient.calls.create(callOptions);

        console.log(`✅ Call dispatched! SID: ${call.sid}`);
        res.json({
            success: true,
            call_sid: call.sid,
            to_number: finalToNumber
        });
    } catch (error) {
        console.error(`❌ Dispatch failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test dispatch endpoint - simple one-parameter version
app.post('/test-dispatch', async (req, res) => {
    try {
        const { agent_id } = req.body;

        if (!agent_id) {
            return res.status(400).json({
                success: false,
                error: 'agent_id is required'
            });
        }

        // Build voice webhook URL
        const renderUrl = process.env.RENDER_URL || `https://${req.headers.host}`;
        const voiceUrl = `${renderUrl}/voice?agent_id=${encodeURIComponent(agent_id)}`;

        // Create Twilio call to test number
        const callOptions = {
            to: '+918826688102',
            from: process.env.TWILIO_FROM_NUMBER || config.TWILIO_PHONE_NUMBER,
            url: voiceUrl,
        };

        console.log(`🧪 Test call to +918826688102 with agent ${agent_id}`);
        const call = await twilioClient.calls.create(callOptions);

        console.log(`✅ Test call dispatched! SID: ${call.sid}`);
        res.json({
            success: true,
            call_sid: call.sid,
            to_number: '+918826688102'
        });
    } catch (error) {
        console.error(`❌ Test dispatch failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Twilio calls this webhook when the call connects
// It tells Twilio to stream audio via WebSocket to our server
app.post('/voice', (req, res) => {
    console.log(`📞 Incoming call webhook from Twilio`);
    const host = req.headers.host;
    const agentId = req.query.agent_id || config.CARTESIA_AGENT_ID;
    const wsUrl = `wss://${host}/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${wsUrl}">
            <Parameter name="agent_id" value="${agentId}" />
        </Stream>
    </Connect>
</Response>`;

    res.type('text/xml');
    res.send(twiml);
});

// ─── HTTP + WebSocket Server ─────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs, request) => {
    console.log('🔗 Twilio media stream connected');
    
    let streamSid = null;
    let cartesiaWs = null;
    
    // Connect to Cartesia Line agent WebSocket
    const cartesiaUrl = `wss://api.cartesia.ai/agents/${config.CARTESIA_AGENT_ID}/ws`;
    
    cartesiaWs = new WebSocket(cartesiaUrl, {
        headers: {
            'Authorization': `Bearer ${config.CARTESIA_API_KEY}`,
            'Cartesia-Version': '2026-03-01',
        }
    });
    
    cartesiaWs.on('open', () => {
        console.log('🤖 Connected to Cartesia agent');
        
        // Start the agent session
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
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'audio' && streamSid) {
                // Forward Cartesia's TTS audio back to Twilio caller
                twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                        payload: msg.data // base64 encoded audio
                    }
                }));
            } else if (msg.type === 'transcript') {
                console.log(`🗣️ Agent said: ${msg.text}`);
            } else if (msg.type === 'user_transcript') {
                console.log(`👤 User said: ${msg.text}`);
            } else if (msg.type === 'call.ended') {
                console.log('📴 Cartesia ended the call');
                twilioWs.close();
            }
        } catch (e) {
            // Binary audio data - forward to Twilio
            if (streamSid) {
                twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: {
                        payload: data.toString('base64')
                    }
                }));
            }
        }
    });
    
    cartesiaWs.on('error', (err) => {
        console.error('❌ Cartesia WebSocket error:', err.message);
    });
    
    cartesiaWs.on('close', () => {
        console.log('📴 Cartesia WebSocket closed');
    });
    
    // Handle Twilio media stream messages
    twilioWs.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`🎙️ Media stream started. SID: ${streamSid}`);
            } else if (msg.event === 'media') {
                // Forward caller's audio to Cartesia for STT
                if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
                    cartesiaWs.send(JSON.stringify({
                        type: 'audio',
                        data: msg.media.payload, // base64 mulaw audio from caller
                    }));
                }
            } else if (msg.event === 'stop') {
                console.log('🛑 Media stream stopped');
                if (cartesiaWs) cartesiaWs.close();
            }
        } catch (error) {
            console.error('Error processing Twilio message:', error.message);
        }
    });
    
    twilioWs.on('close', () => {
        console.log('📴 Twilio WebSocket closed');
        if (cartesiaWs) cartesiaWs.close();
    });
    
    twilioWs.on('error', (err) => {
        console.error('❌ Twilio WebSocket error:', err.message);
    });
});

// ─── Make Outbound Call ──────────────────────────────────────────
async function makeCall(toNumber) {
    console.log(`📞 Initiating call to ${toNumber}...`);
    
    // We need the public URL for the webhook
    const publicUrl = process.env.PUBLIC_URL;
    if (!publicUrl) {
        console.error('❌ PUBLIC_URL not set. Run with ngrok first.');
        return;
    }
    
    try {
        const call = await twilioClient.calls.create({
            url: `${publicUrl}/voice`,
            to: toNumber,
            from: config.TWILIO_PHONE_NUMBER,
        });
        console.log(`✅ Call initiated! SID: ${call.sid}`);
        return call.sid;
    } catch (error) {
        console.error(`❌ Call failed: ${error.message}`);
        throw error;
    }
}

// ─── Start Server ────────────────────────────────────────────────
async function start() {
    server.listen(config.PORT, () => {
        console.log(`\n🚀 Bridge server running on port ${config.PORT}`);
        console.log(`   Agent: ${config.CARTESIA_AGENT_ID}`);
        console.log(`\n📋 Next steps:`);
        console.log(`   1. Start ngrok: ngrok http ${config.PORT}`);
        console.log(`   2. Set PUBLIC_URL=<ngrok-url>`);
        console.log(`   3. Call: node call.js +918826688102\n`);
    });
}

// ─── CLI: Make a call if number provided as argument ─────────────
if (process.argv[2] === 'call' && process.argv[3]) {
    // Direct call mode
    start().then(() => {
        setTimeout(() => makeCall(process.argv[3]), 2000);
    });
} else {
    start();
}

module.exports = { makeCall };
