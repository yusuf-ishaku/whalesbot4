/**
 * Phase 2 acceptance: each fixture wallet returns the expected tier and numbers from a real chain.
 * Skipped unless fixtures/deployed.json exists (run the local node + `npm run fixtures` first).
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeConfigSchema } from "../src/config/runtime.js";
import { checkEligibility } from "../src/engine/decide.js";
import { ContractReader } from "../src/sources/contractRead.js";
import { fixtureSources } from "../fixtures/sources.js";

const file = new URL("../fixtures/deployed.json", import.meta.url);
const deployed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

const cfg = runtimeConfigSchema.parse({
  branding: { communityName: "Test" },
  tiers: [
    { id: "low", name: "Low", threshold: "1000", priority: 1 },
    { id: "high", name: "High", threshold: "10000", priority: 2 },
  ],
});

describe.skipIf(!deployed)("engine against fixture chain", () => {
  const sources = deployed ? fixtureSources(deployed.token, deployed.staking) : [];
  const reader = deployed ? new ContractReader(deployed.rpc, sources) : (null as never);
  const run = (w: string) => checkEligibility(deployed.wallets[w], ["token", "staked"], reader, cfg);

  it("highHolder -> high", async () => expect((await run("highHolder")).tier?.id).toBe("high"));
  it("stakerOnly sums multiple positions -> low", async () => {
    const r = await run("stakerOnly");
    expect(r.total).toBe("1500");
    expect(r.tier?.id).toBe("low");
  });
  it("bothNeeded qualifies only when sources are added", async () => {
    const r = await run("bothNeeded");
    expect(r.sources.map((s) => s.amount)).toEqual(["600", "600"]);
    expect(r.total).toBe("1200");
    expect(r.tier?.id).toBe("low");
  });
  it("tooLow -> none, 900 short of low", async () => {
    const r = await run("tooLow");
    expect(r.tier).toBeNull();
    expect(r.nextTier?.shortfall).toBe("900");
  });
  it("unbonding stake is excluded", async () => {
    const r = await run("unbonding");
    expect(r.total).toBe("500");
    expect(r.tier).toBeNull();
  });
  it("empty wallet is a real zero, not a failure", async () => {
    const r = await run("empty");
    expect(r.status).toBe("ok");
    expect(r.total).toBe("0");
  });
  it("unreachable RPC -> read_failed, not zero", async () => {
    const dead = new ContractReader("http://127.0.0.1:1", sources);
    const r = await checkEligibility(deployed.wallets.highHolder, ["token", "staked"], dead, cfg);
    expect(r.status).toBe("read_failed");
    expect(r.tier).toBeNull();
  }, 30_000);
});
