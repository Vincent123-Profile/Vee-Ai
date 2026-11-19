const admin = require("firebase-admin");
const crypto = require("crypto");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

let app;
function getApp() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Account service is not configured.");
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-telegram-link");
  }
  return app;
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  const header = event.headers && (event.headers.authorization || event.headers.Authorization);
  const tokenMatch = typeof header === "string" ? header.match(/^Bearer\s+(.+)$/i) : null;
  if (!tokenMatch) return json(401, { error: "Sign in to your verified Vee-AI account first." });

  let user;
  let db;
  try {
    const firebaseApp = getApp();
    user = await admin.auth(firebaseApp).verifyIdToken(tokenMatch[1]);
    if (!user.email || user.email_verified !== true) {
      return json(403, { error: "Verify your email address before linking Telegram." });
    }
    db = firebaseApp.database();
  } catch (error) {
    console.error("Telegram link authentication failed:", error && error.message || error);
    return json(401, { error: "Your sign-in session is invalid or expired. Sign in again." });
  }

  try {
    const now = Date.now();
    const rateRef = db.ref("telegram/linkRequests/" + user.uid);
    const rateResult = await rateRef.transaction(current => {
      if (!current || now - Number(current.windowStartedAtMs || 0) >= 900000) {
        return { windowStartedAtMs: now, count: 1 };
      }
      if (Number(current.count || 0) >= 5) return;
      return { windowStartedAtMs: Number(current.windowStartedAtMs), count: Number(current.count || 0) + 1 };
    });
    if (!rateResult.committed) {
      return json(429, { error: "Too many link codes requested. Wait 15 minutes and try again." });
    }

    const code = crypto.randomBytes(5).toString("hex").toUpperCase();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expiresAtMs = now + 10 * 60 * 1000;
    const codeRef = db.ref("telegram/linkCodes/" + codeHash);
    const stored = await codeRef.transaction(current => {
      if (current) return;
      return {
        uid: user.uid,
        email: String(user.email).slice(0, 254),
        createdAtMs: now,
        expiresAtMs
      };
    });
    if (!stored.committed) throw new Error("Unable to reserve a unique link code.");
    const verifySnapshot = await codeRef.once("value");
    const verifyRecord = verifySnapshot.val();
    console.log("Vee-AI Telegram link code created:", JSON.stringify({
      hashPrefix: codeHash.slice(0, 12),
      committed: Boolean(stored.committed),
      readBack: Boolean(verifyRecord && verifyRecord.uid === user.uid),
      databaseHost: (() => { try { return new URL(process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com").host; } catch (_) { return "invalid"; } })(),
      netlifyContext: process.env.CONTEXT || "unknown",
      branch: process.env.BRANCH || "unknown"
    }));
    if (!verifyRecord || verifyRecord.uid !== user.uid) {
      throw new Error("Link code write could not be verified.");
    }

    return json(200, { success: true, code, expiresAtMs, expiresInSeconds: 600 });
  } catch (error) {
    console.error("Telegram link code creation failed:", error && error.message || error);
    return json(500, { error: "A link code could not be created. Please try again." });
  }
};
