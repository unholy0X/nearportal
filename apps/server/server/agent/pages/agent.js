// Minimal approval pages. Untrusted strings are written with textContent only.
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id, on = true) => { $(id).hidden = !on; };
  const result = (text, good) => { const r = $("result"); r.textContent = text; r.className = "status " + (good ? "ok" : "bad"); };
  const SCOPE_TEXT = {
    read: ["Read", "See bounties, your assignments, funding instructions and activity."],
    contribute: ["Contribute", "Claim bounties with a wallet you verified, and submit pull requests."],
    create: ["Create", "Prepare and create bounties on repositories you can write to. Funding stays manual."],
    release: ["Release assignments", "Give up one of your assignments, with an explicit confirmation phrase."],
  };
  let me = null;
  async function session() {
    const r = await fetch("/api/portal/me", { headers: { Accept: "application/json" }, credentials: "same-origin" });
    me = await r.json();
    return me;
  }
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: { Accept: "application/json" }, credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": me?.csrf ?? "" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error?.message || data.error || "Request failed");
    return data.data;
  }
  function signIn(returnTo) {
    show("signin");
    $("signin-link").href = "/auth/github?returnTo=" + encodeURIComponent(returnTo);
    if (me?.localPreview) {
      show("local-login");
      $("local-login").onclick = async () => {
        const r = await fetch("/api/portal/local-login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (r.ok) location.reload(); else result("Local sign-in failed.", false);
      };
    }
  }
  async function connect() {
    const params = new URLSearchParams(location.search);
    const raw = (params.get("code") || "").toUpperCase();
    const code = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(raw) ? raw : null;
    if (!code) {
      show("enter");
      await session().catch(() => null);
      if (me?.user) terminals().catch(() => {});
      $("code-form").onsubmit = (e) => { e.preventDefault(); const v = $("code-input").value.toUpperCase().replace(/[^A-Z]/g, ""); location.search = "?code=" + v.slice(0, 4) + "-" + v.slice(4, 8); };
      return;
    }
    await session();
    if (!me.user) return signIn("/agent/connect?code=" + code);
    let req;
    try { req = await api("/api/agent/device/lookup?code=" + encodeURIComponent(code)); } catch (e) { return result(e.message, false); }
    if (req.status !== "pending") return result(req.status === "expired" ? "This request expired. Start a new login from your terminal." : "This request was already decided.", false);
    show("review");
    $("code").textContent = code;
    $("login").textContent = "@" + req.account.login;
    if (req.account.avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(req.account.avatar)) $("avatar").src = req.account.avatar;
    $("client").textContent = req.clientName;
    $("days").textContent = String(req.credentialDays);
    if (req.expectedLogin && req.expectedLogin.toLowerCase() !== req.account.login.toLowerCase()) result("This request is reserved for @" + req.expectedLogin + ". Sign in with that account to approve it.", false);
    const box = $("scopes");
    for (const s of req.scopes) {
      const [title, text] = SCOPE_TEXT[s] || [s, ""];
      const label = document.createElement("label"); label.className = "scope";
      const input = document.createElement("input"); input.type = "checkbox"; input.value = s; input.checked = s !== "release"; input.disabled = s === "read";
      const div = document.createElement("div"); const strong = document.createElement("strong"); strong.textContent = title; const small = document.createElement("small"); small.textContent = text + (s === "release" ? " Off unless you tick it." : "");
      div.append(strong, small); label.append(input, div); box.append(label);
    }
    const decide = async (decision) => {
      $("approve").disabled = $("deny").disabled = true;
      const scopes = [...box.querySelectorAll("input:checked")].map((i) => i.value);
      try {
        const r = await api("/api/agent/device/decision", { code, decision, scopes });
        show("review", false);
        result(r.status === "approved" ? "Approved for @" + r.account.login + ". Return to your terminal." : "Denied. Nothing was granted.", r.status === "approved");
      } catch (e) { result(e.message, false); $("approve").disabled = $("deny").disabled = false; }
    };
    $("approve").onclick = () => decide("approve");
    $("deny").onclick = () => decide("deny");
  }
  async function terminals() {
    const r = await api("/api/agent/session/tokens");
    const list = $("terminal-list");
    list.textContent = "";
    const active = r.credentials.filter((c) => !c.revokedAt && Date.parse(c.expiresAt) > Date.now());
    show("terminals");
    if (!active.length) { const p = document.createElement("p"); p.textContent = "No active terminal credentials."; list.append(p); return; }
    for (const c of active) {
      const row = document.createElement("div"); row.className = "account";
      const text = document.createElement("div");
      const name = document.createElement("strong"); name.textContent = c.clientName;
      const meta = document.createElement("small"); meta.textContent = " " + c.scopes.join(", ") + " · expires " + c.expiresAt.slice(0, 10) + (c.lastUsedAt ? " · last used " + c.lastUsedAt.slice(0, 16).replace("T", " ") + " UTC" : "");
      text.append(name, document.createElement("br"), meta);
      const btn = document.createElement("button"); btn.className = "secondary"; btn.type = "button"; btn.textContent = "Revoke"; btn.style.marginLeft = "auto";
      btn.onclick = async () => { btn.disabled = true; try { await api("/api/agent/session/tokens/" + c.id + "/revoke", {}); await terminals(); } catch (e) { result(e.message, false); btn.disabled = false; } };
      row.append(text, btn); row.style.marginBottom = "8px"; list.append(row);
    }
  }
  async function wallet() {
    const id = new URLSearchParams(location.search).get("request") || "";
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) return result("Missing or invalid verification request.", false);
    await session();
    if (!me.user) return signIn("/agent/wallet?request=" + id);
    let req;
    try { req = await api("/api/agent/session/wallet-requests/" + id); } catch (e) { return result(e.message, false); }
    if (req.status !== "pending") return result(req.status === "verified" ? "This wallet is already verified. Return to your terminal." : "This request expired. Start a new verification from your terminal.", req.status === "verified");
    show("review");
    $("address").textContent = req.address;
    $("login").textContent = "@" + req.account.login;
    $("message").textContent = req.message;
    $("sign").onclick = async () => {
      const eth = window.ethereum;
      if (!eth) return result("No browser wallet found. Install or unlock an EOA wallet extension.", false);
      $("sign").disabled = true;
      try {
        const accounts = await eth.request({ method: "eth_requestAccounts" });
        if (!accounts.map((a) => String(a).toLowerCase()).includes(req.address)) throw new Error("Select the account " + req.address + " in your wallet.");
        const hex = "0x" + [...new TextEncoder().encode(req.message)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const signature = await eth.request({ method: "personal_sign", params: [hex, req.address] });
        await api("/api/agent/session/wallet-requests/" + id + "/verify", { signature });
        show("review", false);
        result("Wallet verified for @" + req.account.login + " on Base Sepolia. Return to your terminal.", true);
      } catch (e) { result(e.message || "Signing failed.", false); $("sign").disabled = false; }
    };
  }
  (document.body.dataset.page === "connect" ? connect() : wallet()).catch((e) => result(e.message || "Connection interrupted.", false));
})();
