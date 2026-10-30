import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Ctx } from "./ctx.js";
import { adminRoutes } from "./routes/admin.js";
import { verifyRoutes } from "./routes/verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = [path.resolve(here, "../web"), path.resolve(here, "../../web")].find((d) => existsSync(path.join(d, "admin.html")));

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer"); // verification codes live in the URL path
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  app.get("/health", async () => ({
    ok: true,
    version: ctx.env.CODE_VERSION,
    chain: ctx.env.CHAIN_NAME,
    sources: ctx.env.SOURCES_JSON.map((s) => s.id),
    telegram: ctx.tg.configured,
  }));

  async function sendStatic(reply: import("fastify").FastifyReply, file: string) {
    if (!webDir) return reply.code(500).send("web assets not found");
    const body = await readFile(path.join(webDir, file));
    return reply.header("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream").header("Cache-Control", "no-cache").send(body);
  }

  app.get("/", async (_req, reply) => reply.redirect("/admin"));
  app.get("/admin", (_req, reply) => sendStatic(reply, "admin.html"));
  app.get("/verify/:code", (_req, reply) => sendStatic(reply, "verify.html"));
  app.get<{ Params: { file: string } }>("/assets/:file", (req, reply) =>
    /^[\w.-]+\.(js|css)$/.test(req.params.file) ? sendStatic(reply, req.params.file) : reply.code(404).send("not found"),
  );

  verifyRoutes(app, ctx);
  adminRoutes(app, ctx);
  return app;
}
