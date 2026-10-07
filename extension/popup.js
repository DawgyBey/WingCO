const $ = (id) => document.getElementById(id);

async function headers() {
  const s = await chrome.storage.local.get(["apiKey", "orgCode"]);
  let apiKey = s.apiKey;
  if (!apiKey) { apiKey = crypto.randomUUID(); await chrome.storage.local.set({ apiKey }); }
  return { "Content-Type": "application/json", "X-API-Key": apiKey, "X-Org-Code": s.orgCode || "" };
}

function setStatus(online) {
  $("dot").className = "dot " + (online ? "on" : "off");
  $("dot").title = online ? "Server online" : "Server offline";
}

let orgInfo = null; // result of /org/info for the code in the field

async function checkOrg() {
  const code = $("orgCode").value.trim().toUpperCase();
  orgInfo = null; $("review").hidden = true;
  if (!code) return;
  try {
    const r = await fetch(`${WINGCO_BASE}/org/info?code=${encodeURIComponent(code)}`);
    if (!r.ok) { $("msg").className = "err"; $("msg").textContent = "Unknown company code"; return; }
    orgInfo = await r.json();
    $("msg").textContent = "";
    if (orgInfo.review) {
      $("orgName").textContent = orgInfo.name; $("days").textContent = orgInfo.retention_days;
      $("review").hidden = false;
    }
  } catch { /* offline: reported on save */ }
}

async function init() {
  const s = await chrome.storage.local.get(["orgCode", "shareTrends", "senderName", "reviewAck"]);
  $("senderName").value = s.senderName || "";
  $("ack").checked = !!s.orgCode && s.reviewAck === s.orgCode;
  $("orgCode").value = s.orgCode || "";
  $("shareTrends").checked = s.shareTrends !== false;
  try {
    const r = await (await fetch(WINGCO_BASE + "/billing/status", { headers: await headers() })).json();
    setStatus(true);
    $("plan").textContent = r.pro ? "Pro" : "Free";
    $("plan").classList.toggle("pro", !!r.pro);
    $("usage").textContent = r.pro ? "Unlimited rewrites"
      : r.remaining === 0 ? `You've used all ${r.limit} free rewrites. Upgrade to keep going.`
      : `${r.remaining} of ${r.limit} free rewrites left`;
    $("usage").className = !r.pro && r.remaining === 0 ? "warn" : "";
    $("upgrade").hidden = r.pro || !r.billing;
    $("manage").hidden = !r.pro || !r.billing;
  } catch {
    setStatus(false);
    $("plan").textContent = "Offline";
    $("usage").textContent = "Can't reach the WingCO server. Start it with: cd backend && npm start";
  }
}

async function go(path, body) {
  $("msg").className = "";
  try {
    const r = await fetch(WINGCO_BASE + path, { method: "POST", headers: await headers(), body: JSON.stringify(body || {}) });
    const d = await r.json();
    if (d.url) chrome.tabs.create({ url: d.url });
    else { $("msg").className = "err"; $("msg").textContent = d.detail || "Something went wrong"; }
  } catch { $("msg").className = "err"; $("msg").textContent = "Can't reach the WingCO server."; }
}

$("upgrade").onclick = () => go("/billing/checkout", { plan: "pro" });
$("manage").onclick = () => go("/billing/portal");
$("orgCode").addEventListener("change", checkOrg);
$("save").onclick = async () => {
  const code = $("orgCode").value.trim().toUpperCase();
  await checkOrg();
  if (code && !orgInfo) { $("msg").className = "err"; $("msg").textContent = "Unknown company code"; return; }
  const needsAck = !!code && orgInfo?.review;
  if (needsAck && !$("ack").checked) {
    $("msg").className = "err"; $("msg").textContent = "Please accept the notice above to join this company.";
    return;
  }
  await chrome.storage.local.set({ orgCode: code, shareTrends: $("shareTrends").checked,
    senderName: $("senderName").value.trim(), reviewAck: needsAck ? code : "" });
  $("msg").className = "ok";
  $("msg").textContent = "Saved ✓";
  setTimeout(() => ($("msg").textContent = ""), 2000);
  init();
};
init().then(checkOrg);
