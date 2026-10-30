# Technical decisions

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript / Node 24 | One language across backend, bot, web; strong typing for the config schemas. |
| HTTP | Fastify | Fast, schema-friendly, small. |
| DB | Postgres + plain SQL migrations | Relational data model, transactional enforcement; no ORM keeps migrations reviewable. |
| Chain | viem | Typed, human-readable ABIs make config-driven reads simple. |
| Bot | grammY | Maintained, good webhook/long-poll support. |
| Web + dashboard | Dependency-free static pages in `web/`, served by the backend | No build step or front-end toolchain per client; text is set via textContent only (no innerHTML), strict CSP (`script-src 'self'`). |
| Telegram | Behind a `TelegramGateway` interface, long polling | Enforcement is testable with a fake; no public webhook needed. |
| Admin auth | scrypt passwords, HMAC-signed HttpOnly SameSite=Strict cookie, custom CSRF header, login lockout | No session store needed. |
| Validation | zod | Single source for env + runtime config shape. |
| Tests | vitest | Fast, TS-native. |

## Config split
- Deploy-time (env): `src/config/env.ts`. Includes `SOURCES_JSON` (contract addresses + read specs).
- Runtime (DB, versioned, dashboard-edited): `src/config/runtime.ts`. Tiers/combine reference sources by id.

## Engine
- `decide()` in `src/engine/decide.ts` is the only place eligibility is decided; pure over readings.
- Amounts are bigints scaled to 18 decimals; no floats anywhere.
- A failed source read produces `status: "read_failed"` with no tier decision. Enforcement must treat that as "skip".
