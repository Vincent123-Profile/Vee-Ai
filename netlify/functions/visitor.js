const admin = require("firebase-admin");
const crypto = require("crypto");

let app;
function firebaseAdmin() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
    const serviceAccount = JSON.parse(raw);
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-visitor-service");
  }
  return app;
}
const db = () => firebaseAdmin().database();
const auth = () => firebaseAdmin().auth();
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});
function secret() {
  const value = (process.env.VISITOR_TOKEN_SECRET || "").trim();
  if (value.length < 32) throw new Error("VISITOR_TOKEN_SECRET must contain at least 32 characters.");
  return value;
}
function signVisitor(visitorId) {
  const payload = Buffer.from(JSON.stringify({ visitorId, exp: Date.now() + 30 * 86400000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return payload + "." + signature;
}
function verifyVisitor(token) {
  if (typeof token !== "string") throw new Error("Visitor token is required.");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid visitor token.");
  const expected = crypto.createHmac("sha256", secret()).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw new Error("Invalid visitor token.");
  const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (!data.visitorId || !data.exp || data.exp < Date.now()) throw new Error("Visitor token expired.");
  return data.visitorId;
}
async function googleUidFromToken(idToken) {
  if (!idToken) throw new Error("Google sign-in token is required.");
  const decoded = await auth().verifyIdToken(idToken);
  if (!decoded.firebase || !decoded.firebase.sign_in_provider || decoded.firebase.sign_in_provider !== "google.com") {
    throw new Error("A verified Google sign-in is required.");
  }
  return decoded.uid;
}
function networkFingerprint(event) {
  const ip = event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["X-Nf-Client-Connection-Ip"]);
  const key = (process.env.IP_HASH_SECRET || "").trim();
  if (!ip || !key) return "network_unknown";
  return crypto.createHmac("sha256", key).update(String(ip).trim()).digest("hex").slice(0, 32);
}
async function requireAdmin(idToken) {
  const decoded = await auth().verifyIdToken(idToken);
  if ((decoded.email || "").toLowerCase() !== "agboolavincent67@icloud.com") throw new Error("Administrator access denied.");
  return decoded;
}
exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON." }); }
  try {
    const database = db();
    const now = Date.now();

    if (body.action === "identify") {
      let visitorId = null;
      if (body.googleIdToken) {
        const googleUid = await googleUidFromToken(body.googleIdToken);
        const index = await database.ref("googleIndex/" + googleUid).once("value");
        visitorId = index.val() || null;
      }
      if (!visitorId && body.visitorId && body.visitorToken) {
        try { if (verifyVisitor(body.visitorToken) === body.visitorId) visitorId = body.visitorId; } catch (_) {}
      }
      if (!visitorId) visitorId = "v_" + crypto.randomUUID();
      const ref = database.ref("visitors/" + visitorId);
      const snapshot = await ref.once("value");
      const current = snapshot.val() || {};
      const fp = networkFingerprint(event);
      const updates = {
        "profile/createdAtMs": current.profile && current.profile.createdAtMs || now,
        "profile/lastSeenAtMs": now,
        "profile/googleLinked": !!(current.identity && current.identity.googleUid),
        ["networks/" + fp + "/lastSeenAtMs"]: now
      };
      await ref.update(updates);
      if (body.googleIdToken) {
        const googleUid = await googleUidFromToken(body.googleIdToken);
        const existing = await database.ref("googleIndex/" + googleUid).once("value");
        if (existing.val() && existing.val() !== visitorId) throw new Error("This Google account is already linked to another visitor.");
        await ref.child("identity/googleUid").set(googleUid);
        await ref.child("profile/googleLinked").set(true);
        await database.ref("googleIndex/" + googleUid).set(visitorId);
      }
      return json(200, { visitorId, visitorToken: signVisitor(visitorId), networkFingerprint: fp, googleLinked: !!body.googleIdToken || !!(current.identity && current.identity.googleUid) });
    }

    if (body.action === "link-google") {
      const visitorId = verifyVisitor(body.visitorToken);
      if (visitorId !== body.visitorId) throw new Error("Visitor identity mismatch.");
      const googleUid = await googleUidFromToken(body.googleIdToken);
      const indexRef = database.ref("googleIndex/" + googleUid);
      const existing = await indexRef.once("value");
      if (existing.val() && existing.val() !== visitorId) throw new Error("This Google account is already linked to another visitor.");
      await database.ref("visitors/" + visitorId + "/identity/googleUid").set(googleUid);
      await database.ref("visitors/" + visitorId + "/profile/googleLinked").set(true);
      await indexRef.set(visitorId);
      return json(200, { success: true });
    }

    if (body.action === "save-session") {
      const visitorId = verifyVisitor(body.visitorToken);
      if (visitorId !== body.visitorId) throw new Error("Visitor identity mismatch.");
      const s = body.session || {};
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(s.id || ""))) throw new Error("Invalid session ID.");
      const messages = Array.isArray(s.messages) ? s.messages.slice(-100).map(m => ({
        role: m && m.role === "user" ? "user" : "assistant",
        content: String(m && m.content || "").slice(0, 12000)
      })) : [];
      const fp = networkFingerprint(event);
      const record = {
        id: s.id,
        title: String(s.title || "New conversation").slice(0, 100),
        createdAtMs: Number(s.createdAtMs || now),
        updatedAtMs: Number(s.updatedAtMs || now),
        messages
      };
      const ref = database.ref("visitors/" + visitorId);
      await ref.child("profile/lastSeenAtMs").set(now);
      await ref.child("networks/" + fp + "/lastSeenAtMs").set(now);
      await ref.child("networks/" + fp + "/sessions/" + s.id).set(record);
      return json(200, { success: true });
    }

    if (body.action === "recover-google") {
      const googleUid = await googleUidFromToken(body.googleIdToken);
      const snap = await database.ref("googleIndex/" + googleUid).once("value");
      const visitorId = snap.val();
      if (!visitorId) return json(404, { error: "No Vee-AI visitor record is linked to this Google account." });
      return json(200, { visitorId, visitorToken: signVisitor(visitorId) });
    }

    if (body.action === "admin-list") {
      await requireAdmin(body.idToken);
      const snap = await database.ref("visitors").once("value");
      return json(200, { visitors: snap.val() || {} });
    }

    if (body.action === "admin-delete-history") {
      await requireAdmin(body.idToken);
      const visitorId = String(body.visitorId || "");
      if (!/^v_[A-Za-z0-9_-]{10,100}$/.test(visitorId)) throw new Error("Invalid visitor ID.");
      await database.ref("visitors/" + visitorId).update({ networks: null, "profile/historyClearedAtMs": now });
      return json(200, { success: true });
    }

    return json(400, { error: "Unknown visitor action." });
  } catch (error) {
    const message = error && error.message || "Visitor service error.";
    const status = /Administrator access denied|Invalid visitor token|expired|identity mismatch|verified Google|already linked/i.test(message) ? 403 : 500;
    return json(status, { error: message });
  }
};
