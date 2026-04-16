require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const toNumber = process.argv[2] || '+918826688102';
const bridgeUrl = process.argv[3] || 'https://novakos-voice-bridge.onrender.com';

async function main() {
    console.log('Calling ' + toNumber + ' via bridge at ' + bridgeUrl);
    
    const call = await client.calls.create({
        url: bridgeUrl + '/voice',
        to: toNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
    });
    
    console.log('Call initiated. SID: ' + call.sid);
}

main().catch(function(err) { console.error('Failed: ' + err.message); });
