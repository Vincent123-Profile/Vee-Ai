const admin = require("firebase-admin");
let app;
function getApp() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Firebase service account is not configured.");
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-admin-security");
  }
  return app;
}
function db() { return getApp().database(); }
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});
async function verifyAdmin(event) {
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\\s+(.+)$/i.exec(header);
  if (!match) throw new Error("Administrator sign in is required.");
  const decoded = await getApp().auth().verifyIdToken(match[1], true);
  if ((decoded.email || "").toLowerCase() !== "agboolavincent67@gmail.com" || decoded.email_verified !== true) {
    throw new Error("Administrator access denied.");
  }
  return decoded;
}
exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Invalid JSON." }); }
  try {
    const actor = await verifyAdmin(event);
    const database = db();
    const root = database.ref("securityCentre");
    if (body.action === "list") {
      const [eventsSnap, blockedSnap, countersSnap] = await Promise.all([
        root.child("events").limitToLast(250).once("value"),
        root.child("blockedFingerprints").once("value"),
        root.child("counters").once("value")
      ]);
      const events = Object.entries(eventsSnap.val() || {}).map(([id, value]) => ({ id, ...value }))
        .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      const blocked = Object.entries(blockedSnap.val() || {}).map(([fingerprint, value]) => ({
        fingerprint, blockedAtMs: Number(value.blockedAtMs || 0), reason: value.reason || "Manual block"
      }));
      const counters = countersSnap.val() || {};
      return json(200, { events, blocked, counters });
    }
    if (body.action === "block" || body.action === "unblock") {
      const fingerprint = String(body.fingerprint || "");
      if (!/^[a-f0-9]{32,64}$/.test(fingerprint)) return json(400, { error: "Invalid network fingerprint." });
      const ref = root.child("blockedFingerprints").child(fingerprint);
      if (body.action === "block") {
        await ref.set({ blockedAtMs: Date.now(), blockedBy: actor.uid, reason: String(body.reason || "Manual SOC block").slice(0, 180) });
      } else {
        await ref.remove();
      }
      await root.child("events").push({
        createdAtMs: Date.now(),
        eventType: body.action === "block" ? "network_blocked" : "network_unblocked",
        severity: body.action === "block" ? "high" : "medium",
        category: "admin_action",
        fingerprint,
        actorUid: actor.uid,
        details: body.action === "block" ? "Administrator blocked a network fingerprint." : "Administrator removed a network block."
      });
      return json(200, { success: true });
    }
    if (body.action === "clear-old-events") {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const snap = await root.child("events").once("value");
      const updates = {};
      Object.entries(snap.val() || {}).forEach(([id, item]) => {
        if (Number(item && item.createdAtMs || 0) < cutoff) updates[id] = null;
      });
      if (Object.keys(updates).length) await root.child("events").update(updates);
      return json(200, { success: true, removed: Object.keys(updates).length });
    }
    return json(400, { error: "Unknown security action." });
  } catch (error) {
    const message = error && error.message || "Security request failed.";
    const denied = /administrator|sign in|token|expired|revoked|auth/i.test(message);
    console.error("Vee-AI SOC admin error:", message);
    return json(denied ? 403 : 500, { error: denied ? "Administrator verification failed. Sign in again." : "Security Centre request failed." });
  }
};
