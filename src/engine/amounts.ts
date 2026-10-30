/** All amounts are bigints scaled to 18 decimals internally ("units"). */
export const SCALE = 18;

export function rawToUnits(raw: bigint, decimals: number): bigint {
  return decimals <= SCALE ? raw * 10n ** BigInt(SCALE - decimals) : raw / 10n ** BigInt(decimals - SCALE);
}

/** Parse a non-negative decimal string like "1500.25" into scaled units. */
export function parseUnits18(s: string): bigint {
  const [whole = "0", frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(SCALE)).slice(0, SCALE);
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(padded || "0");
}

/** Format scaled units as a trimmed decimal string. */
export function formatUnits18(u: bigint): string {
  const base = 10n ** BigInt(SCALE);
  const whole = u / base;
  const frac = (u % base).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
