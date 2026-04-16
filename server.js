/**
 * NovakOS Voice Bridge — Twilio ↔ Cartesia Line Agent
 * 
 * Bridges Twilio phone calls to Cartesia Line voice agent.
 * Uses Cartesia Calls API (wss://api.cartesia.ai/agents/stream/{agent_id})
 * 
 * Flow: Twilio dials Indian number → audio streams here → Cartesia agent → AI responds
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.CARTESIA_AGENT_ID;
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;

// ─── Get Cartesia Access Token ───────────────────────────────────
async function getAccessToken() {
    const resp = await fetch('https://api.cartesia.ai/access-token', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + CARTESIA_API_KEY,
            'Cartesia-Version': '2025-04-16',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grants: { agent: true },
            expires_in: 3600,
        }),
    });
    const data = await resp.json();
    return data.token;
}

// ─── Health Check ────────────────────────────────────────────────
app.get('/', function(req, res) {
    res.json({ status: 'ok', service: 'NovakOS Voice Bridge', agent: AGENT_ID });
});

// ─── Twilio Voice Webhook ────────────────────────────────────────
app.post('/voice', function(req, res) {
    var host = req.headers.host;
    console.log('[VOICE] Call webhook hit. Host: ' + host);
    
    var twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Connect>' +
        '<Stream url="wss://' + host + '/media-stream" />' +
        '</Connect>' +
        '</Response>';
    
    res.type('text/xml').send(twiml);
});

// ─── HTTP Server + WebSocket ─────────────────────────────────────
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server, path: '/media-stream' });

wss.on('connection', async function(twilioWs) {
    console.log('[TWILIO] Media stream connected');
    
    var streamSid = null;
    var cartesiaWs = null;
    var cartesiaStreamId = null;
    
    try {
        // Get fresh access token
        var accessToken = await getAccessToken();
        console.log('[AUTH] Got Cartesia access token');
        
        // Connect to Cartesia agent via Calls API
        var cartesiaUrl = 'wss://api.cartesia.ai/agents/stream/' + AGENT_ID;
        
        cartesiaWs = new WebSocket(cartesiaUrl, {
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Cartesia-Version': '2025-04-16',
            }
        });
        
        cartesiaWs.on('open', function() {
            console.log('[CARTESIA] Connected to agent stream');
            // Send start event with mulaw 8000 format (Twilio's format)
            cartesiaWs.send(JSON.stringify({
                event: 'start',
                config: {
                    input_format: 'mulaw_8000',
                },
                metadata: {
                    from: 'twilio-bridge',
                    to: AGENT_ID,
                }
            }));
        });
        
        cartesiaWs.on('message', function(data) {
            try {
                var msg = JSON.parse(data.toString());
                
                if (msg.event === 'ack') {
                    cartesiaStreamId = msg.stream_id;
                    console.log('[CARTESIA] Stream acknowledged: ' + cartesiaStreamId);
                    
                } else if (msg.event === 'media_output' && streamSid) {
                    // Forward agent audio back to Twilio caller
                    twilioWs.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: {
                            payload: msg.media.payload
                        }
                    }));
                    
                } else if (msg.event === 'clear' && streamSid) {
                    // Agent wants to interrupt - clear Twilio's audio buffer
                    twilioWs.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid,
                    }));
                    
                } else if (msg.event === 'transcript') {
                    console.log('[AGENT] ' + (msg.text || ''));
                    
                } else if (msg.event === 'user_transcript') {
                    console.log('[USER] ' + (msg.text || ''));
                    
                } else if (msg.event === 'transfer_call') {
                    console.log('[TRANSFER] Agent wants to transfer to: ' + 
                        (msg.transfer ? msg.transfer.target_phone_number : 'unknown'));
                    
                } else if (msg.event === 'error') {
                    console.error('[CARTESIA ERROR]', JSON.stringify(msg));
                }
            } catch (e) {
                console.error('[CARTESIA] Parse error:', e.message);
            }
        });
        
        cartesiaWs.on('error', function(err) {
            console.error('[CARTESIA] WebSocket error:', err.message);
        });
        
        cartesiaWs.on('close', function(code, reason) {
            console.log('[CARTESIA] Closed (' + code + '): ' + reason);
        });
        
    } catch (err) {
        console.error('[ERROR] Failed to connect to Cartesia:', err.message);
    }
    
    // Handle Twilio media stream
    twilioWs.on('message', function(message) {
        try {
            var msg = JSON.parse(message);
            
            if (msg.event === 'connected') {
                console.log('[TWILIO] Stream connected');
                
            } else if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('[TWILIO] Stream started: ' + streamSid);
                
            } else if (msg.event === 'media') {
                // Forward caller audio to Cartesia
                if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN && cartesiaStreamId) {
                    cartesiaWs.send(JSON.stringify({
                        event: 'media_input',
                        stream_id: cartesiaStreamId,
                        media: {
                            payload: msg.media.payload,
                        }
                    }));
                }
                
            } else if (msg.event === 'stop') {
                console.log('[TWILIO] Stream stopped');
                if (cartesiaWs) cartesiaWs.close();
            }
        } catch (error) {
            console.error('[TWILIO] Error:', error.message);
        }
    });
    
    twilioWs.on('close', function() {
        console.log('[TWILIO] Disconnected');
        if (cartesiaWs) cartesiaWs.close();
    });
    
    // Keepalive ping every 30 seconds
    var pingInterval = setInterval(function() {
        if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

// ─── Start ───────────────────────────────────────────────────────
server.listen(PORT, function() {
    console.log('');
    console.log('NovakOS Voice Bridge running on port ' + PORT);
    console.log('Agent: ' + AGENT_ID);
    console.log('Ready for calls');
    console.log('');
});

// ─── Debug Endpoints ─────────────────────────────────────────────
app.get('/version', function(req, res) {
    res.json({ version: '2.0', endpoint: 'agents/stream', auth: 'access_token' });
});

app.get('/test-cartesia', async function(req, res) {
    try {
        var token = await getAccessToken();
        var url = 'wss://api.cartesia.ai/agents/stream/' + AGENT_ID;
        
        var result = await new Promise(function(resolve) {
            var ws = new WebSocket(url, {
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Cartesia-Version': '2025-04-16',
                }
            });
            
            var timeout = setTimeout(function() {
                ws.close();
                resolve({ status: 'timeout', msg: 'No response in 5s' });
            }, 5000);
            
            ws.on('open', function() {
                ws.send(JSON.stringify({
                    event: 'start',
                    config: { input_format: 'mulaw_8000' },
                }));
            });
            
            ws.on('message', function(data) {
                try {
                    var msg = JSON.parse(data.toString());
                    if (msg.event === 'ack') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve({ status: 'ok', stream_id: msg.stream_id, event: 'ack' });
                    }
                } catch(e) {}
            });
            
            ws.on('error', function(err) {
                clearTimeout(timeout);
                resolve({ status: 'error', msg: err.message });
            });
            
            ws.on('close', function(code, reason) {
                clearTimeout(timeout);
                resolve({ status: 'closed', code: code, reason: reason.toString() });
            });
        });
        
        res.json(result);
    } catch(err) {
        res.json({ status: 'error', msg: err.message });
    }
});
