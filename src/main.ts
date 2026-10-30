import { Bot } from "grammy";
import { BOT_ALLOWED_UPDATES, buildBot } from "./bot.js";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import type { Ctx, Logger } from "./ctx.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { ContractReader } from "./sources/contractRead.js";
import { createAdmin } from "./services/adminAuth.js";
import { ConfigStore } from "./services/configStore.js";
import { runRecheck } from "./services/enforcement.js";
import { GrammyGateway, NullGateway } from "./services/telegram.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

const log: Logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: "info", msg, ...data })),
  warn: (msg, data) => console.warn(JSON.stringify({ level: "warn", msg, ...data })),
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, ...data })),
};

const applied = await migrate(pool);
await pool.query("INSERT INTO deployments (code_version) VALUES ($1)", [env.CODE_VERSION]);

const config = new ConfigStore(pool, env.SOURCES_JSON.map((s) => s.id));
await config.ensureSeed();

if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const has = (await pool.query("SELECT 1 FROM admin_accounts LIMIT 1")).rowCount;
  if (!has) {
    await createAdmin(pool, env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    log.info("created first admin", { email: env.ADMIN_EMAIL });
  }
}

let bot: Bot | null = null;
const tg = env.TELEGRAM_BOT_TOKEN ? new GrammyGateway(new Bot(env.TELEGRAM_BOT_TOKEN).api) : new NullGateway();

const ctx: Ctx = { env, pool, config, reader: new ContractReader(env.RPC_URL, env.SOURCES_JSON, { timeoutMs: env.RPC_TIMEOUT_MS }), tg, now: () => new Date(), log };

if (env.TELEGRAM_BOT_TOKEN) bot = buildBot(ctx, env.TELEGRAM_BOT_TOKEN);

const app = buildApp(ctx, { logger: true });
await app.listen({ port: env.PORT, host: "0.0.0.0" });
log.info("boot", { applied, version: env.CODE_VERSION, telegram: !!bot, publicUrl: env.PUBLIC_URL });

if (bot) {
  // Long polling: no public webhook needed. Fire and forget; errors are logged by the bot.
  bot.start({ allowed_updates: [...BOT_ALLOWED_UPDATES], onStart: (me) => log.info("bot started", { username: me.username }) })
    .catch((e) => log.error("bot stopped", { error: String(e) }));
} else {
  log.warn("TELEGRAM_BOT_TOKEN not set: bot disabled, enforcement actions will fail until it is configured");
}

// Scheduler: every tick, re-check members whose last check is older than the configured cadence.
const tick = async () => {
  if (!tg.configured) return;
  try {
    const stats = await runRecheck(ctx);
    if (stats.ran && stats.checked) log.info("recheck", { ...stats });
  } catch (e) {
    log.error("recheck run failed", { error: String(e) });
  }
};
const timer = setInterval(tick, env.RECHECK_TICK_MINUTES * 60_000);

const shutdown = async () => {
  clearInterval(timer);
  await bot?.stop().catch(() => {});
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
