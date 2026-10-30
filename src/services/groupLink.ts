import { randomBytes } from "node:crypto";
import type { Ctx } from "../ctx.js";
import { audit } from "./audit.js";

/** Dashboard generates a code; a group admin posts `/link <code>` in the group to bind it to a tier. */
export async function createLinkCode(ctx: Ctx, tierId: string, by: string) {
  const code = randomBytes(6).toString("hex");
  const expiresAt = new Date(ctx.now().getTime() + 15 * 60_000);
  await ctx.pool.query("INSERT INTO link_codes (code, tier_id, created_by, expires_at) VALUES ($1,$2,$3,$4)", [code, tierId, by, expiresAt]);
  return { code, expiresAt, command: `/link ${code}` };
}

export type LinkResult =
  | { ok: true; tierId: string; tierName: string }
  | { ok: false; error: "bad_code" | "not_admin" | "unknown_tier" };

export async function consumeLinkCode(ctx: Ctx, code: string, groupId: string, userId: number): Promise<LinkResult> {
  const { rows } = await ctx.pool.query(
    "SELECT * FROM link_codes WHERE code=$1 AND NOT used AND expires_at > $2",
    [code, ctx.now()],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "bad_code" };
  if (!(await ctx.tg.isChatAdmin(groupId, userId).catch(() => false))) return { ok: false, error: "not_admin" };

  const { config } = await ctx.config.current();
  const tier = config.tiers.find((t) => t.id === row.tier_id);
  if (!tier) return { ok: false, error: "unknown_tier" };

  await ctx.pool.query("UPDATE link_codes SET used = true WHERE code=$1", [code]);
  const next = { ...config, tiers: config.tiers.map((t) => (t.id === tier.id ? { ...t, telegramGroupId: groupId } : t.telegramGroupId === groupId ? { ...t, telegramGroupId: null } : t)) };
  await ctx.config.save(next, `telegram:${userId}`);
  await audit(ctx, `telegram:${userId}`, "group.linked", null, { tier: tier.id, group: groupId, codeCreatedBy: row.created_by });
  return { ok: true, tierId: tier.id, tierName: tier.name };
}
