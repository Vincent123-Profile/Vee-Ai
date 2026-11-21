const admin = require("firebase-admin");
const crypto = require("crypto");

let app;
function database() {
  if (!app) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("Firebase service account is not configured.");
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
      databaseURL: process.env.FIREBASE_DATABASE_URL || "https://vee-ai-e745e-default-rtdb.firebaseio.com"
    }, "vee-ai-business-workspace-scheduler").database();
  }
  return app;
}

function encryptionKey() {
  const key = Buffer.from((process.env.BUSINESS_AUTOMATION_ENCRYPTION_KEY || "").trim(), "base64");
  if (key.length !== 32) throw new Error("Background encryption key is missing or invalid.");
  return key;
}

function decryptProfile(uid, record) {
  if (!record || record.version !== 1 || record.algorithm !== "AES-256-GCM") {
    throw new Error("Unsupported encrypted business profile.");
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

function validTimeZone(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch (_) {
    return false;
  }
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
  parts.forEach(part => {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  return {
    date: values.year + "-" + values.month + "-" + values.day,
    time: values.hour + ":" + values.minute
  };
}

function clean(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function approvedProfile(profile) {
  return {
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
    businessCompetitors: clean(profile.businessCompetitors, 1000),
    businessExtra: clean(profile.businessExtra, 1500),
    businessDocumentsText: clean(profile.businessDocumentsText, 10000)
  };
}

async function generateDailyDigest(profile, recentTopics) {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("Groq is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: (process.env.GROQ_MODEL || "openai/gpt-oss-20b").trim(),
        temperature: 0.8,
        max_tokens: 4800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are Vee-AI, a careful business content strategist. Generate exactly three complete, distinct, ready-to-use content pieces for one business day. Return valid JSON only in this shape: {pieces:[{category,topic,platforms,platformReason,format,hook,content,caption,callToAction,visualDirection,keywords}]}. Each piece must have a different useful angle and category, such as educational, promotional, engagement, customer education, product demonstration, FAQ, storytelling or brand awareness. Choose one or more suitable platforms dynamically from the business profile and explain briefly why. Respect platforms the business says it uses. Never invent prices, discounts, stock, URLs, locations, product specifications, awards, guarantees, customer results, delivery services or other unsupported claims. Use only explicit facts in the profile. If a detail is missing, omit it. Each content field must be complete and publish-ready, not an outline. Keep each main content section concise enough for a Telegram digest. Include a clear CTA when suitable. Add practical visual direction. Keywords should be relevant and natural. Do not auto-publish. Avoid repeating or closely paraphrasing recent topics. Return exactly three pieces."
          },
          {
            role: "user",
            content: "Create today's three-piece content digest for this business. Recent topics to avoid: " +
              JSON.stringify((recentTopics || []).slice(0, 30)) +
              "\nBusiness profile: " + JSON.stringify(approvedProfile(profile))
          }
        ]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.error && data.error.message ? clean(data.error.message, 180) : "HTTP " + response.status;
      throw new Error("AI content generation failed: " + detail);
    }
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("AI returned an empty content digest.");
    const parsed = JSON.parse(raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, ""));
    if (!Array.isArray(parsed.pieces) || parsed.pieces.length !== 3) {
      throw new Error("AI did not return exactly three content pieces.");
    }
    const pieces = parsed.pieces.map((piece, index) => {
      if (!piece || typeof piece.topic !== "string" || typeof piece.content !== "string") {
        throw new Error("AI returned an incomplete content piece.");
      }
      const platforms = Array.isArray(piece.platforms) ? piece.platforms.slice(0, 3).map(value => clean(value, 60)) : [];
      return {
        pieceNumber: index + 1,
        category: clean(piece.category, 80),
        topic: clean(piece.topic, 220),
        platforms,
        platformReason: clean(piece.platformReason, 260),
        format: clean(piece.format, 100),
        hook: clean(piece.hook, 350),
        content: clean(piece.content, 1800),
        caption: clean(piece.caption, 700),
        callToAction: clean(piece.callToAction, 250),
        visualDirection: clean(piece.visualDirection, 500),
        keywords: Array.isArray(piece.keywords) ? piece.keywords.slice(0, 8).map(value => clean(value, 50)) : []
      };
    });
    return { pieces, generatedAtMs: Date.now(), generator: "groq" };
  } finally {
    clearTimeout(timeout);
  }
}

function buildTelegramParts(businessName, date, digest) {
  const blocks = digest.pieces.map(piece => [
    "CONTENT " + piece.pieceNumber + " OF 3",
    "Category: " + piece.category,
    "Topic: " + piece.topic,
    "Platform: " + (piece.platforms.join(", ") || "Choose manually"),
    piece.platformReason ? "Why: " + piece.platformReason : "",
    "Format: " + piece.format,
    "",
    "Hook: " + piece.hook,
    "",
    "Content:",
    piece.content,
    piece.caption ? "\nCaption: " + piece.caption : "",
    piece.callToAction ? "\nCTA: " + piece.callToAction : "",
    piece.visualDirection ? "\nVisual direction: " + piece.visualDirection : "",
    piece.keywords.length ? "\nKeywords: " + piece.keywords.join(", ") : ""
  ].filter(Boolean).join("\n"));
  const header = "Vee-AI DAILY BUSINESS DIGEST\n" + clean(businessName, 100) + "\n" + date + "\n\n";
  const parts = [];
  let current = header;
  for (const block of blocks) {
    const addition = (current === header ? "" : "\n\n--------------------\n\n") + block;
    if ((current + addition).length > 3800 && current !== header) {
      parts.push(current);
      current = "Vee-AI DAILY BUSINESS DIGEST (continued)\n" + clean(businessName, 100) + "\n" + date + "\n\n" + block;
    } else {
      current += addition;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((value, index) => {
    const suffix = parts.length > 1 ? "\n\nPart " + (index + 1) + " of " + parts.length : "";
    return (value + suffix).slice(0, 4090);
  });
}

async function linkedChatId(db, uid) {
  const snapshot = await db.ref("telegram/accountsByChat").once("value");
  const accounts = snapshot.val() || {};
  const match = Object.entries(accounts).find(([, account]) => account && String(account.uid) === String(uid));
  return match ? match[0] : null;
}

async function sendTelegram(token, chatId, text) {
  const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const description = data.description ? clean(data.description, 160) : "Telegram delivery failed.";
    throw new Error(description);
  }
  return data.result && data.result.message_id;
}

async function deliverDigest(db, token, chatId, uid, businessId, date, revision, parts) {
  const deliveryRef = db.ref("privateBusinessWorkspace/" + uid + "/deliveries/" + businessId + "/" + date + "/" + revision);
  const now = Date.now();
  const claimId = crypto.randomBytes(12).toString("hex");
  const claim = await deliveryRef.transaction(current => {
    if (current && current.status === "sent") return;
    if (current && current.status === "sending" && now - Number(current.claimedAtMs || 0) < 5 * 60 * 1000) return;
    return {
      status: "sending",
      claimId,
      claimedAtMs: now,
      partCount: parts.length,
      parts: current && current.parts ? current.parts : {}
    };
  }, undefined, false);
  if (!claim.committed) return "already_claimed";

  for (let index = 0; index < parts.length; index++) {
    const partRef = deliveryRef.child("parts/" + index);
    const prior = (await partRef.once("value")).val();
    if (prior && prior.status === "sent") continue;
    const partClaimId = crypto.randomBytes(10).toString("hex");
    const partClaim = await partRef.transaction(current => {
      if (current && current.status === "sent") return;
      if (current && current.status === "sending" && Date.now() - Number(current.claimedAtMs || 0) < 5 * 60 * 1000) return;
      return { status: "sending", claimId: partClaimId, claimedAtMs: Date.now() };
    }, undefined, false);
    if (!partClaim.committed) continue;
    try {
      const messageId = await sendTelegram(token, chatId, parts[index]);
      await partRef.set({ status: "sent", messageId: messageId || null, sentAtMs: Date.now() });
    } catch (error) {
      await partRef.set({ status: "failed", failedAtMs: Date.now(), error: clean(error.message, 180) });
      await deliveryRef.update({ status: "failed", failedAtMs: Date.now(), error: clean(error.message, 180) });
      return "failed";
    }
  }

  const sentParts = (await deliveryRef.child("parts").once("value")).val() || {};
  const allSent = parts.every((_, index) => sentParts[index] && sentParts[index].status === "sent");
  if (allSent) {
    await deliveryRef.update({ status: "sent", sentAtMs: Date.now(), chatId: String(chatId) });
    return "sent";
  }
  await deliveryRef.update({ status: "pending", updatedAtMs: Date.now() });
  return "pending";
}

async function processBusiness(db, token, uid, businessId, record, now) {
  if (!record || record.archived === true || !record.encryptedProfile) return "skipped";
  const schedule = record.schedule || {};
  if (schedule.enabled !== true || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time || ""))) return "disabled";
  const timeZone = validTimeZone(schedule.timeZone) ? schedule.timeZone : "Africa/Lagos";
  const clock = localClock(timeZone, now);
  if (clock.time < schedule.time) return "not_due";

  const uidRef = db.ref("privateBusinessWorkspace/" + uid);
  const runRef = uidRef.child("runs/" + businessId + "/" + clock.date);
  let run = (await runRef.once("value")).val();

  if (!run || (run.status === "failed" && now >= Number(run.nextRetryAtMs || 0)) || (run.status === "generating" && now - Number(run.claimedAtMs || 0) >= 5 * 60 * 1000)) {
    const claimId = crypto.randomBytes(12).toString("hex");
    const claim = await runRef.transaction(current => {
      if (current && current.status === "ready" && current.digest) return;
      if (current && current.status === "generating" && now - Number(current.claimedAtMs || 0) < 5 * 60 * 1000) return;
      return {
        status: "generating",
        claimId,
        claimedAtMs: now,
        attemptCount: Number(current && current.attemptCount || 0) + 1,
        localDate: clock.date,
        timeZone,
        createdAtMs: current && current.createdAtMs ? current.createdAtMs : now
      };
    }, undefined, false);
    if (claim.committed) {
      try {
        const consent = (await db.ref("privateBusinessAutomation/" + uid + "/consent").once("value")).val();
        if (!consent || consent.enabled !== true) {
          await runRef.update({ status: "cancelled", reason: "background_consent_disabled", updatedAtMs: Date.now() });
          return "consent_disabled";
        }
        const profile = decryptProfile(uid, record.encryptedProfile);
        const history = (await uidRef.child("runs/" + businessId).orderByChild("localDate").limitToLast(30).once("value")).val() || {};
        const recentTopics = Object.values(history).filter(item => item && item.digest && Array.isArray(item.digest.pieces))
          .flatMap(item => item.digest.pieces.map(piece => piece.topic));
        const digest = await generateDailyDigest(profile, recentTopics);
        const parts = buildTelegramParts(profile.businessName, clock.date, digest);
        await runRef.set({
          status: "ready",
          localDate: clock.date,
          timeZone,
          generatedAtMs: digest.generatedAtMs,
          createdAtMs: now,
          digest,
          telegramParts: parts
        });
        run = { status: "ready", digest, telegramParts: parts };
      } catch (error) {
        const failedRecord = (await runRef.once("value")).val() || {};
        const attemptCount = Number(failedRecord.attemptCount || 0) + 1;
        const delayMs = Math.min(30 * 60 * 1000, Math.max(60 * 1000, Math.pow(2, Math.min(attemptCount - 1, 5)) * 60 * 1000));
        await runRef.update({
          status: "failed",
          attemptCount,
          failedAtMs: Date.now(),
          nextRetryAtMs: Date.now() + delayMs,
          error: clean(error.message, 220)
        });
        throw error;
      }
    } else {
      run = (await runRef.once("value")).val();
    }
  }

  if (!run || run.status !== "ready" || !run.digest || !Array.isArray(run.telegramParts)) return "not_ready";

  const consent = (await db.ref("privateBusinessAutomation/" + uid + "/consent").once("value")).val();
  if (!consent || consent.enabled !== true) return "consent_disabled";

  const chatId = await linkedChatId(db, uid);
  if (!chatId) return "telegram_not_linked";

  const revision = String(Number(schedule.updatedAtMs || record.updatedAtMs || 0));
  const deliveryStatus = await deliverDigest(db, token, chatId, uid, businessId, clock.date, revision, run.telegramParts);
  return deliveryStatus;
}

exports.handler = async event => {
  if (event && event.httpMethod) {
    const secret = (process.env.SCHEDULER_SECRET || "").trim();
    const header = event.headers && (event.headers.authorization || event.headers.Authorization) || "";
    if (!secret || header !== "Bearer " + secret) {
      return { statusCode: 401, body: "Unauthorized." };
    }
  }
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return { statusCode: 503, body: "Telegram is not configured." };
  try {
    const db = database();
    const snapshot = await db.ref("privateBusinessWorkspace").once("value");
    const users = snapshot.val() || {};
    const outcomes = [];
    let processed = 0;
    for (const [uid, userRecord] of Object.entries(users).slice(0, 200)) {
      const businesses = userRecord && userRecord.businesses ? userRecord.businesses : {};
      for (const [businessId, record] of Object.entries(businesses).slice(0, 20)) {
        if (processed >= 500) break;
        processed++;
        try {
          const checkedAtMs = Date.now();
          const status = await processBusiness(db, token, uid, businessId, record, checkedAtMs);
          await db.ref("privateBusinessWorkspace/" + uid + "/businesses/" + businessId + "/schedulerStatus").set({
            lastCheckedAtMs: checkedAtMs,
            lastStatus: status,
            lastError: null
          });
          outcomes.push({ uid, businessId, status });
        } catch (error) {
          const message = clean(error && error.message, 180);
          console.error("Business Workspace job failed:", JSON.stringify({
            uid,
            businessId,
            error: message
          }));
          await db.ref("privateBusinessWorkspace/" + uid + "/businesses/" + businessId + "/schedulerStatus").set({
            lastCheckedAtMs: Date.now(),
            lastStatus: "failed",
            lastError: message
          }).catch(statusError => console.error("Could not save scheduler status:", statusError.message));
          outcomes.push({ uid, businessId, status: "failed", error: message });
        }
      }
      if (processed >= 500) break;
    }
    const result = { ok: true, users: Object.keys(users).length, processed, outcomes };
    console.log("Vee-AI Business Workspace scheduler:", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error("Business Workspace scheduler failed:", error && error.message || error);
    return { statusCode: 500, body: "Business Workspace scheduler failed." };
  }
};
