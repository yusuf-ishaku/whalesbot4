import pg from "pg";
import { mnemonicToAccount } from "viem/accounts";
import { loadEnv } from "../src/config/env.js";
import type { Ctx } from "../src/ctx.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { parseUnits18 } from "../src/engine/amounts.js";
import type { SourceReader, SourceReading } from "../src/engine/types.js";
import { ConfigStore } from "../src/services/configStore.js";
import type { BotGroupStatus, TelegramGateway } from "../src/services/telegram.js";
import { createCode, ensureMember, signingMessage, verifyAndBind, loadCode } from "../src/services/verification.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://tokengate@localhost:5433/postgres";

export async function dbAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

/** Scripted balances. `failing` simulates an RPC outage for every read. */
export class FakeReader implements SourceReader {
  balances = new Map<string, { token: string; staked: string }>();
  failing = false;
  set(wallet: string, token: string, staked = "0") { this.balances.set(wallet.toLowerCase(), { token, staked }); }
  async read(sourceId: string, wallet: string): Promise<SourceReading> {
    if (this.failing) return { sourceId, ok: false, error: "rpc down" };
    const b = this.balances.get(wallet.toLowerCase()) ?? { token: "0", staked: "0" };
    return { sourceId, ok: true, units: parseUnits18(sourceId === "token" ? b.token : b.staked) };
  }
}

export class FakeGateway implements TelegramGateway {
  readonly configured = true;
  messages: { to: number | string; text: string }[] = [];
  invites: { groupId: string; link: string }[] = [];
  removed: { groupId: string; userId: number; permanent: boolean }[] = [];
  approved: { groupId: string; userId: number }[] = [];
  declined: { groupId: string; userId: number }[] = [];
  muted = new Set<string>();
  notices: { groupId: string; text: string; id: number; button?: { text: string; url: string } }[] = [];
  deletedNotices: number[] = [];
  failRestrict = false;
  failRemove = false;
  admins = new Set<string>();
  private n = 0;
  async sendMessage(to: number | string, text: string) { this.messages.push({ to, text }); }
  async createInviteLink(groupId: string) { const link = `https://t.me/+invite${++this.n}`; this.invites.push({ groupId, link }); return link; }
  async revokeInviteLink() {}
  async removeMember(groupId: string, userId: number, o: { permanent: boolean }) {
    if (this.failRemove) throw new Error("telegram down");
    this.removed.push({ groupId, userId, permanent: o.permanent });
  }
  async approveJoinRequest(groupId: string, userId: number) { this.approved.push({ groupId, userId }); }
  async declineJoinRequest(groupId: string, userId: number) { this.declined.push({ groupId, userId }); }
  async botUsername() { return "gatebot"; }
  async restrictMember(groupId: string, userId: number, mute: boolean) {
    if (this.failRestrict) throw new Error("no rights");
    if (mute) this.muted.add(`${groupId}:${userId}`); else this.muted.delete(`${groupId}:${userId}`);
  }
  async postNotice(groupId: string, text: string, button?: { text: string; url: string }) { const id = 500 + this.notices.length; this.notices.push({ groupId, text, id, button }); return id; }
  async deleteMessage(_g: string, id: number) { this.deletedNotices.push(id); }
  async isChatAdmin(groupId: string, userId: number) { return this.admins.has(`${groupId}:${userId}`); }
  async botStatus(): Promise<BotGroupStatus> { return { ok: true }; }
  lastTo(id: number) { return [...this.messages].reverse().find((m) => m.to === id)?.text; }
}

export const SOURCES = [
  { id: "token", label: "Token", contract: "0x" + "1".repeat(40), abi: ["function balanceOf(address) view returns (uint256)"], fn: "balanceOf", args: ["$wallet"], extract: { kind: "scalar" }, decimals: 18 },
  { id: "staked", label: "Staked", contract: "0x" + "2".repeat(40), abi: ["function s(address) view returns (uint256)"], fn: "s", args: ["$wallet"], extract: { kind: "scalar" }, decimals: 18 },
];

const MNEMONIC = "test test test test test test test test test test test junk";
export const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

export async function makeCtx() {
  const dbName = `tg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/postgres$/, `/${dbName}`);
  const pool = createPool(url);
  await migrate(pool);

  const env = loadEnv({
    DATABASE_URL: url, CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:1", PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "s".repeat(40), SOURCES_JSON: JSON.stringify(SOURCES), RECHECK_DELAY_MS: "0",
  } as NodeJS.ProcessEnv);
  const reader = new FakeReader();
  const tg = new FakeGateway();
  const clock = { t: new Date("2026-01-01T00:00:00Z") };
  const config = new ConfigStore(pool, SOURCES.map((s) => s.id), 0);
  const ctx: Ctx = { env, pool, config, reader, tg, now: () => clock.t, log: { info() {}, warn() {}, error() {} } };

  const defaults = (await config.current()).config;
  await config.save({
    ...defaults,
    branding: { ...defaults.branding, communityName: "Test Co" },
    tiers: [
      { id: "high", name: "High", threshold: "10000", priority: 2, telegramGroupId: "-100high", invite: { mode: "single_use_link", expiresMinutes: 60 } },
      { id: "low", name: "Low", threshold: "1000", priority: 1, telegramGroupId: "-100low", invite: { mode: "single_use_link", expiresMinutes: 60 } },
    ],
    recheck: { cadenceHours: 24, gracePeriodHours: 48, warnBeforeRemove: true, warningLeadHours: 12 },
  }, "test");

  return {
    ctx, reader, tg, clock, pool,
    advanceHours: (h: number) => { clock.t = new Date(clock.t.getTime() + h * 3_600_000); },
    async cleanup() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Full happy path: issue a code and sign it with a test account. */
export async function bind(ctx: Ctx, telegramId: number, accountIndex: number) {
  await ensureMember(ctx, telegramId, `user${telegramId}`);
  const { code } = await createCode(ctx, telegramId);
  const { row } = await loadCode(ctx, code);
  const acct = account(accountIndex);
  const { config } = await ctx.config.current();
  const signature = await acct.signMessage({ message: signingMessage(ctx, config.branding.communityName, row!) });
  return { code, acct, signature, result: await verifyAndBind(ctx, code, acct.address, signature) };
}

/** Pretend the member joined the group using the invite we sent. */
export async function markJoined(ctx: Ctx, telegramId: number, groupId: string) {
  const { handleJoin } = await import("../src/services/enforcement.js");
  return handleJoin(ctx, groupId, telegramId);
}
