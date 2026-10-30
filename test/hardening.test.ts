/** Phase 7 edge cases: hanging RPC, garbage contract responses, absurd values. */
import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { sourceSchema } from "../src/config/sources.js";
import { parseUnits18, formatUnits18, rawToUnits } from "../src/engine/amounts.js";
import { runtimeConfigSchema } from "../src/config/runtime.js";
import { decide } from "../src/engine/decide.js";
import { ContractReader, extractRaw } from "../src/sources/contractRead.js";
import { fixtureSources } from "../fixtures/sources.js";

const sources = fixtureSources("0x" + "1".repeat(40), "0x" + "2".repeat(40));

describe("RPC failure modes", () => {
  // A server that accepts the connection and never answers.
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  afterAll(() => { sockets.forEach((s) => s.destroy()); server.close(); });

  it("a hanging RPC times out into a read failure (not a hang, not a zero)", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const reader = new ContractReader(`http://127.0.0.1:${port}`, sources, { timeoutMs: 300, retryCount: 0 });
    const t0 = Date.now();
    const r = await reader.read("token", "0x" + "a".repeat(40));
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("an unknown source id is a failure, not a throw", async () => {
    const reader = new ContractReader("http://127.0.0.1:1", sources, { retryCount: 0 });
    expect(await reader.read("nope", "0x" + "a".repeat(40))).toMatchObject({ ok: false });
  });
});

describe("extraction edge cases", () => {
  const base = { id: "s", label: "", contract: "0x" + "1".repeat(40), abi: ["x"], fn: "f", args: ["$wallet"], decimals: 18 };
  it("non-uint / non-array returns are errors", () => {
    const scalar = sourceSchema.parse({ ...base, extract: { kind: "scalar" } });
    expect(() => extractRaw("0x", scalar)).toThrow();
    const pos = sourceSchema.parse({ ...base, extract: { kind: "positions", amountField: "amount" } });
    expect(() => extractRaw(5n, pos)).toThrow();
  });
  it("empty positions sum to zero (a real zero)", () => {
    const pos = sourceSchema.parse({ ...base, extract: { kind: "positions", amountField: "amount" } });
    expect(extractRaw([], pos)).toBe(0n);
  });
  it("bare uint arrays are summed", () => {
    const pos = sourceSchema.parse({ ...base, extract: { kind: "positions" } });
    expect(extractRaw([1n, 2n, 3n], pos)).toBe(6n);
  });
});

describe("amount math", () => {
  it("handles 6, 8, 18 and 24 decimals", () => {
    expect(formatUnits18(rawToUnits(1_500_000n, 6))).toBe("1.5");
    expect(formatUnits18(rawToUnits(100_000_000n, 8))).toBe("1");
    expect(formatUnits18(rawToUnits(10n ** 24n, 24))).toBe("1");
  });
  it("round-trips fractional thresholds exactly (no float error)", () => {
    expect(formatUnits18(parseUnits18("0.1") + parseUnits18("0.2"))).toBe("0.3");
    expect(formatUnits18(parseUnits18("1234567890123456789.123456789012345678"))).toBe("1234567890123456789.123456789012345678");
  });
  it("supply-scale values (10^30 units) compare correctly", () => {
    const cfg = runtimeConfigSchema.parse({ branding: { communityName: "x" }, tiers: [{ id: "a", name: "A", threshold: "1000000000000", priority: 1 }] });
    const huge = { sourceId: "token", ok: true as const, units: parseUnits18("999999999999") };
    expect(decide("0x1", [huge], cfg).tier).toBeNull();
    expect(decide("0x1", [{ ...huge, units: parseUnits18("1000000000000") }], cfg).tier?.id).toBe("a");
  });
});
