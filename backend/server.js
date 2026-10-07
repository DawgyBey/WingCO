// WingCO backend (Node + Hugging Face). Run: npm start  (config in backend/.env)
// Privacy: raw drafts are never stored. Analytics keep only org, hashed uid, day, hour,
// recipient type, topic, intensity. Dashboard hides any group with < K_MIN distinct users.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Database from "better-sqlite3";
import Stripe from "stripe";
import dotenv from "dotenv";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(BASE_DIR, ".env") });

const FREE_TRIES = parseInt(process.env.FREE_TRIES, 10) || 3; // lifetime free rewrites for non-paying users
const IP_SLACK = 3; // per-network cap = FREE_TRIES * IP_SLACK (shared office networks), blocks reinstall-to-reset abuse
const K_MIN = 5;
const PORT = Number(process.env.PORT) || 8000;
const SALT = process.env.UID_SALT || "change-me";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_BASE_URL = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || "";
const HF_BASE_URL = (process.env.HF_BASE_URL || "https://router.huggingface.co/v1").replace(/\/$/, "");
const HF_MODEL = process.env.HF_MODEL || "Qwen/Qwen3-8B";
const AI_API_KEY = GROQ_API_KEY || HF_API_KEY;
const AI_BASE_URL = (GROQ_API_KEY ? GROQ_BASE_URL : HF_BASE_URL).replace(/\/$/, "");
const AI_MODEL = GROQ_API_KEY ? GROQ_MODEL : HF_MODEL;
const AI_MAX_TOKENS = parseInt(process.env.GROQ_MAX_TOKENS ?? process.env.HF_MAX_TOKENS, 10) || 1500; // headroom for reasoning models
const AI_TIMEOUT_MS = parseInt(process.env.GROQ_TIMEOUT_MS ?? process.env.HF_TIMEOUT_MS, 10) || 60000;
const DEV_PRO_KEYS = new Set((process.env.DEV_PRO_KEYS || "").split(",").filter(Boolean)); // dev only
const TOPICS = ["deadlines", "scope_changes", "unclear_requirements", "workload",
  "communication", "feedback_criticism", "payment_delays", "meetings", "other"];
const TONES = ["diplomatic", "direct", "apologetic", "firm-but-polite"];
const RECIPIENTS = ["manager", "client", "peer"];

if (!process.env.UID_SALT || process.env.UID_SALT === "change-me")
  console.warn("[wingco] WARNING: UID_SALT is still the default; set it in backend/.env for stable hashing.");
if (!process.env.MASTER_KEY)
  console.warn("[wingco] WARNING: MASTER_KEY is not set; org admin endpoints will reject requests until configured.");
if (!AI_API_KEY)
  console.warn("[wingco] WARNING: no AI API key is set; rewrite requests will fail until configured.");
console.log(`[wingco] Using ${GROQ_API_KEY ? "Groq" : "Hugging Face"} model ${AI_MODEL} via ${AI_BASE_URL}`);

const db = new Database(process.env.DB_PATH || path.join(BASE_DIR, "wingco.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS orgs(code TEXT PRIMARY KEY, name TEXT, admin_token TEXT);
CREATE TABLE IF NOT EXISTS events(org TEXT, uid TEXT, day TEXT, hour INT,
                                  recipient TEXT, topic TEXT, intensity INT);`);
const today = () => new Date().toISOString().slice(0, 10);
try { db.exec("ALTER TABLE orgs ADD COLUMN review_enabled INT NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
db.exec(`
CREATE TABLE IF NOT EXISTS free_usage(k TEXT PRIMARY KEY, n INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit(org TEXT, ts INT, action TEXT, msg_id TEXT);`);
// ---------- Free-tier paywall: FREE_TRIES lifetime rewrites, persisted in SQLite ----------
// Counted per client key AND per network, so wiping extension storage doesn't hand out new tries.
const freeUsed = (k) => db.prepare("SELECT n FROM free_usage WHERE k=?").get(k)?.n || 0;
const bump = db.prepare("INSERT INTO free_usage(k,n) VALUES (?,1) ON CONFLICT(k) DO UPDATE SET n=n+?");
const reserveFree = db.transaction((ck, ik) => {
  if (freeUsed(ck) >= FREE_TRIES || freeUsed(ik) >= FREE_TRIES * IP_SLACK) return false;
  bump.run(ck, 1); bump.run(ik, 1);
  return true;
});
const refundFree = db.transaction((ck, ik) => {
  for (const k of [ck, ik]) db.prepare("UPDATE free_usage SET n=MAX(0,n-1) WHERE k=?").run(k);
});
const freeKeys = (req, apiKey) => [`u:${crypto.createHash("sha256").update(apiKey).digest("hex")}`,
  `ip:${crypto.createHash("sha256").update(`${SALT}:${req.ip}`).digest("hex")}`];
const freeLeft = (req, apiKey) => {
  const [ck, ik] = freeKeys(req, apiKey);
  return Math.max(0, Math.min(FREE_TRIES - freeUsed(ck), FREE_TRIES * IP_SLACK - freeUsed(ik)));
};

// ---------- Billing (Stripe) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS subs(sub_id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT,
                                customer_id TEXT, status TEXT, seats INT);
CREATE TABLE IF NOT EXISTS members(org TEXT, uid TEXT, PRIMARY KEY(org, uid));`);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const BASE = process.env.BASE_URL || "http://localhost:8000";
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ACTIVE = "('active','trialing','past_due')"; // past_due = grace period while Stripe retries

// Pro if: the user has their own subscription, or their company has one with a free seat.
function isPro(apiKey, org) {
  if (DEV_PRO_KEYS.has(apiKey)) return true;
  if (db.prepare(`SELECT 1 FROM subs WHERE owner_type='user' AND owner_id=? AND status IN ${ACTIVE}`).get(sha(apiKey)))
    return true;
  if (org) {
    const sub = db.prepare(`SELECT seats FROM subs WHERE owner_type='org' AND owner_id=? AND status IN ${ACTIVE}`).get(org);
    if (sub) {
      const uid = sha(`${SALT}:${org}:${apiKey}`).slice(0, 16);
      db.prepare("INSERT OR IGNORE INTO members(org, uid) VALUES (?,?)").run(org, uid);
      const mine = db.prepare("SELECT rowid AS r FROM members WHERE org=? AND uid=?").get(org, uid).r;
      const rank = db.prepare("SELECT COUNT(*) AS n FROM members WHERE org=? AND rowid<=?").get(org, mine).n;
      return rank <= sub.seats; // first N people to join get seats
    }
  }
  return false;
}

const SYSTEM = `You rewrite workplace messages. Turn the user's raw, frustrated draft into a professional, polite, clear message.
Rules:
- Keep every factual point, real request, and deadline.
- Remove insults, sarcasm, blame, and profanity. Do not add facts or promises.
- Do not soften the actual ask into nothing. Match the requested tone and recipient.
- Keep the same language as the draft. Output the message only: no preamble, no explanations, no subject line unless the draft had one.
- Do not think out loud.
Also classify the draft. Respond with ONLY JSON, no markdown:
{"rewrite": "<message>", "topic": one of ${JSON.stringify(TOPICS)}, "intensity": integer 1-5 (1 calm, 5 furious)}`;

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "1"); // set TRUST_PROXY=1 behind nginx/Cloudflare so req.ip is the real client

const logRequest = (method, route, meta = {}) => {
  console.log(`[wingco] ${method} ${route}`, meta);
};

app.get("/health", (_req, res) => res.json({
  status: "ok",
  backend: "node",
  provider: GROQ_API_KEY ? "groq" : "huggingface",
  model: AI_MODEL,
  ai_configured: !!AI_API_KEY,
  billing_configured: !!stripe,
}));

// Webhook needs the RAW body for signature verification, so it is registered before express.json()
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(503).end();
  let ev;
  try {
    ev = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
  } catch { return res.status(400).send("bad signature"); }
  if (ev.type.startsWith("customer.subscription.")) {
    const sub = ev.data.object, m = sub.metadata || {};
    if (m.owner_type && m.owner_id) {
      db.prepare(`INSERT INTO subs(sub_id,owner_type,owner_id,customer_id,status,seats) VALUES (?,?,?,?,?,?)
        ON CONFLICT(sub_id) DO UPDATE SET status=excluded.status, seats=excluded.seats`)
        .run(sub.id, m.owner_type, m.owner_id, sub.customer, sub.status, sub.items?.data?.[0]?.quantity || 1);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "20kb" }));

// ---- Hugging Face chat completion (OpenAI-compatible router) ----
async function callHF(messages) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const r = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${AI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: AI_MODEL, temperature: 0.2, max_tokens: AI_MAX_TOKENS, messages }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return data;
      const msg = typeof data?.error === "string" ? data.error : data?.error?.message || `${GROQ_API_KEY ? "Groq" : "HF"} error ${r.status}`;
      lastErr = new Error(`${r.status}: ${msg}`);
      if (![429, 502, 503, 504].includes(r.status)) throw lastErr; // only retry transient failures
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`${GROQ_API_KEY ? "Groq" : "Hugging Face"} request timed out`) : e;
      if (/^[0-9]{3}:/.test(lastErr.message) && !/^(429|50[234]):/.test(lastErr.message)) throw lastErr;
    } finally { clearTimeout(timer); }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw lastErr;
}

// Turn the model's raw output into { rewrite, topic, intensity }, tolerating <think> blocks,
// markdown fences, text around the JSON, and plain-text answers.
function parseModelOutput(content) {
  let raw = Array.isArray(content)
    ? content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
    : String(content ?? "");
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (/<think>/i.test(raw)) throw new Error("Model ran out of tokens while thinking; raise HF_MAX_TOKENS or pick a non-reasoning model");
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let rewrite = raw, topic = "other", intensity = 3;
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try {
      const d = JSON.parse(raw.slice(a, b + 1));
      if (typeof d.rewrite === "string" && d.rewrite.trim()) rewrite = d.rewrite.trim();
      if (TOPICS.includes(d.topic)) topic = d.topic;
      intensity = parseInt(d.intensity, 10) || 3;
    } catch { /* not JSON; use the raw text */ }
  }
  if (!rewrite) throw new Error("Empty model response");
  return { rewrite, topic, intensity: Math.max(1, Math.min(5, intensity)) };
}

app.post("/rewrite", async (req, res) => {
  const apiKey = req.get("x-api-key") || "";
  const org = (req.get("x-org-code") || "").trim();
  const share = req.get("x-share-trends") !== "0";
  let { text, tone = "diplomatic", recipient = "manager" } = req.body || {};
  logRequest("POST", "/rewrite", { hasApiKey: !!apiKey, org: org || null,
    textLength: typeof text === "string" ? text.length : 0, tone, recipient, share });
  if (!apiKey) return res.status(401).json({ detail: "Missing API key" });
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    return res.status(422).json({ detail: "Text must be 1-4000 characters" });
  if (!AI_API_KEY) return res.status(503).json({ detail: "Server has no AI API key configured" });
  if (!TONES.includes(tone)) tone = "diplomatic";
  if (!RECIPIENTS.includes(recipient)) recipient = "manager";

  const pro = isPro(apiKey, org);
  const [ck, ik] = freeKeys(req, apiKey);
  if (!pro && !reserveFree(ck, ik))
    return res.status(402).json({ paywall: true, limit: FREE_TRIES,
      detail: `You've used your ${FREE_TRIES} free rewrites. Upgrade to WingCO Pro to keep going.` });

  try {
    const data = await callHF([
      { role: "system", content: SYSTEM },
      { role: "user", content: `Tone: ${tone}\nRecipient: ${recipient}\n\nDraft:\n${text}` },
    ]);
    const { rewrite, topic, intensity } = parseModelOutput(data?.choices?.[0]?.message?.content);

    let shared = false;
    if (org && share && db.prepare("SELECT 1 FROM orgs WHERE code=?").get(org)) {
      const uid = sha(`${SALT}:${org}:${apiKey}`).slice(0, 16);
      db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)").run(
        org, uid, today(), new Date().getHours(), RECIPIENTS.includes(recipient) ? recipient : "other", topic, intensity);
      shared = true;
    }
    const review = !!org && req.get("x-review-ack") === "1" &&
      !!db.prepare("SELECT 1 FROM orgs WHERE code=? AND review_enabled=1").get(org);
    res.json({ rewrite, remaining: pro ? null : freeLeft(req, apiKey), shared, review });
  } catch (e) {
    if (!pro) refundFree(ck, ik); // failed calls don't use up a free try
    console.error("[wingco] /rewrite failed:", e?.message || e);
    const auth = /^40[13]:/.test(e?.message || "");
    res.status(502).json({ detail: auth ? "Hugging Face rejected the API key or model access" : "Rewrite failed, please try again" });
  }
});

// ---------- B2B ----------
app.post("/admin/orgs", (req, res) => {
  const mk = process.env.MASTER_KEY;
  const given = req.get("x-master-key") || "";
  if (!mk || !crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(mk))))
    return res.status(403).json({ detail: "Forbidden" });
  const name = String(req.query.name || "").slice(0, 100);
  if (!name) return res.status(422).json({ detail: "name required" });
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO orgs(code,name,admin_token) VALUES (?,?,?)").run(code, name, token);
  res.json({ org_code: code, admin_token: token });
});

const COLS = new Set(["day", "hour", "recipient", "topic"]);
const agg = (org, col, cutoff) => {
  if (!COLS.has(col)) throw new Error("bad column");
  return db.prepare(`SELECT ${col} AS key, COUNT(*) AS count, ROUND(AVG(intensity),2) AS avg_intensity
    FROM events WHERE org=? AND day>=? GROUP BY ${col}
    HAVING COUNT(DISTINCT uid) >= ? ORDER BY ${col}`).all(org, cutoff, K_MIN);
};

app.get("/api/summary", (req, res) => {
  const row = db.prepare("SELECT code, name FROM orgs WHERE admin_token=?").get(req.get("x-admin-token") || "");
  if (!row) return res.status(401).json({ detail: "Invalid admin token" });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const s = db.prepare(`SELECT COUNT(DISTINCT uid) AS users, COUNT(*) AS total, ROUND(AVG(intensity),2) AS avg
    FROM events WHERE org=? AND day>=?`).get(row.code, cutoff);
  if (s.users < K_MIN) return res.json({ org: row.name, insufficient: true, k: K_MIN });
  res.json({
    org: row.name, k: K_MIN, active_users: s.users, rewrites: s.total, avg_intensity: s.avg,
    by_day: agg(row.code, "day", cutoff), by_topic: agg(row.code, "topic", cutoff),
    by_recipient: agg(row.code, "recipient", cutoff), by_hour: agg(row.code, "hour", cutoff),
  });
});

// ---------- Billing routes ----------
const orgByAdmin = (req) => db.prepare("SELECT code FROM orgs WHERE admin_token=?").get(req.get("x-admin-token") || "");

app.post("/billing/checkout", async (req, res) => {
  if (!stripe) return res.status(503).json({ detail: "Billing not configured" });
  const { plan, seats } = req.body || {};
  let owner_type, owner_id, price, quantity = 1;
  if (plan === "pro") {
    const k = req.get("x-api-key");
    if (!k) return res.status(401).json({ detail: "Missing API key" });
    [owner_type, owner_id, price] = ["user", sha(k), process.env.STRIPE_PRICE_PRO];
  } else if (plan === "unmask") {
    const k = req.get("x-api-key");
    if (!k) return res.status(401).json({ detail: "Missing viewer key" });
    [owner_type, owner_id, price] = ["viewer", sha(k), process.env.STRIPE_PRICE_UNMASK];
  } else if (plan === "team") {
    const o = orgByAdmin(req);
    if (!o) return res.status(401).json({ detail: "Invalid admin token" });
    [owner_type, owner_id, price] = ["org", o.code, process.env.STRIPE_PRICE_TEAM];
    quantity = Math.max(K_MIN, Math.min(parseInt(seats, 10) || K_MIN, 10000));
  } else return res.status(422).json({ detail: "plan must be 'pro', 'team' or 'unmask'" });
  if (!price) return res.status(503).json({ detail: `Stripe price for the ${plan} plan is not configured` });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity }],
      subscription_data: { metadata: { owner_type, owner_id } },
      allow_promotion_codes: true,
      success_url: /^\/m\/[\w-]{6,20}$/.test(req.body?.returnPath || "") ? BASE + req.body.returnPath : `${BASE}/billing/done`,
      cancel_url: `${BASE}/billing/done?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (e) { console.error(e); res.status(502).json({ detail: "Could not start checkout" }); }
});

app.post("/billing/portal", async (req, res) => {
  if (!stripe) return res.status(503).json({ detail: "Billing not configured" });
  const o = orgByAdmin(req);
  const [type, id] = o ? ["org", o.code] : ["user", sha(req.get("x-api-key") || "")];
  const row = db.prepare("SELECT customer_id FROM subs WHERE owner_type=? AND owner_id=? ORDER BY rowid DESC").get(type, id);
  if (!row) return res.status(404).json({ detail: "No subscription found" });
  try {
    const s = await stripe.billingPortal.sessions.create({ customer: row.customer_id, return_url: `${BASE}/billing/done` });
    res.json({ url: s.url });
  } catch (e) { console.error(e); res.status(502).json({ detail: "Could not open billing portal" }); }
});

app.get("/billing/status", (req, res) => {
  const k = req.get("x-api-key") || "";
  const pro = isPro(k, (req.get("x-org-code") || "").trim());
  const left = pro || !k ? null : freeLeft(req, k);
  res.json({ pro, limit: FREE_TRIES, remaining: left, paywalled: left === 0, billing: !!stripe });
});

app.get("/billing/done", (req, res) => res.send(
  `<body style="font:16px system-ui;text-align:center;padding:60px"><h2>${req.query.canceled ? "No changes made." : "You're all set 🎉"}</h2><p>You can close this tab and keep using WingCO.</p>`));

// ---------- Unmask: Premium recipients can see the sender's original ----------
// The sender is always told (panel warning + visible link in the message). Originals are
// AES-256-GCM encrypted at rest and auto-deleted after RETENTION_DAYS.
db.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, sender TEXT, polished TEXT,
                                             original_enc TEXT, expires INT);`);
for (const col of ["org TEXT", "label TEXT", "created INT"]) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch { /* already migrated */ }
}
// Encryption key: MESSAGE_KEY if set, otherwise a random key generated once and kept in .message_key
const keyMaterial = process.env.MESSAGE_KEY || (() => {
  const f = path.join(BASE_DIR, ".message_key");
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(f, "utf8").trim();
})();
const MSG_KEY = crypto.createHash("sha256").update(keyMaterial).digest();
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS, 10) || 30;
const DEV_UNMASK_KEYS = new Set((process.env.DEV_UNMASK_KEYS || "").split(",").filter(Boolean));
const enc = (t) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", MSG_KEY, iv);
  const body = Buffer.concat([c.update(t, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
};
const dec = (s) => {
  const b = Buffer.from(s, "base64"), d = crypto.createDecipheriv("aes-256-gcm", MSG_KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
};
setInterval(() => db.prepare("DELETE FROM messages WHERE expires<?").run(Date.now()), 3600e3).unref();
const canUnmask = (k) => !!k && (DEV_UNMASK_KEYS.has(k) ||
  !!db.prepare(`SELECT 1 FROM subs WHERE owner_type='viewer' AND owner_id=? AND status IN ${ACTIVE}`).get(sha(k)));

app.post("/messages", (req, res) => {
  const k = req.get("x-api-key");
  const { original, polished } = req.body || {};
  logRequest("POST", "/messages", { hasApiKey: !!k,
    originalLength: typeof original === "string" ? original.length : 0,
    polishedLength: typeof polished === "string" ? polished.length : 0 });
  if (!k) return res.status(401).json({ detail: "Missing API key" });
  if (![original, polished].every((v) => typeof v === "string" && v.trim() && v.length <= 4000))
    return res.status(422).json({ detail: "original and polished required (max 4000 chars)" });
  // Company review: only when the org turned it on AND this employee acknowledged the disclosure.
  const org = (req.get("x-org-code") || "").trim();
  const reviewOrg = org && req.get("x-review-ack") === "1" &&
    db.prepare("SELECT code FROM orgs WHERE code=? AND review_enabled=1").get(org)?.code || null;
  let label = null;
  if (reviewOrg) {
    let name = "";
    try { name = decodeURIComponent(req.get("x-sender-label") || ""); } catch { /* ignore bad encoding */ }
    label = name.trim().slice(0, 60) || `Member ${sha(`${SALT}:${org}:${k}`).slice(0, 6)}`;
  }
  const id = crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO messages(id,sender,polished,original_enc,expires,org,label,created) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, sha(k), polished, enc(original), Date.now() + RETENTION_DAYS * 864e5, reviewOrg, label, Date.now());
  res.json({ id, url: `${BASE}/m/${id}`, reviewed: !!reviewOrg });
});

app.get("/api/m/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM messages WHERE id=? AND expires>?").get(req.params.id, Date.now());
  if (!m) return res.status(404).json({ detail: "Message not found or expired" });
  const unlocked = canUnmask(req.get("x-viewer-key"));
  res.json({ polished: m.polished, unlocked, original: unlocked ? dec(m.original_enc) : null,
             retention_days: RETENTION_DAYS, expires: m.expires });
});

// Senders can delete their own message (and its stored original) at any time
app.delete("/api/m/:id", (req, res) => {
  const r = db.prepare("DELETE FROM messages WHERE id=? AND sender=?").run(req.params.id, sha(req.get("x-api-key") || ""));
  res.status(r.changes ? 200 : 404).json({ deleted: r.changes });
});

// ---------- Company dashboard: message review (opt-in per org, disclosed to employees, audited) ----------
const adminOrg = (req, res) => {
  const o = db.prepare("SELECT code, name, review_enabled FROM orgs WHERE admin_token=?").get(req.get("x-admin-token") || "");
  if (!o) res.status(401).json({ detail: "Invalid admin token" });
  return o;
};

// Public: lets the extension tell employees what joining this org means before they accept.
app.get("/org/info", (req, res) => {
  const o = db.prepare("SELECT name, review_enabled FROM orgs WHERE code=?").get(String(req.query.code || "").trim().toUpperCase());
  if (!o) return res.status(404).json({ detail: "Unknown company code" });
  res.json({ name: o.name, review: !!o.review_enabled, retention_days: RETENTION_DAYS });
});

app.get("/api/org/settings", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  res.json({ name: o.name, code: o.code, review_enabled: !!o.review_enabled, retention_days: RETENTION_DAYS });
});
app.post("/api/org/settings", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  const on = req.body?.review_enabled ? 1 : 0;
  db.prepare("UPDATE orgs SET review_enabled=? WHERE code=?").run(on, o.code);
  db.prepare("INSERT INTO audit VALUES (?,?,?,?)").run(o.code, Date.now(), on ? "review_enabled" : "review_disabled", null);
  res.json({ review_enabled: !!on });
});

app.get("/api/org/messages", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const before = parseInt(req.query.before, 10) || Date.now() + 1;
  const rows = db.prepare(`SELECT id, label, created, polished FROM messages
    WHERE org=? AND expires>? AND created<? ORDER BY created DESC LIMIT ?`).all(o.code, Date.now(), before, limit);
  res.json({ messages: rows, next: rows.length === limit ? rows[rows.length - 1].created : null });
});
app.get("/api/org/messages/:id", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  const m = db.prepare("SELECT * FROM messages WHERE id=? AND org=? AND expires>?").get(req.params.id, o.code, Date.now());
  if (!m) return res.status(404).json({ detail: "Message not found or expired" });
  db.prepare("INSERT INTO audit VALUES (?,?,?,?)").run(o.code, Date.now(), "viewed_original", m.id);
  res.json({ id: m.id, label: m.label, created: m.created, polished: m.polished, original: dec(m.original_enc),
             expires: m.expires });
});
app.delete("/api/org/messages/:id", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  const r = db.prepare("DELETE FROM messages WHERE id=? AND org=?").run(req.params.id, o.code);
  if (r.changes) db.prepare("INSERT INTO audit VALUES (?,?,?,?)").run(o.code, Date.now(), "deleted_message", req.params.id);
  res.status(r.changes ? 200 : 404).json({ deleted: r.changes });
});
app.get("/api/org/audit", (req, res) => {
  const o = adminOrg(req, res); if (!o) return;
  res.json({ entries: db.prepare("SELECT ts, action, msg_id FROM audit WHERE org=? ORDER BY ts DESC LIMIT 200").all(o.code) });
});

app.get("/message.css", (_req, res) => res.sendFile(path.join(BASE_DIR, "message.css")));
app.get("/message.js", (_req, res) => res.sendFile(path.join(BASE_DIR, "message.js")));
app.get("/m/:id", (_req, res) => res.sendFile(path.join(BASE_DIR, "message.html")));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(BASE_DIR, "dashboard.html")));
app.get("/", (_req, res) => res.redirect("/health"));

// JSON-only errors (bad JSON, oversized body, ...) instead of Express's HTML error page
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error("[wingco] unhandled error:", err);
  res.status(status).json({ detail: status === 413 ? "Text is too long" : status < 500 ? "Bad request" : "Server error" });
});

app.listen(PORT, () => console.log(`WingCO backend on http://localhost:${PORT}`));
