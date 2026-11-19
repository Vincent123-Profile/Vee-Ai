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
