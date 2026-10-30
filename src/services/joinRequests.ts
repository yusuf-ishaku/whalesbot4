import type { RuntimeConfig, TierConfig } from "../config/runtime.js";
import type { Ctx } from "../ctx.js";
import type { EligibilityResult } from "../engine/types.js";
import { audit } from "./audit.js";
import { render } from "./messages.js";

export interface JoinRequestRow {
  id: number;
  group_id: string;
  telegram_id: number;
  requested_at: Date;
  kind: "request" | "quarantine";
  notice_message_id: number | null;
}

export async function pendingRequest(ctx: Ctx, groupId: string, userId: number): Promise<JoinRequestRow | undefined> {
  return (
    await ctx.pool.query<JoinRequestRow>("SELECT * FROM join_requests WHERE group_id=$1 AND telegram_id=$2 AND resolved_at IS NULL", [groupId, userId])
  ).rows[0];
}

export async function pendingForMember(ctx: Ctx, userId: number): Promise<JoinRequestRow[]> {
  return (await ctx.pool.query<JoinRequestRow>("SELECT * FROM join_requests WHERE telegram_id=$1 AND resolved_at IS NULL", [userId])).rows;
}

async function resolve(ctx: Ctx, id: number, resolution: string) {
  await ctx.pool.query("UPDATE join_requests SET resolved_at=$2, resolution=$3 WHERE id=$1", [id, ctx.now(), resolution]);
}

async function clearNotice(ctx: Ctx, req: JoinRequestRow) {
  if (req.notice_message_id) await ctx.tg.deleteMessage(req.group_id, req.notice_message_id).catch(() => {});
}

async function dm(ctx: Ctx, userId: number, text: string) {
  await ctx.tg.sendMessage(userId, text).catch((e) => ctx.log.warn("dm failed", { userId, error: String(e) }));
}

/** Let the requester in. If Telegram refuses (request withdrawn/expired), mark it failed and carry on. */
export async function approvePending(ctx: Ctx, config: RuntimeConfig, req: JoinRequestRow, tier: TierConfig): Promise<boolean> {
  try {
    if (req.kind === "quarantine") await ctx.tg.restrictMember(req.group_id, req.telegram_id, false);
    else await ctx.tg.approveJoinRequest(req.group_id, req.telegram_id);
  } catch (e) {
    await resolve(ctx, req.id, "failed");
    await audit(ctx, "system", "join.approve_failed", req.telegram_id, { group: req.group_id, error: String(e) });
    return false;
  }
  await ctx.pool.query(
    "INSERT INTO group_memberships (telegram_id, group_id, tier_id, invited_at, joined_at) VALUES ($1,$2,$3,$4,$4)",
    [req.telegram_id, req.group_id, tier.id, ctx.now()],
  );
  await resolve(ctx, req.id, "approved");
  await clearNotice(ctx, req);
  await audit(ctx, "system", "group.joined", req.telegram_id, { group: req.group_id, tier: tier.id, via: req.kind === "quarantine" ? "verified_after_join" : "join_request" });
  await dm(ctx, req.telegram_id, render(config, "join.approved", { tier: tier.name }));
  return true;
}

export type DeclineReason = "short" | "other" | "banned" | "expired";

export async function declinePending(
  ctx: Ctx,
  config: RuntimeConfig,
  req: JoinRequestRow,
  reason: DeclineReason,
  vars: Record<string, string | number> = {},
): Promise<void> {
  const tier = config.tiers.find((t) => t.telegramGroupId === req.group_id);
  const action = req.kind === "quarantine"
    ? ctx.tg.removeMember(req.group_id, req.telegram_id, { permanent: reason === "banned" })
    : ctx.tg.declineJoinRequest(req.group_id, req.telegram_id);
  await action.catch((e) => ctx.log.warn("decline failed", { error: String(e) }));
  await clearNotice(ctx, req);
  await resolve(ctx, req.id, reason === "expired" ? "expired" : `declined_${reason}`);
  await audit(ctx, "system", "join.declined", req.telegram_id, { group: req.group_id, reason });
  const key = { short: "join.declined_short", other: "join.declined_other", banned: "join.declined_banned", expired: "join.expired" }[reason];
  await dm(ctx, req.telegram_id, render(config, key, { tier: tier?.name ?? "", threshold: tier?.threshold ?? "", ...vars }));
}

/**
 * After a SUCCESSFUL read, decline pending requests for groups the member doesn't qualify for.
 * Never called on a failed read: an RPC outage must not turn into a decline.
 */
export async function declineUnqualified(
  ctx: Ctx,
  config: RuntimeConfig,
  userId: number,
  desiredIds: Set<string>,
  result: EligibilityResult | null,
): Promise<void> {
  for (const req of await pendingForMember(ctx, userId)) {
    const tier = config.tiers.find((t) => t.telegramGroupId === req.group_id);
    if (tier && desiredIds.has(tier.id)) continue;
    await declinePending(ctx, config, req, result?.tier ? "other" : "short", {
      total: result?.total ?? "0",
      other: result?.tier?.name ?? "",
    });
  }
}

/** Decline requests that waited too long for verification. */
export async function expireJoinRequests(ctx: Ctx): Promise<number> {
  const { config } = await ctx.config.current();
  const cutoff = new Date(ctx.now().getTime() - config.verification.joinRequestPendingHours * 3_600_000);
  const { rows } = await ctx.pool.query<JoinRequestRow>("SELECT * FROM join_requests WHERE resolved_at IS NULL AND requested_at < $1", [cutoff]);
  for (const r of rows) await declinePending(ctx, config, r, "expired");
  return rows.length;
}
