/** Join requests: strangers get a verification link, then are approved/declined by what they hold. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceMember, onJoinRequest, onUnauthorizedJoin, runRecheck } from "../src/services/enforcement.js";
import { setOverride } from "../src/services/overrides.js";
import { account, bind, dbAvailable, makeCtx } from "./helpers.js";

const available = await dbAvailable();

describe.skipIf(!available)("join requests", () => {
  let t: Awaited<ReturnType<typeof makeCtx>>;
  beforeAll(async () => { t = await makeCtx(); });
  afterAll(async () => { await t?.cleanup(); });

  const req = async (id: number) => (await t.pool.query("SELECT * FROM join_requests WHERE telegram_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0];
  const active = async (id: number) => (await t.pool.query("SELECT * FROM group_memberships WHERE telegram_id=$1 AND removed_at IS NULL", [id])).rows;

  it("a stranger gets a verification link and stays pending (not declined)", async () => {
    expect(await onJoinRequest(t.ctx, "-100low", 3001, "newbie")).toBe("pending");
    expect(t.tg.lastTo(3001)).toContain("/verify/");
    expect(t.tg.declined.filter((d) => d.userId === 3001)).toHaveLength(0);
    expect((await req(3001)).resolved_at).toBeNull();
  });

  it("after verifying with a qualifying wallet the pending request is approved (no invite link sent)", async () => {
    t.reader.set(account(1).address, "1200");
    const before = t.tg.invites.length;
    await bind(t.ctx, 3001, 1);
    await enforceMember(t.ctx, 3001, "verify");
    expect(t.tg.approved).toContainEqual({ groupId: "-100low", userId: 3001 });
    expect(t.tg.invites.length).toBe(before);
    expect((await req(3001)).resolution).toBe("approved");
    const rows = await active(3001);
    expect(rows).toHaveLength(1);
    expect(rows[0].joined_at).not.toBeNull();
    expect(t.tg.lastTo(3001)).toContain("You're in");
  });

  it("a verified, qualifying member who requests is approved immediately", async () => {
    t.reader.set(account(2).address, "20000");
    await bind(t.ctx, 3002, 2);
    expect(await onJoinRequest(t.ctx, "-100high", 3002)).toBe("approved");
    expect(t.tg.approved).toContainEqual({ groupId: "-100high", userId: 3002 });
  });

  it("verifying but being short declines the request with the numbers", async () => {
    await onJoinRequest(t.ctx, "-100low", 3003);
    t.reader.set(account(3).address, "300");
    await bind(t.ctx, 3003, 3);
    await enforceMember(t.ctx, 3003, "verify");
    expect(t.tg.declined).toContainEqual({ groupId: "-100low", userId: 3003 });
    expect((await req(3003)).resolution).toBe("declined_short");
    expect(t.tg.lastTo(3003)).toContain("below the minimum");
    expect(await active(3003)).toHaveLength(0);
  });

  it("CRITICAL: a failed read leaves the request pending, never declines it", async () => {
    t.reader.set(account(4).address, "1200");
    await bind(t.ctx, 3004, 4);
    t.reader.failing = true;
    expect(await onJoinRequest(t.ctx, "-100low", 3004)).toBe("pending");
    expect(t.tg.declined.filter((d) => d.userId === 3004)).toHaveLength(0);
    t.reader.failing = false;
    await enforceMember(t.ctx, 3004, "reverify");
    expect((await req(3004)).resolution).toBe("approved");
  });

  it("highest-only: requesting the lower group while qualifying for the higher is declined with a pointer", async () => {
    t.reader.set(account(5).address, "20000");
    await bind(t.ctx, 3005, 5);
    expect(await onJoinRequest(t.ctx, "-100low", 3005)).toBe("declined");
    const texts = t.tg.messages.filter((m) => m.to === 3005).map((m) => m.text);
    expect(texts.some((x) => x.includes("You qualify for High"))).toBe(true);
    expect(texts.some((x) => x.includes("Your invite to High"))).toBe(true); // and they still get the right invite
  });

  it("a banned user's request is declined", async () => {
    await setOverride(t.ctx, { telegramId: 3006, type: "ban", setBy: "admin:x", reason: "t" });
    expect(await onJoinRequest(t.ctx, "-100low", 3006)).toBe("declined");
    expect((await req(3006)).resolution).toBe("declined_banned");
  });

  it("an allowlisted user is approved without a wallet", async () => {
    await setOverride(t.ctx, { telegramId: 3007, type: "allowlist", tierId: "low", setBy: "admin:x" });
    // setOverride already invited them; simulate a direct request in a fresh group state
    await t.pool.query("UPDATE group_memberships SET removed_at=now(), reason='test' WHERE telegram_id=3007");
    expect(await onJoinRequest(t.ctx, "-100low", 3007)).toBe("approved");
  });

  it("requests that wait too long are declined and the member is told", async () => {
    await onJoinRequest(t.ctx, "-100low", 3008);
    t.advanceHours(25);
    await runRecheck(t.ctx);
    expect((await req(3008)).resolution).toBe("expired");
    expect(t.tg.declined).toContainEqual({ groupId: "-100low", userId: 3008 });
    expect(t.tg.lastTo(3008)).toContain("expired");
  });

  it("requests for unlinked groups are ignored", async () => {
    expect(await onJoinRequest(t.ctx, "-100other", 3009)).toBe("ignored");
  });

  it("repeat requests don't duplicate the pending row", async () => {
    await onJoinRequest(t.ctx, "-100low", 3010);
    await onJoinRequest(t.ctx, "-100low", 3010);
    expect((await t.pool.query("SELECT 1 FROM join_requests WHERE telegram_id=3010 AND resolved_at IS NULL")).rowCount).toBe(1);
  });

  it("someone who came through their own invite link in join-request mode is approved", async () => {
    t.reader.set(account(6).address, "1200");
    await bind(t.ctx, 3011, 6);
    await enforceMember(t.ctx, 3011, "verify"); // issues an invite row
    expect(await onJoinRequest(t.ctx, "-100low", 3011)).toBe("approved");
  });
});

describe.skipIf(!available)("unauthorized joiners (quarantine)", () => {
  let t: Awaited<ReturnType<typeof makeCtx>>;
  beforeAll(async () => { t = await makeCtx(); });
  afterAll(async () => { await t?.cleanup(); });
  const pend = async (id: number) => (await t.pool.query("SELECT * FROM join_requests WHERE telegram_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0];

  it("mutes them, posts a Verify button in the group, and does NOT kick", async () => {
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4001, { username: "bob", name: "Bob" })).toBe("quarantined");
    expect(t.tg.muted.has("-100low:4001")).toBe(true);
    expect(t.tg.removed.filter((r) => r.userId === 4001)).toHaveLength(0);
    const n = t.tg.notices.at(-1)!;
    expect(n.text).toContain("Bob");
    expect(n.button?.url).toBe("https://t.me/gatebot?start=verify");
    expect((await pend(4001)).kind).toBe("quarantine");
  });

  it("verifying with a qualifying wallet unmutes them, removes the notice and records the join", async () => {
    t.reader.set(account(1).address, "1200");
    await bind(t.ctx, 4001, 1);
    await enforceMember(t.ctx, 4001, "verify");
    expect(t.tg.muted.has("-100low:4001")).toBe(false);
    expect(t.tg.deletedNotices).toContain(t.tg.notices.find((x) => x.text.includes("Bob"))!.id);
    expect((await pend(4001)).resolution).toBe("approved");
    const rows = (await t.pool.query("SELECT * FROM group_memberships WHERE telegram_id=4001 AND removed_at IS NULL")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].joined_at).not.toBeNull();
    expect(t.tg.removed.filter((r) => r.userId === 4001)).toHaveLength(0);
  });

  it("verifying but being short removes them with an explanation", async () => {
    await onUnauthorizedJoin(t.ctx, "-100low", 4002, { name: "Cy" });
    t.reader.set(account(2).address, "100");
    await bind(t.ctx, 4002, 2);
    await enforceMember(t.ctx, 4002, "verify");
    expect(t.tg.removed).toContainEqual({ groupId: "-100low", userId: 4002, permanent: false });
    expect(t.tg.lastTo(4002)).toContain("below the minimum");
  });

  it("CRITICAL: a failed read leaves them muted, not removed", async () => {
    t.reader.set(account(3).address, "1200");
    await bind(t.ctx, 4003, 3);
    t.reader.failing = true;
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4003, { name: "Di" })).toBe("quarantined");
    expect(t.tg.removed.filter((r) => r.userId === 4003)).toHaveLength(0);
    t.reader.failing = false;
    await enforceMember(t.ctx, 4003, "reverify");
    expect(t.tg.muted.has("-100low:4003")).toBe(false);
  });

  it("an already-verified qualifying member who enters via any link is let straight through", async () => {
    t.reader.set(account(4).address, "1200");
    await bind(t.ctx, 4004, 4);
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4004, { name: "Ed" })).toBe("approved");
    expect(t.tg.muted.has("-100low:4004")).toBe(false);
  });

  it("not verifying in time removes them", async () => {
    await onUnauthorizedJoin(t.ctx, "-100low", 4005, { name: "Flo" });
    t.advanceHours(25);
    await runRecheck(t.ctx);
    expect(t.tg.removed).toContainEqual({ groupId: "-100low", userId: 4005, permanent: false });
    expect((await pend(4005)).resolution).toBe("expired");
  });

  it("if the bot can't mute, it falls back to removing", async () => {
    t.tg.failRestrict = true;
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4006, { name: "Gus" })).toBe("removed");
    expect(t.tg.removed).toContainEqual({ groupId: "-100low", userId: 4006, permanent: false });
    t.tg.failRestrict = false;
  });

  it("banned users are removed permanently; kick mode removes immediately", async () => {
    await setOverride(t.ctx, { telegramId: 4007, type: "ban", setBy: "admin:x" });
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4007, { name: "Hal" })).toBe("removed");
    expect(t.tg.removed).toContainEqual({ groupId: "-100low", userId: 4007, permanent: true });

    const { config } = await t.ctx.config.current();
    await t.ctx.config.save({ ...config, verification: { ...config.verification, unauthorizedJoin: "kick" } }, "test");
    expect(await onUnauthorizedJoin(t.ctx, "-100low", 4008, { name: "Ivy" })).toBe("removed");
    expect(t.tg.muted.has("-100low:4008")).toBe(false);
  });
});
