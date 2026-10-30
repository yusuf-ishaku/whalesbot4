import type { RuntimeConfig, TierConfig } from "../config/runtime.js";
import { sourceIds, type Ctx } from "../ctx.js";
import { checkEligibility } from "../engine/decide.js";
import type { EligibilityResult, TierRef } from "../engine/types.js";
import { audit } from "./audit.js";
import { approvePending, declinePending, declineUnqualified, expireJoinRequests, pendingForMember, pendingRequest } from "./joinRequests.js";
import { render } from "./messages.js";
import { createCode, ensureMember } from "./verification.js";

export type Trigger = "verify" | "reverify" | "scheduled" | "admin" | "config";

export interface MemberRow {
  telegram_id: number;
  wallet: string | null;
  status: "new" | "verified" | "grace" | "removed" | "banned";
  current_tier: string | null;
  grace_started_at: Date | null;
  warned_at: Date | null;
  reminded_at: Date | null;
  last_check_at: Date | null;
}

interface MembershipRow {
  id: number;
  group_id: string;
  tier_id: string | null;
  joined_at: Date | null;
  invite_link: string | null;
  invite_expires_at: Date | null;
}

export interface EnforceOutcome {
  outcome: "ok" | "skipped_read_failed" | "banned" | "no_member";
  status: MemberRow["status"] | null;
  result: EligibilityResult | null;
  desired: TierRef[];
  actions: string[];
}

const HOUR = 3_600_000;

/** Serialises work per member across processes with a session advisory lock. */
export async function enforceMember(ctx: Ctx, telegramId: number, trigger: Trigger): Promise<EnforceOutcome> {
  const lock = await ctx.pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [telegramId]);
    return await enforceLocked(ctx, telegramId, trigger);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [telegramId]).catch(() => {});
    lock.release();
  }
}

async function notify(ctx: Ctx, telegramId: number, text: string): Promise<void> {
  try {
    await ctx.tg.sendMessage(telegramId, text);
  } catch (e) {
    // Member may have blocked the bot; never let a DM failure abort enforcement.
    ctx.log.warn("dm failed", { telegramId, error: String(e) });
  }
}

async function enforceLocked(ctx: Ctx, telegramId: number, trigger: Trigger): Promise<EnforceOutcome> {
  const { config } = await ctx.config.current();
  const now = ctx.now();
  const empty = (outcome: EnforceOutcome["outcome"], status: MemberRow["status"] | null): EnforceOutcome => ({
    outcome, status, result: null, desired: [], actions: [],
  });

  const m = (await ctx.pool.query<MemberRow>("SELECT * FROM members WHERE telegram_id = $1", [telegramId])).rows[0];
  if (!m) return empty("no_member", null);

  const overrides = (
    await ctx.pool.query("SELECT type, tier_id FROM overrides WHERE telegram_id = $1 AND revoked_at IS NULL", [telegramId])
  ).rows as { type: "allowlist" | "ban"; tier_id: string | null }[];
  const banned = m.status === "banned" || overrides.some((o) => o.type === "ban");
  const allow = overrides.find((o) => o.type === "allowlist");

  const tierById = new Map(config.tiers.map((t) => [t.id, t]));
  const byPriorityDesc = [...config.tiers].sort((a, b) => b.priority - a.priority);
  const actions: string[] = [];
  const active = async () =>
    (
      await ctx.pool.query<MembershipRow>(
        "SELECT id, group_id, tier_id, joined_at, invite_link, invite_expires_at FROM group_memberships WHERE telegram_id = $1 AND removed_at IS NULL",
        [telegramId],
      )
    ).rows;

  // ---- Ban: remove everywhere, permanently. -------------------------------------------------
  if (banned) {
    for (const row of await active()) await removeRow(ctx, m, row, "banned", true, actions);
    for (const req of await pendingForMember(ctx, telegramId)) await declinePending(ctx, config, req, "banned");
    if (m.status !== "banned") {
      await ctx.pool.query("UPDATE members SET status='banned', current_tier=NULL, grace_started_at=NULL WHERE telegram_id=$1", [telegramId]);
      await audit(ctx, "system", "member.banned", telegramId, {});
    }
    return { outcome: "banned", status: "banned", result: null, desired: [], actions };
  }

  // ---- Read. A failed read must never remove anyone. ----------------------------------------
  const result = m.wallet ? await checkEligibility(m.wallet, sourceIds(ctx), ctx.reader, config) : null;
  const readFailed = result?.status === "read_failed";
  await ctx.pool.query("UPDATE members SET last_check_at = $2, last_check_result = $3 WHERE telegram_id = $1", [
    telegramId, now, result ? JSON.stringify(result) : null,
  ]);
  if (readFailed) {
    await audit(ctx, "system", "check.read_failed", telegramId, { trigger, sources: result!.sources });
    if (!allow) return { outcome: "skipped_read_failed", status: m.status, result, desired: [], actions };
  }
  const canRemove = !readFailed;

  // ---- Which tiers should this member be in? ------------------------------------------------
  const ids = new Set<string>(result?.status === "ok" ? result.tiers.map((t) => t.id) : []);
  if (allow) ids.add(allow.tier_id && tierById.has(allow.tier_id) ? allow.tier_id : byPriorityDesc[byPriorityDesc.length - 1]!.id);
  let desiredTiers = byPriorityDesc.filter((t) => ids.has(t.id));
  if (config.overlap === "highest_only") desiredTiers = desiredTiers.slice(0, 1);
  const desiredIds = new Set(desiredTiers.map((t) => t.id));
  const desired: TierRef[] = desiredTiers.map((t) => ({ id: t.id, name: t.name }));

  // Pending join requests for groups this member doesn't qualify for (successful reads only).
  if (canRemove && m.wallet) await declineUnqualified(ctx, config, telegramId, desiredIds, result);

  // Close invites that expired unused.
  let rows = await active();
  for (const r of rows) {
    if (!r.joined_at && r.invite_expires_at && r.invite_expires_at.getTime() < now.getTime()) {
      await closeRow(ctx, r.id, "invite_expired");
    }
  }
  rows = await active();

  let status = m.status;
  let graceStarted = m.grace_started_at;
  let warnedAt = m.warned_at;
  let remindedAt = m.reminded_at;
  const total = result?.total ?? "0";

  if (desiredTiers.length > 0) {
    // ---- Qualifies. ------------------------------------------------------------------------
    if (status === "grace") {
      graceStarted = warnedAt = remindedAt = null;
      await audit(ctx, "system", "grace.cancelled", telegramId, { total });
      await notify(ctx, telegramId, render(config, "grace.cancelled"));
      actions.push("grace_cancelled");
    }
    status = "verified";

    for (const t of desiredTiers) {
      if (rows.some((r) => r.tier_id === t.id)) continue;
      // Someone asked to join this group directly: let them in rather than sending a link.
      const pending = t.telegramGroupId ? await pendingRequest(ctx, t.telegramGroupId, telegramId) : undefined;
      if (pending) {
        if (await approvePending(ctx, config, pending, t)) actions.push(`approved:${t.id}`);
        continue;
      }
      // Scheduled runs only invite when this member never had access to the group (no daily re-spam).
      if (trigger === "scheduled") {
        const had = await ctx.pool.query("SELECT 1 FROM group_memberships WHERE telegram_id=$1 AND group_id=$2 LIMIT 1", [telegramId, t.telegramGroupId ?? ""]);
        if (had.rowCount) continue;
      }
      await issueInvite(ctx, config, m, t, actions);
    }

    if (canRemove) {
      rows = await active();
      const top = desiredTiers[0]!;
      const topJoined = rows.some((r) => r.tier_id === top.id && r.joined_at);
      for (const r of rows) {
        if (r.tier_id && desiredIds.has(r.tier_id)) continue;
        const rowTier = r.tier_id ? tierById.get(r.tier_id) : undefined;
        const downgrade = !rowTier || rowTier.priority > top.priority;
        const remove = config.overlap === "all_qualified" || downgrade || topJoined || !r.joined_at;
        if (remove) await removeRow(ctx, m, r, "tier_change", false, actions);
      }
    }
  } else if (canRemove) {
    // ---- Does not qualify: grace, then removal. -------------------------------------------
    if (rows.length === 0) {
      if (status === "grace") { status = "verified"; graceStarted = warnedAt = remindedAt = null; }
    } else {
      const grace = config.recheck.gracePeriodHours * HOUR;
      const heldTier = (m.current_tier && tierById.get(m.current_tier)) || tierById.get(rows[0]!.tier_id ?? "");
      const tierName = heldTier?.name ?? "the group";
      if (status !== "grace" && grace > 0) {
        status = "grace";
        graceStarted = now;
        remindedAt = null;
        await audit(ctx, "system", "grace.started", telegramId, { total, tier: heldTier?.id, until: new Date(now.getTime() + grace) });
        actions.push("grace_started");
        if (config.recheck.warnBeforeRemove) {
          warnedAt = now;
          await audit(ctx, "system", "warning.sent", telegramId, { kind: "grace_started" });
          await notify(ctx, telegramId, render(config, "warn.grace_started", { total, tier: tierName, hours: config.recheck.gracePeriodHours }));
        }
      } else if (status === "grace" && now.getTime() - (graceStarted ?? now).getTime() < grace) {
        const left = Math.ceil((grace - (now.getTime() - (graceStarted ?? now).getTime())) / HOUR);
        const lead = config.recheck.warningLeadHours;
        if (config.recheck.warnBeforeRemove && !remindedAt && left <= lead && grace > lead * HOUR) {
          remindedAt = now;
          await audit(ctx, "system", "warning.sent", telegramId, { kind: "grace_reminder", hoursLeft: left });
          await notify(ctx, telegramId, render(config, "warn.grace_reminder", { tier: tierName, hours: left }));
        }
      } else {
        // Grace over (or none configured): remove from every group. Only reached after a successful read.
        let allRemoved = true;
        for (const r of rows) allRemoved = (await removeRow(ctx, m, r, "below_threshold", false, actions)) && allRemoved;
        if (allRemoved) {
          status = "removed";
          graceStarted = warnedAt = remindedAt = null;
          await audit(ctx, "system", "member.removed", telegramId, { total, reason: "below_threshold" });
          await notify(ctx, telegramId, render(config, "removed", { tier: tierName, threshold: heldTier?.threshold ?? "" }));
        }
      }
    }
  }

  const currentTier = desiredTiers[0]?.id ?? (status === "grace" ? m.current_tier : null);
  await ctx.pool.query(
    `UPDATE members SET status=$2, current_tier=$3, grace_started_at=$4, warned_at=$5, reminded_at=$6 WHERE telegram_id=$1`,
    [telegramId, status, currentTier, graceStarted, warnedAt, remindedAt],
  );
  return { outcome: "ok", status, result, desired, actions };
}

async function issueInvite(ctx: Ctx, config: RuntimeConfig, m: MemberRow, tier: TierConfig, actions: string[]) {
  if (!tier.telegramGroupId) {
    await audit(ctx, "system", "invite.skipped_no_group", m.telegram_id, { tier: tier.id });
    return;
  }
  try {
    const link = await ctx.tg.createInviteLink(tier.telegramGroupId, {
      expiresMinutes: tier.invite.expiresMinutes,
      joinRequest: tier.invite.mode === "join_request",
      name: `tg${m.telegram_id}`,
    });
    const expires = new Date(ctx.now().getTime() + tier.invite.expiresMinutes * 60_000);
    await ctx.pool.query(
      `INSERT INTO group_memberships (telegram_id, group_id, tier_id, invited_at, invite_link, invite_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [m.telegram_id, tier.telegramGroupId, tier.id, ctx.now(), link, expires],
    );
    await audit(ctx, "system", "invite.sent", m.telegram_id, { tier: tier.id, mode: tier.invite.mode });
    actions.push(`invite:${tier.id}`);
    await notify(ctx, m.telegram_id, render(config, "invite.link", { tier: tier.name, url: link, minutes: tier.invite.expiresMinutes }));
  } catch (e) {
    await audit(ctx, "system", "invite.failed", m.telegram_id, { tier: tier.id, error: String(e) });
  }
}

async function closeRow(ctx: Ctx, id: number, reason: string) {
  await ctx.pool.query("UPDATE group_memberships SET removed_at = $2, reason = $3 WHERE id = $1", [id, ctx.now(), reason]);
}

/** Returns true when the row is closed. A Telegram failure leaves it open so the next run retries. */
async function removeRow(ctx: Ctx, m: MemberRow, row: MembershipRow, reason: string, permanent: boolean, actions: string[]) {
  try {
    if (!row.joined_at) {
      if (row.invite_link) await ctx.tg.revokeInviteLink(row.group_id, row.invite_link).catch(() => {});
      if (permanent) await ctx.tg.removeMember(row.group_id, m.telegram_id, { permanent });
    } else {
      await ctx.tg.removeMember(row.group_id, m.telegram_id, { permanent });
    }
  } catch (e) {
    await audit(ctx, "system", "removal.failed", m.telegram_id, { group: row.group_id, reason, error: String(e) });
    return false;
  }
  await closeRow(ctx, row.id, reason);
  await audit(ctx, "system", "group.removed", m.telegram_id, { group: row.group_id, tier: row.tier_id, reason });
  actions.push(`removed:${row.tier_id ?? row.group_id}`);
  return true;
}

// ---- Scheduled job ------------------------------------------------------------------------------

export interface RecheckStats {
  ran: boolean;
  checked: number;
  skippedReadFailed: number;
  errors: number;
}

const RECHECK_LOCK = 7_243_001;

/** Daily (cadence-driven) re-check. Batched and rate-limited; per-member failures never abort the run. */
export async function runRecheck(ctx: Ctx, opts: { force?: boolean; concurrency?: number; delayMs?: number } = {}): Promise<RecheckStats> {
  const lock = await ctx.pool.connect();
  try {
    const got = (await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [RECHECK_LOCK])).rows[0].ok;
    if (!got) return { ran: false, checked: 0, skippedReadFailed: 0, errors: 0 };
    await expireJoinRequests(ctx).catch((e) => ctx.log.error("expire join requests failed", { error: String(e) }));
    const { config } = await ctx.config.current();
    const cutoff = new Date(ctx.now().getTime() - config.recheck.cadenceHours * HOUR);
    const { rows } = await ctx.pool.query<{ telegram_id: number }>(
      `SELECT m.telegram_id FROM members m
       WHERE m.status IN ('verified','grace')
         AND (m.wallet IS NOT NULL OR EXISTS (SELECT 1 FROM overrides o WHERE o.telegram_id=m.telegram_id AND o.type='allowlist' AND o.revoked_at IS NULL))
         AND ($1::boolean OR m.last_check_at IS NULL OR m.last_check_at < $2)
       ORDER BY m.last_check_at NULLS FIRST`,
      [!!opts.force, cutoff],
    );
    const conc = opts.concurrency ?? ctx.env.RECHECK_CONCURRENCY;
    const delay = opts.delayMs ?? ctx.env.RECHECK_DELAY_MS;
    const stats: RecheckStats = { ran: true, checked: 0, skippedReadFailed: 0, errors: 0 };
    for (let i = 0; i < rows.length; i += conc) {
      const batch = rows.slice(i, i + conc);
      await Promise.all(
        batch.map(async ({ telegram_id }) => {
          try {
            const o = await enforceMember(ctx, telegram_id, opts.force ? "admin" : "scheduled");
            stats.checked++;
            if (o.outcome === "skipped_read_failed") stats.skippedReadFailed++;
          } catch (e) {
            stats.errors++;
            ctx.log.error("recheck failed for member", { telegram_id, error: String(e) });
          }
        }),
      );
      if (delay > 0 && i + conc < rows.length) await new Promise((r) => setTimeout(r, delay));
    }
    return stats;
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [RECHECK_LOCK]).catch(() => {});
    lock.release();
  }
}

// ---- Telegram events ------------------------------------------------------------------------------

/** A user joined (or asked to join) a linked group. Returns whether they're entitled to be there. */
export async function handleJoin(ctx: Ctx, groupId: string, userId: number, inviteLink?: string): Promise<"joined" | "rejected"> {
  const { rows } = await ctx.pool.query<{ id: number; telegram_id: number }>(
    `SELECT id, telegram_id FROM group_memberships WHERE group_id=$1 AND removed_at IS NULL AND telegram_id=$2`,
    [groupId, userId],
  );
  const mine = rows[0];
  if (mine) {
    await ctx.pool.query("UPDATE group_memberships SET joined_at = COALESCE(joined_at, $2) WHERE id=$1", [mine.id, ctx.now()]);
    await audit(ctx, `member:${userId}`, "group.joined", userId, { group: groupId });
    return "joined";
  }
  await audit(ctx, "system", "join.unauthorized", userId, { group: groupId, inviteLink: inviteLink ?? null });
  return "rejected";
}

/** Mark membership closed when someone leaves or is removed outside our control. */
export async function handleLeave(ctx: Ctx, groupId: string, userId: number): Promise<void> {
  const r = await ctx.pool.query(
    "UPDATE group_memberships SET removed_at=$3, reason='left' WHERE group_id=$1 AND telegram_id=$2 AND removed_at IS NULL AND joined_at IS NOT NULL",
    [groupId, userId, ctx.now()],
  );
  if (r.rowCount) await audit(ctx, `member:${userId}`, "group.left", userId, { group: groupId });
}

/**
 * Someone asked to join a linked group (via our invite link, or directly when the group needs approval).
 * Returns what happened: already-invited members are approved at once; verified+qualified members are approved
 * by enforcement; strangers get a verification link and stay pending until they verify (or time out).
 */
export async function onJoinRequest(ctx: Ctx, groupId: string, userId: number, username?: string | null): Promise<"approved" | "declined" | "pending" | "ignored"> {
  const { config } = await ctx.config.current();
  if (!config.tiers.some((t) => t.telegramGroupId === groupId)) return "ignored";
  await ensureMember(ctx, userId, username);
  await ctx.pool.query(
    "INSERT INTO join_requests (group_id, telegram_id, requested_at) VALUES ($1,$2,$3) ON CONFLICT (group_id, telegram_id) WHERE resolved_at IS NULL DO NOTHING",
    [groupId, userId, ctx.now()],
  );
  await audit(ctx, `member:${userId}`, "join.requested", userId, { group: groupId });

  const outcome = async () => {
    const r = (await ctx.pool.query("SELECT resolution FROM join_requests WHERE group_id=$1 AND telegram_id=$2 ORDER BY id DESC LIMIT 1", [groupId, userId])).rows[0];
    return r?.resolution === "approved" ? ("approved" as const) : r?.resolution ? ("declined" as const) : ("pending" as const);
  };

  // They came through an invite link we issued for them: approve straight away.
  const invited = await ctx.pool.query("SELECT id FROM group_memberships WHERE group_id=$1 AND telegram_id=$2 AND removed_at IS NULL", [groupId, userId]);
  if (invited.rowCount) {
    const req = (await pendingRequest(ctx, groupId, userId))!;
    await ctx.pool.query("UPDATE group_memberships SET joined_at = COALESCE(joined_at, $2) WHERE id=$1", [invited.rows[0].id, ctx.now()]);
    await ctx.tg.approveJoinRequest(groupId, userId).catch((e) => ctx.log.warn("approve failed", { error: String(e) }));
    await ctx.pool.query("UPDATE join_requests SET resolved_at=$2, resolution='approved' WHERE id=$1", [req.id, ctx.now()]);
    await audit(ctx, `member:${userId}`, "group.joined", userId, { group: groupId, via: "join_request" });
    return "approved";
  }

  // Let enforcement decide (approves, declines, or leaves pending on a failed read).
  await enforceMember(ctx, userId, "reverify");
  const state = await outcome();
  if (state !== "pending") return state;

  const m = (await ctx.pool.query("SELECT wallet, status FROM members WHERE telegram_id=$1", [userId])).rows[0];
  if (!m?.wallet) {
    const tier = config.tiers.find((t) => t.telegramGroupId === groupId)!;
    const { url, minutes } = await createCode(ctx, userId);
    await ctx.tg.sendMessage(userId, render(config, "join.request_verify", { tier: tier.name, url, minutes, community: config.branding.communityName }))
      .catch((e) => ctx.log.warn("join dm failed", { error: String(e) }));
  } else {
    await ctx.tg.sendMessage(userId, render(config, "status.read_failed")).catch(() => {});
  }
  return "pending";
}

/**
 * Someone is in a linked group without us having let them in (forwarded/leaked link, the group's own link, ...).
 * quarantine: mute them, post a notice with a Verify button (works even if they never started the bot), and
 * let the normal flow approve (unmute) or remove them. kick: remove at once.
 */
export async function onUnauthorizedJoin(ctx: Ctx, groupId: string, userId: number, who: { username?: string | null; name?: string }): Promise<"approved" | "removed" | "quarantined" | "ignored"> {
  const { config } = await ctx.config.current();
  const tier = config.tiers.find((t) => t.telegramGroupId === groupId);
  if (!tier) return "ignored";
  await ensureMember(ctx, userId, who.username);

  const kick = async (permanent: boolean, why: string) => {
    await ctx.tg.removeMember(groupId, userId, { permanent }).catch((e) => ctx.log.warn("kick failed", { error: String(e) }));
    await audit(ctx, "system", "join.removed", userId, { group: groupId, why });
    return "removed" as const;
  };

  const banned = (await ctx.pool.query(
    "SELECT 1 FROM members WHERE telegram_id=$1 AND status='banned' UNION SELECT 1 FROM overrides WHERE telegram_id=$1 AND type='ban' AND revoked_at IS NULL", [userId])).rowCount;
  if (banned) return kick(true, "banned");
  if (config.verification.unauthorizedJoin === "kick") return kick(false, "unauthorized");

  try {
    await ctx.tg.restrictMember(groupId, userId, true);
  } catch (e) {
    ctx.log.warn("could not mute, removing instead", { error: String(e) });
    return kick(false, "mute_failed");
  }
  await ctx.pool.query(
    "INSERT INTO join_requests (group_id, telegram_id, requested_at, kind) VALUES ($1,$2,$3,'quarantine') ON CONFLICT (group_id, telegram_id) WHERE resolved_at IS NULL DO NOTHING",
    [groupId, userId, ctx.now()],
  );
  await audit(ctx, "system", "join.quarantined", userId, { group: groupId });

  const username = await ctx.tg.botUsername().catch(() => "");
  const notice = await ctx.tg
    .postNotice(
      groupId,
      render(config, "quarantine.notice", { name: who.name || who.username || "there", hours: config.verification.joinRequestPendingHours, tier: tier.name }),
      username ? { text: render(config, "quarantine.button"), url: `https://t.me/${username}?start=verify` } : undefined,
    )
    .catch(() => null);
  if (notice) await ctx.pool.query("UPDATE join_requests SET notice_message_id=$3 WHERE group_id=$1 AND telegram_id=$2 AND resolved_at IS NULL", [groupId, userId, notice]);

  // They may already be verified and qualified (or allowlisted): let enforcement settle it now.
  await enforceMember(ctx, userId, "reverify");
  const r = (await ctx.pool.query("SELECT resolution FROM join_requests WHERE group_id=$1 AND telegram_id=$2 ORDER BY id DESC LIMIT 1", [groupId, userId])).rows[0];
  if (r?.resolution === "approved") return "approved";
  if (r?.resolution) return "removed";

  // Still waiting: if they have no wallet yet, try a DM with the link (works only if they've started the bot).
  const m = (await ctx.pool.query("SELECT wallet FROM members WHERE telegram_id=$1", [userId])).rows[0];
  if (!m?.wallet) {
    const { url, minutes } = await createCode(ctx, userId);
    await ctx.tg.sendMessage(userId, render(config, "join.request_verify", { tier: tier.name, url, minutes, community: config.branding.communityName })).catch(() => {});
  }
  return "quarantined";
}
