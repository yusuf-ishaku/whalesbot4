import { z } from "zod";

/**
 * Source definitions are DEPLOY-TIME config (they contain contract addresses).
 * Tiers / combine rule reference sources by `id`; those live in runtime config.
 *
 * A source is one contract read:
 *   - `abi`      human-readable ABI fragment(s) for the call
 *   - `fn`       function name to call
 *   - `args`     arguments; the literal "$wallet" is replaced by the wallet address
 *   - `extract`  how to turn the return value into a raw amount
 *   - `decimals` used to normalise the raw amount
 */
export const extractSchema = z.discriminatedUnion("kind", [
  // Return value is the amount itself (e.g. ERC20 balanceOf) or a tuple member.
  z.object({
    kind: z.literal("scalar"),
    /** Tuple member name/index when the call returns a struct/tuple. Omit for a bare uint. */
    field: z.union([z.string(), z.number().int()]).optional(),
  }),
  // Return value is an array of positions; sum a field across them.
  z.object({
    kind: z.literal("positions"),
    /** Field holding each position's amount. Omit when the array is of bare uints. */
    amountField: z.union([z.string(), z.number().int()]).optional(),
    /**
     * Whether positions that are unbonding/cooling down count toward the total.
     * `unbondingField` is a boolean field on each position (truthy = unbonding).
     */
    unbondingField: z.union([z.string(), z.number().int()]).optional(),
    countUnbonding: z.boolean().default(false),
  }),
]);

export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i),
  label: z.string().default(""),
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  abi: z.array(z.string()).min(1),
  fn: z.string(),
  args: z.array(z.string()).default(["$wallet"]),
  extract: extractSchema,
  decimals: z.number().int().min(0).max(36),
});

export type SourceConfig = z.infer<typeof sourceSchema>;
export const sourcesSchema = z.array(sourceSchema).min(1);
