# Token Gate

Telegram groups gated by on-chain holdings (token balance + staked balance), as a reusable per-client template.
Build plan: see the brief; technical choices: [docs/DECISIONS.md](docs/DECISIONS.md); onboarding: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout
- `src/engine` pure eligibility decision (`decide`) and reader interface · `src/sources` config-driven contract reads
- `src/services` verification, enforcement (grace/removal/tier moves), overrides, config store, audit
- `src/bot.ts` Telegram bot · `src/routes` verification + dashboard API · `web/` the pages
- `migrations/` SQL · `fixtures/` local test chain · `test/` suites

## Develop
```bash
npm ci
npm run node            # local chain (terminal 1)
npm run fixtures        # deploy test token/staking + test wallets
docker compose -f docker-compose.dev.yml up -d   # Postgres on :5433 (or any Postgres: set TEST_PG_ADMIN_URL)
npm test                # DB suites skip when Postgres is unreachable
```
# whalesbot
# whalesbot2
# whalesbot4
