const admin = require("firebase-admin");
const crypto = require("crypto");
const scheduler = require("./gmail-intelligence-scheduler");
let app;
function database(){
  if(!app){
    const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if(!raw)throw new Error("Firebase service account is not configured.");
    app=admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),databaseURL:process.env.FIREBASE_DATABASE_URL||"https://vee-ai-e745e-default-rtdb.firebaseio.com"},"vee-ai-demo-report");
  }
  return app.database();
}
const json=(statusCode,body)=>({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:JSON.stringify(body)});
exports.handler=async event=>{
  if(event.httpMethod!=="POST")return json(405,{error:"Method not allowed."});
  try{
    const header=event.headers&&(event.headers.authorization||event.headers.Authorization)||"";
    const match=/^Bearer\s+(.+)$/i.exec(header);
    if(!match)return json(401,{error:"Sign in to Vee-AI first."});
    const db=database();
    const user=await admin.auth(app).verifyIdToken(match[1],true);
    if(user.email_verified!==true)return json(403,{error:"Verify your Vee-AI email first."});
    if(Buffer.byteLength(event.body||"","utf8")>3000)return json(413,{error:"Request too large."});
    const body=JSON.parse(event.body||"{}");
    const ref=db.ref("telegram/emailIntelligenceDemoReports/"+user.uid+"/pending");
    if(body.action==="process"){
      const current=(await ref.once("value")).val();
      if(!current)return json(404,{error:"No demo report is scheduled."});
      if(current.status==="sent"||current.status==="failed"||current.status==="cancelled")return json(200,{status:current.status});
      if(current.status!=="scheduled")return json(200,{status:"processing"});
      if(Number(current.scheduledAtMs)>Date.now())return json(200,{status:"waiting",scheduledAtMs:current.scheduledAtMs});
      const claim=await ref.transaction(value=>{
        if(!value||value.status!=="scheduled"||Number(value.scheduledAtMs)>Date.now())return;
        return Object.assign({},value,{status:"sending",claimedAtMs:Date.now()});
      },undefined,false);
      if(!claim.committed)return json(200,{status:"processing"});
      try{
        const token=(process.env.TELEGRAM_BOT_TOKEN||"").trim();
        const linked=(await db.ref("telegram/accountsByChat").once("value")).val()||{};
        const chats=Object.entries(linked).filter(([,item])=>item&&String(item.uid)===String(user.uid)).map(([chatId])=>chatId).filter(chatId=>/^\d{1,24}$/.test(chatId));
        if(!token||!chats.length)throw new Error("Telegram connection is unavailable.");
        const settings=(await db.ref("users/"+user.uid+"/emailIntelligenceSettings").once("value")).val()||{};
        const result=await scheduler.sendDemoReport(db,token,chats,user.uid,settings,new Date(),current.id);
        await ref.set(Object.assign({},current,{status:"sent",sentAtMs:Date.now(),resultStatus:result.status}));
        return json(200,{status:"sent",sentAtMs:Date.now()});
      }catch(error){
        await ref.set(Object.assign({},current,{status:"failed",failedAtMs:Date.now(),failure:"Delivery failed. Check your Telegram connection and try again."}));
        console.error("Vee-AI live demo report delivery failed:",error&&error.message||error);
        return json(502,{error:"The demo report delivery failed. Check Telegram and schedule another demo."});
      }
    }
    if(body.action==="cancel"){
      const result=await ref.transaction(current=>{
        if(!current||current.status!=="scheduled")return;
        return Object.assign({},current,{status:"cancelled",cancelledAtMs:Date.now()});
      },undefined,false);
      if(!result.committed)return json(409,{error:"No pending demo report is available to cancel, or delivery has already started."});
      return json(200,{success:true,status:"cancelled"});
    }
    if(body.action!=="schedule")return json(400,{error:"Unknown demo report action."});
    const scheduledAtMs=Number(body.scheduledAtMs);
    const now=Date.now();
    if(!Number.isFinite(scheduledAtMs)||scheduledAtMs<now+45000||scheduledAtMs>now+30*60*1000)return json(400,{error:"Choose a delivery time between 1 and 30 minutes from now."});
    const chatId=String(body.chatId||"");
    if(chatId!=="all")return json(400,{error:"Invalid Telegram recipient selection."});
    const linkedChats=(await db.ref("telegram/accountsByChat").once("value")).val()||{};
    if(!Object.values(linkedChats).some(item=>item&&String(item.uid)===String(user.uid)))return json(403,{error:"Link Telegram to your Vee-AI account before scheduling a demo report."});
    const job={id:crypto.randomBytes(16).toString("hex"),status:"scheduled",chatId,scheduledAtMs,createdAtMs:now,timeZone:"Africa/Lagos"};
    const result=await ref.transaction(current=>{
      if(current&&current.status==="sending")return;
      return job;
    },undefined,false);
    if(!result.committed)return json(409,{error:"A demo report is already being delivered. Wait for delivery to finish."});
    return json(200,{success:true,job:{id:job.id,status:job.status,scheduledAtMs,chatId,timeZone:job.timeZone}});
  }catch(error){
    console.error("Vee-AI demo report scheduling error:",error&&error.message||error);
    return json(400,{error:"Unable to schedule the demo report."});
  }
};
