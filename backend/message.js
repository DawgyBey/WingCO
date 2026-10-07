const $ = (id) => document.getElementById(id);

let viewerKey;
try {
  viewerKey = localStorage.getItem("wingcoViewerKey");
  if (!viewerKey) {
    viewerKey = crypto.randomUUID();
    localStorage.setItem("wingcoViewerKey", viewerKey);
  }
} catch {
  viewerKey = crypto.randomUUID();
}

const id = location.pathname.split("/").pop();

async function load() {
  let res;
  try {
    res = await fetch(`/api/m/${encodeURIComponent(id)}`, { headers: { "X-Viewer-Key": viewerKey } });
  } catch {
    $("polished").textContent = "Can't reach the server. Try again in a moment.";
    return;
  }

  if (!res.ok) {
    $("polished").textContent = "This message was not found or has expired.";
    $("lock").hidden = true;
    $("orig").hidden = true;
    return;
  }

  const data = await res.json();
  $("polished").textContent = data.polished;
  if (data.retention_days) $("retention").textContent = `Messages and originals are deleted automatically after ${data.retention_days} days.`;
  $("lock").hidden = data.unlocked;
  $("orig").hidden = !data.unlocked;

  if (data.unlocked) {
    $("origText").textContent = data.original;
  }
}

$("up").onclick = async () => {
  $("err").textContent = "";
  $("up").disabled = true;
  try {
  const res = await fetch("/billing/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": viewerKey,
    },
    body: JSON.stringify({
      plan: "unmask",
      returnPath: location.pathname,
    }),
  });

  const data = await res.json();
  if (data.url) {
    location.href = data.url;
  } else {
    $("err").textContent = data.detail || "Error";
  }
  } catch {
    $("err").textContent = "Can't reach the server.";
  } finally {
    $("up").disabled = false;
  }
};

$("refresh").onclick = load;
load();
