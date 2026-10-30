import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Abi } from "viem";

const require = createRequire(import.meta.url);
const solc = require("solc");
const here = path.dirname(fileURLToPath(import.meta.url));

export function compile(file: string, name: string): { abi: Abi; bytecode: `0x${string}` } {
  const input = {
    language: "Solidity",
    sources: { [file]: { content: readFileSync(path.join(here, "contracts", file), "utf8") } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts[file][name];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}
