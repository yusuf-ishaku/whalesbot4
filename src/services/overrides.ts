import type { Ctx } from "../ctx.js";
import { audit } from "./audit.js";
import { enforceMember } from "./enforcement.js";
import { ensureMember } from "./verification.js";

/** Allowlist (optionally for a specific tier) or ban. Applies immediately. */
export async function setOverride(
  ctx: Ctx,
  o: { telegramId: number; type: "allowlist" | "ban"; tierId?: string | null; setBy: string; reason?: string },
) {
  await ensureMember(ctx, o.telegramId);
  // Replace any active override of the same type.
  await ctx.pool.query("UPDATE overrides SET revoked_at=$3 WHERE telegram_id=$1 AND type=$2 AND revoked_at IS NULL", [
    o.telegramId, o.type, ctx.now(),
  ]);
  await ctx.pool.query(
    "INSERT INTO overrides (telegram_id, type, tier_id, set_by, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [o.telegramId, o.type, o.tierId ?? null, o.setBy, o.reason ?? null, ctx.now()],
  );
  if (o.type === "ban") await ctx.pool.query("UPDATE members SET status='banned' WHERE telegram_id=$1", [o.telegramId]);
  await audit(ctx, o.setBy, `override.${o.type}.set`, o.telegramId, { tierId: o.tierId ?? null, reason: o.reason ?? null });
  return enforceMember(ctx, o.telegramId, "admin");
}

export async function revokeOverride(ctx: Ctx, telegramId: number, type: "allowlist" | "ban", by: string, reason?: string) {
  const r = await ctx.pool.query("UPDATE overrides SET revoked_at=$3 WHERE telegram_id=$1 AND type=$2 AND revoked_at IS NULL", [
    telegramId, type, ctx.now(),
  ]);
  if (!r.rowCount) return null;
  if (type === "ban") {
    await ctx.pool.query("UPDATE members SET status = CASE WHEN wallet IS NULL THEN 'new' ELSE 'removed' END WHERE telegram_id=$1 AND status='banned'", [telegramId]);
  }
  await audit(ctx, by, `override.${type}.revoked`, telegramId, { reason: reason ?? null });
  return enforceMember(ctx, telegramId, "admin");
}

/** Cancel an in-progress grace period without waiting for the next check. */
export async function releaseGrace(ctx: Ctx, telegramId: number, by: string) {
  const r = await ctx.pool.query(
    `UPDATE members SET status='verified', grace_started_at=NULL, warned_at=NULL, reminded_at=NULL, last_check_at=$2
     WHERE telegram_id=$1 AND status='grace'`,
    [telegramId, ctx.now()],
  );
  if (r.rowCount) await audit(ctx, by, "grace.released", telegramId, {});
  return !!r.rowCount;
}
