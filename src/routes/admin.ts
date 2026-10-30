import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { sourceIds, type Ctx } from "../ctx.js";
import { checkEligibility } from "../engine/decide.js";
import { AttemptLimiter, checkPassword, createAdmin, readSession, signSession } from "../services/adminAuth.js";
import { audit } from "../services/audit.js";
import { ConfigError } from "../services/configStore.js";
import { enforceMember, runRecheck } from "../services/enforcement.js";
import { createLinkCode } from "../services/groupLink.js";
import { DEFAULT_MESSAGES } from "../services/messages.js";
import { releaseGrace, revokeOverride, setOverride } from "../services/overrides.js";

const COOKIE = "tg_admin";

function cookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function adminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const secure = ctx.env.PUBLIC_URL.startsWith("https://");
  const limiter = new AttemptLimiter(10, 15 * 60_000);
  const adminOf = (req: FastifyRequest): string => (req as FastifyRequest & { admin: string }).admin;

  app.register(async (api) => {
    // ---- Auth ---------------------------------------------------------------------------------
    api.post("/login", async (req, reply) => {
      const parsed = z.object({ email: z.string(), password: z.string() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const key = `${req.ip}:${parsed.data.email.toLowerCase()}`;
      if (limiter.tooMany(key)) return reply.code(429).send({ error: "too_many_attempts" });
      const row = (await ctx.pool.query("SELECT email, password_hash FROM admin_accounts WHERE email=$1", [parsed.data.email.toLowerCase()])).rows[0];
      // Always run a hash comparison so response time doesn't reveal whether the account exists.
      const ok = await checkPassword(parsed.data.password, row?.password_hash ?? "scrypt$00$00");
      if (!row || !ok) {
        limiter.record(key);
        await audit(ctx, "system", "admin.login_failed", null, { email: parsed.data.email.toLowerCase(), ip: req.ip });
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const token = signSession(ctx.env.SESSION_SECRET, row.email);
      reply.header("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`);
      await audit(ctx, `admin:${row.email}`, "admin.login", null, {});
      return { email: row.email };
    });

    api.post("/logout", async (_req, reply) => {
      reply.header("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`);
      return { ok: true };
    });

    // Everything below requires a session; mutations also need the custom header (CSRF defence in depth).
    api.register(async (priv) => {
      priv.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
        const email = readSession(ctx.env.SESSION_SECRET, cookie(req, COOKIE));
        if (!email) return reply.code(401).send({ error: "unauthenticated" });
        if (req.method !== "GET" && req.headers["x-requested-with"] !== "dashboard") {
          return reply.code(403).send({ error: "missing_csrf_header" });
        }
        (req as FastifyRequest & { admin: string }).admin = email;
      });
      const actor = (req: FastifyRequest) => `admin:${adminOf(req)}`;

      priv.get("/me", async (req) => ({ email: adminOf(req) }));

      // ---- Config -----------------------------------------------------------------------------
      priv.get("/config", async () => {
        const { version, config } = await ctx.config.current();
        return {
          version, config,
          sources: ctx.env.SOURCES_JSON.map((s) => ({ id: s.id, label: s.label })),
          defaultMessages: DEFAULT_MESSAGES,
          deploy: { version: ctx.env.CODE_VERSION, chain: ctx.env.CHAIN_NAME, chainId: ctx.env.CHAIN_ID, publicUrl: ctx.env.PUBLIC_URL },
        };
      });

      priv.put("/config", async (req, reply) => {
        try {
          const saved = await ctx.config.save(req.body, actor(req));
          await audit(ctx, actor(req), "config.updated", null, { version: saved.version });
          return { version: saved.version };
        } catch (e) {
          if (e instanceof ConfigError) return reply.code(400).send({ error: "invalid_config", problems: e.problems });
          throw e;
        }
      });

      priv.get("/config/history", async () => ({
        versions: (await ctx.pool.query("SELECT version, changed_by, created_at FROM runtime_config ORDER BY version DESC LIMIT 50")).rows,
      }));

      // ---- Setup ------------------------------------------------------------------------------
      priv.get("/setup", async () => {
        const { version, config } = await ctx.config.current();
        const groups = await Promise.all(
          config.tiers.map(async (t) => ({
            tierId: t.id, tierName: t.name, groupId: t.telegramGroupId,
            bot: t.telegramGroupId ? await ctx.tg.botStatus(t.telegramGroupId) : null,
          })),
        );
        const tested = (await ctx.pool.query("SELECT 1 FROM audit_events WHERE action='setup.test_wallet' LIMIT 1")).rowCount! > 0;
        return {
          steps: [
            { id: "bot", label: "Telegram bot connected", done: ctx.tg.configured, hint: "Set TELEGRAM_BOT_TOKEN in the deployment environment and restart." },
            { id: "tiers", label: "Tiers and branding defined", done: version > 1, hint: "Edit tiers, thresholds and branding under Configuration." },
            { id: "groups", label: "Groups linked and bot is admin", done: groups.every((g) => g.bot?.ok), hint: "Use “Link group” per tier, then post the command in that group." },
            { id: "test", label: "Tested with a wallet", done: tested, hint: "Run a wallet check under Setup → Test a wallet." },
          ],
          groups,
        };
      });

      priv.post("/tiers/:id/link-code", async (req, reply) => {
        const { id } = req.params as { id: string };
        const { config } = await ctx.config.current();
        if (!config.tiers.some((t) => t.id === id)) return reply.code(404).send({ error: "unknown_tier" });
        return createLinkCode(ctx, id, actor(req));
      });

      priv.post("/test-wallet", async (req, reply) => {
        const address = (req.body as { address?: string })?.address ?? "";
        if (!isAddress(address)) return reply.code(400).send({ error: "bad_address" });
        const { config } = await ctx.config.current();
        const result = await checkEligibility(getAddress(address).toLowerCase(), sourceIds(ctx), ctx.reader, config);
        await audit(ctx, actor(req), "setup.test_wallet", null, { wallet: address, status: result.status, tier: result.tier?.id ?? null });
        return result;
      });

      // ---- Members ----------------------------------------------------------------------------
      priv.get("/members", async (req) => {
        const q = z.object({
          q: z.string().optional(), status: z.string().optional(), tier: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
        }).parse(req.query);
        const where: string[] = []; const p: unknown[] = [];
        if (q.q) { p.push(`%${q.q}%`); where.push(`(m.telegram_username ILIKE $${p.length} OR m.wallet ILIKE $${p.length} OR m.telegram_id::text LIKE $${p.length})`); }
        if (q.status) { p.push(q.status); where.push(`m.status = $${p.length}`); }
        if (q.tier) { p.push(q.tier); where.push(`m.current_tier = $${p.length}`); }
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const total = (await ctx.pool.query(`SELECT count(*) AS n FROM members m ${w}`, p)).rows[0].n;
        p.push(q.limit, q.offset);
        const rows = (await ctx.pool.query(
          `SELECT m.telegram_id, m.telegram_username, m.wallet, m.status, m.current_tier, m.grace_started_at, m.last_check_at,
                  m.last_check_result, m.created_at,
                  COALESCE((SELECT array_agg(o.type) FROM overrides o WHERE o.telegram_id=m.telegram_id AND o.revoked_at IS NULL), '{}') AS overrides
           FROM members m ${w} ORDER BY m.created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
        return { total, members: rows };
      });

      priv.get("/members/:id", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const m = (await ctx.pool.query("SELECT * FROM members WHERE telegram_id=$1", [id])).rows[0];
        if (!m) return reply.code(404).send({ error: "not_found" });
        const [memberships, overrides, events] = await Promise.all([
          ctx.pool.query("SELECT * FROM group_memberships WHERE telegram_id=$1 ORDER BY id DESC", [id]),
          ctx.pool.query("SELECT * FROM overrides WHERE telegram_id=$1 ORDER BY id DESC", [id]),
          ctx.pool.query("SELECT * FROM audit_events WHERE subject=$1 ORDER BY id DESC LIMIT 50", [id]),
        ]);
        return { member: m, memberships: memberships.rows, overrides: overrides.rows, events: events.rows };
      });

      const memberId = (req: FastifyRequest) => Number((req.params as { id: string }).id);

      priv.post("/members/:id/recheck", async (req) => {
        await audit(ctx, actor(req), "admin.force_recheck", memberId(req), {});
        const o = await enforceMember(ctx, memberId(req), "admin");
        return { outcome: o.outcome, status: o.status, result: o.result, actions: o.actions };
      });

      priv.post("/members/:id/release-grace", async (req) => ({ released: await releaseGrace(ctx, memberId(req), actor(req)) }));

      priv.post("/members/:id/allowlist", async (req) => {
        const b = z.object({ tierId: z.string().nullable().default(null), reason: z.string().max(500).optional() }).parse(req.body ?? {});
        const o = await setOverride(ctx, { telegramId: memberId(req), type: "allowlist", tierId: b.tierId, setBy: actor(req), reason: b.reason });
        return { outcome: o.outcome, actions: o.actions };
      });

      priv.post("/members/:id/ban", async (req) => {
        const b = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
        const o = await setOverride(ctx, { telegramId: memberId(req), type: "ban", setBy: actor(req), reason: b.reason });
        return { outcome: o.outcome, actions: o.actions };
      });

      priv.post("/members/:id/revoke-override", async (req) => {
        const b = z.object({ type: z.enum(["allowlist", "ban"]), reason: z.string().max(500).optional() }).parse(req.body);
        const o = await revokeOverride(ctx, memberId(req), b.type, actor(req), b.reason);
        return { revoked: !!o };
      });

      priv.post("/recheck-all", async (req) => {
        await audit(ctx, actor(req), "admin.recheck_all", null, {});
        return runRecheck(ctx, { force: true });
      });

      // ---- Counts + audit ---------------------------------------------------------------------
      priv.get("/counts", async () => {
        const { config } = await ctx.config.current();
        const inGroup = (await ctx.pool.query(
          "SELECT tier_id, count(*) AS n FROM group_memberships WHERE removed_at IS NULL AND joined_at IS NOT NULL GROUP BY tier_id")).rows;
        const byStatus = (await ctx.pool.query("SELECT status, count(*) AS n FROM members GROUP BY status")).rows;
        return {
          tiers: config.tiers.map((t) => ({ id: t.id, name: t.name, members: inGroup.find((r) => r.tier_id === t.id)?.n ?? 0 })),
          byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
        };
      });

      priv.get("/audit", async (req) => {
        const q = z.object({
          action: z.string().optional(), actor: z.string().optional(), subject: z.coerce.number().optional(),
          from: z.string().optional(), to: z.string().optional(), before: z.coerce.number().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }).parse(req.query);
        const where: string[] = []; const p: unknown[] = [];
        const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace("?", `$${p.length}`)); };
        if (q.action) add("action ILIKE ?", `${q.action}%`);
        if (q.actor) add("actor ILIKE ?", `%${q.actor}%`);
        if (q.subject !== undefined) add("subject = ?", q.subject);
        if (q.from) add("at >= ?", q.from);
        if (q.to) add("at <= ?", q.to);
        if (q.before) add("id < ?", q.before);
        p.push(q.limit);
        const rows = (await ctx.pool.query(
          `SELECT * FROM audit_events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT $${p.length}`, p)).rows;
        return { events: rows };
      });

      // ---- Admin accounts ---------------------------------------------------------------------
      priv.get("/admins", async () => ({ admins: (await ctx.pool.query("SELECT id, email, created_at FROM admin_accounts ORDER BY id")).rows }));

      priv.post("/admins", async (req, reply) => {
        const b = z.object({ email: z.string().email(), password: z.string().min(10) }).safeParse(req.body);
        if (!b.success) return reply.code(400).send({ error: "invalid", problems: b.error.issues.map((i) => i.message) });
        await createAdmin(ctx.pool, b.data.email, b.data.password);
        await audit(ctx, actor(req), "admin.account_saved", null, { email: b.data.email.toLowerCase() });
        return { ok: true };
      });

      priv.delete("/admins/:id", async (req, reply) => {
        const id = Number((req.params as { id: string }).id);
        const target = (await ctx.pool.query("SELECT email FROM admin_accounts WHERE id=$1", [id])).rows[0];
        if (!target) return reply.code(404).send({ error: "not_found" });
        if (target.email === adminOf(req)) return reply.code(400).send({ error: "cannot_delete_self" });
        await ctx.pool.query("DELETE FROM admin_accounts WHERE id=$1", [id]);
        await audit(ctx, actor(req), "admin.account_deleted", null, { email: target.email });
        return { ok: true };
      });
    });
  }, { prefix: "/api/admin" });
}
