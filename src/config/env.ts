import { z } from "zod";
import { sourcesSchema } from "./sources.js";

/** Deploy-time configuration. Secrets live here and nowhere else. */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // Telegram — optional so an empty deployment can boot before the bot is connected.
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Chain
  CHAIN_ID: z.coerce.number().int(),
  CHAIN_NAME: z.string().default("evm"),
  RPC_URL: z.string().url(),
  EXPLORER_URL: z.string().url().optional(),

  /** JSON array of source definitions (see config/sources.ts). */
  SOURCES_JSON: z.string().transform((s, ctx) => {
    try {
      return sourcesSchema.parse(JSON.parse(s));
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `SOURCES_JSON invalid: ${(e as Error).message}` });
      return z.NEVER;
    }
  }),

  // Re-check throttling (RPC rate limits) and scheduler cadence.
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RECHECK_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  RECHECK_DELAY_MS: z.coerce.number().int().min(0).default(250),
  RECHECK_TICK_MINUTES: z.coerce.number().positive().default(10),

  // Optional first dashboard admin, created on boot if no admin exists yet.
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),

  SESSION_SECRET: z.string().min(32),
  CODE_VERSION: z.string().default("dev"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
