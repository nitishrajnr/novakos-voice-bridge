#!/bin/bash
# Start the bridge server with ngrok tunnel
# Usage: ./start.sh

set -e

# Load env
source .env

echo "🚀 Starting Twilio ↔ Cartesia Voice Agent Bridge"
echo ""

# Start the server in background
node app.js &
SERVER_PID=$!
echo "✅ Server started (PID: $SERVER_PID) on port ${PORT:-3000}"

# Wait for server to be ready
sleep 2

# Start ngrok tunnel
echo "🌐 Starting ngrok tunnel..."
npx ngrok http ${PORT:-3000} &
NGROK_PID=$!

# Wait for ngrok
sleep 3

# Get the public URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | node -e "
const data = require('fs').readFileSync('/dev/stdin', 'utf8');
const tunnels = JSON.parse(data).tunnels;
const https = tunnels.find(t => t.proto === 'https');
console.log(https ? https.public_url : '');
" 2>/dev/null)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Failed to get ngrok URL. Make sure ngrok is authenticated."
    echo "   Run: npx ngrok config add-authtoken <your-token>"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ Bridge is LIVE!"
echo "  🌐 Public URL: $NGROK_URL"
echo "  📞 To call Indian number, run:"
echo "     PUBLIC_URL=$NGROK_URL node call.js +918826688102"
echo "═══════════════════════════════════════════════════"
echo ""

# Wait for processes
wait
