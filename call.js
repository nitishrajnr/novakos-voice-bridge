/**
 * Make an outbound call to any number (including Indian +91)
 * 
 * Usage: node call.js +918826688102
 */

const dotenv = require('dotenv');
dotenv.config();

const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const toNumber = process.argv[2];
const publicUrl = process.env.PUBLIC_URL;

if (!toNumber) {
    console.error('Usage: node call.js <phone-number>');
    console.error('Example: node call.js +918826688102');
    process.exit(1);
}

if (!publicUrl) {
    console.error('❌ Set PUBLIC_URL first (your ngrok URL)');
    console.error('Example: PUBLIC_URL=https://abc123.ngrok.io node call.js +918826688102');
    process.exit(1);
}

async function main() {
    console.log(`📞 Calling ${toNumber}...`);
    console.log(`   From: ${process.env.TWILIO_PHONE_NUMBER}`);
    console.log(`   Webhook: ${publicUrl}/voice`);
    
    try {
        const call = await client.calls.create({
            url: `${publicUrl}/voice`,
            to: toNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
        });
        console.log(`✅ Call initiated! SID: ${call.sid}`);
        console.log(`   Status: ${call.status}`);
    } catch (error) {
        console.error(`❌ Failed: ${error.message}`);
        if (error.code === 21219) {
            console.error('   → This number is not verified. On trial, verify it at:');
            console.error('     https://console.twilio.com/us1/develop/phone-numbers/manage/verified');
        }
    }
}

main();
