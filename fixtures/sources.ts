import type { SourceConfig } from "../src/config/sources.js";

/** Source definitions for the fixture contracts (same shape a real deployment puts in SOURCES_JSON). */
export function fixtureSources(token: string, staking: string): SourceConfig[] {
  return [
    {
      id: "token",
      label: "Token balance",
      contract: token,
      abi: ["function balanceOf(address) view returns (uint256)"],
      fn: "balanceOf",
      args: ["$wallet"],
      extract: { kind: "scalar" },
      decimals: 18,
    },
    {
      id: "staked",
      label: "Staked",
      contract: staking,
      abi: [
        "struct Position { uint256 amount; bool unbonding; uint64 unlockAt; }",
        "function positionsOf(address) view returns (Position[])",
      ],
      fn: "positionsOf",
      args: ["$wallet"],
      extract: { kind: "positions", amountField: "amount", unbondingField: "unbonding", countUnbonding: false },
      decimals: 18,
    },
  ];
}
