import { randomInt } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import { sourceIds, type Ctx } from "./ctx.js";
import { checkEligibility } from "./engine/decide.js";
import { enforceMember, handleJoin, handleLeave, onJoinRequest, onUnauthorizedJoin } from "./services/enforcement.js";
import { consumeLinkCode } from "./services/groupLink.js";
import { render } from "./services/messages.js";
import { statusText } from "./services/status.js";
import { createCode, ensureMember } from "./services/verification.js";

const CAPTCHA_TTL_MS = 5 * 60_000;

export function buildBot(ctx: Ctx, token: string): Bot {
  const bot = new Bot(token);
  const cfg = async () => (await ctx.config.current()).config;
  const isBanned = async (id: number) =>
    !!(await ctx.pool.query(
      "SELECT 1 FROM members WHERE telegram_id=$1 AND status='banned' UNION SELECT 1 FROM overrides WHERE telegram_id=$1 AND type='ban' AND revoked_at IS NULL",
      [id],
    )).rowCount;

  async function sendLink(telegramId: number, reply: (t: string) => Promise<unknown>) {
    const config = await cfg();
    const { url, minutes } = await createCode(ctx, telegramId);
    await reply(render(config, "verify.link", { url, minutes }));
  }

  // ---- Private chat -----------------------------------------------------------------------------

  bot.command("start", async (c) => {
    if (c.chat.type !== "private" || !c.from) return;
    const config = await cfg();
    await ensureMember(ctx, c.from.id, c.from.username);
    if (await isBanned(c.from.id)) return void c.reply(render(config, "status.banned"));
    await c.reply(render(config, "start.welcome", { community: config.branding.communityName }));

    const m = (await ctx.pool.query("SELECT captcha_passed FROM members WHERE telegram_id=$1", [c.from.id])).rows[0];
    if (config.verification.captcha && !m.captcha_passed) {
      const a = randomInt(1, 10), b = randomInt(1, 10), answer = a + b;
      const options = new Set<number>([answer]);
      while (options.size < 4) options.add(randomInt(2, 20));
      const shuffled = [...options].sort(() => randomInt(0, 2) - 0.5);
      await ctx.pool.query("UPDATE members SET captcha_answer=$2, captcha_expires_at=$3 WHERE telegram_id=$1", [
        c.from.id, String(answer), new Date(ctx.now().getTime() + CAPTCHA_TTL_MS),
      ]);
      const kb = new InlineKeyboard();
      for (const o of shuffled) kb.text(String(o), `cap:${o}`);
      return void c.reply(render(config, "captcha.prompt", { a, b }), { reply_markup: kb });
    }
    await sendLink(c.from.id, (t) => c.reply(t));
    // Allowlisted members need no wallet: grant access now.
    await enforceMember(ctx, c.from.id, "verify").catch((e) => ctx.log.error("start enforce failed", { error: String(e) }));
  });

  bot.callbackQuery(/^cap:(\d+)$/, async (c) => {
    const config = await cfg();
    const chosen = c.match[1]!;
    const m = (await ctx.pool.query("SELECT captcha_answer, captcha_expires_at FROM members WHERE telegram_id=$1", [c.from.id])).rows[0];
    const valid = m?.captcha_answer && m.captcha_expires_at && m.captcha_expires_at.getTime() > ctx.now().getTime();
    await c.answerCallbackQuery();
    await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (!valid || m.captcha_answer !== chosen) {
      await ctx.pool.query("UPDATE members SET captcha_answer=NULL WHERE telegram_id=$1", [c.from.id]);
      return void c.reply(render(config, "captcha.failed"));
    }
    await ctx.pool.query("UPDATE members SET captcha_passed=true, captcha_answer=NULL WHERE telegram_id=$1", [c.from.id]);
    await c.reply(render(config, "captcha.passed"));
    await sendLink(c.from.id, (t) => c.reply(t));
    await enforceMember(ctx, c.from.id, "verify").catch((e) => ctx.log.error("captcha enforce failed", { error: String(e) }));
  });

  bot.command("wallet", async (c) => {
    if (c.chat.type !== "private" || !c.from) return;
    await ensureMember(ctx, c.from.id, c.from.username);
    if (await isBanned(c.from.id)) return void c.reply(render(await cfg(), "status.banned"));
    await sendLink(c.from.id, (t) => c.reply(t));
  });

  bot.command("status", async (c) => {
    if (c.chat.type !== "private" || !c.from) return;
    const config = await cfg();
    if (await isBanned(c.from.id)) return void c.reply(render(config, "status.banned"));
    const m = (await ctx.pool.query("SELECT wallet FROM members WHERE telegram_id=$1", [c.from.id])).rows[0];
    if (!m?.wallet) return void c.reply(render(config, "status.unverified"));
    const result = await checkEligibility(m.wallet, sourceIds(ctx), ctx.reader, config);
    await c.reply(statusText(config, result));
  });

  bot.command("reverify", async (c) => {
    if (c.chat.type !== "private" || !c.from) return;
    const config = await cfg();
    const o = await enforceMember(ctx, c.from.id, "reverify");
    if (o.outcome === "banned") return void c.reply(render(config, "status.banned"));
    if (o.outcome === "no_member" || !o.result) return void c.reply(render(config, "status.unverified"));
    await c.reply(statusText(config, o.result));
  });

  bot.command("help", async (c) => {
    if (c.chat.type === "private") await c.reply(render(await cfg(), "help"));
  });

  // ---- Groups -----------------------------------------------------------------------------------

  bot.command("link", async (c) => {
    if (c.chat.type === "private" || !c.from) return;
    const config = await cfg();
    const res = await consumeLinkCode(ctx, c.match.trim(), String(c.chat.id), c.from.id);
    if (res.ok) return void c.reply(render(config, "link.ok", { tier: res.tierName }));
    await c.reply(render(config, res.error === "not_admin" ? "link.not_admin" : "link.bad_code"));
  });

  const linkedGroup = async (chatId: number) => (await cfg()).tiers.some((t) => t.telegramGroupId === String(chatId));

  bot.on("chat_member", async (c) => {
    const u = c.chatMember;
    if (u.new_chat_member.user.is_bot || !(await linkedGroup(c.chat.id))) return;
    const group = String(c.chat.id), userId = u.new_chat_member.user.id;
    const was = u.old_chat_member.status, now = u.new_chat_member.status;
    const wasIn = ["member", "administrator", "creator", "restricted"].includes(was);
    const isIn = ["member", "administrator", "creator", "restricted"].includes(now);
    if (!wasIn && isIn) {
      // Added by an admin (not via link/self): that's the admin's call, leave it alone.
      if (u.from.id !== userId && !u.invite_link) return;
      if (now === "administrator" || now === "creator") return;
      const verdict = await handleJoin(ctx, group, userId, u.invite_link?.invite_link);
      if (verdict === "rejected") {
        const user = u.new_chat_member.user;
        await onUnauthorizedJoin(ctx, group, userId, { username: user.username, name: user.first_name });
      }
    } else if (wasIn && !isIn) {
      await handleLeave(ctx, group, userId);
    }
  });

  bot.on("chat_join_request", async (c) => {
    // Handles both our own join-request invite links and groups that simply require approval.
    await onJoinRequest(ctx, String(c.chat.id), c.from.id, c.from.username);
  });

  bot.catch((err) => ctx.log.error("bot error", { error: String(err.error) }));
  return bot;
}

export const BOT_ALLOWED_UPDATES = ["message", "callback_query", "chat_member", "chat_join_request"] as const;
