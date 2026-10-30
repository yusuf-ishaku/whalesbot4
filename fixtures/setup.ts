/**
 * Phase 0: compile + deploy fixtures to a local node and put test wallets at known states.
 *   npx hardhat node            # terminal 1 (needs a hardhat.config.cjs, see repo root)
 *   npm run fixtures            # terminal 2 -> writes fixtures/deployed.json
 *
 * Works against any JSON-RPC (RPC_URL), so the same script can target a testnet
 * if FIXTURE_PRIVATE_KEY is supplied.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { compile } from "./compile.js";
const here = path.dirname(fileURLToPath(import.meta.url));

/** Test wallets: deterministic from the standard hardhat/anvil dev mnemonic. */
const MNEMONIC = "test test test test test test test test test test test junk";
export const wallets = {
  deployer: 0,
  highHolder: 1, // 12,000 token -> high
  stakerOnly: 2, // 1,500 staked over 2 positions -> low
  bothNeeded: 3, // 600 token + 600 staked -> low ONLY when added
  tooLow: 4, // 100 token -> none
  unbonding: 5, // 500 token + 800 staked but unbonding -> none (unbonding excluded)
  empty: 6, // nothing -> none
} as const;

async function main() {
  const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const transport = http(rpc);
  const pub = createPublicClient({ transport });
  const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
  const deployer = acct(wallets.deployer);
  const wallet = createWalletClient({ account: deployer, transport });

  const deploy = async (file: string, name: string) => {
    const { abi, bytecode } = compile(file, name);
    const hash = await wallet.deployContract({ abi, bytecode, chain: null });
    const r = await pub.waitForTransactionReceipt({ hash });
    return { abi, address: r.contractAddress! };
  };
  const send = async (c: { abi: Abi; address: `0x${string}` }, fn: string, args: unknown[]) =>
    pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ ...c, functionName: fn, args, chain: null } as never),
    });

  const token = await deploy("TestToken.sol", "TestToken");
  const staking = await deploy("TestStaking.sol", "TestStaking");
  const a = (k: keyof typeof wallets) => acct(wallets[k]).address;

  await send(token, "setBalance", [a("highHolder"), parseEther("12000")]);
  await send(staking, "stake", [a("stakerOnly"), parseEther("700")]);
  await send(staking, "stake", [a("stakerOnly"), parseEther("800")]);
  await send(token, "setBalance", [a("bothNeeded"), parseEther("600")]);
  await send(staking, "stake", [a("bothNeeded"), parseEther("600")]);
  await send(token, "setBalance", [a("tooLow"), parseEther("100")]);
  await send(token, "setBalance", [a("unbonding"), parseEther("500")]);
  await send(staking, "stake", [a("unbonding"), parseEther("800")]);
  await send(staking, "beginUnbond", [a("unbonding"), 0n, BigInt(Math.floor(Date.now() / 1000) + 86400)]);

  const out = {
    rpc,
    token: token.address,
    staking: staking.address,
    wallets: Object.fromEntries(Object.keys(wallets).map((k) => [k, a(k as keyof typeof wallets)])),
  };
  writeFileSync(path.join(here, "deployed.json"), JSON.stringify(out, null, 2));
  console.log(out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
