const admin = require("firebase-admin");
const crypto = require("crypto");
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
