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
    }, "vee-ai-financial-core");
  }
  return app.database();
}

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  },
  body: JSON.stringify(body)
});

const CURRENCIES = new Set(["NGN", "USD", "GBP", "EUR", "GHS", "CAD", "AUD", "ZAR"]);
const ASSIGNMENTS = new Set(["personal", "business", "shared", "unassigned"]);
const WORKSPACE_TYPES = new Set(["personal", "business"]);
const DIRECTIONS = new Set(["credit", "debit"]);
const CATEGORIES = new Set([
  "personal_income", "personal_expense", "business_income", "business_expense",
  "personal_to_business", "business_to_personal", "business_to_business",
  "savings", "loan_received", "loan_principal_repayment", "loan_interest",
  "refund", "other"
]);

function cleanText(value, max, required) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error("A required text field is missing.");
  if (text.length > max) throw new Error("A text field exceeds its allowed length.");
  return text;
}

function safeId(value, label) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid " + label + ".");
  return id;
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000000) {
    throw new Error("Enter a valid positive transaction amount.");
  }
  return Math.round(amount * 100) / 100;
}

function baseState() {
  return {
    schemaVersion: 1,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    preferences: {
      reportingTimeZone: "Africa/Lagos",
      timezoneSource: "device-default",
      currency: "NGN"
    },
    workspaces: {
      personal: {
        id: "personal",
        type: "personal",
        name: "Personal Finance",
        status: "active",
        createdAtMs: Date.now()
      }
    },
    bankAccounts: {},
    transactions: {},
    ledger: {},
    audit: {},
    idempotency: {}
  };
}

function appendAudit(state, uid, action, recordType, recordId, details) {
  const id = "aud_" + crypto.randomUUID();
  state.audit[id] = {
    id,
    action,
    recordType,
    recordId,
    actorUid: uid,
    details: details || {},
    createdAtMs: Date.now()
  };
}

function sanitiseState(state) {
  const source = state || baseState();
  return {
    schemaVersion: source.schemaVersion || 1,
    preferences: source.preferences || {},
    workspaces: source.workspaces || {},
    bankAccounts: source.bankAccounts || {},
    transactions: source.transactions || {},
    ledger: source.ledger || {},
    audit: source.audit || {},
    updatedAtMs: source.updatedAtMs || null
  };
}

async function verifyUser(event) {
  database();
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new Error("Sign in to Vee-AI before using Financial Intelligence.");
  const decoded = await admin.auth(app).verifyIdToken(match[1], true);
  if (decoded.email_verified !== true) throw new Error("Verify your Vee-AI email before using Financial Intelligence.");
  return decoded;
}

async function mutateUser(uid, mutate) {
  const ref = database().ref("financialIntelligence/" + uid);
  let result;
  const committed = await ref.transaction(current => {
    const state = current && typeof current === "object" ? current : baseState();
    if (!state.workspaces || !state.workspaces.personal) {
      state.workspaces = state.workspaces || {};
      state.workspaces.personal = baseState().workspaces.personal;
    }
    result = mutate(state);
    state.updatedAtMs = Date.now();
    return state;
  }, undefined, false);
  if (!committed.committed) throw new Error("Financial record was not saved. Please retry.");
  return result;
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });
  if (Buffer.byteLength(event.body || "", "utf8") > 25000) return json(413, { error: "Request too large." });

  try {
    const user = await verifyUser(event);
    const body = JSON.parse(event.body || "{}");
    const action = cleanText(body.action, 40, true);
    const uid = user.uid;
    const root = database().ref("financialIntelligence/" + uid);

    if (action === "bootstrap") {
      const snapshot = await root.once("value");
      if (!snapshot.exists()) {
        await mutateUser(uid, state => {
          appendAudit(state, uid, "financial_profile_created", "profile", uid);
          return true;
        });
      }
      const saved = await root.once("value");
      return json(200, { success: true, data: sanitiseState(saved.val()) });
    }

    if (action === "savePreferences") {
      const timeZone = cleanText(body.timeZone, 80, true);
      try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
      catch (_) { throw new Error("Choose a valid device timezone."); }
      const currency = cleanText(body.currency || "NGN", 3, true).toUpperCase();
      if (!CURRENCIES.has(currency)) throw new Error("Unsupported default currency.");
      const saved = await mutateUser(uid, state => {
        state.preferences = {
          ...(state.preferences || {}),
          reportingTimeZone: timeZone,
          timezoneSource: "device",
          timezoneUpdatedAtMs: Date.now(),
          currency
        };
        appendAudit(state, uid, "preferences_updated", "preferences", "main", { timeZone, currency });
        return state.preferences;
      });
      return json(200, { success: true, preferences: saved });
    }

    if (action === "createWorkspace") {
      const type = cleanText(body.type, 20, true);
      if (!WORKSPACE_TYPES.has(type) || type !== "business") {
        throw new Error("Only additional business workspaces are created here.");
      }
      const name = cleanText(body.name, 120, true);
      const industry = cleanText(body.industry || "other", 80, false);
      const id = "biz_" + crypto.randomUUID().replace(/-/g, "");
      const workspace = await mutateUser(uid, state => {
        state.workspaces = state.workspaces || {};
        state.workspaces[id] = {
          id, type: "business", name, industry,
          status: "active", createdAtMs: Date.now()
        };
        appendAudit(state, uid, "workspace_created", "workspace", id, { name, industry });
        return state.workspaces[id];
      });
      return json(201, { success: true, workspace });
    }

    if (action === "assignBankAccount") {
      const accountId = body.accountId ? safeId(body.accountId, "bank account ID") : "bank_" + crypto.randomUUID().replace(/-/g, "");
      const assignment = cleanText(body.assignment, 20, true);
      if (!ASSIGNMENTS.has(assignment)) throw new Error("Choose personal, business, shared or unassigned.");
      const bankName = cleanText(body.bankName, 100, true);
      const maskedAccount = cleanText(body.maskedAccount || "", 32, false);
      const workspaceId = body.workspaceId ? safeId(body.workspaceId, "workspace ID") : "";
      const saved = await mutateUser(uid, state => {
        if (assignment === "business" && (!workspaceId || !state.workspaces[workspaceId] || state.workspaces[workspaceId].type !== "business")) {
          throw new Error("Select an existing business workspace.");
        }
        if (assignment === "personal" && workspaceId && workspaceId !== "personal") throw new Error("Personal accounts belong to Personal Finance.");
        const account = {
          id: accountId,
          bankName,
          maskedAccount,
          assignment,
          workspaceId: assignment === "personal" ? "personal" : (assignment === "business" ? workspaceId : null),
          status: "active",
          updatedAtMs: Date.now()
        };
        state.bankAccounts = state.bankAccounts || {};
        state.bankAccounts[accountId] = account;
        appendAudit(state, uid, "bank_account_assignment_updated", "bank_account", accountId, { assignment, workspaceId: account.workspaceId });
        return account;
      });
      return json(200, { success: true, bankAccount: saved });
    }

    if (action === "createTransaction") {
      const clientRequestId = safeId(body.clientRequestId, "request ID");
      const amount = money(body.amount);
      const currency = cleanText(body.currency || "NGN", 3, true).toUpperCase();
      if (!CURRENCIES.has(currency)) throw new Error("Unsupported transaction currency.");
      const direction = cleanText(body.direction, 10, true);
      if (!DIRECTIONS.has(direction)) throw new Error("Transaction direction must be credit or debit.");
      const category = cleanText(body.category || "other", 50, true);
      if (!CATEGORIES.has(category)) throw new Error("Choose a supported financial category.");
      const description = cleanText(body.description, 240, true);
      const transactionDate = cleanText(body.transactionDate, 40, true);
      if (!Number.isFinite(Date.parse(transactionDate))) throw new Error("Enter a valid transaction date.");
      const workspaceId = body.workspaceId ? safeId(body.workspaceId, "workspace ID") : "personal";
      const accountId = body.accountId ? safeId(body.accountId, "bank account ID") : "";
      const saved = await mutateUser(uid, state => {
        state.idempotency = state.idempotency || {};
        if (state.idempotency[clientRequestId]) return state.transactions[state.idempotency[clientRequestId]];
        if (!state.workspaces[workspaceId]) throw new Error("Select an existing financial workspace.");
        if (accountId && !state.bankAccounts[accountId]) throw new Error("Select a bank account belonging to your Vee-AI account.");
        const account = accountId ? state.bankAccounts[accountId] : null;
        if (account && account.assignment === "unassigned") throw new Error("Assign this bank account before posting a transaction.");
        if (account && account.assignment === "shared" && !body.workspaceId) throw new Error("Shared bank accounts require transaction-level workspace classification.");
        if (account && account.assignment === "personal" && workspaceId !== "personal") throw new Error("This bank account is assigned to Personal Finance.");
        if (account && account.assignment === "business" && account.workspaceId !== workspaceId) throw new Error("This bank account is assigned to another business.");
        const id = "txn_" + crypto.randomUUID().replace(/-/g, "");
        const record = {
          id, clientRequestId, workspaceId, accountId: accountId || null,
          amount, currency, direction, category, description,
          transactionDate, status: "needs_review",
          source: cleanText(body.source || "manual", 30, true),
          sourceReference: cleanText(body.sourceReference || "", 180, false),
          createdAtMs: Date.now(), createdByUid: uid
        };
        state.transactions = state.transactions || {};
        state.transactions[id] = record;
        state.idempotency[clientRequestId] = id;
        appendAudit(state, uid, "transaction_created_for_review", "transaction", id, { amount, currency, direction, workspaceId });
        return record;
      });
      return json(201, { success: true, transaction: saved });
    }

    if (action === "approveTransaction" || action === "rejectTransaction") {
      const transactionId = safeId(body.transactionId, "transaction ID");
      const saved = await mutateUser(uid, state => {
        const record = state.transactions && state.transactions[transactionId];
        if (!record) throw new Error("Transaction was not found.");
        if (record.status !== "needs_review") {
          if (record.status === "verified" && action === "approveTransaction") return record;
          throw new Error("Only transactions awaiting review are eligible for this action.");
        }
        if (action === "rejectTransaction") {
          record.status = "rejected";
          record.reviewedAtMs = Date.now();
          record.reviewedByUid = uid;
          appendAudit(state, uid, "transaction_rejected", "transaction", transactionId);
          return record;
        }
        const workspaceId = body.workspaceId ? safeId(body.workspaceId, "workspace ID") : record.workspaceId;
        if (!state.workspaces[workspaceId]) throw new Error("Select an existing financial workspace.");
        const category = cleanText(body.category || record.category, 50, true);
        if (!CATEGORIES.has(category)) throw new Error("Choose a supported financial category.");
        record.workspaceId = workspaceId;
        record.category = category;
        record.status = "verified";
        record.reviewedAtMs = Date.now();
        record.reviewedByUid = uid;
        record.ledgerEntryId = "led_" + crypto.randomUUID().replace(/-/g, "");
        state.ledger = state.ledger || {};
        state.ledger[record.ledgerEntryId] = {
          id: record.ledgerEntryId,
          transactionId,
          workspaceId,
          amount: record.amount,
          currency: record.currency,
          direction: record.direction,
          category: record.category,
          transactionDate: record.transactionDate,
          postedAtMs: Date.now(),
          status: "posted"
        };
        appendAudit(state, uid, "transaction_approved_and_posted", "transaction", transactionId, { workspaceId, ledgerEntryId: record.ledgerEntryId });
        return record;
      });
      return json(200, { success: true, transaction: saved });
    }

    if (action === "listTransactions") {
      const snapshot = await root.child("transactions").once("value");
      const records = Object.values(snapshot.val() || {});
      const status = cleanText(body.status || "", 30, false);
      const workspaceId = cleanText(body.workspaceId || "", 110, false);
      const filtered = records
        .filter(record => !status || record.status === status)
        .filter(record => !workspaceId || record.workspaceId === workspaceId)
        .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0))
        .slice(0, 200);
      return json(200, { success: true, transactions: filtered });
    }

    return json(400, { error: "Unknown Financial Intelligence action." });
  } catch (error) {
    const message = error && error.message ? error.message : "Financial request failed.";
    const status = /Sign in/.test(message) ? 401 : /Verify your Vee-AI email/.test(message) ? 403 : 400;
    console.error("Financial Intelligence request failed:", message);
    return json(status, { error: message });
  }
};
