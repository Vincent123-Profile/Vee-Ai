const admin = require("firebase-admin");

let app;
function getApp() {
  if (app) return app;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase service account is not configured.");
  app = admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
  }, "vee-ai-admin-users");
  return app;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

async function verifyAdmin(event) {
  const header = event.headers && (event.headers.authorization || event.headers.Authorization) || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Administrator sign in is required.");
  const decoded = await getApp().auth().verifyIdToken(match[1], true);
  if ((decoded.email || "").toLowerCase() !== "agboolavincent67@gmail.com" || decoded.email_verified !== true) {
    throw new Error("Administrator access denied.");
  }
  return decoded;
}

async function listAllUsers(auth) {
  const users = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken && users.length < 10000);
  return users;
}

async function accountMetadata(user, db, telegramByUid) {
  const uid = user.uid;
  const [profileSnap, gmailSnap] = await Promise.all([
    db.ref("users/" + uid + "/profile").once("value"),
    db.ref("gmailConnections/" + uid + "/status").once("value")
  ]);
  const profile = profileSnap.val() || {};
  const gmail = gmailSnap.val() || {};
  const telegram = telegramByUid[uid] || [];
  return {
    uid,
    email: user.email || "",
    displayName: user.displayName || profile.displayName || profile.firstName || "",
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true,
    createdAt: user.metadata && user.metadata.creationTime || null,
    lastSignInAt: user.metadata && user.metadata.lastSignInTime || null,
    telegram: telegram.map(item => ({
      username: item.username || "",
      firstName: item.firstName || "",
      telegramUserId: item.telegramUserId || "",
      linkedAtMs: Number(item.linkedAtMs || 0)
    })),
    gmail: {
      connected: gmail.connected === true,
      gmailAddress: gmail.gmailAddress || "",
      connectedAtMs: Number(gmail.connectedAtMs || 0),
      lastSyncAtMs: Number(gmail.lastSyncAtMs || 0)
    }
  };
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (_) { return json(400, { error: "Invalid request." }); }

  try {
    const adminUser = await verifyAdmin(event);
    const firebase = getApp();
    const auth = firebase.auth();
    const db = firebase.database();

    if (body.action === "list") {
      const [users, telegramSnap] = await Promise.all([
        listAllUsers(auth),
        db.ref("telegram/accountsByChat").once("value")
      ]);
      const telegramByUid = {};
      Object.values(telegramSnap.val() || {}).forEach(item => {
        if (!item || !item.uid) return;
        if (!telegramByUid[item.uid]) telegramByUid[item.uid] = [];
        telegramByUid[item.uid].push(item);
      });
      const accounts = [];
      for (let i = 0; i < users.length; i += 40) {
        const batch = await Promise.all(users.slice(i, i + 40).map(user => accountMetadata(user, db, telegramByUid)));
        accounts.push(...batch);
      }
      accounts.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(200, {
        accounts,
        totals: {
          registered: accounts.length,
          verified: accounts.filter(x => x.emailVerified).length,
          disabled: accounts.filter(x => x.disabled).length,
          telegramConnected: accounts.filter(x => x.telegram.length).length,
          gmailConnected: accounts.filter(x => x.gmail.connected).length
        }
      });
    }

    if (body.action === "set-disabled") {
      const uid = String(body.uid || "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json(400, { error: "Invalid account ID." });
      if (uid === adminUser.uid) return json(400, { error: "You cannot disable the active administrator account." });
      if (typeof body.disabled !== "boolean") return json(400, { error: "A valid account status is required." });
      await auth.updateUser(uid, { disabled: body.disabled });
      if (body.disabled) await auth.revokeRefreshTokens(uid);
      return json(200, { success: true, disabled: body.disabled });
    }

    if (body.action === "delete-account") {
      const uid = String(body.uid || "");
      const confirmEmail = String(body.confirmEmail || "").trim().toLowerCase();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return json(400, { error: "Invalid account ID." });
      if (uid === adminUser.uid) return json(400, { error: "The active administrator account cannot be deleted here." });
      const target = await auth.getUser(uid);
      if (!target.email || confirmEmail !== target.email.toLowerCase()) return json(400, { error: "The account email confirmation does not match." });

      const telegramSnap = await db.ref("telegram/accountsByChat").once("value");
      const linkedChats = Object.entries(telegramSnap.val() || {}).filter(([, item]) => item && item.uid === uid).map(([chatId]) => chatId);
      await auth.deleteUser(uid);
      const updates = {
        ["users/" + uid]: null,
        ["gmailConnections/" + uid]: null,
        ["privateBusiness/" + uid]: null,
        ["privateBusinessAccount/" + uid]: null,
        ["privateBusinessAutomation/" + uid]: null,
        ["privateBusinessAutomationRate/" + uid]: null
      };
      linkedChats.forEach(chatId => {
        updates["telegram/accountsByChat/" + chatId] = null;
        updates["telegram/chats/" + chatId] = null;
      });
      await db.ref().update(updates);
      return json(200, { success: true, deleted: true });
    }

    return json(400, { error: "Unknown administrator action." });
  } catch (error) {
    const message = error && error.message || "Administrator request failed.";
    const status = /administrator|sign in|token|expired|revoked|auth/i.test(message) ? 403 : 500;
    console.error("Vee-AI admin metadata error:", message);
    return json(status, { error: status === 403 ? "Administrator verification failed. Sign in again." : "The administrator request failed." });
  }
};
