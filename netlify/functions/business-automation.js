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
    }, "vee-ai-business-automation");
  }
  return app;
}
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});
function encryptionKey() {
  const value = (process.env.BUSINESS_AUTOMATION_ENCRYPTION_KEY || "").trim();
  if (!value) throw new Error("Background encryption is not configured. Add BUSINESS_AUTOMATION_ENCRYPTION_KEY in Netlify.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("BUSINESS_AUTOMATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}
async function verifyUser(event) {
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new Error("Sign in again to continue.");
  const decoded = await firebase().auth().verifyIdToken(match[1], true);
  if (!decoded.email_verified) throw new Error("Verify your email before enabling background processing.");
  return decoded;
}
function encryptProfile(uid, profile) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("vee-ai-business-automation:v1:" + uid));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(profile), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    updatedAtMs: Date.now()
  };
}
function decryptProfile(uid, record) {
  if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM") throw new Error("Saved business profile format is not recognised.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("vee-ai-business-automation:v1:" + uid));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Business profile is missing.");
  const allowed = {
    businessName: 120, businessIndustry: 120, businessModel: 2000,
    businessProducts: 3000, businessCustomers: 2000, businessLocation: 500,
    businessOffers: 2000, businessDifference: 2000, businessVoice: 100,
    businessGoals: 2000, businessPlatforms: 1500, businessCompetitors: 1500,
    businessExtra: 2000, businessDocumentsText: 50000
  };
  const clean = {};
  for (const [field, max] of Object.entries(allowed)) {
    const value = input[field] === undefined ? "" : input[field];
    if (typeof value !== "string" || value.length > max) throw new Error("Invalid business profile field: " + field);
    clean[field] = value.trim();
  }
  if (!clean.businessName || !clean.businessProducts || !clean.businessCustomers) {
    throw new Error("Business name, products or services, and target customers are required.");
  }
  if (Buffer.byteLength(JSON.stringify(clean), "utf8") > 60000) throw new Error("Business profile exceeds the allowed size.");
  return clean;
}
async function enforceUserRateLimit(db, uid) {
  const ref = db.ref("privateBusinessAutomationRate/" + uid);
  const now = Date.now();
  const result = await ref.transaction(current => {
    const record = current || { windowStartedAtMs: now, count: 0 };
    const fresh = now - Number(record.windowStartedAtMs || 0) >= 10 * 60 * 1000;
    const next = fresh ? { windowStartedAtMs: now, count: 1 } : { windowStartedAtMs: record.windowStartedAtMs, count: Number(record.count || 0) + 1 };
    if (next.count > 10) return;
    return next;
  });
  if (!result.committed) throw new Error("Too many background processing changes. Try again in 10 minutes.");
}
function safeText(value, max) {
  return String(value || "").replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, max);
}
async function createTestDraft(profile, recentIdeas) {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("Groq is not configured in Netlify.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);
  try {
    const context = {
      businessName: safeText(profile.businessName,120),
      businessIndustry: safeText(profile.businessIndustry,120),
      businessModel: safeText(profile.businessModel,1200),
      businessProducts: safeText(profile.businessProducts,2200),
      businessCustomers: safeText(profile.businessCustomers,1200),
      businessLocation: safeText(profile.businessLocation,300),
      businessOffers: safeText(profile.businessOffers,1200),
      businessDifference: safeText(profile.businessDifference,1200),
      businessVoice: safeText(profile.businessVoice,100),
      businessGoals: safeText(profile.businessGoals,1200),
      businessPlatforms: safeText(profile.businessPlatforms,1000),
      businessCompetitors: safeText(profile.businessCompetitors,1000),
      businessExtra: safeText(profile.businessExtra,1500)
    };
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST", signal:controller.signal,
      headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},
      body:JSON.stringify({model:(process.env.GROQ_MODEL||"openai/gpt-oss-20b").trim(),temperature:0.85,max_tokens:1400,response_format:{type:"json_object"},messages:[
        {role:"system",content:"You are Vee-AI, a practical business content strategist. Create one accurate short-form video idea using only explicit facts in the supplied profile. Never invent or guess a website, URL, address, branch, location, stock, price, offer, product specification, award, guarantee, customer result, delivery service, or business capability. Mention a location or service only when explicitly stated. Never create a website or URL. If a detail is absent, omit it. Use correct spelling and natural English. Return valid JSON only with keys topic, style, format, hook, talkingPoints (array), script, caption, platform, callToAction. Script should fit 30 to 60 seconds. Every idea must have a different topic, angle, hook, structure and style. Rotate product demonstration, myth-versus-fact, buyer education, comparison, FAQ, storytelling, behind-the-scenes, checklist, problem-solution, objection handling, trend commentary and sales announcement. Avoid repeating or closely paraphrasing the recent ideas supplied. Rotate the format and opening hook each time."},
        {role:"user",content:"Create a fresh idea for this delivery. Treat the profile as the only source of truth. Do not fill gaps with assumptions. Recent ideas to avoid repeating: "+JSON.stringify((recentIdeas||[]).slice(0,30))+". Business profile: "+JSON.stringify(context)}
      ]})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error("Groq request failed with status "+response.status+".");
    const raw=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content;
    if(typeof raw!=="string"||!raw.trim())throw new Error("Groq returned an empty draft.");
    let draft;
    try {
      draft=JSON.parse(raw.trim().replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/,""));
    } catch (_) {
      throw new Error("The AI returned an incomplete content draft. Please tap the test button again.");
    }
    if(typeof draft.topic!=="string"||typeof draft.script!=="string"||!Array.isArray(draft.talkingPoints))throw new Error("Groq returned an invalid draft.");
    return {topic:safeText(draft.topic,240),style:safeText(draft.style,100),format:safeText(draft.format,100),hook:safeText(draft.hook,500),talkingPoints:draft.talkingPoints.slice(0,5).map(x=>safeText(x,350)),script:safeText(draft.script,1800),caption:safeText(draft.caption,700),platform:safeText(draft.platform,100),callToAction:safeText(draft.callToAction,300)};
  } finally { clearTimeout(timeout); }
}
async function sendTestTelegram(db, uid, draft) {
  const token=(process.env.TELEGRAM_BOT_TOKEN||"").trim();
  if(!token)throw new Error("Telegram bot is not configured in Netlify.");
  const snapshot=await db.ref("telegram/accountsByChat").once("value");
  const accounts=snapshot.val()||{};
  const match=Object.entries(accounts).find(([,account])=>account&&String(account.uid)===String(uid));
  if(!match)throw new Error("No Telegram account is linked to this Vee-AI account.");
  const message=[
    "🧪 Vee-AI Telegram delivery test",
    "Your scheduled content delivery is connected.",
    "",
    "Topic: "+draft.topic,
    "Style: "+draft.style,
    "Format: "+draft.format,
    "",
    "Hook: "+draft.hook,
    "",
    "Talking points:",
    ...draft.talkingPoints.map((point,index)=>(index+1)+". "+point),
    "",
    "Video script:",
    draft.script,
    "",
    "Caption: "+draft.caption,
    "Platform: "+draft.platform,
    "Call to action: "+draft.callToAction
  ].join("\n").slice(0,3900);
  const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:match[0],text:message,link_preview_options:{is_disabled:true}})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||result.ok!==true)throw new Error("Telegram rejected the test message.");
  return true;
}
exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  if (Buffer.byteLength(event.body || "", "utf8") > 70000) return json(413, { error: "Request is too large." });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "Request body must be an object." });
  try {
    const user = await verifyUser(event);
    const db = firebase().database();
    const root = db.ref("privateBusinessAutomation/" + user.uid);
    if (body.action === "send-test-content") {
      await enforceUserRateLimit(db, user.uid);
      const automationSnapshot = await root.once("value");
      const automation = automationSnapshot.val() || {};
      if (!automation.consent || automation.consent.enabled !== true || !automation.encryptedProfile) {
        throw new Error("Enable background processing first.");
      }
      const profile = decryptProfile(user.uid, automation.encryptedProfile);
      const historySnapshot = await root.child("runs").orderByChild("createdAtMs").limitToLast(30).once("value");
      const historyRecords = historySnapshot.val() || {};
      const recentIdeas = Object.values(historyRecords).filter(item => item && item.draft).sort((a,b) => Number(b.createdAtMs||0)-Number(a.createdAtMs||0)).map(item => ({topic:item.draft.topic,style:item.draft.style,format:item.draft.format,hook:item.draft.hook}));
      const draft = await createTestDraft(profile, recentIdeas);
      await sendTestTelegram(db, user.uid, draft);
      return json(200, { sent: true, message: "Test content idea sent to your linked Telegram account." });
    }
    if (body.action === "account-profile-get") {
      const snapshot = await db.ref("privateBusinessAccount/" + user.uid + "/profile").once("value");
      const legacy = await db.ref("privateBusiness/" + user.uid + "/vault").once("value");
      const record = snapshot.val();
      let profile = null;
      if (record) {
        if (!record.encryptedProfile) throw new Error("Saved account profile format is not recognised.");
        profile = decryptProfile(user.uid, record.encryptedProfile);
      }
      return json(200, { profile, legacyEncryptedProfileFound: legacy.exists() });
    }
    if (body.action === "account-profile-save") {
      const profile = validateProfile(body.profile);
      await enforceUserRateLimit(db, user.uid);
      const encryptedProfile = encryptProfile(user.uid, profile);
      await db.ref("privateBusinessAccount/" + user.uid + "/profile").set({
        encryptedProfile,
        updatedAtMs: Date.now(),
        userUid: user.uid
      });
      return json(200, { saved: true, message: "Business profile saved securely to your account." });
    }
    if (body.action === "status") {
      const snapshot = await root.child("consent").once("value");
      const consent = snapshot.val() || {};
      return json(200, { enabled: consent.enabled === true, consentGrantedAtMs: consent.consentGrantedAtMs || null, revokedAtMs: consent.revokedAtMs || null });
    }
    if (body.action === "list-drafts") {
      const snapshot = await root.child("runs").orderByChild("createdAtMs").limitToLast(12).once("value");
      const runs = snapshot.val() || {};
      const drafts = Object.entries(runs).map(([id, value]) => ({
        id,
        createdAtMs: Number(value && value.createdAtMs || 0),
        draft: value && value.draft || null
      })).filter(item => item.draft).sort((a, b) => b.createdAtMs - a.createdAtMs);
      return json(200, { drafts });
    }
    await enforceUserRateLimit(db, user.uid);
    if (body.action === "enable") {
      const profile = validateProfile(body.profile);
      const encryptedProfile = encryptProfile(user.uid, profile);
      const now = Date.now();
      await root.update({
        encryptedProfile,
        consent: { enabled: true, consentGrantedAtMs: now, consentVersion: 1, userUid: user.uid }
      });
      return json(200, { enabled: true, message: "Background processing permission saved. Content is prepared at the local time and days you select in your Content Workspace schedule." });
    }
    if (body.action === "disable") {
      const revokedAtMs = Date.now();
      await root.transaction(current => {
        const next = current || {};
        delete next.encryptedProfile;
        delete next.runs;
        next.consent = { enabled: false, revokedAtMs, consentVersion: 1, userUid: user.uid };
        return next;
      });
      return json(200, { enabled: false, message: "Background processing disabled. The automation copy and generated drafts were deleted." });
    }
    return json(400, { error: "Unknown action." });
  } catch (error) {
    const message = error && error.message ? error.message : "Background processing request failed.";
    const status = /sign in|verify your email|email_verified/i.test(message) ? 401 : /too many/i.test(message) ? 429 : /not configured/i.test(message) ? 503 : 400;
    return json(status, { error: message });
  }
};
