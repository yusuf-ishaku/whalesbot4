/** Phase 5 acceptance: lowering a balance -> warning -> removal after grace; RPC failure removes nobody. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceMember, handleJoin, handleLeave, runRecheck } from "../src/services/enforcement.js";
import { releaseGrace, revokeOverride, setOverride } from "../src/services/overrides.js";
import { account, bind, dbAvailable, makeCtx } from "./helpers.js";

const available = await dbAvailable();

describe.skipIf(!available)("enforcement", () => {
  let t: Awaited<ReturnType<typeof makeCtx>>;
  beforeAll(async () => { t = await makeCtx(); });
  afterAll(async () => { await t?.cleanup(); });

  const member = async (id: number) => (await t.pool.query("SELECT * FROM members WHERE telegram_id=$1", [id])).rows[0];
  const active = async (id: number) => (await t.pool.query("SELECT * FROM group_memberships WHERE telegram_id=$1 AND removed_at IS NULL", [id])).rows;
  const audits = async (id: number, action: string) => (await t.pool.query("SELECT 1 FROM audit_events WHERE subject=$1 AND action=$2", [id, action])).rowCount;
  /** Verify + join the group the invite pointed at. */
  async function onboard(id: number, acctIdx: number, token: string, staked = "0") {
    t.reader.set(account(acctIdx).address, token, staked);
    await bind(t.ctx, id, acctIdx);
    const o = await enforceMember(t.ctx, id, "verify");
    for (const r of await active(id)) await handleJoin(t.ctx, r.group_id, id);
    return o;
  }

  it("qualifying member gets a single-use invite to the right group", async () => {
    const o = await onboard(2001, 1, "1200");
    expect(o.desired.map((d) => d.id)).toEqual(["low"]);
    expect(t.tg.invites.at(-1)?.groupId).toBe("-100low");
    expect(t.tg.lastTo(2001)).toContain("https://t.me/+invite");
    expect((await member(2001)).status).toBe("verified");
  });

  it("a member who is short gets no invite", async () => {
    const o = await onboard(2002, 2, "100");
    expect(o.desired).toEqual([]);
    expect(await active(2002)).toHaveLength(0);
    expect(o.result?.nextTier?.shortfall).toBe("900");
  });

  it("balance drop -> warning + grace; nobody removed yet", async () => {
    await onboard(2003, 3, "1200");
    t.reader.set(account(3).address, "10");
    t.advanceHours(25);
    await enforceMember(t.ctx, 2003, "scheduled");
    const m = await member(2003);
    expect(m.status).toBe("grace");
    expect(t.tg.lastTo(2003)).toContain("no longer meet");
    expect(t.tg.removed.filter((r) => r.userId === 2003)).toHaveLength(0);
    expect(await audits(2003, "warning.sent")).toBe(1);
  });

  it("removed after the grace period elapses, with audit + notice", async () => {
    t.advanceHours(49);
    await enforceMember(t.ctx, 2003, "scheduled");
    expect((await member(2003)).status).toBe("removed");
    expect(t.tg.removed).toContainEqual({ groupId: "-100low", userId: 2003, permanent: false });
    expect(await active(2003)).toHaveLength(0);
    expect(await audits(2003, "member.removed")).toBe(1);
    expect(t.tg.lastTo(2003)).toContain("removed");
  });

  it("requalifying within grace cancels it", async () => {
    await onboard(2004, 4, "1200");
    t.reader.set(account(4).address, "0");
    t.advanceHours(25);
    await enforceMember(t.ctx, 2004, "scheduled");
    expect((await member(2004)).status).toBe("grace");
    t.reader.set(account(4).address, "1500");
    t.advanceHours(10);
    await enforceMember(t.ctx, 2004, "scheduled");
    expect((await member(2004)).status).toBe("verified");
    expect((await member(2004)).grace_started_at).toBeNull();
    expect(await audits(2004, "grace.cancelled")).toBe(1);
    expect(await active(2004)).toHaveLength(1);
  });

  it("CRITICAL: a failed read never removes anyone, even past the grace period", async () => {
    await onboard(2005, 5, "1200");
    t.reader.set(account(5).address, "0");
    t.advanceHours(25);
    await enforceMember(t.ctx, 2005, "scheduled"); // short -> grace
    expect((await member(2005)).status).toBe("grace");

    const before = t.tg.removed.length;
    t.reader.failing = true;
    t.advanceHours(100); // far beyond grace
    const o = await enforceMember(t.ctx, 2005, "scheduled");
    expect(o.outcome).toBe("skipped_read_failed");
    expect((await member(2005)).status).toBe("grace");
    expect(t.tg.removed.length).toBe(before);
    expect(await active(2005)).toHaveLength(1);
    expect(await audits(2005, "check.read_failed")).toBeGreaterThan(0);
    t.reader.failing = false;
  });

  it("CRITICAL: a full scheduled run during an RPC outage removes nobody", async () => {
    await onboard(2006, 6, "1200");
    await onboard(2007, 7, "20000");
    t.advanceHours(25);
    t.reader.failing = true;
    const before = t.tg.removed.length;
    const stats = await runRecheck(t.ctx);
    expect(stats.skippedReadFailed).toBeGreaterThanOrEqual(2);
    expect(t.tg.removed.length).toBe(before);
    t.reader.failing = false;
  });

  it("Telegram removal failure keeps the membership open to retry", async () => {
    await onboard(2008, 8, "1200");
    t.reader.set(account(8).address, "0");
    t.advanceHours(25);
    await enforceMember(t.ctx, 2008, "scheduled");
    t.advanceHours(49);
    t.tg.failRemove = true;
    await enforceMember(t.ctx, 2008, "scheduled");
    expect((await member(2008)).status).toBe("grace");
    expect(await active(2008)).toHaveLength(1);
    expect(await audits(2008, "removal.failed")).toBe(1);
    t.tg.failRemove = false;
    await enforceMember(t.ctx, 2008, "scheduled");
    expect((await member(2008)).status).toBe("removed");
  });

  it("downgrade high -> low: removed from high immediately, invited to low", async () => {
    await onboard(2009, 9, "12000");
    expect((await active(2009)).map((r) => r.tier_id)).toEqual(["high"]);
    t.reader.set(account(9).address, "2000");
    await enforceMember(t.ctx, 2009, "reverify");
    const tiers = (await active(2009)).map((r) => r.tier_id);
    expect(tiers).toEqual(["low"]);
    expect(t.tg.removed).toContainEqual({ groupId: "-100high", userId: 2009, permanent: false });
  });

  it("upgrade low -> high: keeps low until the member joins high", async () => {
    await onboard(2010, 10, "1200");
    t.reader.set(account(10).address, "12000");
    await enforceMember(t.ctx, 2010, "reverify");
    expect((await active(2010)).map((r) => r.tier_id).sort()).toEqual(["high", "low"]);
    await handleJoin(t.ctx, "-100high", 2010);
    await enforceMember(t.ctx, 2010, "reverify");
    expect((await active(2010)).map((r) => r.tier_id)).toEqual(["high"]);
  });

  it("all_qualified overlap keeps access to every qualifying tier", async () => {
    const { config } = await t.ctx.config.current();
    await t.ctx.config.save({ ...config, overlap: "all_qualified" }, "test");
    await onboard(2011, 11, "12000");
    expect((await active(2011)).map((r) => r.tier_id).sort()).toEqual(["high", "low"]);
    await t.ctx.config.save({ ...config, overlap: "highest_only" }, "test");
  });

  it("scheduled runs respect the cadence", async () => {
    await onboard(2012, 12, "1200");
    const first = await runRecheck(t.ctx);
    const second = await runRecheck(t.ctx);
    expect(second.checked).toBe(0);
    expect(first.ran).toBe(true);
    t.advanceHours(25);
    expect((await runRecheck(t.ctx)).checked).toBeGreaterThan(0);
  });

  it("scheduled runs do not re-spam invites to someone who never joined", async () => {
    t.reader.set(account(13).address, "1200");
    await bind(t.ctx, 2013, 13);
    await enforceMember(t.ctx, 2013, "verify");
    const n = t.tg.invites.length;
    t.advanceHours(2); // invite expired (60 min)
    await enforceMember(t.ctx, 2013, "scheduled");
    expect(t.tg.invites.length).toBe(n);
    expect(await active(2013)).toHaveLength(0);
    await enforceMember(t.ctx, 2013, "reverify"); // explicit ask gets a fresh one
    expect(t.tg.invites.length).toBe(n + 1);
  });

  it("ban removes everywhere permanently; unban restores the path back", async () => {
    await onboard(2014, 14, "12000");
    await setOverride(t.ctx, { telegramId: 2014, type: "ban", setBy: "admin:a@b.c", reason: "spam" });
    expect(t.tg.removed).toContainEqual({ groupId: "-100high", userId: 2014, permanent: true });
    expect((await member(2014)).status).toBe("banned");
    expect(await audits(2014, "override.ban.set")).toBe(1);
    const before = t.tg.invites.length;
    await revokeOverride(t.ctx, 2014, "ban", "admin:a@b.c");
    // Still holds 12,000, so the immediate re-check makes them eligible again with a fresh invite.
    expect((await member(2014)).status).toBe("verified");
    expect(t.tg.invites.length).toBe(before + 1);
  });

  it("allowlist grants a tier without a wallet and survives a zero balance", async () => {
    const { ensureMember } = await import("../src/services/verification.js");
    await ensureMember(t.ctx, 2015);
    await setOverride(t.ctx, { telegramId: 2015, type: "allowlist", tierId: "high", setBy: "admin:a@b.c" });
    expect((await active(2015)).map((r) => r.tier_id)).toEqual(["high"]);
    await handleJoin(t.ctx, "-100high", 2015);
    t.advanceHours(100);
    await enforceMember(t.ctx, 2015, "scheduled");
    expect((await active(2015)).map((r) => r.tier_id)).toEqual(["high"]);
  });

  it("admin can release a member from grace", async () => {
    await onboard(2016, 15, "1200");
    t.reader.set(account(15).address, "0");
    t.advanceHours(25);
    await enforceMember(t.ctx, 2016, "scheduled");
    expect(await releaseGrace(t.ctx, 2016, "admin:a@b.c")).toBe(true);
    expect((await member(2016)).status).toBe("verified");
  });

  it("an unauthorised join is rejected; leaving closes the membership", async () => {
    expect(await handleJoin(t.ctx, "-100high", 9999)).toBe("rejected");
    await onboard(2017, 16, "1200");
    await handleLeave(t.ctx, "-100low", 2017);
    expect(await active(2017)).toHaveLength(0);
  });

  it("zero grace period removes on the first failing check", async () => {
    const { config } = await t.ctx.config.current();
    await t.ctx.config.save({ ...config, recheck: { ...config.recheck, gracePeriodHours: 0 } }, "test");
    await onboard(2018, 17, "1200");
    t.reader.set(account(17).address, "0");
    await enforceMember(t.ctx, 2018, "reverify");
    expect((await member(2018)).status).toBe("removed");
    await t.ctx.config.save({ ...config }, "test");
  });
});
