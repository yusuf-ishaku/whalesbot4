import { describe, expect, it } from "vitest";
import { parseUnits18, rawToUnits } from "../src/engine/amounts.js";
import { checkEligibility, decide } from "../src/engine/decide.js";
import { extractRaw } from "../src/sources/contractRead.js";
import type { SourceReader, SourceReading } from "../src/engine/types.js";
import { runtimeConfigSchema } from "../src/config/runtime.js";
import { sourceSchema } from "../src/config/sources.js";

const W = "0x00000000000000000000000000000000000000aa";
const cfg = runtimeConfigSchema.parse({
  branding: { communityName: "Test" },
  tiers: [
    { id: "low", name: "Low", threshold: "1000", priority: 1 },
    { id: "high", name: "High", threshold: "10000", priority: 2 },
  ],
});
const ok = (sourceId: string, amount: string): SourceReading => ({ sourceId, ok: true, units: parseUnits18(amount) });
const bad = (sourceId: string): SourceReading => ({ sourceId, ok: false, error: "rpc down" });

describe("decide", () => {
  it("qualifies only when both sources are added", () => {
    const r = decide(W, [ok("token", "600"), ok("staked", "600")], cfg);
    expect(r.status).toBe("ok");
    expect(r.total).toBe("1200");
    expect(r.tier?.id).toBe("low");
    expect(r.nextTier).toEqual({ id: "high", name: "High", shortfall: "8800" });
  });

  it("each source alone is below threshold", () => {
    expect(decide(W, [ok("token", "600"), ok("staked", "0")], cfg).tier).toBeNull();
  });

  it("picks the highest tier; lists all under all_qualified", () => {
    const readings = [ok("token", "12000"), ok("staked", "0")];
    expect(decide(W, readings, cfg).tiers.map((t) => t.id)).toEqual(["high"]);
    const all = decide(W, readings, { ...cfg, overlap: "all_qualified" });
    expect(all.tiers.map((t) => t.id)).toEqual(["high", "low"]);
    expect(all.nextTier).toBeNull();
  });

  it("zero balance is a real result, with distance to lowest tier", () => {
    const r = decide(W, [ok("token", "0"), ok("staked", "0")], cfg);
    expect(r.status).toBe("ok");
    expect(r.tier).toBeNull();
    expect(r.nextTier?.shortfall).toBe("1000");
  });

  it("a failed read yields read_failed and no decision, never zero", () => {
    const r = decide(W, [ok("token", "50000"), bad("staked")], cfg);
    expect(r.status).toBe("read_failed");
    expect(r.total).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.sources[1]).toMatchObject({ status: "error", error: "rpc down" });
    expect(r.sources[1]).not.toHaveProperty("amount");
  });

  it("weighted sum", () => {
    const c = { ...cfg, combine: { rule: "weighted_sum" as const, weightsBps: { staked: 20000 } } };
    expect(decide(W, [ok("token", "0"), ok("staked", "600")], c).total).toBe("1200");
  });

  it("any / all rules", () => {
    const readings = [ok("token", "1500"), ok("staked", "200")];
    expect(decide(W, readings, { ...cfg, combine: { rule: "any" } }).tier?.id).toBe("low");
    expect(decide(W, readings, { ...cfg, combine: { rule: "all" } }).tier).toBeNull();
  });

  it("handles non-18 decimals and exact threshold", () => {
    expect(rawToUnits(1_000_000_000n, 6)).toBe(parseUnits18("1000"));
    expect(decide(W, [{ sourceId: "t", ok: true, units: rawToUnits(1_000_000_000n, 6) }], cfg).tier?.id).toBe("low");
  });
});

describe("checkEligibility", () => {
  it("turns a throwing reader into read_failed", async () => {
    const reader: SourceReader = { read: async () => { throw new Error("timeout"); } };
    const r = await checkEligibility(W, ["token"], reader, cfg);
    expect(r.status).toBe("read_failed");
  });
});

describe("extractRaw", () => {
  const base = { id: "s", label: "", contract: "0x" + "1".repeat(40), abi: ["x"], fn: "f", args: ["$wallet"], decimals: 18 };
  it("sums positions and excludes unbonding by default", () => {
    const s = sourceSchema.parse({ ...base, extract: { kind: "positions", amountField: "amount", unbondingField: "unbonding" } });
    const result = [{ amount: 100n, unbonding: false }, { amount: 50n, unbonding: true }, { amount: 5n, unbonding: false }];
    expect(extractRaw(result, s)).toBe(105n);
  });
  it("includes unbonding when configured", () => {
    const s = sourceSchema.parse({ ...base, extract: { kind: "positions", amountField: "amount", unbondingField: "unbonding", countUnbonding: true } });
    expect(extractRaw([{ amount: 100n, unbonding: true }], s)).toBe(100n);
  });
  it("scalar tuple field", () => {
    const s = sourceSchema.parse({ ...base, extract: { kind: "scalar", field: 0 } });
    expect(extractRaw([42n, 1n], s)).toBe(42n);
  });
});
