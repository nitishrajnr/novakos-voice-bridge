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

// Call log for debugging
var lastCallLog = [];
function log(msg) {
    var ts = new Date().toISOString().substring(11, 23);
    var entry = ts + ' ' + msg;
    console.log(entry);
    lastCallLog.push(entry);
    if (lastCallLog.length > 200) lastCallLog.shift();
}

async function getAccessToken() {
    var resp = await fetch('https://api.cartesia.ai/access-token', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + CARTESIA_API_KEY,
            'Cartesia-Version': '2025-04-16',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ grants: { agent: true }, expires_in: 3600 }),
    });
    var data = await resp.json();
    return data.token;
}

app.get('/', function(req, res) {
    res.json({ status: 'ok', service: 'NovakOS Voice Bridge', agent: AGENT_ID });
});

app.get('/version', function(req, res) {
    res.json({ version: '4.0', endpoint: 'agents/stream', auth: 'access_token', fix: 'buffer_and_timing' });
});

app.get('/last-call', function(req, res) {
    res.json({ logs: lastCallLog });
});

app.get('/test-cartesia', async function(req, res) {
    try {
        var token = await getAccessToken();
        var url = 'wss://api.cartesia.ai/agents/stream/' + AGENT_ID;
        var result = await new Promise(function(resolve) {
            var ws = new WebSocket(url, {
                headers: { 'Authorization': 'Bearer ' + token, 'Cartesia-Version': '2025-04-16' }
            });
            var timeout = setTimeout(function() { ws.close(); resolve({ status: 'timeout' }); }, 5000);
            ws.on('open', function() {
                ws.send(JSON.stringify({ event: 'start', config: { input_format: 'mulaw_8000' } }));
            });
            ws.on('message', function(data) {
                try {
                    var msg = JSON.parse(data.toString());
                    if (msg.event === 'ack') { clearTimeout(timeout); ws.close(); resolve({ status: 'ok', stream_id: msg.stream_id }); }
                } catch(e) {}
            });
            ws.on('error', function(err) { clearTimeout(timeout); resolve({ status: 'error', msg: err.message }); });
        });
        res.json(result);
    } catch(err) { res.json({ status: 'error', msg: err.message }); }
});

app.post('/voice', function(req, res) {
    var host = req.headers.host;
    log('[VOICE] Webhook hit. Host: ' + host);
    
    // Simple TwiML - just connect the stream
    var twiml = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Connect>' +
        '<Stream url="wss://' + host + '/media-stream" />' +
        '</Connect>' +
        '</Response>';
    
    res.type('text/xml').send(twiml);
});

var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server, path: '/media-stream' });

wss.on('connection', function(twilioWs) {
    log('[TWILIO] Media stream WebSocket connected');
    lastCallLog = []; // Reset log for new call
    
    var streamSid = null;
    var cartesiaWs = null;
    var cartesiaStreamId = null;
     // Buffer audio until streamSid is ready
    var cartesiaAudioBuffer = []; // Buffer Cartesia audio until streamSid ready
    var mediaOutputCount = 0;
    var mediaInputCount = 0;
    var twilioMediaQueue = []; // Queue caller audio until Cartesia is ready
    
    // SET UP TWILIO HANDLER FIRST (before any async work)
    twilioWs.on('message', function(message) {
        try {
            var msg = JSON.parse(message);
            
            if (msg.event === 'connected') {
                log('[TWILIO] Stream connected');
                
            } else if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                log('[TWILIO] Stream STARTED. SID: ' + streamSid);
                log('[TWILIO] Track: ' + (msg.start.track || 'unknown'));
                log('[TWILIO] Media format: ' + JSON.stringify(msg.start.mediaFormat || {}));
                
                // Flush any buffered Cartesia audio
                if (cartesiaAudioBuffer.length > 0) {
                    log('[BUFFER] Flushing ' + cartesiaAudioBuffer.length + ' Cartesia audio chunks');
                    cartesiaAudioBuffer.forEach(function(payload) {
                        twilioWs.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: payload }
                        }));
                    });
                    cartesiaAudioBuffer = [];
                }
                
            } else if (msg.event === 'media') {
                mediaInputCount++;
                if (mediaInputCount <= 3) {
                    log('[TWILIO] media #' + mediaInputCount + ' track: ' + msg.media.track + ' len: ' + msg.media.payload.length);
                }
                if (mediaInputCount === 100) {
                    log('[TWILIO] ... received 100 media chunks from caller');
                }
                
                // Forward to Cartesia if ready
                if (cartesiaWs && cartesiaWs.readyState === 1 && cartesiaStreamId) {
                    cartesiaWs.send(JSON.stringify({
                        event: 'media_input',
                        stream_id: cartesiaStreamId,
                        media: { payload: msg.media.payload }
                    }));
                } else {
                    twilioMediaQueue.push(msg.media.payload);
                }
                
            } else if (msg.event === 'stop') {
                log('[TWILIO] Stream STOPPED');
                log('[SUMMARY] media_output: ' + mediaOutputCount + ', media_input: ' + mediaInputCount);
                if (cartesiaWs) cartesiaWs.close();
            }
        } catch (error) {
            log('[TWILIO ERROR] ' + error.message);
        }
    });
    
    twilioWs.on('close', function() {
        log('[TWILIO] WebSocket CLOSED');
        if (cartesiaWs) cartesiaWs.close();
    });
    
    // NOW connect to Cartesia (async)
    getAccessToken().then(function(accessToken) {
        log('[AUTH] Got Cartesia access token');
        
        var cartesiaUrl = 'wss://api.cartesia.ai/agents/stream/' + AGENT_ID;
        log('[CARTESIA] Connecting to: ' + cartesiaUrl);
        
        cartesiaWs = new WebSocket(cartesiaUrl, {
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'Cartesia-Version': '2025-04-16',
            }
        });
        
        cartesiaWs.on('open', function() {
            log('[CARTESIA] WebSocket OPEN');
            cartesiaWs.send(JSON.stringify({
                event: 'start',
                config: { input_format: 'mulaw_8000' },
                metadata: { from: 'twilio-bridge', to: AGENT_ID }
            }));
            log('[CARTESIA] Sent start event');
        });
        
        cartesiaWs.on('message', function(data) {
            try {
                var msg = JSON.parse(data.toString());
                
                if (msg.event === 'ack') {
                    cartesiaStreamId = msg.stream_id;
                    log('[CARTESIA] ACK received. Stream: ' + cartesiaStreamId);
                    
                    // Flush queued caller audio to Cartesia
                    if (twilioMediaQueue.length > 0) {
                        log('[BUFFER] Flushing ' + twilioMediaQueue.length + ' queued caller audio chunks to Cartesia');
                        twilioMediaQueue.forEach(function(payload) {
                            cartesiaWs.send(JSON.stringify({
                                event: 'media_input',
                                stream_id: cartesiaStreamId,
                                media: { payload: payload }
                            }));
                        });
                        twilioMediaQueue = [];
                    }
                    
                } else if (msg.event === 'media_output') {
                    mediaOutputCount++;
                    var payload = msg.media && msg.media.payload;
                    
                    if (mediaOutputCount <= 3) {
                        log('[CARTESIA] media_output #' + mediaOutputCount + ' payload length: ' + (payload ? payload.length : 0));
                    }
                    
                    if (payload && streamSid) {
                        // Forward to Twilio
                        twilioWs.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: payload }
                        }));
                    } else if (payload && !streamSid) {
                        // Buffer until streamSid is ready
                        cartesiaAudioBuffer.push(payload);
                        if (cartesiaAudioBuffer.length <= 3) {
                            log('[BUFFER] Buffering audio chunk (no streamSid yet)');
                        }
                    }
                    
                } else if (msg.event === 'clear') {
                    log('[CARTESIA] Clear event');
                    if (streamSid) {
                        twilioWs.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
                    }
                    
                } else if (msg.event === 'transcript') {
                    log('[AGENT SAYS] ' + (msg.text || ''));
                    
                } else if (msg.event === 'user_transcript') {
                    log('[USER SAYS] ' + (msg.text || ''));
                    
                } else if (msg.event === 'error') {
                    log('[CARTESIA ERROR] ' + JSON.stringify(msg));
                    
                } else {
                    log('[CARTESIA] Event: ' + msg.event);
                }
            } catch (e) {
                log('[CARTESIA] Non-JSON message, length: ' + data.length);
            }
        });
        
        cartesiaWs.on('error', function(err) {
            log('[CARTESIA ERROR] ' + err.message);
        });
        
        cartesiaWs.on('close', function(code, reason) {
            log('[CARTESIA] Closed (' + code + '): ' + reason);
        });
        
    }).catch(function(err) {
        log('[ERROR] Setup failed: ' + err.message);
    });
    
    // Keepalive
    var pingInterval = setInterval(function() {
        if (cartesiaWs && cartesiaWs.readyState === WebSocket.OPEN) {
            cartesiaWs.ping();
        } else {
            clearInterval(pingInterval);
        }
    }, 30000);
});

server.listen(PORT, function() {
    log('NovakOS Voice Bridge v3.0 running on port ' + PORT);
    log('Agent: ' + AGENT_ID);
});
