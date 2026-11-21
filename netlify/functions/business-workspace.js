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
    }, "vee-ai-business-workspace");
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
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Background encryption key is missing or invalid.");
  return key;
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
  if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM") {
    throw new Error("Saved business profile format is not recognised.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("vee-ai-business-automation:v1:" + uid));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function verifyUser(event) {
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\\s+(.+)$/i.exec(header);
  if (!match) throw new Error("Sign in again to continue.");
  const decoded = await firebase().auth().verifyIdToken(match[1], true);
  if (!decoded.email_verified) throw new Error("Verify your email before managing Business Workspace.");
  return decoded;
}

function validateProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Business profile is missing.");
  }
  const allowed = {
    businessName: 120,
    businessIndustry: 120,
    businessModel: 2000,
    businessProducts: 3000,
    businessCustomers: 2000,
    businessLocation: 500,
    businessOffers: 2000,
    businessDifference: 2000,
    businessVoice: 100,
    businessGoals: 2000,
    businessPlatforms: 1500,
    businessCompetitors: 1500,
    businessExtra: 2000,
    businessDocumentsText: 50000
  };
  const profile = {};
  for (const [field, max] of Object.entries(allowed)) {
    const value = input[field] === undefined ? "" : input[field];
    if (typeof value !== "string" || value.length > max) {
      throw new Error("Invalid business profile field: " + field);
    }
    profile[field] = value.trim();
  }
  if (!profile.businessName || !profile.businessProducts || !profile.businessCustomers) {
    throw new Error("Business name, products or services, and target customers are required.");
  }
  if (Buffer.byteLength(JSON.stringify(profile), "utf8") > 60000) {
    throw new Error("Business profile exceeds the allowed size.");
  }
  return profile;
}

function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch (_) {
    return false;
  }
}

function validateSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A delivery schedule is required.");
  }
  const time = String(input.time || "");
  const timeZone = String(input.timeZone || "Africa/Lagos");
  if (!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(time)) {
    throw new Error("Choose a valid delivery time in HH:MM format.");
  }
  if (!validTimeZone(timeZone)) throw new Error("Choose a valid timezone.");
  return {
    enabled: input.enabled === true,
    time,
    timeZone,
    updatedAtMs: Date.now()
  };
}

function safeBusinessId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(value);
}

async function migrateLegacyBusiness(db, uid) {
  const businessesRef = db.ref("privateBusinessWorkspace/" + uid + "/businesses");
  const existing = await businessesRef.once("value");
  if (existing.exists()) return existing.val();

  const [automationSnapshot, accountSnapshot, scheduleSnapshot] = await Promise.all([
    db.ref("privateBusinessAutomation/" + uid).once("value"),
    db.ref("privateBusinessAccount/" + uid + "/profile").once("value"),
    db.ref("users/" + uid + "/contentStudio/reminderSettings").once("value")
  ]);
  const automation = automationSnapshot.val() || {};
  const account = accountSnapshot.val() || {};
  const encryptedProfile = automation.encryptedProfile || account.encryptedProfile;
  if (!encryptedProfile || !encryptedProfile.ciphertext) return {};

  const now = Date.now();
  const legacySchedule = scheduleSnapshot.val() || {};
  const schedule = {
    enabled: legacySchedule.enabled === true,
    time: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(legacySchedule.time || "")) ? legacySchedule.time : "09:00",
    timeZone: validTimeZone(legacySchedule.timeZone) ? legacySchedule.timeZone : "Africa/Lagos",
    updatedAtMs: now
  };
  const record = {
    businessId: "business_default",
    encryptedProfile,
    schedule,
    archived: false,
    createdAtMs: now,
    updatedAtMs: now,
    migratedFromLegacy: true
  };
  await businessesRef.child("business_default").transaction(current => current || record);
  return (await businessesRef.once("value")).val() || {};
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  if (Buffer.byteLength(event.body || "", "utf8") > 70000) return json(413, { error: "Request is too large." });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return json(400, { error: "Invalid JSON." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "Request body must be an object." });
  }

  try {
    const user = await verifyUser(event);
    const uid = user.uid;
    const db = firebase().database();
    const businessesRef = db.ref("privateBusinessWorkspace/" + uid + "/businesses");

    if (body.action === "list") {
      const businesses = await migrateLegacyBusiness(db, uid);
      const result = [];
      for (const [businessId, record] of Object.entries(businesses || {})) {
        if (!record || record.archived === true || !record.encryptedProfile) continue;
        result.push({
          businessId,
          profile: decryptProfile(uid, record.encryptedProfile),
          schedule: record.schedule || { enabled: false, time: "09:00", timeZone: "Africa/Lagos" },
          createdAtMs: Number(record.createdAtMs || 0),
          updatedAtMs: Number(record.updatedAtMs || 0)
        });
      }
      return json(200, { businesses: result });
    }

    if (body.action === "save") {
      const profile = validateProfile(body.profile);
      const current = await migrateLegacyBusiness(db, uid);
      const requestedId = body.businessId;
      const businessId = requestedId ? requestedId : "business_" + crypto.randomBytes(8).toString("hex");
      if (!safeBusinessId(businessId)) throw new Error("Invalid business identifier.");
      const existing = current[businessId] || null;
      const count = Object.keys(current).filter(id => current[id] && current[id].archived !== true).length;
      if (!existing && count >= 20) throw new Error("You have reached the 20-business limit.");
      const encryptedProfile = encryptProfile(uid, profile);
      const now = Date.now();
      const record = {
        businessId,
        encryptedProfile,
        schedule: existing && existing.schedule ? existing.schedule : {
          enabled: false,
          time: "09:00",
          timeZone: "Africa/Lagos",
          updatedAtMs: now
        },
        archived: false,
        createdAtMs: existing ? Number(existing.createdAtMs || now) : now,
        updatedAtMs: now,
        migratedFromLegacy: existing ? existing.migratedFromLegacy === true : false
      };
      await businessesRef.child(businessId).set(record);
      return json(200, { saved: true, businessId, profile, schedule: record.schedule });
    }

    if (body.action === "history") {
      const businessId = body.businessId;
      if (!safeBusinessId(businessId)) throw new Error("Choose a valid business.");
      const businessSnapshot = await businessesRef.child(businessId).once("value");
      const businessRecord = businessSnapshot.val();
      if (!businessRecord || businessRecord.archived === true) throw new Error("Business profile was not found.");
      const runsSnapshot = await db.ref("privateBusinessWorkspace/" + uid + "/runs/" + businessId).orderByChild("localDate").limitToLast(30).once("value");
      const runs = runsSnapshot.val() || {};
      const history = Object.entries(runs).map(([localDate, run]) => ({
        localDate,
        status: run && run.status || "unknown",
        generatedAtMs: Number(run && run.generatedAtMs || 0),
        digest: run && run.digest ? run.digest : null
      })).sort((a, b) => String(b.localDate).localeCompare(String(a.localDate)));
      return json(200, { history });
    }

    if (body.action === "schedule") {
      const businessId = body.businessId;
      if (!safeBusinessId(businessId)) throw new Error("Choose a valid business.");
      const schedule = validateSchedule(body.schedule);
      const ref = businessesRef.child(businessId);
      const snapshot = await ref.once("value");
      const record = snapshot.val();
      if (!record || !record.encryptedProfile) throw new Error("Business profile was not found.");
      await ref.update({ schedule, updatedAtMs: Date.now() });
      return json(200, { saved: true, businessId, schedule });
    }

    if (body.action === "archive") {
      const businessId = body.businessId;
      if (!safeBusinessId(businessId)) throw new Error("Choose a valid business.");
      const ref = businessesRef.child(businessId);
      const snapshot = await ref.once("value");
      if (!snapshot.exists()) throw new Error("Business profile was not found.");
      await ref.update({ archived: true, updatedAtMs: Date.now(), schedule: Object.assign({}, snapshot.val().schedule || {}, { enabled: false }) });
      return json(200, { archived: true, businessId });
    }

    return json(400, { error: "Unknown action." });
  } catch (error) {
    const message = error && error.message ? error.message : "Business Workspace request failed.";
    const status = /sign in|verify your email/i.test(message) ? 401 :
      /too many/i.test(message) ? 429 :
      /not configured|encryption key/i.test(message) ? 503 : 400;
    return json(status, { error: message });
  }
};
