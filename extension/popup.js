const BASE = "http://localhost:8000"; // change for production
let apiKey = "";

async function headers() {
  const s = await chrome.storage.local.get(["apiKey", "orgCode"]);
  apiKey = s.apiKey || crypto.randomUUID();
  if (!s.apiKey) await chrome.storage.local.set({ apiKey });
  return { "Content-Type": "application/json", "X-API-Key": apiKey, "X-Org-Code": s.orgCode || "" };
}

async function init() {
  const s = await chrome.storage.local.get(["orgCode", "shareTrends"]);
  orgCode.value = s.orgCode || "";
  shareTrends.checked = s.shareTrends !== false;
  try {
    const r = await (await fetch(BASE + "/billing/status", { headers: await headers() })).json();
    plan.textContent = r.pro ? "Pro ✓" : "Free";
    upgrade.style.display = r.pro ? "none" : "";
    manage.style.display = r.pro ? "" : "none";
  } catch { plan.textContent = "offline"; }
}

async function go(path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: await headers(), body: JSON.stringify(body || {}) });
  const d = await r.json();
  if (d.url) chrome.tabs.create({ url: d.url }); else ok.textContent = d.detail || "Error";
}
upgrade.onclick = () => go("/billing/checkout", { plan: "pro" });
manage.onclick = () => go("/billing/portal");
save.onclick = async () => {
  await chrome.storage.local.set({ orgCode: orgCode.value.trim().toUpperCase(), shareTrends: shareTrends.checked });
  ok.textContent = "Saved ✓"; init();
};
init();
