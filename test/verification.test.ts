/** Phase 3 acceptance: a user links a wallet, and a second account cannot reuse it. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCode, ensureMember, loadCode, signingMessage, verifyAndBind } from "../src/services/verification.js";
import { account, bind, dbAvailable, makeCtx } from "./helpers.js";

const available = await dbAvailable();

describe.skipIf(!available)("ownership verification", () => {
  let t: Awaited<ReturnType<typeof makeCtx>>;
  beforeAll(async () => { t = await makeCtx(); });
  afterAll(async () => { await t?.cleanup(); });

  it("binds a wallet after a valid signature", async () => {
    const r = await bind(t.ctx, 1001, 1);
    expect(r.result).toMatchObject({ ok: true, wallet: account(1).address.toLowerCase() });
    const m = (await t.pool.query("SELECT wallet, status FROM members WHERE telegram_id=1001")).rows[0];
    expect(m).toEqual({ wallet: account(1).address.toLowerCase(), status: "verified" });
  });

  it("codes are single-use", async () => {
    const first = await bind(t.ctx, 1002, 2);
    expect(first.result.ok).toBe(true);
    const again = await verifyAndBind(t.ctx, first.code, first.acct.address, first.signature);
    expect(again).toEqual({ ok: false, error: "invalid_code" });
  });

  it("codes expire", async () => {
    await ensureMember(t.ctx, 1003);
    const { code } = await createCode(t.ctx, 1003);
    const { row } = await loadCode(t.ctx, code);
    const sig = await account(3).signMessage({ message: signingMessage(t.ctx, "Test Co", row!) });
    t.advanceHours(1);
    expect(await verifyAndBind(t.ctx, code, account(3).address, sig)).toEqual({ ok: false, error: "invalid_code" });
  });

  it("a newer code invalidates the older one", async () => {
    await ensureMember(t.ctx, 1004);
    const a = await createCode(t.ctx, 1004);
    await createCode(t.ctx, 1004);
    expect((await loadCode(t.ctx, a.code)).state).toBe("used");
  });

  it("rejects a signature from a different wallet than claimed", async () => {
    await ensureMember(t.ctx, 1005);
    const { code } = await createCode(t.ctx, 1005);
    const { row } = await loadCode(t.ctx, code);
    const sig = await account(4).signMessage({ message: signingMessage(t.ctx, "Test Co", row!) });
    // Claims account 5's address but the signature is from account 4: the "paste a whale's address" attack.
    expect(await verifyAndBind(t.ctx, code, account(5).address, sig)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects a signature over a different message (replay from another code)", async () => {
    await ensureMember(t.ctx, 1006);
    const { code } = await createCode(t.ctx, 1006);
    const sig = await account(6).signMessage({ message: "something else entirely" });
    expect(await verifyAndBind(t.ctx, code, account(6).address, sig)).toEqual({ ok: false, error: "bad_signature" });
  });

  it("refuses a second Telegram account for the same wallet", async () => {
    expect((await bind(t.ctx, 1010, 7)).result.ok).toBe(true);
    const second = await bind(t.ctx, 1011, 7);
    expect(second.result).toEqual({ ok: false, error: "wallet_in_use" });
    const m = (await t.pool.query("SELECT wallet FROM members WHERE telegram_id=1011")).rows[0];
    expect(m.wallet).toBeNull();
    const ev = (await t.pool.query("SELECT 1 FROM audit_events WHERE action='wallet.rejected_in_use' AND subject=1011")).rowCount;
    expect(ev).toBe(1);
  });

  it("concurrent attempts for one wallet: exactly one account wins", async () => {
    const results = await Promise.all([bind(t.ctx, 1020, 8), bind(t.ctx, 1021, 8), bind(t.ctx, 1022, 8)]);
    expect(results.filter((r) => r.result.ok)).toHaveLength(1);
  });

  it("replacing a wallet is allowed and audited", async () => {
    await bind(t.ctx, 1030, 9);
    const r = await bind(t.ctx, 1030, 10);
    expect(r.result).toMatchObject({ ok: true, replaced: account(9).address.toLowerCase() });
    expect((await t.pool.query("SELECT 1 FROM audit_events WHERE action='wallet.replaced' AND subject=1030")).rowCount).toBe(1);
  });

  it("a banned account can't bind", async () => {
    await ensureMember(t.ctx, 1040);
    await t.pool.query("UPDATE members SET status='banned' WHERE telegram_id=1040");
    expect((await bind(t.ctx, 1040, 11)).result).toEqual({ ok: false, error: "banned" });
  });
});
