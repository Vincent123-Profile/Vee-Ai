const admin = require("firebase-admin");
let app;
function database() {
  if (!app) {
    const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if(!raw)throw new Error("Firebase service account is not configured.");
    app=admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),databaseURL:process.env.FIREBASE_DATABASE_URL||"https://vee-ai-e745e-default-rtdb.firebaseio.com"},"vee-ai-email-settings");
  }
  return app.database();
}
const json=(statusCode,body)=>({statusCode,headers:{"Content-Type":"application/json","Cache-Control":"no-store"},body:JSON.stringify(body)});
function validTimeZone(value){if(typeof value!=="string"||value.length>80)return false;try{new Intl.DateTimeFormat("en",{timeZone:value}).format();return true;}catch(_){return false;}}
exports.handler=async event=>{
  if(event.httpMethod!=="POST")return json(405,{error:"Method not allowed."});
  try{
    const header=event.headers&&(event.headers.authorization||event.headers.Authorization)||"";
    const match=/^Bearer\s+(.+)$/i.exec(header);
    if(!match)return json(401,{error:"Sign in to Vee-AI first."});
    const db=database();
    const user=await admin.auth(app).verifyIdToken(match[1],true);
    if(user.email_verified!==true)return json(403,{error:"Verify your Vee-AI email first."});
    if(Buffer.byteLength(event.body||"","utf8")>5000)return json(413,{error:"Request too large."});
    const body=JSON.parse(event.body||"{}");
    const ref=db.ref("users/"+user.uid+"/emailIntelligenceSettings");
    if(body.action==="get"){const snap=await ref.once("value");return json(200,{settings:snap.val()||{}});}
    if(body.action!=="save")return json(400,{error:"Unknown settings action."});
    const time=String(body.dailyReportTime||"21:00");
    const timeZone="Africa/Lagos";
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return json(400,{error:"Choose a valid report time."});
    if(!validTimeZone(timeZone))return json(400,{error:"Nigeria time zone configuration is invalid."});
    const settings={
      dailyReportEnabled:body.dailyReportEnabled===true,
      dailyReportTime:time,
      timeZone,
      alertSecurity:body.alertSecurity===true,
      alertFailedTransactions:body.alertFailedTransactions===true,
      alertEachTransaction:body.alertEachTransaction===true,
      largeTransactionAlerts:body.largeTransactionAlerts===true,
      largeTransactionThreshold:Math.max(0,Math.min(1000000000000,Number(body.largeTransactionThreshold)||0)),
      scanMode:body.scanMode==="financial_only"?"financial_only":"all_inbox",
      reportShowTransactions:body.reportShowTransactions!==false,
      reportShowExceptions:body.reportShowExceptions!==false,
      reportShowSecurity:body.reportShowSecurity===true,
      updatedAtMs:Date.now()
    };
    await ref.set(settings);
    return json(200,{success:true,settings});
  }catch(error){
    console.error("Email Intelligence settings error:",error&&error.message||error);
    return json(400,{error:"Unable to save Email Intelligence settings."});
  }
};
