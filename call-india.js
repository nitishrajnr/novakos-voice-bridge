require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

async function main() {
    console.log('📞 Calling +918826688102...');
    
    const call = await client.calls.create({
        twiml: '<Response><Pause length="1"/><Say voice="Polly.Aditi" language="hi-IN">Namaste! Yeh NovakOS supply chain assistant bol raha hai. Aapka order number 4521, paanch hazaar pieces polo t-shirts, Tirupur se ship ho chuki hai. Mumbai port par 3 din mein pahunch jayegi. Kya aapko koi aur jaankari chahiye?</Say><Pause length="2"/><Say voice="Polly.Raveena" language="en-IN">Your order number 4522, two thousand pieces denim jeans, is currently in production at our Bangalore factory. It is sixty percent complete. Expected delivery is April 25th. Thank you for using NovakOS!</Say></Response>',
        to: '+918826688102',
        from: process.env.TWILIO_PHONE_NUMBER,
    });
    
    console.log('✅ Call initiated! SID:', call.sid);
    console.log('⏳ Phone should ring in a few seconds...');
}

main().catch(err => console.error('❌', err.message));
