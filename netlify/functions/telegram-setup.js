const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

function matches(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && require("crypto").timingSafeEqual(left, right);
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const supplied = event.headers && (event.headers["x-setup-key"] || event.headers["X-Setup-Key"]);
  if (!matches(supplied, secret)) return json(401, {
    error: "Unauthorized.",
    diagnostic: {
      configuredSecretPresent: Boolean(secret),
      configuredSecretLength: secret.length,
      receivedHeaderPresent: typeof supplied === "string" && supplied.length > 0,
      receivedHeaderLength: typeof supplied === "string" ? supplied.length : 0,
      deployContext: process.env.CONTEXT || "unknown",
      branch: process.env.BRANCH || "unknown"
    }
  });

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  let requestedBaseUrl = "";
  try {
    const body = JSON.parse(event.body || "{}");
    requestedBaseUrl = typeof body.deployUrl === "string" ? body.deployUrl.trim() : "";
  } catch (_) {}
  const candidateBaseUrl = requestedBaseUrl || process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  let baseUrl = "";
  try {
    const parsed = new URL(candidateBaseUrl);
    const host = parsed.hostname.toLowerCase();
    const allowedHost = host === "fantastic-sable-dba726.netlify.app" || /^deploy-preview-[0-9]+--fantastic-sable-dba726\.netlify\.app$/.test(host);
    if (parsed.protocol === "https:" && allowedHost) baseUrl = parsed.origin;
  } catch (_) {}
  if (!token || secret.length < 32 || !baseUrl) return json(503, {
    error: "Telegram setup configuration is incomplete.",
    diagnostic: {
      botTokenPresent: Boolean(token),
      webhookSecretLengthValid: secret.length >= 32,
      deploymentUrlPresent: Boolean(baseUrl),
      deployContext: process.env.CONTEXT || "unknown",
      branch: process.env.BRANCH || "unknown"
    }
  });

  const webhookUrl = baseUrl + "/.netlify/functions/telegram";
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message"],
        drop_pending_updates: false
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      console.error("Telegram webhook registration failed:", result.description || response.status);
      return json(502, { error: "Telegram rejected webhook registration." });
    }
    return json(200, { success: true, webhookUrl, description: result.description || "Webhook registered." });
  } catch (error) {
    console.error("Telegram setup error:", error && error.message || error);
    return json(502, { error: "Unable to contact Telegram." });
  }
};
