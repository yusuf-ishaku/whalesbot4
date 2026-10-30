// Wallet connect + signature. No dependencies; text is always set via textContent (never innerHTML).
(() => {
  const code = location.pathname.split("/").pop();
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
  };

  // EIP-6963: wallets announce themselves; fall back to window.ethereum.
  const providers = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => providers.set(e.detail.info.uuid, e.detail));
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  const toHex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

  let info;
  const status = (text, cls = "") => { $("status").replaceChildren(el("p", { textContent: text, className: cls })); };

  async function load() {
    const res = await fetch(`/api/verify/${encodeURIComponent(code)}`);
    info = await res.json();
    const t = info.texts;
    document.title = `${t["web.title"]} · ${info.community}`;
    $("title").textContent = t["web.title"];
    $("intro").textContent = t["web.intro"];
    if (info.colors?.primary) document.documentElement.style.setProperty("--primary", info.colors.primary);
    if (info.colors?.background) { document.documentElement.style.setProperty("--bg", info.colors.background); document.documentElement.dataset.brand = "1"; }
    if (info.logoUrl) { $("logo").src = info.logoUrl; $("logo").hidden = false; }

    if (info.state !== "valid") return status(t["web.expired"], "bad");
    renderWalletChoices();
    // Wallets may announce slightly after load.
    setTimeout(renderWalletChoices, 600);
  }

  function renderWalletChoices() {
    const list = [...providers.values()];
    if (!list.length && window.ethereum) list.push({ info: { name: "Browser wallet", uuid: "injected" }, provider: window.ethereum });
    const box = $("actions");
    if (!list.length) {
      const here = location.href.replace(/^https?:\/\//, "");
      box.replaceChildren(
        el("p", { className: "muted", textContent: info.texts["web.no_wallet"] }),
        el("a", { className: "btn", href: `https://metamask.app.link/dapp/${here}`, textContent: "Open in MetaMask" }),
        el("a", { className: "btn secondary", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(location.href)}`, textContent: "Open in Trust Wallet" }),
        el("a", { className: "btn secondary", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}`, textContent: "Open in Coinbase Wallet" }),
      );
      return;
    }
    box.replaceChildren(...list.map((w) => el("button", { textContent: `${info.texts["web.connect"]}: ${w.info.name}`, onclick: () => sign(w.provider) })));
  }

  async function sign(provider) {
    const buttons = [...document.querySelectorAll("#actions button")];
    buttons.forEach((b) => (b.disabled = true));
    try {
      status("…");
      const [address] = await provider.request({ method: "eth_requestAccounts" });
      status(`${info.texts["web.sign"]}…`);
      let signature = "";
      if (info.signatureRequired) {
        signature = await provider.request({ method: "personal_sign", params: [toHex(info.message), address] });
      }
      const res = await fetch(`/api/verify/${encodeURIComponent(code)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, signature }),
      });
      const data = await res.json();
      if (!data.ok) { status(data.message || "Verification failed.", "bad"); buttons.forEach((b) => (b.disabled = false)); return; }
      showResult(data);
    } catch (e) {
      status(e && e.code === 4001 ? "Signature request was rejected." : (e && e.message) || "Something went wrong.", "bad");
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function showResult(d) {
    $("actions").replaceChildren();
    status(d.message, d.tier ? "ok" : "warn");
    const rows = d.sources.map((s) => el("tr", {}, el("td", { textContent: s.sourceId }), el("td", { textContent: s.status === "ok" ? s.amount : "could not read", className: s.status === "ok" ? "" : "bad" })));
    $("result").replaceChildren(
      el("table", { className: "breakdown" }, ...rows, el("tr", {}, el("th", { textContent: "total" }), el("th", { textContent: d.total ?? "–" }))),
      el("p", { className: "muted", textContent: d.done, style: "margin-top:12px" }),
    );
  }

  load().catch(() => status("Could not load verification details. Please retry.", "bad"));
})();
