(() => {
  const isEditable = (el) =>
    el &&
    (el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && /^(text|search|)$/.test(el.type)) ||
      el.isContentEditable ||
      el.getAttribute?.("role") === "textbox");

  // Shadow DOM keeps our UI isolated from the host page's CSS
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box;font-family:system-ui,sans-serif}
      #btn{position:fixed;display:none;padding:6px 14px;border:0;border-radius:999px;
        background:linear-gradient(135deg, rgba(99,102,241,.93), rgba(168,85,247,.9));
        color:#fff;font-size:12px;font-weight:800;letter-spacing:.02em;cursor:pointer;
        box-shadow:0 10px 26px rgba(99,102,241,.32), inset 0 1px 0 rgba(255,255,255,.45);
        transform:translateY(-8px);transition:transform .14s ease, box-shadow .14s ease, filter .14s ease;
        backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:flex;align-items:center;gap:8px}
      #btn:hover{transform:translateY(-11px) scale(1.02);box-shadow:0 16px 32px rgba(99,102,241,.38), inset 0 1px 0 rgba(255,255,255,.5);filter:saturate(1.12)}
      .wingco-badge{width:16px;height:16px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,.5);box-shadow:0 4px 10px rgba(17,24,39,.18)}
      #panel{position:fixed;display:none;width:360px;padding:12px;background:rgba(255,255,255,.2);
        color:#111;border:1px solid rgba(255,255,255,.45);border-radius:18px;
        box-shadow:0 18px 42px rgba(15,23,42,.18), inset 0 1px 0 rgba(255,255,255,.4);
        backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);
        font-size:13px}
      #controls{display:flex;gap:8px;margin-bottom:8px}
      #controls select{flex:1;min-width:0;font-size:12px;padding:8px 10px;border-radius:10px;
        border:1px solid rgba(255,255,255,.45);background:rgba(255,255,255,.28);color:#111;cursor:pointer;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
      #out{white-space:pre-wrap;margin:8px 0;max-height:200px;overflow:auto;padding:10px 12px;
        background:rgba(255,255,255,.26);border:1px solid rgba(255,255,255,.25);border-radius:12px;
        color:#111;min-height:48px;box-shadow:inset 0 1px 0 rgba(255,255,255,.25)}
      #out.loading{color:#2d3748}
      #out.error{color:#991b1b;background:rgba(254,242,242,.55);border:1px solid rgba(252,165,165,.7)}
      #prompt{display:none;margin:0 0 8px;font-size:12px;font-weight:700;color:#1f2937}
      select,button.a{font-size:12px;padding:7px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.42);
        background:rgba(255,255,255,.34);color:#111;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.35)}
      button.a:disabled,button.p:disabled{opacity:.55;cursor:not-allowed}
      button.p{background:linear-gradient(135deg,#4f46e5,#6d5efc);color:#fff;border-color:transparent;
        box-shadow:0 8px 20px rgba(79,70,229,.28), inset 0 1px 0 rgba(255,255,255,.34)}
      .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
      #meta{color:#374151;font-size:11px;margin-top:8px;line-height:1.4}
      label{font-size:12px;display:block;line-height:1.5;color:#111}#warn{color:#7c2d12;font-size:11px;margin:2px 0 8px}
    </style>
    <button id="btn"><img class="wingco-badge" src="${chrome.runtime.getURL("pfp.png")}" alt="WingCO logo"> <span>WingCO</span></button>
    <div id="panel">
      <div id="prompt">Improve this text?</div>
      <div id="controls">
        <select id="tone">
          <option value="diplomatic">Diplomatic</option>
          <option value="direct">Direct</option>
          <option value="apologetic">Apologetic</option>
          <option value="firm-but-polite">Firm but polite</option>
        </select>
        <select id="recipient">
          <option value="manager">Manager</option>
          <option value="client">Client</option>
          <option value="peer">Peer</option>
        </select>
      </div>
      <div id="out">…</div>
      <label><input type="checkbox" id="unmask" checked> Add "polished by WingCO" link to my message</label>
      <div id="warn">⚠️ Anyone with Unmask Premium who opens that link can see your original text. Uncheck to keep it private.</div>
      <div class="row">
        <button class="a p" id="replace">Replace</button>
        <button class="a" id="copy">Copy</button>
        <button class="a" id="retry">Retry</button>
        <button class="a" id="improve">Improve it</button>
        <button class="a" id="decline">No thanks</button>
        <button class="a" id="close">✕</button>
      </div>
      <div id="meta"></div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const btn = $("btn"), panel = $("panel"), out = $("out"), prompt = $("prompt");
  let target = null, rewrite = "", original = "", selectedText = "";

  const hasText = (value) => typeof value === "string" && value.trim().length > 0;

  const checkBackend = async () => {
    try {
      console.log("[WingCO] checking backend health via extension background");
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("health check timed out")), 4000);
        chrome.runtime.sendMessage({ type: "health" }, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response || { ok: false, error: "no response from background" });
        });
      });
      console.log("[WingCO] backend health:", result);
      return !!result?.ok;
    } catch (err) {
      console.error("[WingCO] backend unreachable:", err);
      return false;
    }
  };

  const setBusy = (busy, message = "Polishing...") => {
    const actions = [$("replace"), $("copy"), $("retry"), $("improve")];
    actions.forEach((el) => { if (el) el.disabled = busy; });
    out.classList.toggle("loading", busy);
    out.classList.remove("error");
    out.textContent = message;
  };

  const showError = (message) => {
    rewrite = "";
    out.classList.add("error");
    out.classList.remove("loading");
    out.textContent = `⚠️ ${message}`;
    $("meta").textContent = "WingCO backend is offline or not responding. Start it with: cd backend && npm run dev";
    $("replace").disabled = true;
    $("copy").disabled = true;
  };

  const getText = (el) => (el.value !== undefined ? el.value : el.innerText);
  const getSelectionText = () => {
    const sel = window.getSelection && window.getSelection();
    return sel && sel.toString ? sel.toString().trim() : "";
  };

  function placeSelectionButton(rect) {
    const pad = 12;
    const btnW = 110;
    const x = Math.min(Math.max(rect.right + 8, pad), window.innerWidth - btnW - pad);
    const y = Math.max(pad, rect.top - 28);
    btn.style.left = x + "px";
    btn.style.top = y + "px";
  }

  function setText(el, text) {
    el.focus();
    if (el.value !== undefined) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, text); // works with React
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null); // Gmail/Slack-friendly
      document.execCommand("insertText", false, text);
    }
  }

  function place(el, node, dy) {
    const r = el.getBoundingClientRect();
    const pad = 12;
    const nodeW = node === btn ? 110 : 340;
    const x = Math.min(Math.max(r.right - nodeW / 2, pad), window.innerWidth - nodeW - pad);
    const y = r.top + dy;
    node.style.left = x + "px";
    node.style.top = Math.max(pad, y) + "px";
  }

  function placePanelNearTarget() {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const panelHeight = 220;
    const pad = 12;
    const left = Math.min(Math.max(r.right - 170, pad), window.innerWidth - 340 - pad);
    const top = r.top - panelHeight - 12;
    panel.style.left = left + "px";
    panel.style.top = (top > pad ? top : r.bottom + 8) + "px";
  }

  document.addEventListener("focusin", (e) => {
    if (host.contains(e.target) || !isEditable(e.target)) return;
    target = e.target;
    selectedText = "";
    const value = getText(target);
    if (!hasText(value)) {
      btn.style.display = "none";
      panel.style.display = "none";
      return;
    }
    place(target, btn, -22);
    btn.style.display = "block";
  });

  document.addEventListener("selectionchange", () => {
    const text = getSelectionText();
    if (!text) {
      selectedText = "";
      btn.style.display = target && hasText(getText(target)) ? "block" : "none";
      return;
    }
    selectedText = text;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      target = null;
      placeSelectionButton(rect);
      btn.style.display = "block";
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (e.composedPath().includes(host)) return;
    if (!isEditable(e.target) && !getSelectionText()) {
      btn.style.display = "none";
      panel.style.display = "none";
    }
  });

  async function run() {
    const text = target ? (getText(target) || "").trim() : (selectedText || "").trim();
    if (!text) {
      out.classList.remove("loading", "error");
      out.textContent = "Type something first.";
      return;
    }

    setBusy(true, "Checking backend...");
    const backendLive = await checkBackend();
    if (!backendLive) {
      showError("WingCO server is offline or not responding");
      console.warn("[WingCO] blocked rewrite request: backend unavailable on http://localhost:8000");
      return;
    }

    original = text;
    rewrite = "";
    $("meta").textContent = "";
    setBusy(true, "Polishing...");
    console.log("[WingCO] sending rewrite request", {
      textLength: text.length,
      tone: $("tone").value,
      recipient: $("recipient").value,
    });

    try {
      const res = await chrome.runtime.sendMessage({
        type: "rewrite", text, tone: $("tone").value, recipient: $("recipient").value,
      });

      if (!res || !res.ok) {
        const detail = res?.error || "Something went wrong";
        console.error("[WingCO] rewrite response error:", detail);
        showError(detail);
        return;
      }

      rewrite = res.rewrite;
      out.classList.remove("loading", "error");
      out.textContent = rewrite;
      const bits = [];
      if (res.remaining != null) bits.push(`${res.remaining} free left today`);
      if (res.shared) bits.push("Anonymous trend stats shared with your company, never your text");
      $("meta").textContent = bits.join(" · ");
      $("replace").disabled = false;
      $("copy").disabled = false;
      $("retry").disabled = false;
    } catch (err) {
      showError("Can't reach WingCO server");
    } finally {
      $("improve").disabled = false;
    }
  }

  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
  btn.addEventListener("click", () => {
    if (!target && selectedText) {
      prompt.textContent = "Improve this selected text?";
      prompt.style.display = "block";
      out.textContent = selectedText;
      panel.style.display = "block";
      return;
    }
    placePanelNearTarget();
    panel.style.display = "block";
    run();
  });
  $("retry").onclick = async () => {
    $("retry").disabled = true;
    await run();
  };
  $("improve").onclick = async () => {
    prompt.style.display = "none";
    $("improve").disabled = true;
    await run();
  };
  $("decline").onclick = () => {
    prompt.style.display = "none";
    panel.style.display = "none";
    selectedText = "";
    if (window.getSelection) window.getSelection().removeAllRanges();
  };
  $("tone").onchange = run;
  $("recipient").onchange = run;
  $("close").onclick = () => (panel.style.display = "none");
  $("copy").onclick = () => rewrite && navigator.clipboard.writeText(rewrite);
  $("replace").onclick = async () => {
    const targetEl = target || document.activeElement;
    if (!rewrite || !targetEl || (!isEditable(targetEl) && !selectedText)) return;
    setBusy(true, "Applying rewrite...");
    let final = rewrite;
    try {
      if ($("unmask").checked) {
        const r = await chrome.runtime.sendMessage({ type: "publish", original, polished: rewrite });
        if (!r?.ok) {
          showError(r?.error || "Couldn't create link");
          return;
        }
        final = `${rewrite}\n\n— polished by WingCO · ${r.url}`;
      }
      if (targetEl && isEditable(targetEl)) {
        setText(targetEl, final);
      } else if (selectedText) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(final));
          sel.removeAllRanges();
        }
      }
      panel.style.display = "none";
    } catch (err) {
      showError("Could not apply the rewrite");
    } finally {
      $("replace").disabled = false;
      $("copy").disabled = false;
    }
  };
})();
