import type pg from "pg";
import { runtimeConfigSchema, type RuntimeConfig } from "../config/runtime.js";

export function defaultRuntimeConfig(): RuntimeConfig {
  return runtimeConfigSchema.parse({
    branding: { communityName: "My Community" },
    tiers: [
      { id: "tier-2", name: "Tier 2 (higher)", threshold: "10000", priority: 2 },
      { id: "tier-1", name: "Tier 1 (lower)", threshold: "1000", priority: 1 },
    ],
  });
}

/** Cross-field checks the zod schema can't express. Returns human-readable problems. */
export function validateRuntimeConfig(c: RuntimeConfig, sourceIds: string[]): string[] {
  const problems: string[] = [];
  const dup = (xs: (string | number)[]) => xs.length !== new Set(xs).size;
  if (dup(c.tiers.map((t) => t.id))) problems.push("Tier ids must be unique.");
  if (dup(c.tiers.map((t) => t.priority))) problems.push("Tier priorities must be unique.");
  const groups = c.tiers.map((t) => t.telegramGroupId).filter((g): g is string => !!g);
  if (dup(groups)) problems.push("Two tiers cannot share one Telegram group.");
  if (c.combine.rule === "weighted_sum") {
    for (const id of Object.keys(c.combine.weightsBps)) {
      if (!sourceIds.includes(id)) problems.push(`Weight given for unknown source "${id}".`);
    }
  }
  return problems;
}

export class ConfigStore {
  private cache: { at: number; version: number; config: RuntimeConfig } | null = null;

  constructor(
    private pool: pg.Pool,
    private sourceIds: string[],
    private ttlMs = 5_000,
  ) {}

  /** Seed version 1 on a fresh deployment so it boots from env alone. */
  async ensureSeed(): Promise<void> {
    const { rowCount } = await this.pool.query("SELECT 1 FROM runtime_config LIMIT 1");
    if (!rowCount) {
      await this.pool.query("INSERT INTO runtime_config (version, config, changed_by) VALUES (1, $1, 'system')", [
        JSON.stringify(defaultRuntimeConfig()),
      ]);
    }
  }

  async current(): Promise<{ version: number; config: RuntimeConfig }> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache;
    await this.ensureSeed();
    const { rows } = await this.pool.query("SELECT version, config FROM runtime_config ORDER BY version DESC LIMIT 1");
    this.cache = { at: Date.now(), version: rows[0].version, config: runtimeConfigSchema.parse(rows[0].config) };
    return this.cache;
  }

  /** Validates and appends a new version. Throws with a joined message on invalid input. */
  async save(input: unknown, changedBy: string): Promise<{ version: number; config: RuntimeConfig }> {
    const parsed = runtimeConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    const problems = validateRuntimeConfig(parsed.data, this.sourceIds);
    if (problems.length) throw new ConfigError(problems);
    const { rows } = await this.pool.query(
      `INSERT INTO runtime_config (version, config, changed_by)
       SELECT COALESCE(MAX(version), 0) + 1, $1, $2 FROM runtime_config RETURNING version`,
      [JSON.stringify(parsed.data), changedBy],
    );
    this.cache = null;
    return { version: rows[0].version, config: parsed.data };
  }

  invalidate(): void {
    this.cache = null;
  }
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(problems.join("; "));
  }
}
