import { createPublicClient, http, parseAbi, type Abi, type PublicClient } from "viem";
import type { SourceConfig } from "../config/sources.js";
import { rawToUnits } from "../engine/amounts.js";
import type { SourceReader, SourceReading } from "../engine/types.js";

type Member = string | number | undefined;

function pick(value: unknown, field: Member): unknown {
  if (field === undefined) return value;
  if (value === null || typeof value !== "object") throw new Error(`cannot read field ${field} of non-object`);
  return (value as Record<string | number, unknown>)[field];
}

function toBigInt(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  throw new Error(`${what} is not a uint (got ${typeof v})`);
}

/** Turn a contract call's return value into a raw amount, per the source's extract rule. */
export function extractRaw(result: unknown, source: SourceConfig): bigint {
  const ex = source.extract;
  if (ex.kind === "scalar") return toBigInt(pick(result, ex.field), "amount");

  if (!Array.isArray(result)) throw new Error("positions source did not return an array");
  let sum = 0n;
  for (const p of result) {
    if (ex.unbondingField !== undefined && !ex.countUnbonding && pick(p, ex.unbondingField)) continue;
    sum += toBigInt(pick(p, ex.amountField), "position amount");
  }
  return sum;
}

export class ContractReader implements SourceReader {
  private client: PublicClient;
  private abis = new Map<string, Abi>();

  constructor(
    rpcUrl: string,
    private sources: SourceConfig[],
    opts: { timeoutMs?: number; retryCount?: number; client?: PublicClient } = {},
  ) {
    this.client =
      opts.client ??
      createPublicClient({ transport: http(rpcUrl, { timeout: opts.timeoutMs ?? 10_000, retryCount: opts.retryCount ?? 2, retryDelay: 300 }) });
    for (const s of sources) this.abis.set(s.id, parseAbi(s.abi as readonly string[]) as Abi);
  }

  async read(sourceId: string, wallet: string): Promise<SourceReading> {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return { sourceId, ok: false, error: `unknown source ${sourceId}` };
    try {
      const result = await this.client.readContract({
        address: source.contract as `0x${string}`,
        abi: this.abis.get(sourceId)!,
        functionName: source.fn,
        args: source.args.map((a) => (a === "$wallet" ? wallet : a)),
      });
      return { sourceId, ok: true, units: rawToUnits(extractRaw(result, source), source.decimals) };
    } catch (e) {
      return { sourceId, ok: false, error: e instanceof Error ? e.message.split("\n")[0]! : String(e) };
    }
  }
}
