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
    }, "vee-ai-business-content-scheduler");
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
  const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch (_) { return false; }
}
function localClock(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year:"numeric", month:"2-digit", day:"2-digit", weekday:"short",
    hour:"2-digit", minute:"2-digit", hourCycle:"h23"
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { if (part.type !== "literal") values[part.type] = part.value; });
  const dayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    date: values.year + "-" + values.month + "-" + values.day,
    time: values.hour + ":" + values.minute,
    day: dayMap[values.weekday]
  };
}
function clean(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
async function generateContent(profile) {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("Groq is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);
  try {
    const approvedContext = {
      businessName: clean(profile.businessName, 120),
      businessIndustry: clean(profile.businessIndustry, 120),
      businessModel: clean(profile.businessModel, 1200),
      businessProducts: clean(profile.businessProducts, 2200),
      businessCustomers: clean(profile.businessCustomers, 1200),
      businessLocation: clean(profile.businessLocation, 300),
      businessOffers: clean(profile.businessOffers, 1200),
      businessDifference: clean(profile.businessDifference, 1200),
      businessVoice: clean(profile.businessVoice, 100),
      businessGoals: clean(profile.businessGoals, 1200),
      businessPlatforms: clean(profile.businessPlatforms, 1000),
      businessCompetitors: clean(profile.businessCompetitors, 1000)
    };
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST", signal:controller.signal,
      headers:{ Authorization:"Bearer " + apiKey, "Content-Type":"application/json" },
      body:JSON.stringify({
        model:(process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim(),
        temperature:0.7, max_tokens:900,
        messages:[
          { role:"system", content:"You are Vee-AI, a practical business content strategist. Create one useful short-form video idea for the business profile. Make the idea specific to the supplied products, services, customers, market and goals. Do not invent prices, stock, guarantees, awards, customer results or claims. Use only supplied facts. Return valid JSON only with keys: topic, hook, talkingPoints (array of 3 to 5 strings), script, caption, platform (one string), callToAction. Keep the script suitable for a 30 to 60 second video. Do not include markdown fences." },
          { role:"user", content:"Create one original content idea from this approved business profile.\n" + JSON.stringify(approvedContext) }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Groq request failed with status " + response.status + ".");
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("Groq returned an empty content draft.");
    const cleaned = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
    const draft = JSON.parse(cleaned);
    if (typeof draft.topic !== "string" || typeof draft.script !== "string" || !Array.isArray(draft.talkingPoints)) throw new Error("Groq returned an invalid content draft.");
    return {
      topic:draft.topic.slice(0,240), hook:clean(draft.hook,500),
      talkingPoints:draft.talkingPoints.slice(0,5).map(value => clean(value,500)),
      script:draft.script.slice(0,5000), caption:clean(draft.caption,2000),
      platform:clean(draft.platform || "Choose a suitable platform",100),
      callToAction:clean(draft.callToAction,500)
    };
  } finally { clearTimeout(timeout); }
}
async function sendTelegram(token, chatId, draft) {
  const text = [
    "💡 Your scheduled Vee-AI business content idea",
    "",
    "Topic: " + clean(draft.topic,240),
    "",
    "Hook: " + clean(draft.hook,500),
    "",
    "Talking points:",
    ...(Array.isArray(draft.talkingPoints) ? draft.talkingPoints.slice(0,5).map((point,index) => (index+1) + ". " + clean(point,350)) : []),
    "",
    "Video script:",
    clean(draft.script,1800),
    "",
    "Caption: " + clean(draft.caption,700),
    "",
    "Platform: " + clean(draft.platform,100),
    "Call to action: " + clean(draft.callToAction,300),
    "",
    "Open Vee-AI Business Workspace to review your saved idea."
  ].join("\n").slice(0,3900);
  const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:chatId, text, link_preview_options:{ is_disabled:true } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error("Telegram content delivery failed.");
}
async function deliverToLinkedTelegram(db, uid, draft) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return { status:"not_configured" };
  const snapshot = await db.ref("telegram/accountsByChat").once("value");
  const accounts = snapshot.val() || {};
  const match = Object.entries(accounts).find(([, account]) => account && String(account.uid) === String(uid));
  if (!match) return { status:"not_linked" };
  await sendTelegram(token, match[0], draft);
  return { status:"sent", chatId:match[0] };
}
exports.handler = async () => {
  const startedAt = Date.now();
  try {
    const db = firebase().database();
    const snapshot = await db.ref("privateBusinessAutomation").once("value");
    const all = snapshot.val() || {};
    const now = new Date();
    const outcomes = [];
    for (const [uid, record] of Object.entries(all).slice(0,200)) {
      if (!uid || uid === "undefined" || !record || !record.consent || record.consent.enabled !== true || !record.encryptedProfile || !record.encryptedProfile.ciphertext) continue;
      const scheduleSnapshot = await db.ref("users/" + uid + "/contentStudio/reminderSettings").once("value");
      const schedule = scheduleSnapshot.val() || {};
      if (schedule.enabled !== true || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time || "")) || !validTimeZone(schedule.timeZone)) continue;
      const clock = localClock(schedule.timeZone, now);
      const days = Array.isArray(schedule.days) ? schedule.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
      const intervalHours = Number(schedule.intervalHours || 3);
      if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 12) continue;
      const currentParts = clock.time.split(":").map(Number);
      const startParts = String(schedule.time).split(":").map(Number);
      const currentMinute = currentParts[0] * 60 + currentParts[1];
      const startMinute = startParts[0] * 60 + startParts[1];
      const elapsedMinutes = currentMinute - startMinute;
      const intervalMinutes = intervalHours * 60;
      if (elapsedMinutes < 0 || !days.includes(clock.day)) continue;
      const minutesPastSlot = elapsedMinutes % intervalMinutes;
      if (minutesPastSlot > 2) continue;
      const dueMinuteOfDay = currentMinute - minutesPastSlot;
      const dueTime = String(Math.floor(dueMinuteOfDay / 60)).padStart(2,"0") + ":" + String(dueMinuteOfDay % 60).padStart(2,"0");
      const runKey = "content_" + clock.date.replace(/-/g,"") + "_" + dueTime.replace(":","");
      const userRef = db.ref("privateBusinessAutomation/" + uid);
      const runRef = userRef.child("runs/" + runKey);
      const prior = await runRef.once("value");
      if (prior.exists()) {
        const existing = prior.val() || {};
        if (existing.status === "ready" && existing.draft && (!existing.telegramDelivery || existing.telegramDelivery.status !== "sent")) {
          try {
            const delivery = await deliverToLinkedTelegram(db, uid, existing.draft);
            await runRef.child("telegramDelivery").set(Object.assign({}, delivery, { attemptedAtMs:Date.now() }));
          } catch (error) {
            await runRef.child("telegramDelivery").set({ status:"failed", attemptedAtMs:Date.now(), error:clean(error.message,180) });
          }
        }
        continue;
      }

      const consentNow = await userRef.child("consent").once("value");
      if (!consentNow.val() || consentNow.val().enabled !== true) continue;
      try {
        const profile = decryptProfile(uid, record.encryptedProfile);
        const draft = await generateContent(profile);
        const consentLatest = await userRef.child("consent").once("value");
        const scheduleLatest = await db.ref("users/" + uid + "/contentStudio/reminderSettings").once("value");
        if (!consentLatest.val() || consentLatest.val().enabled !== true || !scheduleLatest.val() || scheduleLatest.val().enabled !== true) {
          outcomes.push({ uid, status:"consent_or_schedule_revoked" });
          continue;
        }
        const savedAtMs = Date.now();
        const commit = await runRef.transaction(current => {
          if (current) return;
          return { status:"ready", createdAtMs:savedAtMs, scheduledForLocal:clock.date + " " + dueTime, timeZone:schedule.timeZone, draft };
        }, undefined, false);
        if (!commit.committed) continue;
        await userRef.update({ lastGeneratedAtMs:savedAtMs, lastRunKey:runKey });
        let delivery;
        try { delivery = await deliverToLinkedTelegram(db, uid, draft); }
        catch (error) { delivery = { status:"failed", error:clean(error.message,180) }; }
        await runRef.child("telegramDelivery").set(Object.assign({}, delivery, { attemptedAtMs:Date.now() }));
        outcomes.push({ uid, status:"generated", telegram:delivery.status });
      } catch (error) {
        console.error("Scheduled content generation failed:", JSON.stringify({ uid, error:clean(error.message,220) }));
        outcomes.push({ uid, status:"failed" });
      }
    }
    const result = { ok:true, checked:Object.keys(all).length, outcomes, durationMs:Date.now()-startedAt };
    console.log("Vee-AI scheduled content run:", JSON.stringify(result));
    return { statusCode:200, body:JSON.stringify(result) };
  } catch (error) {
    console.error("Business content scheduler failed:", error && error.message || error);
    return { statusCode:500, body:"Business content scheduler failed." };
  }
};
