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
    }, "vee-ai-business-automation-scheduler");
  }
  return app;
}
function encryptionKey() {
  const key = Buffer.from((process.env.BUSINESS_AUTOMATION_ENCRYPTION_KEY || "").trim(), "base64");
  if (key.length !== 32) throw new Error("Background encryption key is missing or invalid.");
  return key;
}
function decryptProfile(uid, record) {
  if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM") throw new Error("Unsupported encrypted profile format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("vee-ai-business-automation:v1:" + uid));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
async function generateContent(profile) {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("Groq is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);
  try {
    const approvedContext = {
      businessName: String(profile.businessName || "").slice(0, 120),
      businessIndustry: String(profile.businessIndustry || "").slice(0, 120),
      businessModel: String(profile.businessModel || "").slice(0, 1200),
      businessProducts: String(profile.businessProducts || "").slice(0, 2200),
      businessCustomers: String(profile.businessCustomers || "").slice(0, 1200),
      businessLocation: String(profile.businessLocation || "").slice(0, 300),
      businessOffers: String(profile.businessOffers || "").slice(0, 1200),
      businessDifference: String(profile.businessDifference || "").slice(0, 1200),
      businessVoice: String(profile.businessVoice || "").slice(0, 100),
      businessGoals: String(profile.businessGoals || "").slice(0, 1200),
      businessPlatforms: String(profile.businessPlatforms || "").slice(0, 1000),
      businessCompetitors: String(profile.businessCompetitors || "").slice(0, 1000)
    };
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim(),
        temperature: 0.7,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content: "You are Vee-AI, a practical business content strategist. Create one useful short-form video idea for the business profile. Do not invent prices, stock, guarantees, awards, customer results or claims. Use only supplied facts. Return valid JSON only with keys: topic, hook, talkingPoints (array of 3 to 5 strings), script, caption, platform (one string), callToAction. Keep the script suitable for a 30 to 60 second video. Do not include markdown fences."
          },
          {
            role: "user",
            content: "Create one original content idea from this approved business profile.\n" + JSON.stringify(profile)
          }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Groq request failed with status " + response.status + ".");
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Groq returned an empty content draft.");
    const cleaned = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
    const draft = JSON.parse(cleaned);
    if (typeof draft.topic !== "string" || typeof draft.script !== "string" || !Array.isArray(draft.talkingPoints)) {
      throw new Error("Groq returned an invalid content draft.");
    }
    return {
      topic: draft.topic.slice(0, 240),
      hook: String(draft.hook || "").slice(0, 500),
      talkingPoints: draft.talkingPoints.slice(0, 5).map(value => String(value).slice(0, 500)),
      script: draft.script.slice(0, 5000),
      caption: String(draft.caption || "").slice(0, 2000),
      platform: String(draft.platform || "Choose a suitable platform").slice(0, 100),
      callToAction: String(draft.callToAction || "").slice(0, 500)
    };
  } finally {
    clearTimeout(timeout);
  }
}
function safeRunKey(value) {
  return String(value || new Date().toISOString()).replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 80);
}
exports.handler = async event => {
  const startedAt = Date.now();
  try {
    const db = firebase().database();
    const snapshot = await db.ref("privateBusinessAutomation").once("value");
    const all = snapshot.val() || {};
    const eligible = Object.entries(all).filter(([uid, record]) =>
      uid !== "undefined" &&
      record && record.consent && record.consent.enabled === true &&
      record.encryptedProfile && record.encryptedProfile.ciphertext
    );
    eligible.sort((a, b) => Number(a[1].lastGeneratedAtMs || 0) - Number(b[1].lastGeneratedAtMs || 0));
    const body = event && event.body ? (typeof event.body === "string" ? JSON.parse(event.body) : event.body) : {};
    const runKey = safeRunKey(body.next_run || new Date().toISOString());
    const selected = eligible.slice(0, 3);
    const outcomes = await Promise.allSettled(selected.map(async ([uid, record]) => {
      const userRef = db.ref("privateBusinessAutomation/" + uid);
      const prior = await userRef.child("runs/" + runKey).once("value");
      if (prior.exists()) return { uid, status: "already_processed" };
      const currentConsent = await userRef.child("consent").once("value");
      if (!currentConsent.val() || currentConsent.val().enabled !== true) return { uid, status: "revoked" };
      const profile = decryptProfile(uid, record.encryptedProfile);
      const draft = await generateContent(profile);
      const latestConsent = await userRef.child("consent").once("value");
      if (!latestConsent.val() || latestConsent.val().enabled !== true) return { uid, status: "revoked_during_generation" };
      const now = Date.now();
      const commit = await userRef.transaction(current => {
        if (!current || !current.consent || current.consent.enabled !== true) return;
        current.runs = current.runs || {};
        if (current.runs[runKey]) return;
        current.runs[runKey] = { status: "ready", createdAtMs: now, nextRunAt: body.next_run || null, draft };
        current.lastGeneratedAtMs = now;
        current.lastRunKey = runKey;
        return current;
      });
      if (!commit.committed) return { uid, status: "revoked_or_already_processed" };
      return { uid, status: "generated" };
    }));
    const results = outcomes.map(item => item.status === "fulfilled" ? item.value : { status: "failed", error: String(item.reason && item.reason.message || item.reason).slice(0, 240) });
    console.log(JSON.stringify({ event: "business_automation_run", runKey, eligible: eligible.length, selected: selected.length, results, durationMs: Date.now() - startedAt }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, runKey, eligible: eligible.length, processed: results.length, results }) };
  } catch (error) {
    console.error("Business automation scheduler failed:", error && error.message || error);
    return { statusCode: 500, body: "Business automation scheduler failed." };
  }
};
