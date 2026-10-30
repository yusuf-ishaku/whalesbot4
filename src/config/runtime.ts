import { z } from "zod";

/** Runtime configuration: edited in the dashboard, stored versioned in the DB. */

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "non-negative decimal string");

export const tierSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  name: z.string(),
  /** Minimum combined amount (human units, decimal string). */
  threshold: decimalString,
  /** Higher priority wins when overlap = "highest". */
  priority: z.number().int(),
  /** Telegram chat id of the group; null until linked in setup. */
  telegramGroupId: z.string().nullable().default(null),
  invite: z
    .object({
      mode: z.enum(["single_use_link", "join_request"]).default("single_use_link"),
      expiresMinutes: z.number().int().positive().default(60),
    })
    .default({}),
});

export const combineSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("sum") }),
  z.object({
    rule: z.literal("weighted_sum"),
    /** sourceId -> weight in basis points (10000 = 1.0x). Missing source = 10000. */
    weightsBps: z.record(z.number().int().min(0)),
  }),
  /** Tier is met if ANY single source meets the threshold on its own. */
  z.object({ rule: z.literal("any") }),
  /** Tier is met only if EVERY source meets the threshold on its own. */
  z.object({ rule: z.literal("all") }),
]);

export const runtimeConfigSchema = z.object({
  branding: z.object({
    communityName: z.string(),
    logoUrl: z.string().url().startsWith("https://").nullable().default(null),
    colors: z
      .object({
        primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4f46e5"),
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0b0b10"),
      })
      .default({}),
    messages: z.record(z.string()).default({}),
  }),
  combine: combineSchema.default({ rule: "sum" }),
  tiers: z.array(tierSchema).min(1),
  overlap: z.enum(["highest_only", "all_qualified"]).default("highest_only"),
  recheck: z
    .object({
      cadenceHours: z.number().positive().default(24),
      gracePeriodHours: z.number().nonnegative().default(48),
      warnBeforeRemove: z.boolean().default(true),
      warningLeadHours: z.number().nonnegative().default(24),
    })
    .default({}),
  verification: z
    .object({
      captcha: z.boolean().default(true),
      signatureRequired: z.boolean().default(true),
      oneWalletPerAccount: z.boolean().default(true),
      /** How long a join request may wait for the requester to verify before it is declined. */
      joinRequestPendingHours: z.number().nonnegative().default(24),
      /** Someone enters a group without being let in by us: hold them muted until they verify, or remove at once. */
      unauthorizedJoin: z.enum(["quarantine", "kick"]).default("quarantine"),
    })
    .default({}),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type TierConfig = z.infer<typeof tierSchema>;
