import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { enforceMember } from "../services/enforcement.js";
import { render } from "../services/messages.js";
import { AttemptLimiter } from "../services/adminAuth.js";
import { statusText } from "../services/status.js";
import { loadCode, signingMessage, verifyAndBind } from "../services/verification.js";

const WEB_KEYS = ["web.title", "web.intro", "web.connect", "web.sign", "web.no_wallet", "web.expired", "web.success", "web.wallet_in_use", "web.bad_signature"];

export function verifyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const limiter = new AttemptLimiter(30, 15 * 60_000);

  app.get<{ Params: { code: string } }>("/api/verify/:code", async (req) => {
    const { config } = await ctx.config.current();
    const { state, row } = await loadCode(ctx, req.params.code);
    return {
      state,
      community: config.branding.communityName,
      logoUrl: config.branding.logoUrl,
      colors: config.branding.colors,
      signatureRequired: config.verification.signatureRequired,
      message: state === "valid" && row ? signingMessage(ctx, config.branding.communityName, row) : null,
      texts: Object.fromEntries(WEB_KEYS.map((k) => [k, render(config, k)])),
    };
  });

  const body = z.object({ address: z.string().max(64), signature: z.string().max(1000).default("") });

  app.post<{ Params: { code: string } }>("/api/verify/:code", async (req, reply) => {
    if (limiter.tooMany(req.ip)) return reply.code(429).send({ ok: false, error: "rate_limited" });
    limiter.record(req.ip);
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "bad_request" });

    const { config } = await ctx.config.current();
    const bound = await verifyAndBind(ctx, req.params.code, parsed.data.address, parsed.data.signature);
    if (!bound.ok) {
      const key = bound.error === "wallet_in_use" ? "web.wallet_in_use" : bound.error === "bad_signature" ? "web.bad_signature" : bound.error === "invalid_code" ? "web.expired" : null;
      const message = bound.error === "banned" ? render(config, "verify.done_banned") : key ? render(config, key) : "Invalid request.";
      return reply.code(bound.error === "wallet_in_use" ? 409 : 400).send({ ok: false, error: bound.error, message });
    }

    // Engine + enforcement (invites go out via DM). A failing Telegram call must not fail the verification.
    const outcome = await enforceMember(ctx, bound.telegramId, "verify");
    const text = statusText(config, outcome.result, "verify");
    await ctx.tg.sendMessage(bound.telegramId, text).catch((e) => ctx.log.warn("verify dm failed", { error: String(e) }));

    return {
      ok: true,
      message: text,
      done: render(config, "web.success"),
      wallet: bound.wallet,
      status: outcome.result?.status ?? null,
      total: outcome.result?.total ?? null,
      tier: outcome.result?.tier ?? null,
      nextTier: outcome.result?.nextTier ?? null,
      sources: outcome.result?.sources ?? [],
    };
  });
}
