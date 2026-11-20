const admin = require("firebase-admin");
const crypto = require("crypto");
const gmail = require("./gmail");

let app;
function database() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Firebase service account is not configured.");
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-gmail-background-scanner");
  }
  return app.database();
}
function clean(value,max) {
  return String(value || "").replace(/[\\u0000-\\u001f\\u007f]/g," ").trim().slice(0,max);
}
exports.handler = async () => {
  const db = database();
  const now = Date.now();
  const claimId = crypto.randomBytes(16).toString("hex");
  const lockRef = db.ref("gmailIntelligenceScheduler/lock");
  const lock = await lockRef.transaction(current => {
    if (current && current.claimedAtMs && now - Number(current.claimedAtMs) < 4 * 60 * 1000) return;
    return { claimId, claimedAtMs:now };
  }, undefined, false);
  if (!lock.committed) return { statusCode:200, body:JSON.stringify({ok:true,skipped:"another scan is running"}) };
  const outcomes = [];
  try {
    const snapshot = await db.ref("gmailConnections").once("value");
    const users = snapshot.val() || {};
    let processed = 0;
    for (const [uid, record] of Object.entries(users).slice(0,100)) {
      if (!uid || uid === "undefined" || !record) continue;
      const accounts = Object.entries(record.accounts || {}).filter(([,item]) =>
        item && item.status && item.status.connected === true && item.tokenVault
      );
      if (record.status && record.status.connected === true && record.tokenVault) {
        accounts.unshift(["legacy",record]);
      }
      for (const [accountId] of accounts.slice(0,3)) {
        if (processed >= 30) break;
        try {
          const result = await gmail.runScheduledScan(db,uid,accountId);
          outcomes.push({uid,accountId,status:result.skipped?"skipped":"scanned",messages:result.synced||0});
        } catch (error) {
          console.error("Vee-AI scheduled Gmail scan failed:",JSON.stringify({uid,accountId,error:clean(error.message,180)}));
          outcomes.push({uid,accountId,status:"failed"});
        }
        processed++;
      }
      if (processed >= 30) break;
    }
    return {statusCode:200,body:JSON.stringify({ok:true,processed,outcomes})};
  } catch (error) {
    console.error("Vee-AI Gmail background scanner failed:",clean(error.message,240));
    return {statusCode:500,body:"Gmail background scan failed."};
  } finally {
    const current = await lockRef.once("value");
    if (current.val() && current.val().claimId === claimId) await lockRef.remove();
  }
};
