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
  if (!value) throw new Error(name + " is not configured in Netlify.");
  return value;
}
function redirectUrl() { return env("GMAIL_REDIRECT_URI"); }
async function tokenRequest(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body:new URLSearchParams(params).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Google token exchange failed. Check the Gmail OAuth configuration.");
  return data;
}
async function refreshAccessToken(uid, db, saved) {
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
  await db.ref("gmailConnections/" + uid + "/tokenVault").set(encrypt(uid,next));
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
function collectText(payload, output) {
  if (!payload) return;
  if (payload.mimeType === "text/plain" && payload.body && payload.body.data) output.push(decodeBody(payload.body.data));
  (payload.parts || []).forEach(part => collectText(part,output));
}
function classifyEmail(email) {
  const text = (email.subject + " " + email.from + " " + email.snippet + " " + email.bodyText).toLowerCase();
  const categories = [];
  if (/bank|statement|transaction|credited|debited|transfer|withdrawal|deposit|balance alert|card payment|pos payment|account alert/.test(text)) categories.push("bank");
  if (/flight|boarding pass|itinerary|booking confirmation|airline|check-in|check in|departure|arrival|ticket number/.test(text)) categories.push("flight");
  if (/job application|application received|interview|recruiter|career opportunity|vacancy|employment|shortlisted|job offer/.test(text)) categories.push("job");
  if (/unsubscribe|promotion|newsletter|sale ends|marketing email/.test(text)) categories.push("promotions");
  if (!categories.length) categories.push("general");

  const urls = Array.from(new Set((email.bodyText + " " + email.snippet).match(/https?:\/\/[^\s<>"')]+/gi) || [])).slice(0,30);
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
  if (/urgent action|required immediately|account suspended|verify your password|confirm your bank|send your otp|one.time password|share your pin/i.test(text)) {
    suspicious.push({ url:"", reason:"Urgent credential or account-pressure language" });
  }
  if (suspicious.length) categories.push("security");
  return { categories:Array.from(new Set(categories)), linkCount:urls.length, securityFindings:suspicious.slice(0,12), riskLevel:suspicious.length >= 2 ? "high" : suspicious.length ? "review" : "none" };
}
async function syncMessages(uid, db, token) {
  const list = await gmailFetch(token.accessToken,"messages?maxResults=30");
  const messages = Array.isArray(list.messages) ? list.messages : [];
  const saved = [];
  for (const item of messages) {
    const message = await gmailFetch(token.accessToken,"messages/" + encodeURIComponent(item.id) + "?format=full");
    const payload = message.payload || {};
    const headers = payload.headers || [];
    const textParts = [];
    collectText(payload,textParts);
    const email = {
      id:String(message.id),
      threadId:String(message.threadId || ""),
      from:header(headers,"From").slice(0,300),
      subject:header(headers,"Subject").slice(0,300) || "(No subject)",
      date:header(headers,"Date").slice(0,120),
      internalDate:Number(message.internalDate || 0),
      snippet:String(message.snippet || "").slice(0,1000),
      bodyText:textParts.join("\n").replace(/<[^>]*>/g," ").replace(/\s+/g," ").slice(0,12000),
      unread:(message.labelIds || []).includes("UNREAD"),
      labels:(message.labelIds || []).filter(label => ["INBOX","UNREAD","IMPORTANT","STARRED","SPAM"].includes(label))
    };
    const analysis = classifyEmail(email);
    const record = {
      id:email.id, threadId:email.threadId, from:email.from, subject:email.subject,
      date:email.date, internalDate:email.internalDate, snippet:email.snippet,
      unread:email.unread, labels:email.labels, categories:analysis.categories,
      linkCount:analysis.linkCount, securityFindings:analysis.securityFindings,
      riskLevel:analysis.riskLevel, analysedAtMs:Date.now()
    };
    await db.ref("gmailConnections/" + uid + "/emails/" + email.id).set(record);
    saved.push(record);
  }
  await db.ref("gmailConnections/" + uid + "/status").update({
    connected:true, lastSyncAtMs:Date.now(), lastSyncCount:saved.length,
    securityAlertCount:saved.filter(item => item.riskLevel !== "none").length
  });
  return saved;
}
exports.handler = async event => {
  const method = event.httpMethod || "GET";
  const params = event.queryStringParameters || {};
  const db = firebase().database();
  try {
    if (method === "GET" && params.action === "callback") {
      const state = String(params.state || "");
      if (!/^[a-f0-9]{64}$/.test(state)) return { statusCode:400, body:"Invalid Gmail connection state." };
      if (params.error) return { statusCode:302, headers:{ Location:redirectUrl() + "?gmail=denied" }, body:"" };
      const stateRef = db.ref("gmailOAuthStates/" + state);
      const claim = await stateRef.transaction(current => {
        if (!current || Number(current.expiresAtMs || 0) < Date.now() || current.usedAtMs) return;
        return Object.assign({},current,{usedAtMs:Date.now()});
      });
      const stateRecord = claim.snapshot && claim.snapshot.val();
      if (!claim.committed || !stateRecord || !stateRecord.uid) return { statusCode:302, headers:{ Location:redirectUrl() + "?gmail=state_error" }, body:"" };
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
        const previous = await db.ref("gmailConnections/" + stateRecord.uid + "/tokenVault").once("value");
        if (previous.exists()) tokenData.refreshToken = decrypt(stateRecord.uid,previous.val()).refreshToken || "";
      }
      if (!tokenData.refreshToken) throw new Error("Google did not return offline access. Remove the app from Google Account connections and reconnect.");
      await db.ref("gmailConnections/" + stateRecord.uid).update({
        tokenVault:encrypt(stateRecord.uid,tokenData),
        status:{connected:true,gmailAddress:tokenData.gmailAddress,connectedAtMs:Date.now(),scope:"gmail.readonly"}
      });
      await stateRef.remove();
      return {statusCode:302,headers:{Location:redirectUrl()+"?gmail=connected"},body:""};
    }
    if (method !== "POST") return json(405,{error:"Method not allowed."});
    const user = await verifyUser(event);
    if (Buffer.byteLength(event.body || "","utf8") > 5000) return json(413,{error:"Request too large."});
    let body;
    try { body=JSON.parse(event.body || "{}"); } catch (_) { return json(400,{error:"Invalid JSON."}); }
    const root = db.ref("gmailConnections/" + user.uid);
    if (body.action === "connect") {
      const state = crypto.randomBytes(32).toString("hex");
      await db.ref("gmailOAuthStates/" + state).set({uid:user.uid,createdAtMs:Date.now(),expiresAtMs:Date.now()+10*60*1000});
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
      const status = snapshot.val() || {};
      return json(200,{connected:status.connected===true,gmailAddress:status.gmailAddress||"",lastSyncAtMs:status.lastSyncAtMs||null,lastSyncCount:status.lastSyncCount||0,securityAlertCount:status.securityAlertCount||0});
    }
    if (body.action === "disconnect") {
      await root.remove();
      return json(200,{success:true});
    }
    if (body.action === "sync") {
      const snapshot = await root.child("tokenVault").once("value");
      if (!snapshot.exists()) return json(400,{error:"Connect Gmail first."});
      const saved = decrypt(user.uid,snapshot.val());
      const fresh = await refreshAccessToken(user.uid,db,saved);
      const emails = await syncMessages(user.uid,db,fresh);
      return json(200,{success:true,synced:emails.length,securityAlerts:emails.filter(item=>item.riskLevel!=="none").length});
    }
    if (body.action === "list") {
      const snapshot = await root.child("emails").orderByChild("internalDate").limitToLast(100).once("value");
      const emails = Object.values(snapshot.val()||{}).sort((a,b)=>Number(b.internalDate||0)-Number(a.internalDate||0));
      return json(200,{emails});
    }
    return json(400,{error:"Unknown Gmail action."});
  } catch (error) {
    console.error("Vee-AI Gmail integration error:",error&&error.message||error);
    const message=error&&error.message?error.message:"Gmail request failed.";
    const status=/sign in|verify your Vee-AI email/i.test(message)?401:/not configured/i.test(message)?503:/expired|reconnect/i.test(message)?401:400;
    return json(status,{error:message});
  }
};
