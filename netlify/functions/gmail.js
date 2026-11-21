const admin = require("firebase-admin");
const crypto = require("crypto");

let app;
function firebase() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Firebase service account is not configured.");
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-gmail");
  }
  return app;
}
const json = (statusCode, body, extraHeaders) => ({
  statusCode,
  headers: Object.assign({ "Content-Type":"application/json", "Cache-Control":"no-store" }, extraHeaders || {}),
  body: JSON.stringify(body)
});
function encryptionKey() {
  const key = Buffer.from((process.env.GMAIL_TOKEN_ENCRYPTION_KEY || "").trim(), "base64");
  if (key.length !== 32) throw new Error("Gmail token encryption is not configured.");
  return key;
}
function encrypt(uid, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("vee-ai-gmail:v1:" + uid));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version:1, algorithm:"AES-256-GCM", iv:iv.toString("base64"), tag:cipher.getAuthTag().toString("base64"), ciphertext:ciphertext.toString("base64") };
}
function decrypt(uid, record) {
  if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM") throw new Error("Stored Gmail connection is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv,"base64"));
  decipher.setAAD(Buffer.from("vee-ai-gmail:v1:" + uid));
  decipher.setAuthTag(Buffer.from(record.tag,"base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext,"base64")),decipher.final()]).toString("utf8"));
}
async function verifyUser(event) {
  const headers = event.headers || {};
  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || headers.Authorization || "");
  if (!match) throw new Error("Sign in to Vee-AI before connecting Gmail.");
  const user = await firebase().auth().verifyIdToken(match[1], true);
  if (!user.email_verified) throw new Error("Verify your Vee-AI email before connecting Gmail.");
  return user;
}
function env(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    const context = String(process.env.CONTEXT || "unknown");
    const branch = String(process.env.BRANCH || "unknown");
    throw new Error(name + " is missing from this Netlify Function runtime (context: " + context + ", branch: " + branch + "). Check variable scopes for this deploy context and redeploy.");
  }
  return value;
}
function redirectUrl() { return env("GMAIL_REDIRECT_URI"); }
function appRedirectUrl() { return env("GMAIL_APP_REDIRECT_URL"); }
async function tokenRequest(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams(params).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Google token exchange failed. Check the Gmail OAuth configuration.");
  return data;
}
async function refreshAccessToken(uid, db, saved, accountId) {
  if (saved.accessToken && Number(saved.expiresAtMs || 0) > Date.now() + 60000) return saved;
  if (!saved.refreshToken) throw new Error("Gmail access expired. Disconnect Gmail and connect again.");
  const refreshed = await tokenRequest({
    client_id:env("GMAIL_CLIENT_ID"), client_secret:env("GMAIL_CLIENT_SECRET"),
    refresh_token:saved.refreshToken, grant_type:"refresh_token"
  });
  const next = Object.assign({}, saved, {
    accessToken:refreshed.access_token,
    expiresAtMs:Date.now() + Number(refreshed.expires_in || 3600) * 1000
  });
  await db.ref("gmailConnections/" + uid + (accountId==="legacy" ? "/tokenVault" : "/accounts/" + accountId + "/tokenVault")).set(encrypt(uid,next));
  return next;
}
async function gmailFetch(accessToken, path) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    headers:{ Authorization:"Bearer " + accessToken }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) throw new Error("Gmail access expired. Reconnect your Google account.");
    throw new Error("Gmail returned an error while reading messages.");
  }
  return data;
}
function header(headers, name) {
  const found = (headers || []).find(item => String(item.name || "").toLowerCase() === name.toLowerCase());
  return found ? String(found.value || "") : "";
}
function decodeBody(data) {
  if (!data) return "";
  try { return Buffer.from(String(data).replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"); }
  catch (_) { return ""; }
}
function decodeHtmlText(value) {
  return String(value||"")
    .replace(/<script\b[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[\s\S]*?<\/style>/gi," ")
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/td|\/th|\/h[1-6])\b[^>]*>/gi,"\n")
    .replace(/<[^>]*>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&#(\d+);/g,(_,n)=>{const cp=Number(n);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):" ";})
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>{const cp=parseInt(n,16);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):" ";})
    .replace(/\s+/g," ").trim();
}
function collectText(payload, plainOutput, htmlOutput) {
  if (!payload) return;
  if (payload.mimeType === "text/plain" && payload.body && payload.body.data) plainOutput.push(decodeBody(payload.body.data));
  if (payload.mimeType === "text/html" && payload.body && payload.body.data) htmlOutput.push(decodeHtmlText(decodeBody(payload.body.data)));
  (payload.parts || []).forEach(part => collectText(part,plainOutput,htmlOutput));
}
function transactionDateFromText(source,email,timeZone){
  const value=String(source||"");
  const iso=value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  const local=value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2}|\d{2})(?:[ ,]+(?:at\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i);
  let parts=null;
  if(iso)parts={year:Number(iso[1]),month:Number(iso[2]),day:Number(iso[3]),hour:Number(iso[4]||0),minute:Number(iso[5]||0),second:Number(iso[6]||0),ampm:iso[7]};
  else if(local)parts={year:Number(local[3].length===2?"20"+local[3]:local[3]),month:Number(local[2]),day:Number(local[1]),hour:Number(local[4]||0),minute:Number(local[5]||0),second:Number(local[6]||0),ampm:local[7]};
  if(parts&&parts.year>=2000&&parts.month>=1&&parts.month<=12&&parts.day>=1&&parts.day<=31){
    if(parts.ampm){const pm=String(parts.ampm).toUpperCase()==="PM";parts.hour=parts.hour%12+(pm?12:0);}
    if(parts.hour<=23&&parts.minute<=59&&parts.second<=59){
      const wallClock=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
      try{
        const zone=String(timeZone||"UTC");
        const fmt=new Intl.DateTimeFormat("en-GB",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
        const values={};fmt.formatToParts(new Date(wallClock)).forEach(part=>{if(part.type!=="literal")values[part.type]=Number(part.value);});
        const represented=Date.UTC(values.year,values.month-1,values.day,values.hour,values.minute,values.second);
        return wallClock-(represented-wallClock);
      }catch(_){return wallClock;}
    }
  }
  return Number(email.internalDate||Date.parse(email.date)||0)||null;
}
function extractTransaction(email, text, timeZone) {
  const body=String(email.bodyText||"");
  const source=(String(email.subject||"")+" "+String(email.snippet||"")+" "+body).replace(/\s+/g," ");
  const currencyCode=token=>{const v=String(token||"").toUpperCase();return /NGN|₦|NAIRA|^N$/.test(v)?"NGN":/USD|\$/.test(v)?"USD":/GBP|£/.test(v)?"GBP":/EUR|€/.test(v)?"EUR":null;};
  const patterns=[
    /(?:transaction amount|transfer amount|amount transferred|amount credited|amount debited|amount)\s*[:#=-]?\s*(NGN|₦|NAIRA|N|USD|\$|GBP|£|EUR|€)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:your transfer|transfer|transaction)\s+of\s+(NGN|₦|NAIRA|N|USD|\$|GBP|£|EUR|€)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:credited|debited|received|paid|sent|withdrawn)\s+(?:with|of|by)?\s*(NGN|₦|NAIRA|N|USD|\$|GBP|£|EUR|€)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:NGN|₦|NAIRA|N)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:NGN|₦)\b/i,
    /(?:USD|\$)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:GBP|£)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:EUR|€)\s*([\d,]+(?:\.\d{1,2})?)/i
  ];
  let amount=null,currency=null;
  for(const pattern of patterns){const m=source.match(pattern);if(!m)continue;const raw=m[2]||m[1],n=Number(String(raw).replace(/,/g,""));if(!Number.isFinite(n)||n<=0)continue;amount=n;currency=currencyCode(m[2]?m[1]:m[0]);break;}
  const balanceMatch=source.match(/(?:available balance|account balance|new balance|closing balance|balance)\s*(?:is|:|=|-)?\s*(NGN|₦|NAIRA|N|USD|\$|GBP|£|EUR|€)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const availableBalance=balanceMatch?Number(String(balanceMatch[2]).replace(/,/g,"")):null;
  const availableBalanceCurrency=balanceMatch?currencyCode(balanceMatch[1]||balanceMatch[0]):null;
  // Direction is decided from the action and the money's destination.
  // Bills, airtime, data, electricity and subscriptions are money-out events.
  const debitPattern=/\b(your transfer of|you transferred|you have transferred|you've transferred|you successfully transferred|successfully transferred|transfer to|sent to|you sent|you just sent|you have just sent|you've just sent|you have sent|you've sent|successfully sent|you just paid|money sent|amount sent|outgoing transfer|funds transferred to|your account (?:has been|was) debited|debited from your account|account debited|debit amount|debit alert|debit transaction|has left your|have left your|left your account|withdrawn|withdrawal|cash withdrawal|pos purchase|pos transaction|card purchase|card transaction|payment made|paid to|you paid|paid for|payment for|bill payment|bill paid|airtime purchase|airtime recharge|data purchase|data bundle purchase|internet bundle purchase|electricity token purchase|electricity bill payment|utility bill payment|subscription payment|tv subscription payment|dstv payment|gotv payment|startimes payment|top.?up|recharge card|you purchased|purchase of|spent)\b/i;
  const creditPattern=/\b(your account (?:has been|was) credited|credited to your account|account credited|you received|you have received|received from|money received|amount received|funds received|incoming transfer|transfer from|just sent you|sent you|has been sent to you|was sent to you|you received some money|credit amount|credit alert|deposit(?:ed)?|cash deposit|cashback received|refund(?:ed)?)\b/i;
  const billServicePattern=/\b(airtime|data|internet|electricity|utility|bill|subscription|dstv|gotv|startimes|school fees|water|gas|recharge|top.?up)\b/i;
  const billActionPattern=/\b(purchase|purchased|payment|paid|pay|recharge|bought|top.?up|successful|successfully|debited|deducted|transaction|token)\b/i;
  const billDebit=billServicePattern.test(source)&&billActionPattern.test(source);
  const debitLabel=/\b(debit amount|debit alert|debit transaction|account debited)\b/i;
  const creditLabel=/\b(credit amount|credit alert|credit transaction|account credited)\b/i;
  const outgoingAction=/\b(your transfer of|you just sent|you sent|you have sent|you've sent|sent to|transfer to|has left your|left your account|you just paid|you paid|paid to|paid for|bill payment|airtime purchase|airtime recharge|data purchase|data bundle purchase|electricity token purchase|electricity bill payment|utility bill payment|subscription payment|top.?up|recharge card|you purchased|purchase of|withdrawal|withdrawn|debited from your account)\b/i;
  const incomingAction=/\b(just sent you|sent you|you received|you have received|received from|money received|funds received|incoming transfer|transfer from|credited to your account|your account (?:has been|was) credited|has been sent to you|was sent to you|deposit(?:ed)?|cash deposit|cashback received|refund(?:ed)?)\b/i;
  const bodyText=body, snippetText=String(email.snippet||""), subjectText=String(email.subject||"");
  const bodyDebit=debitPattern.test(bodyText)||billDebit;
  const bodyCredit=creditPattern.test(bodyText);
  const snippetDebit=debitPattern.test(snippetText);
  const snippetCredit=creditPattern.test(snippetText);
  const subjectDebit=debitPattern.test(subjectText);
  const subjectCredit=creditPattern.test(subjectText);
  const allText=subjectText+" "+snippetText+" "+bodyText;
  const outgoingStrong=outgoingAction.test(allText)||billDebit;
  const incomingStrong=incomingAction.test(allText);
  const debitScore=(outgoingStrong?7:0)+(debitLabel.test(allText)?3:0)+(subjectDebit?1:0);
  const creditScore=(incomingStrong?7:0)+(creditLabel.test(allText)?3:0)+(subjectCredit?1:0);
  let hasTransactionLanguage=debitScore>0||creditScore>0||bodyDebit||bodyCredit||snippetDebit||snippetCredit;
  let direction=null,directionEvidence="",directionConflict=false;
  if(debitScore>creditScore){
    direction="out";
    directionEvidence=billDebit?"Bill or service payment wording":outgoingStrong?"Outgoing payment or transfer wording": "Debit bank label";
  }else if(creditScore>debitScore){
    direction="in";
    directionEvidence=incomingStrong?"Incoming payment or transfer wording":"Credit bank label";
  }else if(debitScore>0&&creditScore>0){
    directionConflict=true;
    directionEvidence="Conflicting incoming and outgoing transaction evidence";
  }
  const explicitBodyDebit=bodyDebit&&!bodyCredit;
  const explicitBodyCredit=bodyCredit&&!bodyDebit;
  const transactionStatus=/\b(failed|unsuccessful|declined|not successful|could not be completed)\b/i.test(source)?"failed":/\b(reversed|reversal)\b/i.test(source)?"reversed":/\b(refunded|refund)\b/i.test(source)?"refunded":/\b(pending|processing|awaiting confirmation)\b/i.test(source)?"pending":hasTransactionLanguage?"successful":"unknown";
  if(transactionStatus==="reversed"){if(/\b(?:debit|debited)\b.{0,35}\b(?:reversed|reversal)\b|\b(?:reversed|reversal)\b.{0,35}\b(?:debit|debited)\b/i.test(source))direction="in";else if(/\b(?:credit|credited)\b.{0,35}\b(?:reversed|reversal)\b|\b(?:reversed|reversal)\b.{0,35}\b(?:credit|credited)\b/i.test(source))direction="out";else direction=null;}
  const partyMatch=source.match(/\b(?:sender(?: name)?|sender's name|from|beneficiary(?: name)?|beneficiary|recipient(?: name)?|receiver(?: name)?|account name)\s*[:#-]?\s*([A-Z][A-Z .\x27-]{2,60}?)(?=\s+(?:account|acct|narration|description|remark|amount|date|time|reference|ref|available balance|bank|balance)\b|[,.;]|$)/i)
    ||source.match(/\b(?:to|recipient|beneficiary)\s*:\s*([A-Z][A-Z .\x27-]{2,60}?)(?=\s+(?:account|acct|narration|description|remark|amount|date|time|reference|ref|available balance|bank|balance)\b|[,.;]|$)/i)
    ||source.match(/\b(?:transfer to|sent to|paid to|beneficiary)\s+([A-Z][A-Z .\x27-]{2,60}?)(?=\s+(?:account|acct|narration|description|remark|amount|date|time|reference|ref|available balance|bank|balance)\b|[,.;]|$)/i)
    ||source.match(/\b(?:received from|transfer from)\s+([A-Z][A-Z .\x27-]{2,60}?)(?=\s+(?:account|acct|narration|description|remark|amount|date|time|reference|ref|available balance|bank|balance)\b|[,.;]|$)/i);
  const narrationMatch=source.match(/\b(?:narration|description|remarks?|payment details|transfer details|purpose|transaction details|remark)\s*[:#-]\s*(.{2,180}?)(?=\s+(?:available balance|transaction reference|reference|session id|account number|account no|date|time|beneficiary|recipient|sender|amount)\s*[:#-]|$)/i);
  const counterparty=partyMatch?partyMatch[1].trim().slice(0,100):"",narration=narrationMatch?narrationMatch[1].trim().slice(0,180):"";
  const reference=(source.match(/\b(?:transaction|trans(?:action)?|session|reference|ref)(?:\s*(?:id|no|number))?\s*[:#-]?\s*([A-Z0-9-]{6,})/i)||[])[1]||"";
  return {amount,currency,direction,directionTag:direction==="in"?"CREDIT":direction==="out"?"DEBIT":"REVIEW",directionEvidence,availableBalance:Number.isFinite(availableBalance)&&availableBalance>0?availableBalance:null,availableBalanceCurrency,transactionType:/\b(refund|refunded)\b/i.test(source)?"refund":direction==="in"?"income":direction==="out"?"expense":null,transactionStatus,counterparty,narration,transactionAtMs:transactionDateFromText(source,email,timeZone),reference:reference.slice(0,80),hasTransactionLanguage,ambiguousDirection:directionConflict};
}
function extractFlightDetails(email) {
  const source = email.subject + " " + email.snippet + " " + email.bodyText;
  const flightNumber = (source.match(/\b([A-Z]{1,3}\s?\d{1,4})\b/) || [])[1] || "";
  const bookingReference = (source.match(/\b(?:booking reference|booking ref|pnr|record locator|reservation code)\s*[:#-]?\s*([A-Z0-9]{5,8})\b/i) || [])[1] || "";
  const route = (source.match(/\b([A-Z]{3})\s*(?:to|→|-)\s*([A-Z]{3})\b/i) || []);
  const date = (source.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/) || [])[0] || "";
  return {
    airline:(email.from.match(/([^<,]+?)(?:\s*<|$)/) || [])[1] || "",
    flightNumber:flightNumber.replace(/\s+/g," ").trim(),
    origin:route[1] || "",
    destination:route[2] || "",
    travelDate:date,
    bookingReference:bookingReference
  };
}
function identifyBank(email) {
  const from=String(email.from||"").toLowerCase();
  const subject=String(email.subject||"").toLowerCase();
  const body=String(email.bodyText||"").slice(0,5000).toLowerCase();
  const source=from+" "+subject+" "+body;
  const banks=[
    ["First Bank",/firstbank|first bank|firstbanknigeria/],
    ["Kuda",/kuda\.com|kuda bank|kuda/],
    ["OPay",/opay|o-?pay/],
    ["PalmPay",/palmpay|palm pay/],
    ["Moniepoint",/moniepoint/],
    ["Access Bank",/accessbank|access bank/],
    ["GTBank",/gtbank|guaranty trust|gt\s*bank/],
    ["UBA",/ubagroup|united bank for africa|\buba\b/],
    ["Zenith Bank",/zenithbank|zenith bank/],
    ["Wema Bank",/wemabank|wema bank/],
    ["Sterling Bank",/sterlingbank|sterling bank/],
    ["Fidelity Bank",/fidelitybank|fidelity bank/],
    ["FCMB",/fcmb|first city monument/],
    ["Union Bank",/unionbank|union bank/],
    ["Stanbic IBTC",/stanbic|ibtc/],
    ["Polaris Bank",/polarisbank|polaris bank/],
    ["Ecobank",/ecobank|eco bank/],
    ["Jaiz Bank",/jaizbank|jaiz bank/],
    ["Providus Bank",/providus/],
    ["Citibank",/citibank|citi bank/]
  ];
  const matches=banks.filter(entry=>entry[1].test(from+" "+subject));
  if(matches.length===1)return {name:matches[0][0],confidence:"high"};
  if(matches.length>1)return {name:"Multiple bank names detected",confidence:"review"};
  const bodyMatches=banks.filter(entry=>entry[1].test(body));
  if(bodyMatches.length===1)return {name:bodyMatches[0][0],confidence:"medium"};
  return {name:"Bank not identified",confidence:"review"};
}
function classifyEmail(email,timeZone) {
  const subject = String(email.subject || "");
  const from = String(email.from || "");
  const body = String(email.bodyText || "");
  const snippet = String(email.snippet || "");
  const text = (subject + " " + from + " " + snippet + " " + body).toLowerCase();
  const categories = [];
  const evidence = [];
  const transaction = extractTransaction(email,text,timeZone);
  const bank = identifyBank(email);
  if(transaction.amount && !transaction.currency){
    if(transaction.availableBalanceCurrency) transaction.currency=transaction.availableBalanceCurrency;
    else if(bank.name!=="Bank not identified" && bank.name!=="Multiple bank names detected") transaction.currency="NGN";
  }
  const senderAddress = (from.match(/<([^>]+)>/) || [])[1] || from;
  const senderDomain = (senderAddress.split("@").pop() || "").replace(/[>]/g,"").toLowerCase();
  const knownBankNames = /\b(access bank|first bank|gtbank|guaranty trust|uba|united bank for africa|zenith bank|moniepoint|opay|palmpay|kuda|wema|sterling bank|fidelity bank|fcmb|union bank|providus|stanbic|polaris bank|ecobank|jaiz bank|citibank|chase|barclays|hsbc|natwest|lloyds|revolut|wise)\b/i;
  const senderLooksFinancial = knownBankNames.test(from) || /\b(bank|banking|alerts?|transaction|payments?)\b/i.test(senderDomain);
  const transactionSubject = /\b(debit|credit|transaction|transfer|withdrawal|deposit|payment|pos alert|card alert|account alert|statement|bill|airtime|recharge|data bundle|electricity|utility|subscription|dstv|gotv|startimes)\b/i.test(subject);
  const billPaymentEvidence = /\b(airtime|data|internet|electricity|utility|bill|subscription|dstv|gotv|startimes|school fees|water|gas|recharge|top.?up)\b/i.test(subject+" "+snippet+" "+body) && /\b(purchase|purchased|payment|paid|pay|recharge|bought|top.?up|successful|successfully|debited|deducted|transaction|token)\b/i.test(subject+" "+snippet+" "+body);
  const strongTransaction = transaction.hasTransactionLanguage && transaction.amount !== null && !!transaction.direction;
  const financialContext = (senderLooksFinancial && transactionSubject) || strongTransaction || billPaymentEvidence;
  if ((email.labels || []).includes("SPAM")) {
    categories.push("spam");
    evidence.push("Gmail marked this message as spam");
  }
  if (strongTransaction && financialContext) {
    categories.push("bank");
    evidence.push("Financial sender/context, transaction amount and clear money-in or money-out wording");
  } else if (senderLooksFinancial && transactionSubject) {
    categories.push("bank");
    evidence.push("Financial sender and transaction-related subject, but transaction details need review");
  }

  const flightSender = /\b(airline|airways|aviation|travel|booking|trip|flight)\b/i.test(from);
  const flightSubject = /\b(e-ticket|e ticket|flight booking|booking confirmation|itinerary|boarding pass|flight change|flight cancelled|flight cancellation|check.?in|flight schedule)\b/i.test(subject);
  const flightEvidence = /\b(flight number|flight no\.?|departure|arrival|boarding pass|e-ticket|booking reference|pnr|terminal|gate)\b/i.test(body + " " + snippet);
  if ((flightSubject && (flightSender || flightEvidence)) || (flightSender && flightEvidence && /\b(confirmed|ticketed|booked|cancelled|rescheduled|delayed)\b/i.test(text))) {
    categories.push("flight");
    evidence.push("Flight-specific booking or travel details found");
  }

  const jobSubject = /\b(application received|job application|interview invitation|interview scheduled|assessment invitation|job offer|offer letter|application update|application status|recruitment process)\b/i.test(subject);
  const jobContext = /\b(position|role|vacancy|recruitment|recruiter|hiring team|interview|shortlisted|employment offer|job application|career portal)\b/i.test(text);
  if (jobSubject && jobContext) {
    categories.push("job");
    evidence.push("Job-related subject and recruitment context found");
  } else if (/\b(job alert|new jobs for you|career newsletter)\b/i.test(subject)) {
    categories.push("job");
    evidence.push("Job-alert or career-news subject found");
  }

  if (/\b(unsubscribe|newsletter|sale ends|special offer|limited time offer|promotional offer)\b/i.test(text) && !categories.includes("bank") && !categories.includes("flight") && !categories.includes("job")) {
    categories.push("promotions");
    evidence.push("Marketing or newsletter indicators found");
  }

  const urls = Array.from(new Set((body + " " + snippet).match(/https?:\/\/[^\s<>"')]+/gi) || [])).slice(0,30);
  const suspicious = [];
  const riskyHosts = ["bit.ly","tinyurl.com","t.co","cutt.ly","is.gd","rb.gy","ow.ly"];
  for (const value of urls) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (riskyHosts.includes(host)) suspicious.push({ url:value.slice(0,500), reason:"URL shortener hides the final destination" });
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) suspicious.push({ url:value.slice(0,500), reason:"Link uses a raw IP address" });
      if (host.startsWith("xn--") || host.split(".").some(part => part.startsWith("xn--"))) suspicious.push({ url:value.slice(0,500), reason:"Internationalised domain name requires extra scrutiny" });
      if (/login|verify|password|wallet|secure|account|bank/i.test(parsed.pathname) && /urgent|suspend|locked|verify|password|bank/i.test(text)) suspicious.push({ url:value.slice(0,500), reason:"Account-verification language combined with a login-related link" });
    } catch (_) { suspicious.push({ url:value.slice(0,500), reason:"Malformed link" }); }
  }
  if (/\b(urgent action|required immediately|account suspended|verify your password|confirm your bank|send your otp|one.time password|share your pin|send your password)\b/i.test(text)) {
    suspicious.push({ url:"", reason:"Urgent credential or account-pressure language" });
  }
  if (suspicious.length) {
    categories.push("security");
    evidence.push("Suspicious link or credential-pressure indicators found");
  }
  if (!categories.length) categories.push("general");
  const needsReview = categories.includes("bank") && (!transaction.amount || !transaction.currency || !transaction.direction || transaction.ambiguousDirection);
  return {
    categories:Array.from(new Set(categories)),
    linkCount:urls.length,
    securityFindings:suspicious.slice(0,12),
    riskLevel:suspicious.length >= 2 ? "high" : suspicious.length ? "review" : "none",
    evidence:evidence.slice(0,8),
    transaction:categories.includes("bank") ? transaction : null,
    bank:categories.includes("bank") ? bank : null,
    classificationConfidence:categories.includes("bank") ? (strongTransaction && financialContext ? "high" : "review") : categories.includes("flight") || categories.includes("job") ? "medium" : "low",
    needsReview
  };
}
async function syncMessages(uid, db, token, accountId, afterMs, scanMode, timeZone) {
  const { analyzeFinancialEmails, toTransaction } = require("./grok-finance");
  const query = Number(afterMs) > 0 ? "messages?maxResults=100&includeSpamTrash=true&q=" + encodeURIComponent("after:" + Math.max(0,Math.floor(Number(afterMs)/1000))) : "messages?maxResults=100&includeSpamTrash=true";
  const list = await gmailFetch(token.accessToken,query);
  const messages = Array.isArray(list.messages) ? list.messages : [];
  const parsedEmails = [];

  for (let offset=0; offset<messages.length; offset+=10) {
    const batch = await Promise.all(messages.slice(offset,offset+10).map(async item => {
      const message = await gmailFetch(token.accessToken,"messages/" + encodeURIComponent(item.id) + "?format=full");
      if ((message.labelIds || []).includes("TRASH")) return null;
      const payload = message.payload || {};
      const headers = payload.headers || [];
      const textParts = [], htmlParts = [];
      collectText(payload,textParts,htmlParts);
      return {
        id:String(message.id),
        threadId:String(message.threadId || ""),
        from:header(headers,"From").slice(0,300),
        subject:header(headers,"Subject").slice(0,300) || "(No subject)",
        date:header(headers,"Date").slice(0,120),
        internalDate:Number(message.internalDate || 0),
        snippet:String(message.snippet || "").slice(0,1000),
        bodyText:(textParts.length?textParts:htmlParts).join("\n").replace(/\s+/g," ").slice(0,12000),
        unread:(message.labelIds || []).includes("UNREAD"),
        labels:(message.labelIds || []).filter(label => ["INBOX","UNREAD","IMPORTANT","STARRED","SPAM"].includes(label))
      };
    }));
    parsedEmails.push(...batch.filter(Boolean));
  }

  // Groq is the sole authority for financial classification. Existing rule-based
  // categories remain available for flights, jobs, promotions and security.
  const aiResults = await analyzeFinancialEmails(parsedEmails);
  const saved = [];
  for (const email of parsedEmails) {
    const base = classifyEmail(email,timeZone);
    const categories = (base.categories || []).filter(category => category !== "bank");
    const ai = aiResults.get(email.id) || null;
    const transaction = toTransaction(email,ai,timeZone);
    const isFinancial = !!transaction && ai && ai.classification !== "non_financial";
    const needsReview = isFinancial ? !!transaction.needsReview : false;
    const providerName = ai && ai.provider ? String(ai.provider).slice(0,100) : "";
    const identifiedBank = identifyBank(email);
    if (isFinancial) categories.push("bank");
    if (!categories.length) categories.push("general");

    const record = {
      id:email.id, threadId:email.threadId, from:email.from, subject:email.subject,
      date:email.date, internalDate:email.internalDate, snippet:email.snippet,
      unread:email.unread, labels:email.labels, categories:Array.from(new Set(categories)),
      linkCount:base.linkCount, securityFindings:base.securityFindings,
      riskLevel:base.riskLevel, evidence:isFinancial ? [cleanGrokEvidence(ai)] : base.evidence,
      transaction:isFinancial ? transaction : null,
      bank:isFinancial ? {name:providerName || identifiedBank.name,confidence:providerName?"ai_extracted":identifiedBank.confidence} : null,
      classificationConfidence:isFinancial ? transaction.aiConfidence : categories.includes("flight") || categories.includes("job") ? "medium" : "low",
      needsReview,
      analysisEngine:isFinancial ? "groq" : "vee_ai_general",
      analysisStatus:ai ? "analysed" : "not_financial_candidate",
      flightDetails:categories.includes("flight") ? extractFlightDetails(email) : null,
      analysedAtMs:Date.now()
    };

    if (scanMode === "financial_only" && !record.categories.includes("bank")) continue;
    await db.ref("gmailConnections/" + uid + (accountId==="legacy" ? "/emails/" : "/accounts/" + accountId + "/emails/") + record.id).set(record);
    saved.push(record);
  }

  await db.ref("gmailConnections/" + uid + (accountId==="legacy" ? "/status" : "/accounts/" + accountId + "/status")).update({
    connected:true, lastSyncAtMs:Date.now(), lastSyncCount:saved.length,
    securityAlertCount:saved.filter(item => item.riskLevel !== "none").length,
    lastAiEngine:"groq", lastAiAnalysisAtMs:Date.now()
  });
  return saved;
}

function cleanGrokEvidence(ai) {
  return String(ai && ai.evidence || "Groq classified this email using its transaction context.").replace(/\s+/g," ").slice(0,300);
}
exports.runScheduledScan = async (db, uid, accountId) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(accountId || ""))) throw new Error("Invalid mailbox reference.");
  const target = accountId==="legacy"
    ? db.ref("gmailConnections/" + uid)
    : db.ref("gmailConnections/" + uid + "/accounts/" + accountId);
  const tokenSnapshot = await target.child("tokenVault").once("value");
  if (!tokenSnapshot.exists()) return { skipped:true, reason:"missing_token" };
  const saved = decrypt(uid, tokenSnapshot.val());
  const statusSnapshot = await target.child("status").once("value");
  const previousSyncAtMs = Number((statusSnapshot.val() || {}).lastSyncAtMs || 0);
  const fresh = await refreshAccessToken(uid, db, saved, accountId);
  const settingsSnapshot = await db.ref("users/" + uid + "/emailIntelligenceSettings").once("value");
  const settings = settingsSnapshot.val() || {};
  const emails = await syncMessages(uid, db, fresh, accountId, previousSyncAtMs ? previousSyncAtMs - 10 * 60 * 1000 : 0, settings.scanMode || "all_inbox", "Africa/Lagos");
  return { accountId, gmailAddress:fresh.gmailAddress||"", synced:emails.length, securityAlerts:emails.filter(item=>item.riskLevel!=="none").length };
};

exports.handler = async event => {
  const method = event.httpMethod || "GET";
  const params = event.queryStringParameters || {};
  const db = firebase().database();
  try {
    if (method === "GET") {
      const state = String(params.state || "");
      if (!/^[a-f0-9]{64}$/.test(state)) return { statusCode:400, body:"Invalid Gmail connection state." };
      if (params.error) return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=denied" }, body:"" };
      const stateRef = db.ref("gmailOAuthStates/" + state);
      const beforeClaim = await stateRef.once("value");
      const existingState = beforeClaim.val();
      if (!existingState) {
        console.error("Vee-AI Gmail OAuth state check: state_missing");
        return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=state_missing" }, body:"" };
      }
      if (Number(existingState.expiresAtMs || 0) < Date.now()) {
        console.error("Vee-AI Gmail OAuth state check: state_expired");
        await stateRef.remove();
        return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=state_expired" }, body:"" };
      }
      if (existingState.usedAtMs) {
        console.error("Vee-AI Gmail OAuth state check: state_already_used");
        return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=state_used" }, body:"" };
      }
      const claimAtMs = Date.now();
      const claim = await stateRef.child("usedAtMs").transaction(current => {
        if (current !== null && typeof current !== "undefined") return;
        return claimAtMs;
      }, undefined, false);
      if (!claim.committed || !claim.snapshot || !claim.snapshot.exists()) {
        console.error("Vee-AI Gmail OAuth state check: transaction_not_committed", JSON.stringify({committed:claim.committed,hasSnapshot:!!claim.snapshot,hasValue:!!(claim.snapshot&&claim.snapshot.exists())}));
        return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=state_claim_failed" }, body:"" };
      }
      const claimedState = await stateRef.once("value");
      const stateRecord = claimedState.val();
      if (!stateRecord || !stateRecord.uid || Number(stateRecord.expiresAtMs || 0) < Date.now()) {
        console.error("Vee-AI Gmail OAuth state check: claimed_record_invalid", JSON.stringify({hasRecord:!!stateRecord,hasUid:!!(stateRecord&&stateRecord.uid),notExpired:!!(stateRecord&&Number(stateRecord.expiresAtMs||0)>=Date.now())}));
        return { statusCode:302, headers:{ Location:appRedirectUrl() + "?gmail=state_claim_failed" }, body:"" };
      }
      const tokens = await tokenRequest({
        code:String(params.code || ""), client_id:env("GMAIL_CLIENT_ID"),
        client_secret:env("GMAIL_CLIENT_SECRET"), redirect_uri:redirectUrl(),
        grant_type:"authorization_code"
      });
      const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",{headers:{Authorization:"Bearer "+tokens.access_token}});
      const profile = await profileResponse.json().catch(()=>({}));
      if (!profileResponse.ok || !profile.emailAddress) throw new Error("Google did not return a Gmail address.");
      const tokenData = {
        accessToken:tokens.access_token, refreshToken:tokens.refresh_token || "",
        expiresAtMs:Date.now()+Number(tokens.expires_in || 3600)*1000,
        scope:String(tokens.scope || ""), tokenType:String(tokens.token_type || "Bearer"),
        gmailAddress:String(profile.emailAddress).slice(0,254)
      };
      if (!tokenData.refreshToken) {
        const userRoot=db.ref("gmailConnections/"+stateRecord.uid);
        const previous=await userRoot.child("tokenVault").once("value");
        if(previous.exists())tokenData.refreshToken=decrypt(stateRecord.uid,previous.val()).refreshToken||"";
        if(!tokenData.refreshToken){
          const accountsSnapshot=await userRoot.child("accounts").once("value");
          const previousAccount=Object.values(accountsSnapshot.val()||{}).find(item=>item&&item.status&&String(item.status.gmailAddress||"").toLowerCase()===tokenData.gmailAddress.toLowerCase()&&item.tokenVault);
          if(previousAccount)tokenData.refreshToken=decrypt(stateRecord.uid,previousAccount.tokenVault).refreshToken||"";
        }
      }
      if (!tokenData.refreshToken) throw new Error("Google did not return offline access. Remove the app from Google Account connections and reconnect.");
      const proposedAccountId = /^[a-zA-Z0-9_-]{1,80}$/.test(String(stateRecord.accountId || "")) ? stateRecord.accountId : "mail_" + crypto.randomBytes(12).toString("hex");
      const userConnections = db.ref("gmailConnections/" + stateRecord.uid);
      const [existingAccounts,legacyStatusSnapshot] = await Promise.all([userConnections.child("accounts").once("value"),userConnections.child("status").once("value")]);
      const existingMatch = Object.entries(existingAccounts.val() || {}).find(([,item]) => item && item.status && String(item.status.gmailAddress||"").toLowerCase() === tokenData.gmailAddress.toLowerCase());
      const legacyStatus = legacyStatusSnapshot.val() || {};
      const accountId = existingMatch ? existingMatch[0] : String(legacyStatus.gmailAddress||"").toLowerCase() === tokenData.gmailAddress.toLowerCase() ? "legacy" : proposedAccountId;
      const accountRoot = accountId === "legacy" ? userConnections : userConnections.child("accounts/" + accountId);
      await accountRoot.update({tokenVault:encrypt(stateRecord.uid,tokenData),status:{connected:true,accountId,gmailAddress:tokenData.gmailAddress,connectedAtMs:Date.now(),scope:"gmail.readonly"}});
      await stateRef.remove();
      return {statusCode:302,headers:{Location:appRedirectUrl()+"?gmail=connected"},body:""};
    }
    if (method !== "POST") return json(405,{error:"Method not allowed."});
    const user = await verifyUser(event);
    if (Buffer.byteLength(event.body || "","utf8") > 5000) return json(413,{error:"Request too large."});
    let body;
    try { body=JSON.parse(event.body || "{}"); } catch (_) { return json(400,{error:"Invalid JSON."}); }
    const root = db.ref("gmailConnections/" + user.uid);
    const accountId = String(body.accountId || "").trim();
    if (accountId && !/^[a-zA-Z0-9_-]{1,80}$/.test(accountId)) return json(400,{error:"Invalid email account reference."});
    if (body.action === "connect") {
      const accountId = "mail_" + crypto.randomBytes(12).toString("hex");
      const state = crypto.randomBytes(32).toString("hex");
      await db.ref("gmailOAuthStates/" + state).set({uid:user.uid,accountId,createdAtMs:Date.now(),expiresAtMs:Date.now()+10*60*1000});
      const savedState = await db.ref("gmailOAuthStates/" + state).once("value");
      if (!savedState.exists()) throw new Error("Gmail OAuth state could not be saved to Firebase. Check Firebase Admin database access.");
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id",env("GMAIL_CLIENT_ID"));
      url.searchParams.set("redirect_uri",redirectUrl());
      url.searchParams.set("response_type","code");
      url.searchParams.set("scope","https://www.googleapis.com/auth/gmail.readonly");
      url.searchParams.set("access_type","offline");
      url.searchParams.set("prompt","consent");
      url.searchParams.set("include_granted_scopes","true");
      url.searchParams.set("state",state);
      return json(200,{authorizationUrl:url.toString()});
    }
    if (body.action === "status") {
      const snapshot = await root.child("status").once("value");
      const legacyStatus = snapshot.val() || {};
      const accountsSnapshot = await root.child("accounts").once("value");
      const accounts = Object.entries(accountsSnapshot.val() || {}).map(([id,record]) => {const status=record&&record.status||{};return {accountId:id,connected:status.connected===true,gmailAddress:status.gmailAddress||"",connectedAtMs:status.connectedAtMs||null,lastSyncAtMs:status.lastSyncAtMs||null,lastSyncCount:status.lastSyncCount||0,securityAlertCount:status.securityAlertCount||0};});
      if(legacyStatus.connected===true)accounts.unshift({accountId:"legacy",connected:true,gmailAddress:legacyStatus.gmailAddress||"",connectedAtMs:legacyStatus.connectedAtMs||null,lastSyncAtMs:legacyStatus.lastSyncAtMs||null,lastSyncCount:legacyStatus.lastSyncCount||0,securityAlertCount:legacyStatus.securityAlertCount||0,legacy:true});
      const status = legacyStatus;
      const selectedAccountId = accountId || (accounts[0] && accounts[0].accountId) || "";
      let recentEmails = [];
      if (selectedAccountId) {
        const selectedRoot = selectedAccountId === "legacy" ? root : root.child("accounts/" + selectedAccountId);
        const recentSnapshot = await selectedRoot.child("emails").orderByChild("internalDate").limitToLast(100).once("value");
        recentEmails = Object.values(recentSnapshot.val() || {}).sort((a,b)=>Number(b.internalDate||0)-Number(a.internalDate||0)).map(item=>Object.assign({accountId:selectedAccountId},item));
      }
      return json(200,{approved:true,connected:accounts.some(item=>item.connected),gmailAddress:accounts.length===1?accounts[0].gmailAddress:"",accounts,selectedAccountId,recentEmails,lastSyncAtMs:status.lastSyncAtMs||null,lastSyncCount:status.lastSyncCount||0,securityAlertCount:status.securityAlertCount||0});
    }
    if (body.action === "disconnect") {
      if (!accountId) return json(400,{error:"Choose an email account to disconnect."});
      if (accountId==="legacy") await Promise.all([root.child("tokenVault").remove(),root.child("status").remove(),root.child("emails").remove()]); else await root.child("accounts/"+accountId).remove();
      return json(200,{success:true,accountId});
    }
    if (body.action === "sync" || body.action === "list") {
      if (!accountId) return json(400,{error:"Choose an email account first."});
      const target = accountId==="legacy" ? root : root.child("accounts/"+accountId);
      if (body.action === "sync") {
        const tokenSnapshot=await target.child("tokenVault").once("value");
        if(!tokenSnapshot.exists())return json(400,{error:"This email account is not connected."});
        const saved=decrypt(user.uid,tokenSnapshot.val());
        const fresh=await refreshAccessToken(user.uid,db,saved,accountId);
        const settingsSnapshot=await db.ref("users/"+user.uid+"/emailIntelligenceSettings").once("value");
        const settings=settingsSnapshot.val()||{};
        const emails=await syncMessages(user.uid,db,fresh,accountId,0,settings.scanMode||"all_inbox","Africa/Lagos");
        await target.child("status").update({connected:true,accountId,gmailAddress:fresh.gmailAddress||"",lastSyncAtMs:Date.now(),lastSyncCount:emails.length,securityAlertCount:emails.filter(item=>item.riskLevel!=="none").length});
        return json(200,{success:true,accountId,synced:emails.length,securityAlerts:emails.filter(item=>item.riskLevel!=="none").length});
      }
      const snapshot=await target.child("emails").orderByChild("internalDate").limitToLast(100).once("value");
      const emails=Object.values(snapshot.val()||{}).sort((a,b)=>Number(b.internalDate||0)-Number(a.internalDate||0)).map(item=>Object.assign({accountId},item));
      return json(200,{accountId,emails});
    }
    return json(400,{error:"Unknown Gmail action."});
  } catch (error) {
    console.error("Vee-AI Gmail integration error:",error&&error.message||error);
    const message=error&&error.message?error.message:"Gmail request failed.";
    const status=/sign in|verify your Vee-AI email/i.test(message)?401:/not configured/i.test(message)?503:/expired|reconnect/i.test(message)?401:400;
    return json(status,{error:message});
  }
};
