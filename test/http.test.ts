/** HTTP surface: verification page API, dashboard auth/CSRF, config validation, group linking. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createAdmin } from "../src/services/adminAuth.js";
import { consumeLinkCode, createLinkCode } from "../src/services/groupLink.js";
import { createCode, ensureMember, loadCode, signingMessage } from "../src/services/verification.js";
import { account, dbAvailable, makeCtx } from "./helpers.js";

const available = await dbAvailable();

describe.skipIf(!available)("http", () => {
  let t: Awaited<ReturnType<typeof makeCtx>>;
  let app: ReturnType<typeof buildApp>;
  let cookie = "";
  const H = () => ({ cookie, "x-requested-with": "dashboard" });

  beforeAll(async () => {
    t = await makeCtx();
    app = buildApp(t.ctx);
    await createAdmin(t.pool, "Boss@Example.com", "correct-horse-battery");
  });
  afterAll(async () => { await app?.close(); await t?.cleanup(); });

  it("serves the pages and assets with security headers", async () => {
    for (const url of ["/admin", "/verify/abc", "/assets/admin.js", "/assets/verify.js", "/assets/style.css"]) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    }
    expect((await app.inject({ url: "/assets/..%2Fpackage.json" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/health" })).json()).toMatchObject({ ok: true, telegram: true });
  });

  it("dashboard API requires login", async () => {
    expect((await app.inject({ url: "/api/admin/members" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "boss@example.com", password: "nope" } });
    expect(bad.statusCode).toBe(401);
  });

  it("logs in (email case-insensitive) and sets an HttpOnly strict cookie", async () => {
    const r = await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "BOSS@example.com", password: "correct-horse-battery" } });
    expect(r.statusCode).toBe(200);
    const set = String(r.headers["set-cookie"]);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    cookie = set.split(";")[0]!;
    expect((await app.inject({ url: "/api/admin/me", headers: H() })).json()).toEqual({ email: "boss@example.com" });
  });

  it("rejects a tampered session and mutations without the CSRF header", async () => {
    expect((await app.inject({ url: "/api/admin/me", headers: { cookie: cookie.slice(0, -2) + "xx" } })).statusCode).toBe(401);
    const r = await app.inject({ method: "PUT", url: "/api/admin/config", headers: { cookie }, payload: {} });
    expect(r.statusCode).toBe(403);
  });

  it("locks out after repeated failed logins", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: "victim@example.com", password: "x" } })).statusCode;
    expect(last).toBe(429);
  });

  it("validates config: unique tiers, shared groups, bad colours", async () => {
    const { config } = (await app.inject({ url: "/api/admin/config", headers: H() })).json();
    const put = (c: unknown) => app.inject({ method: "PUT", url: "/api/admin/config", headers: H(), payload: c as object });

    const dupGroup = await put({ ...config, tiers: config.tiers.map((x: object) => ({ ...x, telegramGroupId: "-1" })) });
    expect(dupGroup.statusCode).toBe(400);
    expect(dupGroup.json().problems.join()).toContain("share one Telegram group");

    const badColor = await put({ ...config, branding: { ...config.branding, colors: { primary: "red;} body{display:none", background: "#000000" } } });
    expect(badColor.statusCode).toBe(400);

    const badLogo = await put({ ...config, branding: { ...config.branding, logoUrl: "javascript:alert(1)" } });
    expect(badLogo.statusCode).toBe(400);

    const ok = await put({ ...config, branding: { ...config.branding, communityName: "Renamed" } });
    expect(ok.statusCode).toBe(200);
    expect((await t.ctx.config.current()).config.branding.communityName).toBe("Renamed");
    const versions = (await app.inject({ url: "/api/admin/config/history", headers: H() })).json().versions;
    expect(versions[0].changed_by).toBe("admin:boss@example.com");
    await put({ ...config, branding: { ...config.branding, communityName: "Test Co" } });
  });

  it("test-wallet runs the engine and is audited; read failure is reported, not zero", async () => {
    t.reader.set(account(1).address, "600", "600");
    const r = await app.inject({ method: "POST", url: "/api/admin/test-wallet", headers: H(), payload: { address: account(1).address } });
    expect(r.json()).toMatchObject({ status: "ok", total: "1200", tier: { id: "low" } });
    t.reader.failing = true;
    const f = await app.inject({ method: "POST", url: "/api/admin/test-wallet", headers: H(), payload: { address: account(1).address } });
    expect(f.json()).toMatchObject({ status: "read_failed", total: null });
    t.reader.failing = false;
    expect((await app.inject({ method: "POST", url: "/api/admin/test-wallet", headers: H(), payload: { address: "nope" } })).statusCode).toBe(400);
    const setup = (await app.inject({ url: "/api/admin/setup", headers: H() })).json();
    expect(setup.steps.find((s: { id: string }) => s.id === "test").done).toBe(true);
  });

  it("end-to-end verification through the HTTP API, then admin sees the member", async () => {
    t.reader.set(account(2).address, "20000");
    await ensureMember(t.ctx, 5001, "alice");
    const { code } = await createCode(t.ctx, 5001);
    const info = (await app.inject({ url: `/api/verify/${code}` })).json();
    expect(info.state).toBe("valid");
    expect(info.message).toContain("Telegram ID: 5001");
    expect(info.texts["web.title"]).toBeTruthy();

    const signature = await account(2).signMessage({ message: info.message });
    const done = await app.inject({ method: "POST", url: `/api/verify/${code}`, payload: { address: account(2).address, signature } });
    expect(done.json()).toMatchObject({ ok: true, tier: { id: "high" }, total: "20000" });
    expect(t.tg.invites.at(-1)?.groupId).toBe("-100high");

    // used code now reports used; a replay is rejected
    expect((await app.inject({ url: `/api/verify/${code}` })).json().state).toBe("used");
    const replay = await app.inject({ method: "POST", url: `/api/verify/${code}`, payload: { address: account(2).address, signature } });
    expect(replay.statusCode).toBe(400);

    const list = (await app.inject({ url: "/api/admin/members?q=alice", headers: H() })).json();
    expect(list.total).toBe(1);
    expect(list.members[0]).toMatchObject({ telegram_id: 5001, status: "verified", current_tier: "high" });

    const counts = (await app.inject({ url: "/api/admin/counts", headers: H() })).json();
    expect(counts.tiers.map((x: { id: string }) => x.id)).toContain("high");
  });

  it("second account on the same wallet gets a 409 with a friendly message", async () => {
    await ensureMember(t.ctx, 5002);
    const { code } = await createCode(t.ctx, 5002);
    const { row } = await loadCode(t.ctx, code);
    const signature = await account(2).signMessage({ message: signingMessage(t.ctx, "Test Co", row!) });
    const r = await app.inject({ method: "POST", url: `/api/verify/${code}`, payload: { address: account(2).address, signature } });
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toContain("already linked");
  });

  it("malformed / unknown codes never throw", async () => {
    expect((await app.inject({ url: "/api/verify/short" })).json().state).toBe("unknown");
    const r = await app.inject({ method: "POST", url: "/api/verify/doesnotexistdoesnotexist1", payload: { address: account(3).address, signature: "0x00" } });
    expect(r.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/verify/x", payload: "garbage" })).statusCode).toBe(415); // non-JSON is a client error, not a crash
    expect((await app.inject({ method: "POST", url: "/api/verify/x", headers: { "content-type": "application/json" }, payload: "{bad" })).statusCode).toBe(400);
  });

  it("admin overrides via API ban and then unban", async () => {
    const ban = await app.inject({ method: "POST", url: "/api/admin/members/5001/ban", headers: H(), payload: { reason: "test" } });
    expect(ban.json().outcome).toBe("banned");
    const detail = (await app.inject({ url: "/api/admin/members/5001", headers: H() })).json();
    expect(detail.member.status).toBe("banned");
    const audit = (await app.inject({ url: "/api/admin/audit?action=override.&subject=5001", headers: H() })).json();
    expect(audit.events[0].actor).toBe("admin:boss@example.com");
    await app.inject({ method: "POST", url: "/api/admin/members/5001/revoke-override", headers: H(), payload: { type: "ban" } });
  });

  it("group linking: only a Telegram group admin with a valid code can link", async () => {
    const { code } = await createLinkCode(t.ctx, "low", "admin:boss@example.com");
    expect(await consumeLinkCode(t.ctx, code, "-100newgroup", 77)).toEqual({ ok: false, error: "not_admin" });
    t.tg.admins.add("-100newgroup:77");
    expect(await consumeLinkCode(t.ctx, "badcode", "-100newgroup", 77)).toEqual({ ok: false, error: "bad_code" });
    expect(await consumeLinkCode(t.ctx, code, "-100newgroup", 77)).toMatchObject({ ok: true, tierId: "low" });
    expect((await t.ctx.config.current()).config.tiers.find((x) => x.id === "low")?.telegramGroupId).toBe("-100newgroup");
    expect(await consumeLinkCode(t.ctx, code, "-100newgroup", 77)).toEqual({ ok: false, error: "bad_code" }); // single use
  });

  it("can't delete your own admin account; can add another", async () => {
    await app.inject({ method: "POST", url: "/api/admin/admins", headers: H(), payload: { email: "second@example.com", password: "another-long-pass" } });
    const admins = (await app.inject({ url: "/api/admin/admins", headers: H() })).json().admins;
    expect(admins).toHaveLength(2);
    const self = admins.find((a: { email: string }) => a.email === "boss@example.com");
    expect((await app.inject({ method: "DELETE", url: `/api/admin/admins/${self.id}`, headers: H() })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/admins", headers: H(), payload: { email: "x@y.z", password: "short" } })).statusCode).toBe(400);
  });
});
