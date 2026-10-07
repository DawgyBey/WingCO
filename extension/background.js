importScripts("config.js");

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (apiKey) return apiKey;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ apiKey: fresh });
  return fresh;
}

// Headers that tie a request to the employee's company. The review ack is only sent for the exact
// company code the employee accepted the disclosure for.
async function orgHeaders() {
  const { orgCode = "", reviewAck = "", senderName = "", shareTrends = true } =
    await chrome.storage.local.get(["orgCode", "reviewAck", "senderName", "shareTrends"]);
  return {
    "X-Org-Code": orgCode,
    "X-Share-Trends": shareTrends ? "1" : "0",
    "X-Review-Ack": orgCode && reviewAck === orgCode ? "1" : "0",
    "X-Sender-Label": encodeURIComponent(senderName),
  };
}

async function post(path, body, extraHeaders = {}) {
  const apiKey = await getApiKey();
  const res = await fetch(WINGCO_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

const handlers = {
  async rewrite(msg) {
    const { res, data } = await post("/rewrite",
      { text: msg.text, tone: msg.tone, recipient: msg.recipient }, await orgHeaders());
    if (!res.ok) return { ok: false, status: res.status, paywall: !!data.paywall, error: data.detail || "Request failed" };
    return { ok: true, rewrite: data.rewrite, remaining: data.remaining, shared: data.shared, review: !!data.review };
  },
  async publish(msg) {
    const { res, data } = await post("/messages", { original: msg.original, polished: msg.polished }, await orgHeaders());
    if (!res.ok) return { ok: false, error: data.detail || "Publish failed" };
    return { ok: true, url: data.url, reviewed: !!data.reviewed };
  },
  async upgrade() { // opens Stripe checkout for the individual Pro plan
    const { res, data } = await post("/billing/checkout", { plan: "pro" });
    if (!res.ok || !data.url) return { ok: false, error: data.detail || "Couldn't start checkout" };
    await chrome.tabs.create({ url: data.url });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return;
  handler(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[WingCO]", msg.type, "failed:", err);
      sendResponse({ ok: false, error: "Can't reach the WingCO server. Is the backend running?", offline: true });
    });
  return true; // keep the channel open for the async response
});
