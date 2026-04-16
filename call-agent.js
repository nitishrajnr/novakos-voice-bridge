/**
 * Call any Indian number with a specific NovakOS agent
 * Usage: node call-agent.js <phone> <agent>
 * Agents: sthflow, cos, sales, marketing, finance, pm, legal, cto
 */
require('dotenv').config();
var twilio = require('twilio');
var client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

var phone = process.argv[2];
var agent = process.argv[3] || 'default';
var bridge = 'https://novakos-voice-bridge.onrender.com';

if (!phone) {
    console.log('Usage: node call-agent.js <phone> <agent>');
    console.log('Agents: sthflow, cos, sales, marketing, finance, pm, legal, cto');
    process.exit(1);
}

async function main() {
    console.log('Calling ' + phone + ' with agent: ' + agent);
    var call = await client.calls.create({
        url: bridge + '/voice?agent=' + agent,
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
    });
    console.log('Call SID: ' + call.sid);
}
main().catch(function(e) { console.error('Failed:', e.message); });
