const admin = require("firebase-admin");
const crypto = require("crypto");

let firebaseApp;
function database() {
  if (!firebaseApp) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Firebase service account is not configured.");
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-planner-reminders");
  }
  return firebaseApp.database();
}

async function telegramRequest(token, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error("Telegram " + method + " failed.");
  return data.result;
}

function localClock(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = {};
  parts.forEach(part => { if (part.type !== "literal") values[part.type] = part.value; });
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: values.year + "-" + values.month + "-" + values.day,
    time: values.hour + ":" + values.minute,
    day: dayMap[values.weekday]
  };
}

function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch (_) { return false; }
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

async function sendTaskReminder(db, token, chatId, uid, date, taskId, task, now) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return false;
  const deliveryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(task.dueDate || "")) ? String(task.dueDate) : date;
  const deliveryRef = db.ref("telegram/reminderDeliveries/" + uid + "/" + deliveryDate + "/" + taskId);
  const claimId = crypto.randomBytes(12).toString("hex");
  const claim = await deliveryRef.transaction(current => {
    if (current && (current.status === "sent" || (current.status === "sending" && now - Number(current.claimedAtMs || 0) < 10 * 60 * 1000))) return;
    return { status: "sending", claimId, claimedAtMs: now };
  }, undefined, false);
  if (!claim.committed) return false;

  const title = cleanText(task.title, 120) || "Untitled task";
  const dueDate = String(task.dueDate || "");
  const overdue = dueDate < date;
  const message = (overdue ? "⏰ Overdue task reminder" : "⏰ Task due today") +
    "\n\n" + title +
    (dueDate ? "\nDue date: " + dueDate : "") +
    (task.notes ? "\n\n" + cleanText(task.notes, 300) : "") +
    "\n\nOpen Vee-AI to update your Planner.";
  try {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: message,
      link_preview_options: { is_disabled: true }
    });
    await deliveryRef.set({ status: "sent", sentAtMs: Date.now() });
    return true;
  } catch (error) {
    const current = (await deliveryRef.once("value")).val();
    if (current && current.claimId === claimId) await deliveryRef.remove();
    console.error("Planner reminder delivery failed:", JSON.stringify({ uid, chatId, taskId, error: error.message }));
    return false;
  }
}

async function sendDailyPlannerSummary(db, token, chatId, uid, settings, tasks, now) {
  const timeZone = validTimeZone(settings.timeZone) ? settings.timeZone : "Africa/Lagos";
  const clock = localClock(timeZone, new Date(now));
  if (clock.time !== settings.time) return false;
  const deliveryRef = db.ref("telegram/plannerDailySummaryDeliveries/" + uid + "/" + clock.date);
  const claimId = crypto.randomBytes(12).toString("hex");
  const claim = await deliveryRef.transaction(current => {
    if (current && current.status === "sent") return;
    if (current && current.status === "sending" && now - Number(current.claimedAtMs || 0) < 10 * 60 * 1000) return;
    return { status: "sending", claimId, claimedAtMs: now, localDate: clock.date, timeZone };
  }, undefined, false);
  if (!claim.committed) return false;

  const entries = Object.entries(tasks || {}).filter(([, task]) => task && task.done !== true);
  const overdue = entries.filter(([, task]) => /^\d{4}-\d{2}-\d{2}$/.test(String(task.dueDate || "")) && task.dueDate < clock.date);
  const today = entries.filter(([, task]) => task.dueDate === clock.date);
  const upcoming = entries.filter(([, task]) => /^\d{4}-\d{2}-\d{2}$/.test(String(task.dueDate || "")) && task.dueDate > clock.date && task.dueDate <= addDays(clock.date, 7));
  const lines = ["📋 YOUR DAILY PLANNER SUMMARY", clock.date, ""];
  function addGroup(title, list) {
    lines.push(title + " (" + list.length + ")");
    if (!list.length) lines.push("None");
    list.slice(0, 12).forEach(([, task]) => {
      lines.push("• " + cleanText(task.title, 110) + (task.dueDate ? " · " + task.dueDate : "") + (task.dueTime ? " at " + task.dueTime : ""));
    });
    lines.push("");
  }
  addGroup("OVERDUE TASKS", overdue);
  addGroup("TODAY'S TASKS", today);
  addGroup("UPCOMING DEADLINES (7 DAYS)", upcoming);
  if (!overdue.length && !today.length && !upcoming.length) lines.push("Your Planner is clear. No pending tasks or upcoming deadlines.");
  lines.push("Open Vee-AI to update your tasks.");
  try {
    const result = await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: lines.join("\n").slice(0, 3900),
      link_preview_options: { is_disabled: true }
    });
    await deliveryRef.set({ status: "sent", sentAtMs: Date.now(), messageId: result && result.message_id || null, localDate: clock.date, timeZone });
    return true;
  } catch (error) {
    const current = (await deliveryRef.once("value")).val();
    if (current && current.claimId === claimId) await deliveryRef.set({ status: "failed", failedAtMs: Date.now(), error: cleanText(error.message, 160), localDate: clock.date, timeZone });
    console.error("Daily Planner summary failed:", JSON.stringify({ uid, error: error.message }));
    return false;
  }
}

function addDays(date, count) {
  const parts = String(date).split("-").map(Number);
  const value = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + count));
  return value.getUTCFullYear() + "-" + String(value.getUTCMonth() + 1).padStart(2, "0") + "-" + String(value.getUTCDate()).padStart(2, "0");
}

exports.handler = async () => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return { statusCode: 503, body: "Telegram is not configured." };

  try {
    const db = database();
    const linkedSnapshot = await db.ref("telegram/accountsByChat").once("value");
    const linkedAccounts = linkedSnapshot.val() || {};
    const now = Date.now();
    let checked = 0;
    let sent = 0;

    for (const [chatId, account] of Object.entries(linkedAccounts).slice(0, 200)) {
      if (!account || !account.uid || !/^\d{1,24}$/.test(String(chatId))) continue;
      const uid = String(account.uid);
      const [settingsSnapshot, tasksSnapshot, summarySettingsSnapshot] = await Promise.all([
        db.ref("users/" + uid + "/planner/reminderSettings").once("value"),
        db.ref("users/" + uid + "/planner/tasks").once("value"),
        db.ref("users/" + uid + "/planner/dailySummarySettings").once("value")
      ]);
      const settings = settingsSnapshot.val() || {};
      const summarySettings = summarySettingsSnapshot.val() || {};
      if (settings.enabled !== true && summarySettings.enabled !== true) continue;
      const tasks = tasksSnapshot.val() || {};
      if (summarySettings.enabled === true && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(summarySettings.time || ""))) {
        if (await sendDailyPlannerSummary(db, token, chatId, uid, summarySettings, tasks, now)) sent++;
      }
      if (settings.enabled !== true) continue;
      const fallbackTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.time || "")) ? settings.time : "";
      const fallbackDays = Array.isArray(settings.days) ? settings.days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [];
      for (const [taskId, task] of Object.entries(tasks).slice(0, 100)) {
        if (!task || task.done === true || !/^\d{4}-\d{2}-\d{2}$/.test(String(task.dueDate || ""))) continue;
        const hasTaskTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(task.dueTime || ""));
        const timeZone = validTimeZone(hasTaskTime ? task.timeZone : settings.timeZone) ? (hasTaskTime ? task.timeZone : settings.timeZone) : "UTC";
        const clock = localClock(timeZone, new Date(now));
        let dueNow = false;
        if (hasTaskTime) {
          dueNow = task.dueDate < clock.date || (task.dueDate === clock.date && task.dueTime <= clock.time);
        } else {
          dueNow = !!fallbackTime && clock.time === fallbackTime && fallbackDays.includes(clock.day) && task.dueDate <= clock.date;
        }
        if (!dueNow) continue;
        checked++;
        if (sent >= 100) break;
        if (await sendTaskReminder(db, token, chatId, uid, clock.date, taskId, task, now)) sent++;
      }
      if (sent >= 100) break;
    }

    console.log("Vee-AI planner reminder run:", JSON.stringify({ checked, sent, linkedAccounts: Object.keys(linkedAccounts).length }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, checked, sent }) };
  } catch (error) {
    console.error("Vee-AI planner reminder scheduler failed:", error && error.message || error);
    return { statusCode: 500, body: "Planner reminder run failed." };
  }
};
