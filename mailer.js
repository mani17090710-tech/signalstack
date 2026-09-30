// Tiny SMTP client using only Node's built-in net/tls modules — no npm install needed.
// Configure via env vars: SMTP_HOST, SMTP_PORT (587 default), SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE ("true" for port 465).
const net=require('node:net'),tls=require('node:tls');

function talk(sock){return new Promise((res,rej)=>{let buf='';const onData=d=>{buf+=d.toString();const lines=buf.split('\r\n').filter(Boolean);const last=lines[lines.length-1];
if(last&&/^\d{3} /.test(last)){sock.removeListener('data',onData);res({code:+last.slice(0,3),text:lines.join('\n')})}};
sock.on('data',onData);sock.once('error',rej)})}
function cmd(sock,line){sock.write(line+'\r\n');return talk(sock)}

async function sendMail({to,subject,text}){
const host=process.env.SMTP_HOST,port=+(process.env.SMTP_PORT||587),user=process.env.SMTP_USER,pass=process.env.SMTP_PASS,from=process.env.SMTP_FROM||user,secure=process.env.SMTP_SECURE==='true';
if(!host||!user||!pass||!from)return{ok:false,error:'Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in the environment to enable email alerts.'};
let sock;
try{
sock=secure?tls.connect({host,port}):net.connect({host,port});
await new Promise((res,rej)=>{sock.once(secure?'secureConnect':'connect',res);sock.once('error',rej)});
await talk(sock); // greeting
let r=await cmd(sock,'EHLO signalstack.local');
if(!secure&&/STARTTLS/i.test(r.text)){
r=await cmd(sock,'STARTTLS');if(r.code!==220)throw new Error('Server refused STARTTLS');
const plain=sock;sock=await new Promise((res,rej)=>{const s=tls.connect({socket:plain,host},()=>res(s));s.once('error',rej)});
r=await cmd(sock,'EHLO signalstack.local');
}
r=await cmd(sock,'AUTH LOGIN');if(r.code!==334)throw new Error('Server did not offer AUTH LOGIN');
r=await cmd(sock,Buffer.from(user).toString('base64'));if(r.code!==334)throw new Error('Username rejected');
r=await cmd(sock,Buffer.from(pass).toString('base64'));if(r.code!==235)throw new Error('Login failed — check SMTP_USER/SMTP_PASS');
r=await cmd(sock,`MAIL FROM:<${from}>`);if(r.code!==250)throw new Error('Sender rejected');
r=await cmd(sock,`RCPT TO:<${to}>`);if(r.code!==250)throw new Error('Recipient rejected');
r=await cmd(sock,'DATA');if(r.code!==354)throw new Error('Server refused DATA');
const body=`From: Signalstack <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`;
r=await cmd(sock,body);if(r.code!==250)throw new Error('Server rejected the message');
await cmd(sock,'QUIT');sock.end();
return{ok:true};
}catch(e){try{sock&&sock.end()}catch(_){}
return{ok:false,error:e.message}}
}
module.exports={sendMail};
