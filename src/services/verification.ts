import { randomBytes } from "node:crypto";
import { createPublicClient, getAddress, http, isAddress, verifyMessage } from "viem";
import type { Ctx } from "../ctx.js";
import { audit } from "./audit.js";

export const CODE_TTL_MINUTES = 15;

export interface CodeRow {
  code: string;
  telegram_id: number;
  expires_at: Date;
  used: boolean;
}

export async function ensureMember(ctx: Ctx, telegramId: number, username?: string | null): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO members (telegram_id, telegram_username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET telegram_username = COALESCE($2, members.telegram_username)`,
    [telegramId, username ?? null],
  );
}

/** Issue a one-time link. Any earlier unused code for the same member is invalidated. */
export async function createCode(ctx: Ctx, telegramId: number) {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(ctx.now().getTime() + CODE_TTL_MINUTES * 60_000);
  await ctx.pool.query("UPDATE verification_codes SET used = true WHERE telegram_id = $1 AND NOT used", [telegramId]);
  await ctx.pool.query("INSERT INTO verification_codes (code, telegram_id, expires_at) VALUES ($1,$2,$3)", [
    code,
    telegramId,
    expiresAt,
  ]);
  return { code, url: `${ctx.env.PUBLIC_URL.replace(/\/$/, "")}/verify/${code}`, expiresAt, minutes: CODE_TTL_MINUTES };
}

/** The exact text the wallet signs. Server-built, so the client can't choose what is signed. */
export function signingMessage(ctx: Ctx, communityName: string, row: CodeRow): string {
  return [
    `${communityName} wallet verification`,
    "",
    "Signing proves you own this wallet. It costs no gas and moves no tokens.",
    "",
    `Telegram ID: ${row.telegram_id}`,
    `Code: ${row.code}`,
    `Site: ${new URL(ctx.env.PUBLIC_URL).host}`,
    `Chain ID: ${ctx.env.CHAIN_ID}`,
    `Expires: ${row.expires_at.toISOString()}`,
  ].join("\n");
}

export type CodeState = "valid" | "used" | "expired" | "unknown";

export async function loadCode(ctx: Ctx, code: string): Promise<{ state: CodeState; row?: CodeRow }> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return { state: "unknown" };
  const { rows } = await ctx.pool.query<CodeRow>("SELECT * FROM verification_codes WHERE code = $1", [code]);
  const row = rows[0];
  if (!row) return { state: "unknown" };
  if (row.used) return { state: "used", row };
  if (row.expires_at.getTime() <= ctx.now().getTime()) return { state: "expired", row };
  return { state: "valid", row };
}

/** EOAs verify locally; contract wallets (ERC-1271) fall back to an on-chain check. */
export async function verifySignature(ctx: Ctx, address: `0x${string}`, message: string, signature: `0x${string}`) {
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    /* fall through to contract-wallet check */
  }
  try {
    const client = createPublicClient({ transport: http(ctx.env.RPC_URL, { timeout: 10_000 }) });
    return await client.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

export type BindResult =
  | { ok: true; telegramId: number; wallet: string; replaced: string | null }
  | { ok: false; error: "invalid_code" | "bad_address" | "bad_signature" | "wallet_in_use" | "banned" };

/**
 * Verifies the signature and binds Telegram ID -> wallet atomically.
 * One-wallet-per-account is enforced inside the transaction under an advisory lock on the wallet.
 */
export async function verifyAndBind(
  ctx: Ctx,
  code: string,
  addressInput: string,
  signature: string,
): Promise<BindResult> {
  const { config } = await ctx.config.current();
  const loaded = await loadCode(ctx, code);
  if (loaded.state !== "valid" || !loaded.row) return { ok: false, error: "invalid_code" };
  if (!isAddress(addressInput)) return { ok: false, error: "bad_address" };
  const address = getAddress(addressInput);
  const row = loaded.row;

  if (config.verification.signatureRequired) {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: "bad_signature" };
    const message = signingMessage(ctx, config.branding.communityName, row);
    if (!(await verifySignature(ctx, address, message, signature as `0x${string}`))) {
      return { ok: false, error: "bad_signature" };
    }
  }

  const wallet = address.toLowerCase();
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [wallet]);
    const fresh = await client.query("SELECT used, expires_at FROM verification_codes WHERE code = $1 FOR UPDATE", [code]);
    const f = fresh.rows[0];
    if (!f || f.used || f.expires_at.getTime() <= ctx.now().getTime()) {
      await client.query("ROLLBACK");
      return { ok: false, error: "invalid_code" };
    }
    const member = (await client.query("SELECT wallet, status FROM members WHERE telegram_id = $1 FOR UPDATE", [row.telegram_id]))
      .rows[0];
    const banned =
      member?.status === "banned" ||
      (await client.query("SELECT 1 FROM overrides WHERE telegram_id=$1 AND type='ban' AND revoked_at IS NULL", [row.telegram_id]))
        .rowCount;
    if (banned) {
      await client.query("ROLLBACK");
      return { ok: false, error: "banned" };
    }
    if (config.verification.oneWalletPerAccount) {
      const other = await client.query("SELECT telegram_id FROM members WHERE wallet = $1 AND telegram_id <> $2 LIMIT 1", [
        wallet,
        row.telegram_id,
      ]);
      if (other.rowCount) {
        await client.query("ROLLBACK");
        await audit(ctx, `member:${row.telegram_id}`, "wallet.rejected_in_use", row.telegram_id, {
          wallet,
          heldBy: other.rows[0].telegram_id,
        });
        return { ok: false, error: "wallet_in_use" };
      }
    }
    await client.query("UPDATE verification_codes SET used = true WHERE code = $1", [code]);
    const replaced: string | null = member?.wallet && member.wallet !== wallet ? member.wallet : null;
    await client.query(
      `UPDATE members SET wallet = $2, status = CASE WHEN status IN ('new','removed') THEN 'verified' ELSE status END
       WHERE telegram_id = $1`,
      [row.telegram_id, wallet],
    );
    await client.query("COMMIT");
    await audit(ctx, `member:${row.telegram_id}`, replaced ? "wallet.replaced" : "wallet.bound", row.telegram_id, {
      wallet,
      ...(replaced ? { previous: replaced } : {}),
    });
    return { ok: true, telegramId: row.telegram_id, wallet, replaced };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
