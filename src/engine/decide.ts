import type { RuntimeConfig } from "../config/runtime.js";
import { formatUnits18, parseUnits18 } from "./amounts.js";
import type { EligibilityResult, SourceReader, SourceReading, TierRef } from "./types.js";

/**
 * The ONLY place eligibility is decided. Pure given the readings:
 * no I/O, no clock, no randomness.
 */
export function decide(
  wallet: string,
  readings: SourceReading[],
  config: Pick<RuntimeConfig, "combine" | "tiers" | "overlap">,
): EligibilityResult {
  const sources = readings.map((r) =>
    r.ok
      ? { sourceId: r.sourceId, status: "ok" as const, amount: formatUnits18(r.units) }
      : { sourceId: r.sourceId, status: "error" as const, error: r.error },
  );

  // A failed read is never treated as zero: no decision at all.
  if (readings.some((r) => !r.ok)) {
    return { wallet, status: "read_failed", sources, total: null, tier: null, tiers: [], nextTier: null };
  }
  const values = readings.map((r) => ({ id: r.sourceId, units: (r as { units: bigint }).units }));

  const { combine } = config;
  let total: bigint;
  if (combine.rule === "weighted_sum") {
    total = values.reduce((acc, v) => acc + (v.units * BigInt(combine.weightsBps[v.id] ?? 10000)) / 10000n, 0n);
  } else {
    total = values.reduce((acc, v) => acc + v.units, 0n);
  }

  const meets = (threshold: bigint): boolean => {
    switch (combine.rule) {
      case "any":
        return values.some((v) => v.units >= threshold);
      case "all":
        return values.length > 0 && values.every((v) => v.units >= threshold);
      default:
        return total >= threshold;
    }
  };

  const byPriority = [...config.tiers].sort((a, b) => b.priority - a.priority);
  const ref = (t: { id: string; name: string }): TierRef => ({ id: t.id, name: t.name });
  const qualified = byPriority.filter((t) => meets(parseUnits18(t.threshold)));
  const top = qualified[0];

  // Next tier: the lowest-threshold tier not yet met. Shortfall is only meaningful for total-based rules.
  let nextTier: EligibilityResult["nextTier"] = null;
  if (combine.rule === "sum" || combine.rule === "weighted_sum") {
    const unmet = config.tiers
      .filter((t) => parseUnits18(t.threshold) > total)
      .sort((a, b) => (parseUnits18(a.threshold) < parseUnits18(b.threshold) ? -1 : 1));
    const n = unmet[0];
    if (n) nextTier = { ...ref(n), shortfall: formatUnits18(parseUnits18(n.threshold) - total) };
  }

  return {
    wallet,
    status: "ok",
    sources,
    total: formatUnits18(total),
    tier: top ? ref(top) : null,
    tiers: config.overlap === "all_qualified" ? qualified.map(ref) : top ? [ref(top)] : [],
    nextTier,
  };
}

/** Read every source for a wallet, then decide. Never throws on a failed read. */
export async function checkEligibility(
  wallet: string,
  sourceIds: string[],
  reader: SourceReader,
  config: Pick<RuntimeConfig, "combine" | "tiers" | "overlap">,
): Promise<EligibilityResult> {
  const readings = await Promise.all(
    sourceIds.map((id) =>
      reader.read(id, wallet).catch(
        (e): SourceReading => ({ sourceId: id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      ),
    ),
  );
  return decide(wallet, readings, config);
}
