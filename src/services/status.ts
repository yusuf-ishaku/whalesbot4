import type { RuntimeConfig } from "../config/runtime.js";
import type { EligibilityResult } from "../engine/types.js";
import { render } from "./messages.js";

/** The member-facing summary of an engine result. Shared by the bot and the web page. */
export function statusText(config: RuntimeConfig, result: EligibilityResult | null, mode: "status" | "verify" = "status"): string {
  if (!result) return render(config, "status.unverified");
  if (result.status === "read_failed") return render(config, mode === "verify" ? "verify.done_read_failed" : "status.read_failed");
  const total = result.total ?? "0";
  if (result.tier) {
    const base = render(config, mode === "verify" ? "verify.done_eligible" : "status.eligible", { tier: result.tier.name, total });
    return result.nextTier
      ? `${base}\n${render(config, "status.next", { shortfall: result.nextTier.shortfall, next: result.nextTier.name })}`
      : base;
  }
  const n = result.nextTier;
  return render(config, mode === "verify" ? "verify.done_short" : "status.short", {
    total,
    next: n?.name ?? "",
    shortfall: n?.shortfall ?? "",
  });
}
