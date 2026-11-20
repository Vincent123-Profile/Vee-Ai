const admin = require("firebase-admin");
const crypto = require("crypto");
const gmail = require("./gmail");
let app;
function database() {
  if (!app) {
    const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if(!raw)throw new Error("Firebase service account is not configured.");
    app=admin.initializeApp({credential:admin.credential.cert(JSON.parse(raw)),databaseURL:process.env.FIREBASE_DATABASE_URL||"https://vee-ai-e745e-default-rtdb.firebaseio.com"},"vee-ai-gmail-background-scanner");
  }
  return app.database();
}
function clean(value,max){return String(value||"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,max);}
function html(value){return clean(value,400).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function validTimeZone(value){if(typeof value!=="string"||value.length>80)return false;try{new Intl.DateTimeFormat("en",{timeZone:value}).format();return true;}catch(_){return false;}}
function localClock(timeZone,now){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const values={};parts.forEach(part=>{if(part.type!=="literal")values[part.type]=part.value;});
  const days={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {date:values.year+"-"+values.month+"-"+values.day,time:values.hour+":"+values.minute,day:days[values.weekday]};
}
async function sendTelegram(token,chatId,text){
  const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",link_preview_options:{is_disabled:true}})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok!==true)throw new Error("Telegram delivery failed.");
}
async function chatsForUser(db,uid){
  const snap=await db.ref("telegram/accountsByChat").once("value");
  return Object.entries(snap.val()||{}).filter(([,account])=>account&&String(account.uid)===String(uid)).map(([chatId])=>chatId).filter(id=>/^\d{1,24}$/.test(id));
}
async function deliverOnce(db,token,chats,uid,key,message){
  const ref=db.ref("telegram/emailIntelligenceDeliveries/"+uid+"/"+key);
  const claimId=crypto.randomBytes(12).toString("hex"),now=Date.now();
  const claim=await ref.transaction(current=>{
    if(current&&current.status==="sent")return;
    if(current&&current.status==="sending"&&now-Number(current.claimedAtMs||0)<10*60*1000)return;
    return {status:"sending",claimId,claimedAtMs:now};
  },undefined,false);
  if(!claim.committed)return false;
  try{
    for(const chatId of chats)await sendTelegram(token,chatId,message);
    await ref.set({status:"sent",sentAtMs:Date.now()});
    return true;
  }catch(error){
    const current=(await ref.once("value")).val();
    if(current&&current.claimId===claimId)await ref.remove();
    throw error;
  }
}
function localDateFor(ms,timeZone){
  return new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Number(ms)||0));
}
function money(amount,currency){
  const n=Number(amount||0);
  return (currency==="NGN"?"₦":String(currency||"")+" ")+n.toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2});
}
async function sendImmediateAlerts(db,token,chats,uid,accountId,items,settings){
  for(const item of items){
    if(!item||!item.id)continue;
    const transaction=item.transaction||{};
    const status=transaction.transactionStatus||"unknown";
    if(settings.alertSecurity===true&&item.riskLevel&&item.riskLevel!=="none"){
      const reasons=(item.securityFindings||[]).slice(0,3).map(f=>html(f.reason)).join("; ");
      const msg="🚨 <b>Vee-AI Security Alert</b>\n\n<b>"+html(item.subject||"Suspicious email")+"</b>\nFrom: "+html(item.from||"Unknown sender")+"\nRisk: "+html(item.riskLevel.toUpperCase())+(reasons?"\nFindings: "+reasons:"")+"\n\nReview this message in Vee-AI. Avoid opening suspicious links.";
      await deliverOnce(db,token,chats,uid,"alert_"+accountId+"_"+item.id+"_security",msg);
    }
    if(settings.alertFailedTransactions===true&&(status==="failed"||status==="reversed")){
      const msg=(status==="failed"?"⚠️ <b>Failed transaction detected</b>":"↩️ <b>Transaction reversal detected</b>")+"\n\n"+money(transaction.amount,transaction.currency)+"\nBank: "+html(item.bank&&item.bank.name||"Not identified")+"\n"+html(item.subject||"Bank notification")+"\n\nReview the original bank notification in Vee-AI.";
      await deliverOnce(db,token,chats,uid,"alert_"+accountId+"_"+item.id+"_status",msg);
    }
    const isValid=transaction.amount>0&&(transaction.direction==="in"||transaction.direction==="out")&&item.classificationConfidence==="high"&&!item.needsReview&&status!=="failed"&&status!=="pending";
    if(isValid){
      const threshold=Number(settings.largeTransactionThreshold||0);
      const large=settings.largeTransactionAlerts===true&&threshold>0&&Number(transaction.amount)>=threshold;
      if(settings.alertEachTransaction===true||large){
        const label=transaction.direction==="in"?"Credit received":"Debit recorded";
        const msg="💳 <b>"+label+"</b>\n\n<b>"+money(transaction.amount,transaction.currency)+"</b>\nBank: "+html(item.bank&&item.bank.name||"Not identified")+"\nDate: "+html(item.date||"Date unavailable")+"\nFrom / To: "+html(transaction.counterparty||"Name unavailable")+"\nTime: "+html(item.date||"Unavailable")+"\nDetails: "+html(transaction.narration||item.subject||item.snippet||"No description available");
        await deliverOnce(db,token,chats,uid,"alert_"+accountId+"_"+item.id+"_transaction",msg);
      }
    }
  }
}
async function sendDailyReport(db,token,chats,uid,settings,now,options){
  options=options||{};
  if(!options.demoMode&&(settings.dailyReportEnabled!==true||!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.dailyReportTime||""))))return {status:"disabled_or_invalid_time"};
  const zone="Africa/Lagos";
  const clock=localClock(zone,now);
  if(!options.demoMode){const current=clock.time.split(":").map(Number),wanted=String(settings.dailyReportTime).split(":").map(Number);const elapsed=(current[0]*60+current[1])-(wanted[0]*60+wanted[1]);if(elapsed<0)return {status:"not_due",localTime:clock.time,scheduledTime:settings.dailyReportTime,timeZone:zone};}
  const snapshot=await db.ref("gmailConnections/"+uid).once("value"),root=snapshot.val()||{};
  const records=[];
  Object.entries(root.accounts||{}).forEach(([accountId,account])=>Object.values(account&&account.emails||{}).forEach(item=>records.push(Object.assign({accountId},item))));
  Object.values(root.emails||{}).forEach(item=>records.push(Object.assign({accountId:"legacy"},item)));
  const today=records.filter(item=>{
    if(!item||!Array.isArray(item.categories)||!item.categories.includes("bank"))return false;
    const tx=item.transaction||{};
    const eventMs=Number(tx.transactionAtMs||item.internalDate||0);
    return eventMs>0&&(options.demoMode||localDateFor(eventMs,zone)===clock.date);
  });
  const seen=new Set();
  const unique=today.filter(item=>{
    const tx=item.transaction||{};
    const bankName=String(item.bank&&item.bank.name||"unknown").toLowerCase();
    const ref=String(tx.reference||"").trim().toLowerCase();
    const key=ref?bankName+":"+ref: String(item.accountId)+":"+String(item.id);
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
  const groups={};
  const counts={successful:0,credits:0,debits:0,failed:0,reversed:0,refunded:0,pending:0,review:0,unknown:0};
  const rows=[];
  for(const item of unique){
    const tx=item.transaction||{},status=String(tx.transactionStatus||"unknown");
    const amount=Number(tx.amount||0),currency=String(tx.currency||"UNKNOWN").toUpperCase();
    if(!groups[currency])groups[currency]={in:0,out:0,net:0,transactions:0};
    const group=groups[currency];group.transactions++;
    if(status==="failed"){counts.failed++;continue;}
    if(status==="pending"){counts.pending++;continue;}
    if(status==="reversed")counts.reversed++;
    else if(status==="refunded"){counts.refunded++;}
    if(item.needsReview||item.classificationConfidence!=="high"||!(amount>0)||!(tx.direction==="in"||tx.direction==="out")){
      counts.review++;continue;
    }
    if(status==="successful")counts.successful++;
    else if(status!=="reversed"&&status!=="refunded")counts.unknown++;
    if(tx.direction==="in"){group.in+=amount;counts.credits++;}
    if(tx.direction==="out"){group.out+=amount;counts.debits++;}
    if(tx.direction==="in"||tx.direction==="out"){
      if(rows.length<30){
        const eventTime=Number(tx.transactionAtMs||item.internalDate||0);
        const timeLabel=eventTime?new Intl.DateTimeFormat("en-NG",{timeZone:zone,dateStyle:"short",timeStyle:"short"}).format(new Date(eventTime)):"Time unavailable";
        rows.push((tx.direction==="in"?"➕ ":"➖ ")+money(amount,currency)+" · "+html(item.bank&&item.bank.name||"Bank not identified")+" · "+html(timeLabel)+"\n"+html(tx.counterparty||"Name unavailable")+" · "+html(tx.narration||item.subject||item.snippet||"Description unavailable").slice(0,180));
      }
    }
  }
  const currencies=Object.keys(groups).sort();
  currencies.forEach(currency=>{groups[currency].net=groups[currency].in-groups[currency].out;});
  const totalsText=currencies.length?currencies.map(currency=>{
    const g=groups[currency],net=g.net;
    return "<b>"+html(currency)+"</b> · Credits "+money(g.in,currency)+" · Debits "+money(g.out,currency)+" · Net "+(net>=0?"+":"")+money(net,currency)+" · Transactions "+g.transactions;
  }).join("\n"):"No bank transaction emails found for this date.";
  const showTransactions=settings.reportShowTransactions!==false;
  const showExceptions=settings.reportShowExceptions!==false;
  const showSecurity=settings.reportShowSecurity===true;
  const security=showSecurity?records.filter(item=>{
    const ms=Number(item.transaction&&item.transaction.transactionAtMs||item.internalDate||0);
    return ms>0&&localDateFor(ms,zone)===clock.date&&item.riskLevel&&item.riskLevel!=="none";
  }).length:0;
  const exceptionText=showExceptions?"\nFailed: "+counts.failed+" · Reversed: "+counts.reversed+" · Refunded: "+counts.refunded+" · Pending: "+counts.pending+" · Needs review: "+counts.review:"";
  const securityText=showSecurity?"\n🛡️ Security findings: "+security:"";
  const transactionText=showTransactions?"\n\n<b>Transaction details</b>\n"+(rows.length?rows.join("\n\n"):"No high-confidence transactions to list."):"";
  const message=(options.demoMode?"📊 <b>Vee-AI Financial Intelligence Demo Report</b>":"📊 <b>Vee-AI Daily Bank Report</b>")+"\n"+(options.demoMode?"All available connected Gmail financial records":"Reporting date: "+clock.date)+" · "+html(zone)+"\n\n"+totalsText+"\n\n<b>Activity counts</b>\nTransactions identified: "+unique.length+" · Successful: "+counts.successful+" · Credits: "+counts.credits+" · Debits: "+counts.debits+exceptionText+securityText+transactionText+"\n\n<i>Net account movement is not business profit. Currency totals are kept separate. Failed and pending items are excluded from completed money movement. Reversals are shown as returned money on their transaction date.</i>";
  const deliveryKey=options.deliveryKey||("daily_"+clock.date);
  const delivered=await deliverOnce(db,token,chats,uid,deliveryKey,message.slice(0,3900));
  if(!delivered){
    const existing=(await db.ref("telegram/emailIntelligenceDeliveries/"+uid+"/"+deliveryKey).once("value")).val()||{};
    return {status:existing.status==="sent"?"already_sent":"already_in_progress",localTime:clock.time,scheduledTime:settings.dailyReportTime,timeZone:zone,date:clock.date,transactions:unique.length,currencies};
  }
  return {status:"sent",localTime:clock.time,scheduledTime:settings.dailyReportTime,timeZone:zone,date:clock.date,transactions:unique.length,currencies};
}
exports.handler=async()=>{
  const token=(process.env.TELEGRAM_BOT_TOKEN||"").trim();
  const db=database(),now=Date.now(),claimId=crypto.randomBytes(16).toString("hex");
  const lockRef=db.ref("gmailIntelligenceScheduler/lock");
  const lock=await lockRef.transaction(current=>{
    if(current&&current.claimedAtMs&&now-Number(current.claimedAtMs)<50*1000)return;
    return {claimId,claimedAtMs:now};
  },undefined,false);
  if(!lock.committed)return {statusCode:200,body:JSON.stringify({ok:true,skipped:"another scan is running"})};
  const outcomes=[];
  try{
    // Process one-off demo reports independently from normal daily reports.\n    for(const [uid] of Object.entries((await db.ref("gmailConnections").once("value")).val()||{})){\n      const jobRef=db.ref("telegram/emailIntelligenceDemoReports/"+uid+"/pending");\n      const job=(await jobRef.once("value")).val();\n      if(!job||job.status!=="scheduled"||Number(job.scheduledAtMs)>now)continue;\n      const claim=await jobRef.transaction(current=>{if(!current||current.status!=="scheduled"||Number(current.scheduledAtMs)>now)return;return Object.assign({},current,{status:"sending",claimedAtMs:now});},undefined,false);\n      if(!claim.committed)continue;\n      try{\n        const chats=token&&job.chatId==="all"?await chatsForUser(db,uid):[];\n        if(!token||!chats.length)throw new Error("Selected Telegram chat is no longer linked.");\n        const settings=(await db.ref("users/"+uid+"/emailIntelligenceSettings").once("value")).val()||{};\n        const result=await sendDailyReport(db,token,chats,uid,settings,new Date(now),{demoMode:true,deliveryKey:"demo_"+String(job.id||"")});\n        await jobRef.set(Object.assign({},job,{status:"sent",sentAtMs:Date.now(),resultStatus:result.status}));\n      }catch(error){await jobRef.set(Object.assign({},job,{status:"failed",failedAtMs:Date.now(),failure:"Delivery failed. Check Telegram connection and retry."}));console.error("Vee-AI demo report failed:",clean(error.message,180));}\n    }
    const snapshot=await db.ref("gmailConnections").once("value"),users=snapshot.val()||{};
    const userEntries=Object.entries(users).slice(0,100);
    // Run report delivery for all eligible users first. Gmail scans follow in a
    // separate pass so slow mailbox reads cannot prevent later reports.
    for(const [uid,record] of userEntries){
      if(!uid||uid==="undefined"||!record)continue;
      const settings=(await db.ref("users/"+uid+"/emailIntelligenceSettings").once("value")).val()||{};
      if(settings.dailyReportEnabled!==true)continue;
      const chats=token?await chatsForUser(db,uid):[];
      if(!token||!chats.length){
        console.warn("Vee-AI daily report not sent:",JSON.stringify({uid,reason:!token?"telegram_bot_token_missing":"no_linked_telegram_chat"}));
      }else{
        try{
          const reportResult=await sendDailyReport(db,token,chats,uid,settings,new Date(now));
          console.log("Vee-AI daily report check:",JSON.stringify({uid,...reportResult}));
        }catch(error){console.error("Vee-AI daily email report failed:",JSON.stringify({uid,error:clean(error.message,180)}));}
      }
    }
    let processed=0;
    for(const [uid,record] of userEntries){
      if(!uid||uid==="undefined"||!record)continue;
      const accounts=Object.entries(record.accounts||{}).filter(([,item])=>item&&item.status&&item.status.connected===true&&item.tokenVault);
      if(record.status&&record.status.connected===true&&record.tokenVault)accounts.unshift(["legacy",record]);
      const settingsSnapshot=await db.ref("users/"+uid+"/emailIntelligenceSettings").once("value");
      const settings=settingsSnapshot.val()||{};
      const chats=token?await chatsForUser(db,uid):[];
      for(const [accountId,account] of accounts.slice(0,3)){
        if(processed>=30)break;
        try{
          const statusPath=accountId==="legacy"?"gmailConnections/"+uid+"/status":"gmailConnections/"+uid+"/accounts/"+accountId+"/status";
          const priorStatus=(await db.ref(statusPath).once("value")).val()||{};
          const emailPath=accountId==="legacy"?"gmailConnections/"+uid+"/emails":"gmailConnections/"+uid+"/accounts/"+accountId+"/emails";
          const beforeSnapshot=await db.ref(emailPath).once("value");
          const beforeIds=new Set(Object.keys(beforeSnapshot.val()||{}));
          const result=await gmail.runScheduledScan(db,uid,accountId);
          if(token&&chats.length&&priorStatus.lastSyncAtMs){
            const emailSnapshot=await db.ref(emailPath).orderByChild("internalDate").limitToLast(30).once("value");
            const newItems=Object.values(emailSnapshot.val()||{}).filter(item=>!beforeIds.has(String(item.id||"")));
            await sendImmediateAlerts(db,token,chats,uid,accountId,newItems,settings);
          }
          outcomes.push({uid,accountId,status:"scanned",messages:result.synced||0});
        }catch(error){
          console.error("Vee-AI scheduled Gmail scan failed:",JSON.stringify({uid,accountId,error:clean(error.message,180)}));
          outcomes.push({uid,accountId,status:"failed"});
        }
        processed++;
      }
      if(processed>=30)break;

    }
    return {statusCode:200,body:JSON.stringify({ok:true,processed,outcomes})};
  }catch(error){
    console.error("Vee-AI Gmail background scanner failed:",clean(error.message,240));
    return {statusCode:500,body:"Gmail background scan failed."};
  }finally{
    const current=await lockRef.once("value");
    if(current.val()&&current.val().claimId===claimId)await lockRef.remove();
  }
};
