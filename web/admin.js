// Admin dashboard. Dependency-free; all dynamic text goes through textContent (no innerHTML).
(() => {
  const app = document.getElementById("app");

  // ---- helpers ------------------------------------------------------------------------------------
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n[k] = v;
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
    return n;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmt = (d) => (d ? new Date(d).toLocaleString() : "–");
  const short = (w) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "–");

  let toastTimer;
  function toast(text, bad = false) {
    document.querySelector(".toast")?.remove();
    const t = h("div", { className: "toast " + (bad ? "bad" : "ok"), textContent: text });
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 5000);
  }

  async function api(method, path, body) {
    const res = await fetch("/api/admin" + path, {
      method,
      headers: { "content-type": "application/json", "x-requested-with": "dashboard" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && path !== "/login") { showLogin(); throw new Error("unauthenticated"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.problems?.join("\n") || data.error || res.statusText); e.data = data; throw e; }
    return data;
  }
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { if (e.message !== "unauthenticated") toast(e.message, true); } };

  const field = (label, input, hint) => h("div", {}, h("label", { textContent: label }), input, hint && h("div", { className: "muted", textContent: hint, style: "font-size:12px;margin-top:3px" }));
  const bind = (obj, key, type = "text") => {
    const i = h("input", { type, value: obj[key] ?? "" });
    i.addEventListener("input", () => { obj[key] = type === "number" ? Number(i.value) : i.value; });
    return i;
  };
  const check = (label, obj, key) => {
    const i = h("input", { type: "checkbox", checked: !!obj[key], style: "width:auto" });
    i.addEventListener("change", () => { obj[key] = i.checked; });
    return h("label", { style: "display:flex;gap:8px;align-items:center;color:var(--fg)" }, i, label);
  };

  // ---- login --------------------------------------------------------------------------------------
  function showLogin() {
    const email = h("input", { type: "email", autocomplete: "username" });
    const pass = h("input", { type: "password", autocomplete: "current-password" });
    const err = h("p", { className: "bad" });
    const go = async () => {
      try { await api("POST", "/login", { email: email.value, password: pass.value }); boot(); }
      catch (e) { err.textContent = e.message === "too_many_attempts" ? "Too many attempts. Try again later." : "Invalid email or password."; }
    };
    pass.addEventListener("keydown", (e) => e.key === "Enter" && go());
    app.replaceChildren(h("div", { className: "card login" }, h("h1", { textContent: "Admin sign in" }), field("Email", email), field("Password", pass), err, h("button", { textContent: "Sign in", onclick: go, style: "margin-top:12px" })));
  }

  // ---- shell --------------------------------------------------------------------------------------
  const pages = { setup: pageSetup, config: pageConfig, members: pageMembers, audit: pageAudit, admins: pageAdmins };
  let current = location.hash.slice(1) || "setup";
  let me = "";

  async function boot() {
    try { me = (await api("GET", "/me")).email; } catch { return; }
    render();
  }

  function render() {
    const main = h("main");
    const nav = h("nav", {}, h("strong", { textContent: "Token Gate", style: "padding:8px 10px" }),
      ...Object.keys(pages).map((k) => h("a", { textContent: k[0].toUpperCase() + k.slice(1), className: k === current ? "active" : "", onclick: () => { current = k; location.hash = k; render(); } })),
      h("div", { style: "flex:1" }),
      h("span", { className: "muted", textContent: me, style: "padding:8px 10px;font-size:12px;word-break:break-all" }),
      h("a", { textContent: "Sign out", onclick: async () => { await api("POST", "/logout", {}).catch(() => {}); showLogin(); } }));
    app.replaceChildren(h("div", { className: "admin" }, nav, main));
    (pages[current] || pageSetup)(main).catch((e) => e.message !== "unauthenticated" && main.append(h("p", { className: "bad", textContent: e.message })));
  }

  // ---- setup --------------------------------------------------------------------------------------
  async function pageSetup(main) {
    const [setup, counts, cfg] = await Promise.all([api("GET", "/setup"), api("GET", "/counts"), api("GET", "/config")]);
    const done = setup.steps.every((s) => s.done);
    main.append(h("h1", { textContent: done ? "Setup complete" : "First-run setup" }));
    main.append(h("div", { className: "card" }, setup.steps.map((s) => h("p", {},
      h("span", { className: s.done ? "ok" : "warn", textContent: s.done ? "✔ " : "○ " }), h("strong", { textContent: s.label }),
      !s.done && h("div", { className: "muted", textContent: s.hint, style: "margin-left:20px" })))));

    // Groups
    const groupsCard = h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Groups" }));
    for (const g of setup.groups) {
      const out = h("div", {});
      groupsCard.append(h("div", { style: "margin-bottom:14px" },
        h("strong", { textContent: g.tierName }), " ",
        g.groupId ? h("span", { className: "pill", textContent: g.groupId }) : h("span", { className: "pill warn", textContent: "not linked" }), " ",
        g.bot && h("span", { className: g.bot.ok ? "ok" : "bad", textContent: g.bot.ok ? `bot ok${g.bot.title ? " · " + g.bot.title : ""}` : g.bot.reason }),
        h("div", {}, h("button", { className: "secondary", textContent: g.groupId ? "Re-link group" : "Link group", style: "margin-top:6px", onclick: async () => {
          const r = await act(() => api("POST", `/tiers/${g.tierId}/link-code`, {}));
          if (r) out.replaceChildren(h("p", {}, "1) Add the bot to the group as an admin (invite users + ban users).", h("br"), "2) Post this in the group within 15 minutes:"), h("pre", { textContent: r.command }));
        } })), out));
    }
    main.append(groupsCard);

    // Test wallet
    const addr = h("input", { placeholder: "0x… wallet address" });
    const res = h("div", {});
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Test a wallet" }),
      h("p", { className: "muted", textContent: "Runs the real eligibility check against your configured contracts. Nothing is saved to the member list." }),
      h("div", { className: "row" }, h("div", { style: "flex:1;min-width:240px" }, addr), h("button", { textContent: "Check", onclick: async () => {
        const r = await act(() => api("POST", "/test-wallet", { address: addr.value.trim() }));
        if (!r) return;
        res.replaceChildren(h("pre", { textContent: JSON.stringify(r, null, 2) }));
      } })), res));

    // Counts
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Members" }),
      h("table", {}, h("tr", {}, h("th", { textContent: "Tier" }), h("th", { textContent: "In group" })),
        counts.tiers.map((t) => h("tr", {}, h("td", { textContent: t.name }), h("td", { textContent: String(t.members) })))),
      h("p", { className: "muted", style: "margin-top:10px", textContent: "By status: " + (Object.entries(counts.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet") }),
      h("button", { className: "secondary", textContent: "Re-check everyone now", onclick: () => act(async () => { const r = await api("POST", "/recheck-all", {}); toast(`Checked ${r.checked}, skipped (read failed) ${r.skippedReadFailed}, errors ${r.errors}`); }) })));
    main.append(h("p", { className: "muted", style: "margin-top:16px", textContent: `Version ${cfg.deploy.version} · chain ${cfg.deploy.chain} (${cfg.deploy.chainId}) · ${cfg.deploy.publicUrl}` }));
  }

  // ---- configuration ------------------------------------------------------------------------------
  async function pageConfig(main) {
    const loaded = await api("GET", "/config");
    const d = clone(loaded.config);
    main.append(h("h1", { textContent: "Configuration" }), h("p", { className: "muted", textContent: `Version ${loaded.version}. Contract addresses and secrets are deploy-time settings and are not editable here.` }));

    // Branding
    d.branding.colors ??= {};
    main.append(h("div", { className: "card" }, h("h2", { textContent: "Branding" }), h("div", { className: "grid cols2" },
      field("Community name", bind(d.branding, "communityName")),
      field("Logo URL (https)", (() => { const i = h("input", { value: d.branding.logoUrl ?? "" }); i.addEventListener("input", () => { d.branding.logoUrl = i.value.trim() || null; }); return i; })()),
      field("Primary colour", bind(d.branding.colors, "primary", "color")),
      field("Page background", bind(d.branding.colors, "background", "color")))));

    // Tiers
    const tiersBody = h("div", {});
    const drawTiers = () => {
      tiersBody.replaceChildren(...d.tiers.map((t, i) => h("div", { className: "card", style: "margin-bottom:10px" },
        h("div", { className: "grid cols2" },
          field("Id", bind(t, "id")), field("Name", bind(t, "name")),
          field("Threshold (token units)", bind(t, "threshold")), field("Priority (higher wins)", bind(t, "priority", "number")),
          field("Invite type", (() => { const s = h("select", {}, h("option", { value: "single_use_link", textContent: "Single-use link" }), h("option", { value: "join_request", textContent: "Approve join requests" })); s.value = t.invite.mode; s.addEventListener("change", () => { t.invite.mode = s.value; }); return s; })()),
          field("Invite expires (minutes)", bind(t.invite, "expiresMinutes", "number")),
          field("Telegram group id", h("input", { value: t.telegramGroupId ?? "", disabled: true }), "Set via Setup → Link group.")),
        h("button", { className: "danger", textContent: "Remove tier", style: "margin-top:10px", onclick: () => { d.tiers.splice(i, 1); drawTiers(); } }))));
    };
    drawTiers();
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Tiers" }), tiersBody,
      h("button", { className: "secondary", textContent: "+ Add tier", onclick: () => { d.tiers.push({ id: `tier-${d.tiers.length + 1}`, name: "New tier", threshold: "1000", priority: Math.max(0, ...d.tiers.map((t) => t.priority)) + 1, telegramGroupId: null, invite: { mode: "single_use_link", expiresMinutes: 60 } }); drawTiers(); } })));

    // Rules
    const weights = h("div", {});
    const drawWeights = () => {
      weights.replaceChildren();
      if (d.combine.rule !== "weighted_sum") return;
      d.combine.weightsBps ??= {};
      for (const s of loaded.sources) { d.combine.weightsBps[s.id] ??= 10000; weights.append(field(`Weight for “${s.label || s.id}” (basis points; 10000 = 1×)`, bind(d.combine.weightsBps, s.id, "number"))); }
    };
    const rule = h("select", {}, ...[["sum", "Sum of all sources"], ["weighted_sum", "Weighted sum"], ["any", "Any single source meets the threshold"], ["all", "Every source meets the threshold"]].map(([v, l]) => h("option", { value: v, textContent: l })));
    rule.value = d.combine.rule;
    rule.addEventListener("change", () => { d.combine = rule.value === "weighted_sum" ? { rule: "weighted_sum", weightsBps: {} } : { rule: rule.value }; drawWeights(); });
    drawWeights();
    const overlap = h("select", {}, h("option", { value: "highest_only", textContent: "Highest tier only" }), h("option", { value: "all_qualified", textContent: "Every tier they qualify for" }));
    overlap.value = d.overlap; overlap.addEventListener("change", () => { d.overlap = overlap.value; });
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Rules" }), h("div", { className: "grid cols2" }, field("How sources combine", rule), field("Overlap", overlap)), weights));

    // Re-check + verification
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Re-check & verification" }), h("div", { className: "grid cols2" },
      field("Re-check every (hours)", bind(d.recheck, "cadenceHours", "number")), field("Grace period (hours)", bind(d.recheck, "gracePeriodHours", "number")),
      field("Final reminder lead (hours)", bind(d.recheck, "warningLeadHours", "number")),
      field("Pending join requests wait (hours)", bind(d.verification, "joinRequestPendingHours", "number"), "How long a join request waits for the person to verify before it is declined.")),
      h("div", { style: "margin-top:10px" }, field("If someone gets into a group without being let in", (() => { const sel = h("select", {}, h("option", { value: "quarantine", textContent: "Mute them and let them verify (recommended)" }), h("option", { value: "kick", textContent: "Remove them immediately" })); sel.value = d.verification.unauthorizedJoin || "quarantine"; sel.addEventListener("change", () => { d.verification.unauthorizedJoin = sel.value; }); return sel; })())),
      h("div", { style: "margin-top:10px;display:grid;gap:6px" }, check("Warn members before removal", d.recheck, "warnBeforeRemove"), check("Require captcha on /start", d.verification, "captcha"),
        check("One wallet per Telegram account (a wallet can't be shared across accounts)", d.verification, "oneWalletPerAccount"),
        check("Require wallet signature (turn off only for testing — unsigned addresses can be spoofed)", d.verification, "signatureRequired"))));

    // Messages
    const msgBody = h("div", { className: "grid" });
    for (const [key, def] of Object.entries(loaded.defaultMessages)) {
      const ta = h("textarea", { value: d.branding.messages[key] ?? "", placeholder: def });
      ta.addEventListener("input", () => { if (ta.value.trim()) d.branding.messages[key] = ta.value; else delete d.branding.messages[key]; });
      msgBody.append(field(key, ta));
    }
    main.append(h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Bot & page messages" }),
      h("p", { className: "muted", textContent: "Leave blank to use the default shown as placeholder. {placeholders} are filled in automatically." }), msgBody));

    main.append(h("div", { style: "margin:20px 0" }, h("button", { textContent: "Save configuration", onclick: async () => {
      try { const r = await api("PUT", "/config", d); toast(`Saved as version ${r.version}`); render(); }
      catch (e) { toast(e.message, true); }
    } })));
  }

  // ---- members ------------------------------------------------------------------------------------
  async function pageMembers(main) {
    const cfg = await api("GET", "/config");
    const q = h("input", { placeholder: "Search username, id or wallet" });
    const status = h("select", {}, h("option", { value: "", textContent: "Any status" }), ...["new", "verified", "grace", "removed", "banned"].map((s) => h("option", { value: s, textContent: s })));
    const tier = h("select", {}, h("option", { value: "", textContent: "Any tier" }), ...cfg.config.tiers.map((t) => h("option", { value: t.id, textContent: t.name })));
    const body = h("div", {});
    const detail = h("div", {});
    async function load() {
      const p = new URLSearchParams(); if (q.value) p.set("q", q.value); if (status.value) p.set("status", status.value); if (tier.value) p.set("tier", tier.value);
      const r = await act(() => api("GET", "/members?" + p));
      if (!r) return;
      body.replaceChildren(h("p", { className: "muted", textContent: `${r.total} member(s)` }), h("div", { style: "overflow-x:auto" }, h("table", {},
        h("tr", {}, ["Telegram", "Wallet", "Tier", "Status", "Last check", "Flags"].map((x) => h("th", { textContent: x }))),
        r.members.map((m) => {
          const lc = m.last_check_result;
          return h("tr", { style: "cursor:pointer", onclick: () => open(m.telegram_id) },
            h("td", { textContent: m.telegram_username ? `@${m.telegram_username} (${m.telegram_id})` : String(m.telegram_id) }),
            h("td", { textContent: short(m.wallet), title: m.wallet || "" }),
            h("td", { textContent: cfg.config.tiers.find((t) => t.id === m.current_tier)?.name ?? "–" }),
            h("td", {}, h("span", { className: "pill " + (m.status === "grace" ? "warn" : m.status === "banned" ? "bad" : ""), textContent: m.status })),
            h("td", { textContent: `${fmt(m.last_check_at)}${lc ? " · " + (lc.status === "ok" ? lc.total : "READ FAILED") : ""}` }),
            h("td", { textContent: (m.overrides || []).join(", ") }));
        }))));
    }
    async function open(id) {
      const r = await act(() => api("GET", `/members/${id}`));
      if (!r) return;
      const m = r.member;
      const reload = async () => { await load(); await open(id); };
      const tierSel = h("select", {}, h("option", { value: "", textContent: "Lowest tier" }), ...cfg.config.tiers.map((t) => h("option", { value: t.id, textContent: t.name })));
      detail.replaceChildren(h("div", { className: "card", style: "margin-top:16px" },
        h("h2", { textContent: `${m.telegram_username ? "@" + m.telegram_username + " · " : ""}${m.telegram_id}` }),
        h("p", { className: "muted", textContent: `Wallet ${m.wallet ?? "none"} · status ${m.status}${m.grace_started_at ? " · grace since " + fmt(m.grace_started_at) : ""}` }),
        m.last_check_result && h("pre", { textContent: JSON.stringify(m.last_check_result.sources, null, 1) }),
        h("div", { className: "row" },
          h("button", { textContent: "Force re-check", onclick: () => act(async () => { await api("POST", `/members/${id}/recheck`, {}); await reload(); }, "Re-checked") }),
          m.status === "grace" && h("button", { className: "secondary", textContent: "Release from grace", onclick: () => act(async () => { await api("POST", `/members/${id}/release-grace`, {}); await reload(); }, "Released") }),
          h("button", { className: "danger", textContent: "Ban", onclick: () => confirm("Ban and remove this member from all groups?") && act(async () => { await api("POST", `/members/${id}/ban`, {}); await reload(); }, "Banned") }),
          m.status === "banned" && h("button", { className: "secondary", textContent: "Unban", onclick: () => act(async () => { await api("POST", `/members/${id}/revoke-override`, { type: "ban" }); await reload(); }, "Unbanned") })),
        h("div", { className: "row", style: "margin-top:12px" }, tierSel,
          h("button", { className: "secondary", textContent: "Allowlist", onclick: () => act(async () => { await api("POST", `/members/${id}/allowlist`, { tierId: tierSel.value || null }); await reload(); }, "Allowlisted") }),
          r.overrides.some((o) => o.type === "allowlist" && !o.revoked_at) && h("button", { className: "secondary", textContent: "Remove allowlist", onclick: () => act(async () => { await api("POST", `/members/${id}/revoke-override`, { type: "allowlist" }); await reload(); }, "Removed") })),
        h("h2", { textContent: "Recent events", style: "margin-top:16px" }),
        h("table", {}, r.events.map((e) => h("tr", {}, h("td", { textContent: fmt(e.at) }), h("td", { textContent: e.action }), h("td", { textContent: e.actor }), h("td", { textContent: JSON.stringify(e.details) }))))));
      detail.scrollIntoView({ behavior: "smooth" });
    }
    [status, tier].forEach((s) => s.addEventListener("change", load));
    q.addEventListener("keydown", (e) => e.key === "Enter" && load());
    main.append(h("h1", { textContent: "Members" }), h("div", { className: "row" }, h("div", { style: "flex:1;min-width:220px" }, q), status, tier, h("button", { textContent: "Search", onclick: load })), body, detail);
    await load();
  }

  // ---- audit --------------------------------------------------------------------------------------
  async function pageAudit(main) {
    const f = { action: h("input", { placeholder: "action prefix, e.g. member." }), actor: h("input", { placeholder: "actor" }), subject: h("input", { placeholder: "telegram id" }), from: h("input", { type: "date" }), to: h("input", { type: "date" }) };
    const body = h("tbody", {});
    const more = h("button", { className: "secondary", textContent: "Load more", hidden: true });
    let last = null;
    async function load(reset) {
      if (reset) { body.replaceChildren(); last = null; }
      const p = new URLSearchParams();
      for (const [k, i] of Object.entries(f)) if (i.value) p.set(k, k === "to" ? i.value + "T23:59:59" : i.value);
      if (last) p.set("before", last);
      const r = await act(() => api("GET", "/audit?" + p));
      if (!r) return;
      for (const e of r.events) body.append(h("tr", {}, h("td", { textContent: fmt(e.at) }), h("td", { textContent: e.action }), h("td", { textContent: e.actor }), h("td", { textContent: e.subject ?? "" }), h("td", { textContent: Object.keys(e.details || {}).length ? JSON.stringify(e.details) : "" })));
      last = r.events.at(-1)?.id ?? last;
      more.hidden = r.events.length < 100;
    }
    more.addEventListener("click", () => load(false));
    main.append(h("h1", { textContent: "Audit log" }), h("div", { className: "row" }, Object.values(f).map((i) => h("div", { style: "min-width:150px;flex:1" }, i)), h("button", { textContent: "Filter", onclick: () => load(true) })),
      h("div", { style: "overflow-x:auto;margin-top:12px" }, h("table", {}, h("thead", {}, h("tr", {}, ["Time", "Action", "Actor", "Subject", "Details"].map((x) => h("th", { textContent: x })))), body)), more);
    await load(true);
  }

  // ---- admins -------------------------------------------------------------------------------------
  async function pageAdmins(main) {
    const r = await api("GET", "/admins");
    const email = h("input", { type: "email" }), pw = h("input", { type: "password", autocomplete: "new-password" });
    main.append(h("h1", { textContent: "Admin accounts" }), h("div", { className: "card" }, h("table", {}, r.admins.map((a) => h("tr", {}, h("td", { textContent: a.email }), h("td", { textContent: fmt(a.created_at) }),
      h("td", {}, a.email !== me && h("button", { className: "danger", textContent: "Delete", onclick: () => confirm(`Delete ${a.email}?`) && act(async () => { await api("DELETE", `/admins/${a.id}`); render(); }, "Deleted") })))))),
      h("div", { className: "card", style: "margin-top:16px" }, h("h2", { textContent: "Add or reset an admin" }), h("div", { className: "grid cols2" }, field("Email", email), field("Password (min 10 chars)", pw)),
        h("button", { textContent: "Save", style: "margin-top:12px", onclick: () => act(async () => { await api("POST", "/admins", { email: email.value, password: pw.value }); render(); }, "Saved") })));
  }

  window.addEventListener("hashchange", () => { current = location.hash.slice(1) || "setup"; if (me) render(); });
  boot().catch(() => {});
})();
