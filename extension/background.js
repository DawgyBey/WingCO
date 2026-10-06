const API_URL = "http://localhost:8000/rewrite"; // change for production
const HEALTH_URL = "http://localhost:8000/health";

chrome.runtime.onInstalled.addListener(async () => {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) await chrome.storage.local.set({ apiKey: crypto.randomUUID() });
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type !== "health") return;
  (async () => {
    try {
      const res = await fetch(HEALTH_URL, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const ok = res.ok && data?.status === "ok";
      console.log("[WingCO] health check", { ok, status: res.status, data });
      sendResponse({ ok, status: res.status, data });
    } catch (err) {
      console.error("[WingCO] health check failed", err);
      sendResponse({ ok: false, error: err?.message || "backend unavailable" });
    }
  })();
  return true;
});

// Saves the original so Unmask-Premium recipients can view it via the link added to the message
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type !== "publish") return;
  (async () => {
    try {
      const { apiKey = "" } = await chrome.storage.local.get("apiKey");
      console.log("[WingCO] publishing message link", { originalLength: msg.original?.length || 0, polishedLength: msg.polished?.length || 0 });
      const res = await fetch(API_URL.replace("/rewrite", "/messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({ original: msg.original, polished: msg.polished }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("[WingCO] publish failed", data);
        return sendResponse({ ok: false, error: data.detail || "Publish failed" });
      }
      sendResponse({ ok: true, url: data.url });
    } catch (err) {
      console.error("[WingCO] publish request failed", err);
      sendResponse({ ok: false, error: "Can't reach WingCO server" });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type !== "rewrite") return;
  (async () => {
    try {
      const { apiKey = "", orgCode = "", shareTrends = true } =
        await chrome.storage.local.get(["apiKey", "orgCode", "shareTrends"]);
      console.log("[WingCO] sending rewrite request from extension", {
        textLength: msg.text?.length || 0,
        tone: msg.tone,
        recipient: msg.recipient,
        orgCode: orgCode || null,
      });
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey,
                   "X-Org-Code": orgCode, "X-Share-Trends": shareTrends ? "1" : "0" },
        body: JSON.stringify({ text: msg.text, tone: msg.tone, recipient: msg.recipient }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("[WingCO] rewrite request failed", { status: res.status, body: data });
        return sendResponse({ ok: false, error: data.detail || "Request failed" });
      }
      console.log("[WingCO] rewrite success", { remaining: data.remaining, shared: !!data.shared });
      sendResponse({ ok: true, rewrite: data.rewrite, remaining: data.remaining, shared: data.shared });
    } catch (e) {
      console.error("[WingCO] rewrite request crashed", e);
      sendResponse({ ok: false, error: "Can't reach WingCO server" });
    }
  })();
  return true;
});
