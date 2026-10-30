export type SourceReading =
  | { sourceId: string; ok: true; units: bigint }
  | { sourceId: string; ok: false; error: string };

/** Implemented per source type; the engine and combine step never see how it reads. */
export interface SourceReader {
  read(sourceId: string, wallet: string): Promise<SourceReading>;
}

export interface SourceBreakdown {
  sourceId: string;
  status: "ok" | "error";
  /** Decimal string; present only when status = ok. A failed read is NOT zero. */
  amount?: string;
  error?: string;
}

export interface TierRef {
  id: string;
  name: string;
}

/**
 * status:
 *  - "ok":          every source read; tier decision is authoritative (zero is a real zero)
 *  - "read_failed": at least one source failed; NO decision is made. Callers must not remove anyone.
 */
export interface EligibilityResult {
  wallet: string;
  status: "ok" | "read_failed";
  sources: SourceBreakdown[];
  /** Combined total (decimal string). Null when status = read_failed. */
  total: string | null;
  /** Highest-priority qualifying tier, or null. */
  tier: TierRef | null;
  /** Every tier qualified for (only differs from [tier] when overlap = all_qualified). */
  tiers: TierRef[];
  /** Tier to aim for next and how much more is needed (sum/weighted rules only). */
  nextTier: (TierRef & { shortfall: string }) | null;
}
