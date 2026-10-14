// Sends email over plain HTTPS using Resend's API (https://resend.com) — not raw SMTP sockets.
// Why: most free hosting platforms (Render included) block outbound SMTP ports (25/465/587)
// to stop spam, so a correct SMTP client can still fail with no useful error. HTTPS on port 443
// is never blocked — it's the same kind of connection this app already uses for ingestion.
//
// Setup (free, no credit card):
//   1. Sign up at https://resend.com
//   2. Dashboard -> API Keys -> Create API Key -> copy it
//   3. Set one environment variable: RESEND_API_KEY=re_xxxxxxxx
// That's it — no host/port/username/password to configure.
//
// Sending address: without verifying your own domain on Resend, you can only send FROM
// onboarding@resend.dev (Resend's shared testing address) but TO any real inbox. That's fine
// for password-reset codes. If you later verify your own domain on Resend, set RESEND_FROM
// to an address on that domain and it'll be used instead.
 
async function sendMail({to,subject,text}){
const key=process.env.RESEND_API_KEY;
if(!key)return{ok:false,error:'Email not configured. Set RESEND_API_KEY in the environment (free account at resend.com) to enable email alerts.'};
const from=process.env.RESEND_FROM||'Signalstack <onboarding@resend.dev>';
try{
const r=await fetch('https://api.resend.com/emails',{
method:'POST',
headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
body:JSON.stringify({from,to:[to],subject,text}),
signal:AbortSignal.timeout(15000)
});
const d=await r.json().catch(()=>({}));
if(!r.ok)return{ok:false,error:d.message||`Resend API returned HTTP ${r.status}`};
return{ok:true};
}catch(e){return{ok:false,error:e.message}}
}
module.exports={sendMail};
 
