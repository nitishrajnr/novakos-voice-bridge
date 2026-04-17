/**
 * Direct Twilio → India call with Cartesia TTS
 * 
 * Simplest approach: Twilio calls Indian number, plays AI-generated speech.
 * Uses TwiML Bin (no server needed) + Cartesia TTS for voice generation.
 * 
 * For full bidirectional (caller talks back to AI), we need the WebSocket bridge.
 * This script tests one-way: AI speaks to the caller.
 * 
 * Usage: node direct-call.js +918826688102
 */

require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const toNumber = process.argv[2] || '+918826688102';

async function makeCall() {
    console.log(`📞 Calling ${toNumber} from ${process.env.TWILIO_PHONE_NUMBER}...`);
    console.log('   This is a one-way test: AI will speak, caller listens.');
    console.log('   (Full two-way conversation needs the bridge server)\n');
    
    try {
        // Use TwiML directly - Twilio speaks a message
        // This proves the India calling works before we add Cartesia
        const call = await client.calls.create({
            twiml: `<Response>
                <Say voice="alice" language="en-IN">
                    Hello! This is a test call from NovakOS supply chain assistant. 
                    Your order number 4521, 5000 pieces polo t-shirts, has been shipped from Tirupur. 
                    It will arrive at Mumbai port in 3 days.
                    Thank you for using NovakOS. Have a great day!
                </Say>
                <Pause length="2"/>
                <Say voice="alice" language="hi-IN">
                    Namaste! Yeh NovakOS supply chain assistant hai. 
                    Aapka order number 4522, 2000 pieces denim jeans, 
                    Bangalore factory mein production mein hai. 
                    60 percent complete hai, delivery April 25 tak hogi.
                    Dhanyavaad!
                </Say>
            </Response>`,
            to: toNumber,
            from: process.env.TWILIO_PHONE_NUMBER,
        });
        
        console.log(`✅ Call initiated!`);
        console.log(`   SID: ${call.sid}`);
        console.log(`   Status: ${call.status}`);
        console.log(`\n⏳ Your phone should ring in a few seconds...`);
        console.log(`   Note: Trial message will play first, then the AI message.`);
        
    } catch (error) {
        console.error(`\n❌ Call failed: ${error.message}`);
        if (error.code === 21219) {
            console.error('   → Number not verified. Verify at:');
            console.error('     https://console.twilio.com/us1/develop/phone-numbers/manage/verified');
        } else if (error.code === 21215) {
            console.error('   → Geographic permission not enabled for India.');
            console.error('     Enable at: Voice → Settings → Geo Permissions');
        } else if (error.code === 21210) {
            console.error('   → From number not valid. Check TWILIO_PHONE_NUMBER in .env');
        }
    }
}

makeCall();
