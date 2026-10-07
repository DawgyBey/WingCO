(() => {
  if (window.top !== window && window.innerHeight < 120) return; // skip tiny ad/tracking iframes
  if (window.__wingcoLoaded) return;
  window.__wingcoLoaded = true;

  // ---------- helpers ----------
  const isTextInput = (el) =>
    el && ((el.tagName === "TEXTAREA") || (el.tagName === "INPUT" && /^(text|search)$/i.test(el.type || "text")));
  const isRich = (el) => el && (el.isContentEditable || el.getAttribute?.("role") === "textbox");
  const isEditable = (el) => isTextInput(el) || isRich(el);
  const editableRoot = (el) => { // nearest editable ancestor (contenteditable children report as editable too)
    while (el && el !== document.body) { if (isEditable(el)) return el; el = el.parentElement; }
    return null;
  };
  const getText = (el) => (isTextInput(el) ? el.value : el.innerText) || "";
  const hasText = (v) => typeof v === "string" && v.trim().length > 0;
  const store = {
    get: (keys) => { try { return chrome.storage.local.get(keys); } catch { return Promise.resolve({}); } },
    set: (obj) => { try { return chrome.storage.local.set(obj); } catch { return Promise.resolve(); } },
  };

  // ---------- UI (Shadow DOM isolates us from the host page's CSS) ----------
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host{all:initial}
      *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      [hidden]{display:none !important}
      .t{--bg:#fff;--fg:#17172b;--mut:#686880;--line:#e3e3f0;--field:#f6f6fc;--acc:#4f46e5;--acc2:#7c3aed;
         --err-bg:#fef2f2;--err-fg:#b91c1c;--ok:#15803d}
      @media (prefers-color-scheme:dark){.t{--bg:#1c1c26;--fg:#eeeef7;--mut:#a0a0b8;--line:#33334a;--field:#14141c;
         --err-bg:#3a1c1f;--err-fg:#fca5a5;--ok:#4ade80}}
      #btn{position:fixed;display:none;align-items:center;gap:7px;padding:5px 12px 5px 6px;border:0;border-radius:999px;
        background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;font-size:12px;font-weight:700;
        cursor:pointer;box-shadow:0 6px 18px rgba(79,70,229,.4);transition:transform .12s,box-shadow .12s}
      #btn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(79,70,229,.45)}
      #btn:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
      #btn img{width:20px;height:20px;object-fit:contain;background:#fff;border-radius:50%;padding:1px}
      #panel{position:fixed;display:none;width:380px;max-width:calc(100vw - 24px);padding:14px;background:var(--bg);
        color:var(--fg);border:1px solid var(--line);border-radius:14px;font-size:13px;line-height:1.45;
        box-shadow:0 20px 50px rgba(15,15,40,.28)}
      .head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .head b{font-size:13px;flex:1}.head img{width:18px;height:18px;object-fit:contain}
      #x{border:0;background:transparent;color:var(--mut);font-size:16px;cursor:pointer;padding:2px 6px;border-radius:6px}
      #x:hover{background:var(--field)}
      .sel{display:flex;gap:8px;margin-bottom:10px}
      select{flex:1;min-width:0;font-size:12px;padding:7px 8px;border-radius:8px;border:1px solid var(--line);
        background:var(--field);color:var(--fg);cursor:pointer}
      #out{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;padding:10px 12px;min-height:52px;
        background:var(--field);border:1px solid var(--line);border-radius:10px;user-select:text}
      #out.loading{color:var(--mut)}
      #out.error{color:var(--err-fg);background:var(--err-bg);border-color:transparent}
      #out .dots span{display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:var(--acc);
        animation:b 1s infinite ease-in-out}
      #out .dots span:nth-child(2){animation-delay:.15s}#out .dots span:nth-child(3){animation-delay:.3s}
      @keyframes b{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
      label.chk{display:flex;gap:8px;align-items:flex-start;margin:10px 0 2px;font-size:12px;cursor:pointer}
      label.chk input{margin-top:2px;accent-color:var(--acc)}
      #warn{color:var(--mut);font-size:11px;margin:2px 0 0 24px}
      .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
      button.a{font-size:12px;font-weight:600;padding:7px 12px;border-radius:8px;border:1px solid var(--line);
        background:var(--field);color:var(--fg);cursor:pointer}
      button.a:hover:not(:disabled){border-color:var(--acc)}
      button.p{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;border-color:transparent}
      button:disabled{opacity:.5;cursor:not-allowed}
      .sp{flex:1}
      #paywall{margin-top:10px;padding:14px;border-radius:12px;text-align:center;
        background:linear-gradient(135deg,rgba(79,70,229,.12),rgba(124,58,237,.12));border:1px solid var(--line)}
      #paywall b{display:block;font-size:14px;margin-bottom:4px}
      #paywall p{margin:0 0 10px;color:var(--mut);font-size:12px}
      #paywall button{width:100%;padding:10px 14px;font-size:13px}
      #reviewNote{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.4;
        background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.5)}
      #meta{color:var(--mut);font-size:11px;margin-top:10px}
      #meta.ok{color:var(--ok)}
    </style>
    <div class="t">
      <button id="btn" type="button" aria-label="Rewrite with WingCO"><img id="logo" alt=""><span>WingCO</span></button>
      <div id="panel" role="dialog" aria-label="WingCO">
        <div class="head"><img id="logo2" alt=""><b id="title">WingCO</b><button id="x" type="button" aria-label="Close">✕</button></div>
        <div class="sel">
          <select id="tone" aria-label="Tone">
            <option value="diplomatic">Diplomatic</option><option value="direct">Direct</option>
            <option value="apologetic">Apologetic</option><option value="firm-but-polite">Firm but polite</option>
          </select>
          <select id="recipient" aria-label="Recipient">
            <option value="manager">To: Manager</option><option value="client">To: Client</option><option value="peer">To: Peer</option>
          </select>
        </div>
        <div id="out"></div>
        <div id="paywall" hidden>
          <b>You've used your free rewrites</b>
          <p>Upgrade to WingCO Pro for unlimited polished messages.</p>
          <button class="a p" id="upgrade" type="button">Upgrade to Pro</button>
        </div>
        <div id="reviewNote" hidden>🏢 <span id="reviewText">Your company can read the original of this message once you replace it.</span></div>
        <label class="chk" id="unmaskRow"><input type="checkbox" id="unmask" checked><span>Add a “polished by WingCO” link</span></label>
        <div id="warn">Anyone with Unmask Premium who opens that link can see your original text. Uncheck to keep it private.</div>
        <div class="row" id="actions">
          <button class="a p" id="replace" type="button">Replace</button>
          <button class="a" id="copy" type="button">Copy</button>
          <button class="a" id="retry" type="button">↻ Retry</button>
          <span class="sp"></span>
        </div>
        <div id="meta"></div>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const btn = $("btn"), panel = $("panel"), out = $("out"), meta = $("meta");
  try {
    const logo = chrome.runtime.getURL("pfp.png");
    $("logo").src = logo; $("logo2").src = logo;
  } catch { /* extension reloaded; page needs refresh */ }

  // ---------- state ----------
  // ctx describes what will be rewritten: { el, kind: "field"|"rich"|"page", text, start, end, range }
  let ctx = null;
  let activeEl = null;       // last focused editable
  let rewrite = "", original = "", reviewActive = false;
  let reqId = 0;             // guards against out-of-order responses
  let busy = false;

  const setMeta = (text, ok = false) => { meta.textContent = text || ""; meta.className = ok ? "ok" : ""; };

  function setState(state, message = "") {
    busy = state === "loading";
    const paywallState = state === "paywall";
    out.className = state === "loading" ? "loading" : state === "error" ? "error" : "";
    out.hidden = paywallState;
    if (state === "loading") out.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>' + (message || "Polishing…");
    else out.textContent = message;
    const paywall = state === "paywall";
    $("paywall").hidden = !paywall;
    $("actions").hidden = paywall;
    $("reviewNote").hidden = !(state === "done" && reviewActive);
    const done = state === "done";
    $("replace").disabled = !done || ctx?.kind === "page";
    $("copy").disabled = !done;
    $("retry").disabled = busy;
    $("replace").hidden = ctx?.kind === "page";
    const showLink = ctx?.kind !== "page" && !paywall;
    $("unmaskRow").hidden = !showLink; $("warn").hidden = !showLink;
  }

  // ---------- capture what to rewrite ----------
  function captureContext() {
    const sel = window.getSelection();
    const el = activeEl && document.contains(activeEl) ? activeEl : null;
    if (el && isTextInput(el)) {
      const { selectionStart: s, selectionEnd: e, value } = el;
      if (s != null && e != null && e > s && hasText(value.slice(s, e)))
        return { el, kind: "field", text: value.slice(s, e), start: s, end: e };
      return { el, kind: "field", text: value, start: 0, end: value.length };
    }
    if (el && isRich(el)) {
      if (sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode) && hasText(sel.toString()))
        return { el, kind: "rich", text: sel.toString(), range: sel.getRangeAt(0).cloneRange() };
      return { el, kind: "rich", text: el.innerText || "", range: null };
    }
    if (sel && !sel.isCollapsed && hasText(sel.toString()))
      return { el: null, kind: "page", text: sel.toString() };
    return null;
  }

  // ---------- positioning ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  function anchorRect() {
    if (ctx?.kind === "rich" && ctx.range) { const r = ctx.range.getBoundingClientRect(); if (r.width) return r; }
    if (activeEl && document.contains(activeEl)) return activeEl.getBoundingClientRect();
    const sel = window.getSelection();
    if (sel && sel.rangeCount) return sel.getRangeAt(0).getBoundingClientRect();
    return null;
  }
  function placeButton() {
    const r = anchorRect();
    if (!r || (!r.width && !r.height)) return;
    const w = 100, h = 30, pad = 8;
    btn.style.left = clamp(r.right - w - 4, pad, window.innerWidth - w - pad) + "px";
    btn.style.top = clamp(r.bottom - h - 4 > r.top ? r.bottom - h - 4 : r.top - h - 4, pad, window.innerHeight - h - pad) + "px";
  }
  function placePanel() {
    const r = anchorRect() || { left: window.innerWidth / 2 - 190, right: window.innerWidth / 2 + 190, top: 80, bottom: 80 };
    const w = Math.min(380, window.innerWidth - 24), h = panel.offsetHeight || 300, pad = 12;
    const left = clamp(r.right - w, pad, window.innerWidth - w - pad);
    const below = r.bottom + 8;
    const top = below + h < window.innerHeight - pad ? below : Math.max(pad, r.top - h - 8);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }
  let rafPending = false;
  const reposition = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (btn.style.display !== "none" && btn.style.display !== "") placeButton();
      if (panel.style.display === "block") placePanel();
    });
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // ---------- show/hide the floating button ----------
  const showButton = () => { btn.style.display = "flex"; placeButton(); };
  const hideButton = () => { btn.style.display = "none"; };
  const closePanel = () => { panel.style.display = "none"; reqId++; busy = false; };

  function refreshButton() {
    if (panel.style.display === "block") return;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && hasText(sel.toString());
    const fieldText = activeEl && document.contains(activeEl) ? getText(activeEl) : "";
    if (hasText(fieldText) || hasSel || (activeEl && isTextInput(activeEl) && activeEl.selectionEnd > activeEl.selectionStart)) showButton();
    else hideButton();
  }

  document.addEventListener("focusin", (e) => {
    if (e.composedPath().includes(host)) return;
    const el = editableRoot(e.target);
    if (el) { activeEl = el; refreshButton(); }
  }, true);
  document.addEventListener("input", (e) => {
    if (e.composedPath().includes(host)) return;
    const el = editableRoot(e.target);
    if (el) { activeEl = el; refreshButton(); }
  }, true);
  let selTimer;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(refreshButton, 150);
  });
  document.addEventListener("mouseup", () => setTimeout(refreshButton, 0), true);
  document.addEventListener("mousedown", (e) => {
    if (e.composedPath().includes(host)) return;
    if (panel.style.display === "block") closePanel();
    if (!editableRoot(e.target)) { activeEl = null; setTimeout(refreshButton, 0); }
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.style.display === "block") { closePanel(); e.stopPropagation(); }
  }, true);

  // ---------- rewriting ----------
  const sendMessage = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: "Can't reach the WingCO extension. Reload this page." });
        else resolve(r || { ok: false, error: "No response from the WingCO extension" });
      });
    } catch { resolve({ ok: false, error: "WingCO was updated. Reload this page to keep using it." }); }
  });

  async function run() {
    if (!ctx || !hasText(ctx.text)) { setState("error", "Type or select some text first."); return; }
    const id = ++reqId;
    original = ctx.text;
    rewrite = "";
    reviewActive = false;
    setMeta("");
    setState("loading");
    store.set({ tone: $("tone").value, recipient: $("recipient").value });
    const res = await sendMessage({ type: "rewrite", text: ctx.text, tone: $("tone").value, recipient: $("recipient").value });
    if (id !== reqId) return; // user closed the panel or started a newer request
    if (!res.ok) {
      if (res.paywall) { setState("paywall", "Your free rewrites are used up. Upgrade to continue polishing messages."); return; }
      setState("error", res.error || "Something went wrong");
      if (res.offline) setMeta("Start the backend with: cd backend && npm start");
      return;
    }
    rewrite = res.rewrite;
    reviewActive = !!res.review;
    setState("done", rewrite);
    const bits = [];
    if (res.remaining != null)
      bits.push(res.remaining === 0 ? "That was your last free rewrite" : `${res.remaining} free rewrite${res.remaining === 1 ? "" : "s"} left`);
    if (res.shared) bits.push("Anonymous trend stats shared with your company, never your text");
    setMeta(bits.join(" · "));
  }

  async function openPanel() {
    ctx = captureContext();
    if (!ctx) { hideButton(); return; }
    const saved = await store.get(["tone", "recipient", "unmask"]);
    if (saved.tone) $("tone").value = saved.tone;
    if (saved.recipient) $("recipient").value = saved.recipient;
    $("unmask").checked = saved.unmask !== false;
    $("title").textContent = ctx.kind !== "page" && ctx.text.length < getTextLength() ? "Polish selection" : ctx.kind === "page" ? "Polish selected text" : "Polish message";
    panel.style.display = "block";
    placePanel();
    run().then(placePanel);
  }
  const getTextLength = () => (ctx?.el ? getText(ctx.el).length : 0);

  // ---------- applying the result ----------
  function applyToField(el, c, text) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const value = el.value;
    const next = value.slice(0, c.start) + text + value.slice(c.end);
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, next); // works with React/Vue
    const caret = c.start + text.length;
    try { el.setSelectionRange(caret, caret); } catch { /* some input types don't support it */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function applyToRich(el, c, text) {
    el.focus();
    const sel = window.getSelection();
    if (c.range) { sel.removeAllRanges(); sel.addRange(c.range); }
    else sel.selectAllChildren(el);
    if (!document.execCommand("insertText", false, text)) { // fallback if the editor blocks execCommand
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  $("replace").onclick = async () => {
    if (!rewrite || !ctx || ctx.kind === "page" || busy) return;
    $("replace").disabled = true;
    let final = rewrite, note = "";
    if ($("unmask").checked || reviewActive) {
      const r = await sendMessage({ type: "publish", original, polished: rewrite });
      if (r.ok) { if ($("unmask").checked) final = `${rewrite}\n\n— polished by WingCO · ${r.url}`; }
      else note = `Couldn't save the message (${r.error}); inserted without a link.`;
    }
    store.set({ unmask: $("unmask").checked });
    if (!ctx.el || !document.contains(ctx.el)) { setState("error", "The text box is gone. Use Copy instead."); $("copy").disabled = false; return; }
    if (ctx.kind === "field") applyToField(ctx.el, ctx, final); else applyToRich(ctx.el, ctx, final);
    closePanel();
    hideButton();
    if (note) console.warn("[WingCO]", note);
  };

  $("copy").onclick = async () => {
    if (!rewrite) return;
    try { await navigator.clipboard.writeText(rewrite); }
    catch { // clipboard API can be blocked on some pages
      const ta = document.createElement("textarea");
      ta.value = rewrite; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    setMeta("Copied to clipboard ✓", true);
  };
  $("upgrade").onclick = async () => {
    $("upgrade").disabled = true;
    const r = await sendMessage({ type: "upgrade" });
    $("upgrade").disabled = false;
    if (!r.ok) setMeta(r.error || "Couldn't open checkout");
    else setMeta("Checkout opened in a new tab. Come back and hit Retry once you've subscribed.", true);
  };
  $("retry").onclick = run;
  $("tone").onchange = run;
  $("recipient").onchange = run;
  $("x").onclick = closePanel;
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus/selection in the page
  btn.addEventListener("click", openPanel);
})();
