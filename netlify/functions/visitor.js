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
  const payload = Buffer.from(JSON.stringify({ visitorId, exp: Date.now() + 365 * 86400000 })).toString("base64url");
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
function networkFingerprint(event) {
  const ip = event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["X-Nf-Client-Connection-Ip"]);
  const key = (process.env.IP_HASH_SECRET || "").trim();
  if (!ip) return "network_unknown";
  const value = String(ip).trim();
  return (key
    ? crypto.createHmac("sha256", key).update(value).digest("hex")
    : crypto.createHash("sha256").update(value).digest("hex")).slice(0, 32);
}
async function enforceVisitorLimit(database, event, action, now, visitorId) {
  const limits = {
    identify: { count: 30, windowMs: 600000 },
    "save-session": { count: 90, windowMs: 60000 },
    "load-sessions": { count: 30, windowMs: 60000 },
    "clear-history": { count: 5, windowMs: 60000 }
  };
  const rule = limits[action];
  if (!rule) return false;
  const fingerprint = networkFingerprint(event);
  const identity = action === "identify" ? fingerprint : fingerprint + ":" + String(visitorId || "unknown");
  const key = crypto.createHash("sha256").update(action + ":" + identity).digest("hex");
  const windowKey = String(Math.floor(now / rule.windowMs));
  const ref = database.ref("visitorRateLimits/" + key);
  const result = await ref.transaction(current => {
    const record = current && current.window === windowKey ? current : { window: windowKey, count: 0 };
    if (Number(record.count || 0) >= rule.count) return;
    return { window: windowKey, count: Number(record.count || 0) + 1, updatedAtMs: now };
  });
  return !result.committed;
}
exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  const rawBody = event.body || "";
  if (Buffer.byteLength(rawBody, "utf8") > 1500 * 1024) return json(413, { error: "Request is too large." });
  let body;
  try { body = JSON.parse(rawBody || "{}"); } catch (_) { return json(400, { error: "Invalid JSON." }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "Invalid request." });
  try {
    const database = db();
    const now = Date.now();
    const action = String(body.action || "");
    const rateLimited = await enforceVisitorLimit(database, event, action, now, body.visitorId);
    if (rateLimited) return json(429, { error: "Too many requests. Please wait and try again." });

    if (body.action === "identify") {
      let visitorId = null;
      if (body.visitorId && body.visitorToken) {
        try { if (verifyVisitor(body.visitorToken) === body.visitorId) visitorId = body.visitorId; } catch (_) {}
      }
      if (!visitorId) visitorId = "v_" + crypto.randomUUID();
      const ref = database.ref("visitors/" + visitorId);
      const fp = networkFingerprint(event);
      const createdAtRef = ref.child("profile/createdAtMs");
      await createdAtRef.transaction(current => current || now);
      const countedRef = ref.child("profile/analyticsCounted");
      const countedTx = await countedRef.transaction(current => current ? undefined : true);
      if (countedTx.committed) {
        await database.ref("visitorStats/totalGuests").transaction(current => (Number(current) || 0) + 1);
      }
      const dayKey = new Date(now).toISOString().slice(0, 10);
      const activeRef = database.ref("visitorStats/dailyActive/" + dayKey + "/" + visitorId);
      const activeTx = await activeRef.transaction(current => current ? undefined : true);
      if (activeTx.committed) {
        await database.ref("visitorStats/dailyActiveCounts/" + dayKey).transaction(current => (Number(current) || 0) + 1);
      }
      const pruneDate = new Date(now);
      pruneDate.setUTCDate(pruneDate.getUTCDate() - 7);
      const pruneKey = pruneDate.toISOString().slice(0, 10);
      await database.ref("visitorStats/dailyActive/" + pruneKey).remove();
      await database.ref("visitorStats/dailyVisits/" + dayKey).transaction(current => (Number(current) || 0) + 1);
      await ref.update({
        "profile/lastSeenAtMs": now,
        "profile/visitCount": admin.database.ServerValue.increment(1),
        ["networks/" + fp + "/lastSeenAtMs"]: now
      });
      return json(200, { visitorId, visitorToken: signVisitor(visitorId), networkFingerprint: fp });
    }


    if (body.action === "save-session") {
      const visitorId = verifyVisitor(body.visitorToken);
      if (visitorId !== body.visitorId) throw new Error("Visitor identity mismatch.");
      const s = body.session || {};
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(s.id || ""))) throw new Error("Invalid session ID.");
      if (!Array.isArray(s.messages) || s.messages.length > 100) throw new Error("Invalid conversation messages.");
      const messages = s.messages.map(m => {
        if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") {
          throw new Error("Invalid conversation message.");
        }
        if (!m.content.trim() || m.content.length > 12000) throw new Error("Conversation message is too large or empty.");
        return { role: m.role, content: m.content };
      });
      const createdAtInput = Number(s.createdAtMs);
      const updatedAtInput = Number(s.updatedAtMs);
      const createdAtMs = Number.isFinite(createdAtInput) && createdAtInput > 0
        ? Math.min(createdAtInput, now) : now;
      const updatedAtMs = Number.isFinite(updatedAtInput) && updatedAtInput > 0
        ? Math.min(updatedAtInput, now + 60000) : now;
      const fp = networkFingerprint(event);
      const record = {
        id: s.id,
        title: String(s.title || "New conversation").slice(0, 100),
        createdAtMs,
        updatedAtMs,
        messages
      };
      const ref = database.ref("visitors/" + visitorId);
      const profileSnapshot = await ref.child("profile").once("value");
      const clearedAt = Number(profileSnapshot.val() && profileSnapshot.val().historyClearedAtMs || 0);
      if (record.updatedAtMs <= clearedAt) return json(200, { success: true, ignored: true });
      await ref.child("profile/lastSeenAtMs").set(now);
      await ref.child("networks/" + fp + "/lastSeenAtMs").set(now);
      const sessionRef = ref.child("networks/" + fp + "/sessions/" + s.id);
      await sessionRef.transaction(current => {
        if (current && Number(current.updatedAtMs || 0) > record.updatedAtMs) return;
        return record;
      });
      return json(200, { success: true });
    }

    if (body.action === "load-sessions") {
      const visitorId = verifyVisitor(body.visitorToken);
      if (visitorId !== body.visitorId) throw new Error("Visitor identity mismatch.");
      const snap = await database.ref("visitors/" + visitorId + "/networks").once("value");
      const networks = snap.val() || {};
      const sessions = [];
      Object.entries(networks).forEach(([fingerprint, network]) => {
        Object.entries(network && network.sessions || {}).forEach(([id, session]) => {
          sessions.push({ ...session, id: session.id || id, fingerprint });
        });
      });
      sessions.sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0));
      return json(200, { sessions: sessions.slice(0, 50) });
    }

    if (body.action === "clear-history") {
      const visitorId = verifyVisitor(body.visitorToken);
      if (visitorId !== body.visitorId) throw new Error("Visitor identity mismatch.");
      await database.ref("visitors/" + visitorId).update({ networks: null, "profile/historyClearedAtMs": now });
      return json(200, { success: true });
    }

    return json(400, { error: "Unknown visitor action." });
  } catch (error) {
    const message = error && error.message || "Visitor service error.";
    const status = /Invalid visitor token|expired|identity mismatch|Visitor token is required/i.test(message) ? 403 : 500;
    console.error("Vee-AI visitor service error:", message);
    return json(status, { error: status === 403 ? "Visitor session is invalid or expired." : "Visitor service is temporarily unavailable." });
  }
};
