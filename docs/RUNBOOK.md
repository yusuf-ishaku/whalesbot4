# Setup runbook: onboarding a new client

One deployment per client: same code, different `.env` and a fresh database. Nothing here needs a code change.

## 0. What you need from the client
| Item | Goes in |
|---|---|
| Chain id, RPC URL (a paid/keyed RPC is recommended for the daily re-check) | `CHAIN_ID`, `RPC_URL` |
| Token contract + how the staking contract exposes a wallet's stake | `SOURCES_JSON` (see below) |
| Threshold per group, overlap choice, grace period | Dashboard → Config |
| The two Telegram groups | Dashboard → Setup |
| Admin emails | Dashboard → Admins |

### Describing a source (`SOURCES_JSON`)
Each source is one contract read:
- ERC-20 balance: `fn: balanceOf`, `extract: {"kind":"scalar"}`.
- Staked amount returned directly (`stakedBalance(address) → uint256`): `extract: {"kind":"scalar"}`.
- Tuple return (e.g. `(amount, rewardDebt)`): `extract: {"kind":"scalar","field":0}` (or the member name).
- Several positions (`positionsOf(address) → Position[]`): `extract: {"kind":"positions","amountField":"amount","unbondingField":"unbonding","countUnbonding":false}`.
- `decimals` must match the token. Use human-readable ABI strings (viem format); structs are declared as `"struct Position { uint256 amount; bool unbonding; }"`.

If a real staking contract does not fit any of these, only that source needs a custom module (`src/sources/`); the engine, combine rule and tiers are unchanged. **Confirm this with the client before go-live.**

## 1. Telegram
1. @BotFather → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Keep both groups **private** (recommended). Private groups have no "Approve New Members" toggle and don't need one: set each tier's *Invite type* to "Approve join requests" in the dashboard and the bot creates approval-required links itself. (That toggle exists only for public groups; use it only if you deliberately run a public group.)
3. For each group: add the bot as **admin** with *Invite users via link* and *Ban users*. (Groups should be private; invite links are the only way in.)
4. Do NOT disable the bot's group privacy requirement for admins; admin bots receive join events.

## 2. Deploy
```bash
cp .env.example .env      # fill it in; set ADMIN_EMAIL / ADMIN_PASSWORD for the first admin
./scripts/deploy.sh       # builds, migrates, records the git revision as the code version
```
Put a TLS reverse proxy (Caddy/nginx) in front and set `PUBLIC_URL` to the https address. Verification links use it, and the admin cookie is marked `Secure` when it is https.
No Docker? `npm ci && npm run migrate && npm start` with the same env.

## 3. First-run setup (client admin, in the dashboard at `/admin`)
1. **Config**: community name, logo, colours, tiers + thresholds, combine rule, overlap, grace, messages. Save.
2. **Setup → Link group** per tier. Post the shown `/link <code>` in that group as a group admin.
3. **Setup → Test a wallet** with a known holder, a short wallet and an empty wallet. Check the numbers against the explorer.
4. All four setup steps should be green.

## 4. Go-live acceptance (re-run the fixture cases against the real contracts)
- Fresh account: `/start` → captcha → link → sign → lands in the right group.
- A second Telegram account tries the same wallet → refused.
- Short wallet → told how much more it needs, no invite.
- Lower a test wallet below the threshold (move tokens out) → Dashboard shows *grace*, member gets a warning; after the grace period → removed.
- Point `RPC_URL` at a dead host, run **Re-check everyone now** → nobody removed, audit shows `check.read_failed`. Restore the RPC.

## 5. Operating
- Health: `GET /health`. Logs are JSON lines.
- Re-check runs every `RECHECK_TICK_MINUTES`, handling members whose last check is older than the configured cadence. Throttle with `RECHECK_CONCURRENCY` / `RECHECK_DELAY_MS` on rate-limited RPCs.
- Config changes are versioned (Config history API) and audited. Changing a token/staking contract is a redeploy (`SOURCES_JSON`), by design.
- Upgrades: `git pull && ./scripts/deploy.sh`. Migrations run on boot.
- Backups: `docker compose exec db pg_dump -U tokengate tokengate > backup.sql`.

## 6. Behaviours worth knowing
- A failed read (RPC down, contract error) never removes anyone; the member is skipped and the failure audited.
- Telegram removal failures leave the membership open, and it is retried on the next run.
- Scheduled runs invite only members who never had access to a group; anyone else asks via `/reverify`.
- Allowlisted members are exempt from removal; bans remove permanently.
- A wallet can be linked to one Telegram account (toggle in Config). Wallet replacement is allowed and audited.
- Join requests/links used by anyone other than the intended member are rejected and logged (`join.unauthorized`).

## Join requests (auto-approve)
This applies to requests made through the bot's own approval links (private groups) and, for public groups with *Approve New Members* on, to anyone who finds the group. A requester gets a DM from the bot with a one-time verification link (Telegram lets the bot message a requester for ~5 minutes even if they never started it). The request stays pending while they verify, then:
- qualifies -> approved automatically and told so; no invite link is sent;
- short -> declined with their total and the threshold;
- qualifies only for a different group (highest-only overlap) -> declined with a pointer to the right group;
- banned -> declined; no verification within *Pending join requests wait (hours)* (Config, default 24) -> declined as expired;
- RPC/contract read failed -> stays pending, never declined.
Bots cannot add people to a group directly, which is why approval of a request is the closest thing to auto-add.

## Unverified people who get into a group
If someone ends up in a linked group without the bot letting them in (the group's own link, a forwarded link), the default is to **mute them and post a notice with a Verify button in the group**. The button opens the bot, so it works even for people who never started it (Telegram doesn't let bots DM strangers). Then:
- verifies and qualifies -> unmuted automatically, notice deleted;
- verifies but is short -> removed, with their total and the threshold;
- doesn't verify within *Pending join requests wait (hours)* -> removed;
- read failed -> stays muted, never removed;
- banned -> removed permanently.
Config -> "If someone gets into a group without being let in" can switch this to *Remove immediately*. If the bot lacks the ban/restrict right it falls back to removing. Giving the bot the *Delete messages* right lets it tidy the notice afterwards (optional).

## Known limits (v1)
- The verification page uses injected wallets (EIP-1193/6963) and wallet-app deep links. Telegram's in-app browser has no wallet, so mobile users open the page in their wallet app. WalletConnect would improve this and needs a WalletConnect project id.
- One app instance per deployment (the re-check uses a DB lock, so extra instances are safe but not needed).
- Smart-contract wallets verify through an on-chain ERC-1271 call and need the RPC to be up.
