import type { Ctx } from "../ctx.js";

/** Every join, warning, removal, override and wallet change goes through here. */
export async function audit(
  ctx: Pick<Ctx, "pool" | "now">,
  actor: string,
  action: string,
  subject: number | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await ctx.pool.query("INSERT INTO audit_events (at, actor, action, subject, details) VALUES ($1,$2,$3,$4,$5)", [
    ctx.now(),
    actor,
    action,
    subject,
    JSON.stringify(details),
  ]);
}
