// WingCO backend (Node). Run: ANTHROPIC_API_KEY=... MASTER_KEY=... UID_SALT=... npm start
// Privacy: raw drafts are never stored. Analytics keep only org, hashed uid, day, hour,
// recipient type, topic, intensity. Dashboard hides any group with < K_MIN distinct users.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Database from "better-sqlite3";
import { MongoClient } from "mongodb";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env") });

const MODEL = "claude-sonnet-5-5";
const FREE_DAILY_LIMIT = 10;
const K_MIN = 5;
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
const SALT = process.env.UID_SALT || "change-me";
const HF_BASE_URL = (process.env.HF_BASE_URL || "https://router.huggingface.co/v1").replace(/\/$/, "");
const HF_MODEL = process.env.HF_MODEL || "Qwen/Qwen3-8B";
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || "";
const DEV_PRO_KEYS = new Set((process.env.DEV_PRO_KEYS || "").split(",").filter(Boolean)); // dev only
const TOPICS = ["deadlines", "scope_changes", "unclear_requirements", "workload",
  "communication", "feedback_criticism", "payment_delays", "meetings", "other"];

if (!process.env.UID_SALT || process.env.UID_SALT === "change-me") {
  console.warn("[wingco] WARNING: UID_SALT is still the default; set it in backend/.env for stable hashing.");
}
if (!process.env.MASTER_KEY) {
  console.warn("[wingco] WARNING: MASTER_KEY is not set; org admin endpoints will reject requests until configured.");
}
if (!HF_API_KEY) {
  console.warn("[wingco] WARNING: HUGGINGFACE_API_KEY is not set; rewrite requests will fail until configured.");
}

const mongoUri = process.env.MONGODB_URI?.trim();
let mongoDb = null;
if (mongoUri) {
  try {
    const mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    mongoDb = mongoClient.db();
    console.log("[wingco] Connected to MongoDB");
  } catch (err) {
    console.warn("[wingco] WARNING: MongoDB connection failed:", err.message || err);
  }
}
const db = new Database(path.join(BASE_DIR, "wingco.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS orgs(code TEXT PRIMARY KEY, name TEXT, admin_token TEXT);
CREATE TABLE IF NOT EXISTS events(org TEXT, uid TEXT, day TEXT, hour INT,
                                  recipient TEXT, topic TEXT, intensity INT);`);
const usage = new Map(); // TODO: Redis

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
Also classify the draft. Respond with ONLY JSON, no markdown:
{"rewrite": "<message>", "topic": one of ${JSON.stringify(TOPICS)}, "intensity": integer 1-5 (1 calm, 5 furious)}`;

const today = () => new Date().toISOString().slice(0, 10);
const app = express();

const logRequest = (method, route, meta = {}) => {
  console.log(`[wingco] ${method} ${route}`, meta);
};

app.get("/health", (_req, res) => res.json({
  status: "ok",
  backend: "node",
  database: mongoDb ? "mongodb" : "sqlite",
  database_path: mongoDb ? process.env.MONGODB_URI : path.join(BASE_DIR, "wingco.db"),
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

app.post("/rewrite", async (req, res) => {
  const apiKey = req.get("x-api-key") || "";
  const org = (req.get("x-org-code") || "").trim();
  const share = req.get("x-share-trends") !== "0";
  const { text, tone = "diplomatic", recipient = "manager" } = req.body || {};
  logRequest("POST", "/rewrite", {
    hasApiKey: !!apiKey,
    org: org || null,
    textLength: typeof text === "string" ? text.length : 0,
    tone,
    recipient,
    share,
  });
  if (!apiKey) return res.status(401).json({ detail: "Missing API key" });
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    return res.status(422).json({ detail: "Text must be 1-4000 characters" });

  let remaining = null;
  if (!isPro(apiKey, org)) {
    const k = `${apiKey}:${today()}`;
    const n = usage.get(k) || 0;
    if (n >= FREE_DAILY_LIMIT)
      return res.status(402).json({ detail: "Daily free limit reached. Upgrade to WingCO Pro." });
    usage.set(k, n + 1);
    remaining = FREE_DAILY_LIMIT - n - 1;
  }

  try {
    const response = await fetch(`${HF_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HF_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Tone: ${tone}\nRecipient: ${recipient}\n\nDraft:\n${text}` },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = data?.error?.message || "HF chat completion request failed";
      throw new Error(details);
    }

    const content = data?.choices?.[0]?.message?.content;
    const raw = Array.isArray(content)
      ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("")
      : (typeof content === "string" ? content : String(content || "")).trim();

    let out, topic = "other", intensity = 3;
    try {
      const d = JSON.parse(raw.replace(/^```json/, "").replace(/```$/, "").trim());
      out = d.rewrite; topic = d.topic; intensity = parseInt(d.intensity, 10) || 3;
    } catch { out = raw; }
    if (!TOPICS.includes(topic)) topic = "other";
    intensity = Math.max(1, Math.min(5, intensity));

    let shared = false;
    if (org && share && db.prepare("SELECT 1 FROM orgs WHERE code=?").get(org)) {
      const uid = crypto.createHash("sha256").update(`${SALT}:${org}:${apiKey}`).digest("hex").slice(0, 16);
      db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?)").run(
        org, uid, today(), new Date().getHours(),
        ["manager", "client", "peer"].includes(recipient) ? recipient : "other", topic, intensity);
      shared = true;
    }
    res.json({ rewrite: out, remaining, shared });
  } catch (e) {
    console.error("[wingco] /rewrite failed", {
      message: e?.message || String(e),
      stack: e?.stack || null,
      apiKeyPresent: !!apiKey,
      org: org || null,
      textLength: typeof text === "string" ? text.length : 0,
    });
    res.status(502).json({ detail: "Rewrite failed, try again" });
  }
});

// ---------- B2B ----------
app.post("/admin/orgs", (req, res) => {
  const mk = process.env.MASTER_KEY;
  if (!mk || req.get("x-master-key") !== mk) return res.status(403).json({ detail: "Forbidden" });
  const name = String(req.query.name || "").slice(0, 100);
  if (!name) return res.status(422).json({ detail: "name required" });
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const token = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO orgs VALUES (?,?,?)").run(code, name, token);
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
  } else return res.status(422).json({ detail: "plan must be 'pro' or 'team'" });
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

app.get("/billing/status", (req, res) =>
  res.json({ pro: isPro(req.get("x-api-key") || "", (req.get("x-org-code") || "").trim()) }));

app.get("/billing/done", (req, res) => res.send(
  `<body style="font:16px system-ui;text-align:center;padding:60px"><h2>${req.query.canceled ? "No changes made." : "You're all set 🎉"}</h2><p>You can close this tab and keep using WingCO.</p>`));

// ---------- Unmask: Premium recipients can see the sender's original ----------
// The sender is always told (panel warning + visible link in the message). Originals are
// AES-256-GCM encrypted at rest and auto-deleted after RETENTION_DAYS.
db.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, sender TEXT, polished TEXT,
                                             original_enc TEXT, expires INT);`);
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
  logRequest("POST", "/messages", {
    hasApiKey: !!k,
    originalLength: typeof original === "string" ? original.length : 0,
    polishedLength: typeof polished === "string" ? polished.length : 0,
  });
  if (!k) return res.status(401).json({ detail: "Missing API key" });
  if (![original, polished].every((v) => typeof v === "string" && v.trim() && v.length <= 4000))
    return res.status(422).json({ detail: "original and polished required (max 4000 chars)" });
  const id = crypto.randomBytes(6).toString("base64url");
  db.prepare("INSERT INTO messages VALUES (?,?,?,?,?)")
    .run(id, sha(k), polished, enc(original), Date.now() + RETENTION_DAYS * 864e5);
  console.log("[wingco] message stored", { id, senderHash: sha(k) });
  res.json({ id, url: `${BASE}/m/${id}` });
});

app.get("/api/m/:id", (req, res) => {
  const m = db.prepare("SELECT * FROM messages WHERE id=? AND expires>?").get(req.params.id, Date.now());
  if (!m) return res.status(404).json({ detail: "Message not found or expired" });
  const unlocked = canUnmask(req.get("x-viewer-key"));
  res.json({ polished: m.polished, unlocked, original: unlocked ? dec(m.original_enc) : null });
});

// Senders can delete their own message (and its stored original) at any time
app.delete("/api/m/:id", (req, res) => {
  const r = db.prepare("DELETE FROM messages WHERE id=? AND sender=?").run(req.params.id, sha(req.get("x-api-key") || ""));
  res.status(r.changes ? 200 : 404).json({ deleted: r.changes });
});

app.get("/message.css", (_req, res) => res.sendFile(path.join(here, "message.css")));
app.get("/message.js", (_req, res) => res.sendFile(path.join(here, "message.js")));
app.get("/m/:id", (_req, res) => res.sendFile(path.join(here, "message.html")));

const here = path.dirname(fileURLToPath(import.meta.url));
app.get("/dashboard", (_req, res) => res.sendFile(path.join(here, "dashboard.html")));

app.listen(PORT, () => console.log(`WingCO backend on http://localhost:${PORT}`));
