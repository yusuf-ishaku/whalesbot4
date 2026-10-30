/**
 * Put ANY address at a chosen balance on the fixture chain, so you can test with your own wallet.
 *   npm run fixtures:set -- 0xYourAddress <token> [staked...] [--unbonding <amount>]
 *   npm run fixtures:set -- 0xYourAddress 600 600          # 600 token + one 600 stake
 *   npm run fixtures:set -- 0xYourAddress 0 700 800        # two stake positions
 *   npm run fixtures:set -- 0xYourAddress 100 --unbonding 5000   # 5000 staked but unbonding (not counted)
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, parseEther, type Abi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { compile } from "./compile.js";

const [addr, token, ...rest] = process.argv.slice(2);
if (!addr || token === undefined) { console.error("usage: fixtures:set -- <address> <token> [staked...] [--unbonding <amount>]"); process.exit(1); }
const ui = rest.indexOf("--unbonding");
const unbonding = ui >= 0 ? rest.splice(ui, 2)[1] : undefined;
const stakes = rest;

const d = JSON.parse(readFileSync(new URL("./deployed.json", import.meta.url), "utf8"));
const transport = http(d.rpc);
const pub = createPublicClient({ transport });
const deployer = mnemonicToAccount("test test test test test test test test test test test junk");
const wallet = createWalletClient({ account: deployer, transport });
const who = getAddress(addr);
const tokenAbi = compile("TestToken.sol", "TestToken").abi as Abi;
const stakingAbi = compile("TestStaking.sol", "TestStaking").abi as Abi;
const send = async (address: string, abi: Abi, fn: string, args: unknown[]) =>
  pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: address as `0x${string}`, abi, functionName: fn, args, chain: null } as never) });

await send(d.token, tokenAbi, "setBalance", [who, parseEther(token)]);
await send(d.staking, stakingAbi, "clear", [who]);
for (const s of stakes) await send(d.staking, stakingAbi, "stake", [who, parseEther(s)]);
if (unbonding) {
  await send(d.staking, stakingAbi, "stake", [who, parseEther(unbonding)]);
  await send(d.staking, stakingAbi, "beginUnbond", [who, BigInt(stakes.length), BigInt(Math.floor(Date.now() / 1000) + 86400)]);
}
console.log(`${who}: token=${token} staked=[${stakes.join(", ")}]${unbonding ? ` unbonding=${unbonding}` : ""}`);
