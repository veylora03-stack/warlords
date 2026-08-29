# WARLORDS — Engineering Worklog (append-only)

---

Task ID: 0
Agent: Z.ai Code (orchestrator — senior team role)
Task: PHASE 0 — Architecture + Repository Structure + Database Design + API Design + Development Plan

Work Log:
- Inspected repo: Next.js 16 + React 19 + TS 5 + Tailwind 4 + shadcn/ui scaffold, Prisma 6 (SQLite sandbox driver), Zod 4 / Zustand 5 / TanStack Query 5 present; git repo with only an empty initial commit.
- Committed untouched scaffold as baseline (`chore: baseline scaffold`).
- Wrote full architecture document set under `docs/`:
  - ARCHITECTURE.md — stack decisions (incl. justified deviations: Route Handlers instead of separate NestJS/Fastify service; SQLite only as dev driver, PostgreSQL-first schema), layering rules (adapters→services→engines→config), lazy-tick game state model, BigInt/basis-point numeric policy, notification outbox, observability, deployment topology (sandbox gateway + Vercel/Supabase production), module maturity matrix.
  - DATABASE_DESIGN.md — ERD (mermaid), 45-entity catalog, ledger-first economy, catalog/instance split, hot-path indexes, transaction boundary examples, PG migration notes.
  - API_DESIGN.md — envelope contract, error code taxonomy, auth headers, idempotency, rate-limit groups, full endpoint catalog for phases 1–9, attack + idempotent-claim sequences.
  - BATTLE_MODEL.md — deterministic seeded simulation, bps modifier aggregation, data-driven counter matrix, round loop, loot/hospital/protection rules, replay contract, anti-exploit notes.
  - SECURITY.md — Telegram initData HMAC verification, JWT session, anti-cheat matrix, RBAC, anti-replay, secrets register, honest limitations register.
  - ROADMAP.md — phase contracts 0–13 with exit criteria + per-phase quality gate (lint/typecheck/runtime/commit/worklog).
- Designed complete Prisma schema (`prisma/schema.prisma`): 45 models incl. users, players, resource_wallets, resource_transactions (ledger), cities, buildings, unit_types, player_units, marches, commanders, items, technologies, territories, battles/battle_rounds/battle_logs, quests, clans & wars, market, seasons, world_bosses, events, notifications, admin_audit_logs, idempotency_keys, post-MVP-ready diplomacy_relations & spy_missions. All tables @@map'd to snake_case; BigInt for money/power/HP; Json for data-driven config blobs.
  - Fixed 4 validation errors (missing back-relations User.notifications→removed, Player.transactions & Player.ledClans added, March.battleId made unique).
  - `prisma validate` ✅ and `prisma db push` ✅ on SQLite (schema proven valid; Prisma Client regenerated). Post-MVP tables exist from day one so later phases are additive.
- Implemented Phase 0 code:
  - `src/lib/game/types/` — common.ts (all enum-like unions + bps policy), game-state.ts (projections, command intents, reconciliation contract), battle.ts (BattleConfig/BattleSide/BattleInput/simulation/replay types + mergeBps helper), index.ts barrel.
  - `src/lib/api/errors.ts` — AppError taxonomy (stable machine-readable codes) + helpers.
  - `src/lib/api/response.ts` — standard envelope, BigInt-safe JSON serialization, request-id propagation, `handle()` catch-all wrapper.
  - `src/app/api/health/route.ts` — real liveness probe (SELECT 1 via Prisma, latency, uptime, version).
  - `src/app/page.tsx` — WARLORDS dev console (dark fantasy/military theme, amber accents, no indigo/blue): live system status from /api/health, architecture summary, 14-phase roadmap, Phase 0 deliverables; sticky footer via min-h-screen flex + mt-auto; responsive.
  - layout.tsx metadata → WARLORDS; README.md; .env.example (no secrets); package.json `typecheck` script; tsconfig excludes sandbox-only dirs (examples/skills/tests).
- Quality gate: `tsc --noEmit` ✅ clean · `eslint .` ✅ clean · dev server 200s ✅ · Agent Browser verification ✅ (page renders, DATABASE UP with real SELECT 1 latency, zero console errors, zero page errors, desktop 1108px + mobile 390px screenshots verified, footer sticks/pushes correctly) · dev.log free of errors.
- Commit: `feat(phase-0): architecture, database design, api design, battle model, security model, roadmap + schema + api infra + status console`.

Stage Summary:
- Phase 0 exit criteria met: schema validates & pushes; typecheck/lint clean; `/` renders verified console; `/api/health` returns real DB probe.
- Key decisions recorded: Next.js Route Handlers as REST layer with framework-agnostic game core; PostgreSQL-first Prisma schema (SQLite sandbox only); JWT session via `jose` over next-auth for Telegram initData; lazy-tick world without cron; ledger-first economy; deterministic replayable battles with configVersion snapshots; post-MVP tables schema-ready from day one.
- Awaiting user approval to begin PHASE 1 (Database & Authentication: migrations, Telegram initData verification, session JWT, middleware, logger, rate limiter, player bootstrap).

---
Task ID: 0-b
Agent: Z.ai Code (orchestrator — senior team role)
Task: PHASE 0 (revision) — expand architecture into the full 12-view master specification, precise roadmap; no major implementation

Work Log:
- Re-inspected repository per instruction: clean tree at commit 9bb5825, 6 docs, api infra + types + health + console from 0-a, server healthy (db up, 1ms probe).
- Rewrote docs/ARCHITECTURE.md as v2.0 MASTER with the 12 requested views (system, frontend, backend, database, telegram, authentication, battle, economy, notification, admin, security, deployment) + folder structure + hard module/dependency boundaries + cross-cutting strategy summary table. v1.0 preserved in git history.
- New deep-dive documents:
  - FRONTEND_ARCHITECTURE.md — single-route SPA shell, component layering, TanStack/Zustand split, query-key taxonomy + invalidation matrix, serverTime-anchored timers, Telegram SDK wrapper contract, UX/perf budgets, i18n (fa/en), a11y.
  - BACKEND_ARCHITECTURE.md — runtime model, module dependency rules (engine purity contract), request lifecycle, 3-class error handling strategy, structured logging strategy, multi-layer caching strategy (Redis-ready, stampede-safe), phased WebSocket strategy (polling now, socket.io mini-service :3003 later, polling as permanent fallback), optional WORKER mode.
  - TELEGRAM_ARCHITECTURE.md — webhook+long-poll pipeline, 9 command surface, /start payload grammar (referrals/campaigns), deep-link grammar, Mini App lifecycle contract, notification delivery queue with throttling + mute prefs, Telegram-specific security rules, explicit MVP non-goals.
  - AUTHENTICATION.md — identity model, Flow A initData HMAC verification sequence (mermaid), Flow B env-guarded dev impersonation, Flow C admin login with allowlist, guard/failure code map, secrets summary.
  - ECONOMY_ARCHITECTURE.md — principles, money types, SIX canonical transaction flows with sequence diagrams (production collect, upgrade spend, training+upkeep, battle loot transfer, market escrow fill, admin adjust), invariant table + enforcement, faucets/sinks inflation model, anti-exploit map.
  - ADMIN_ARCHITECTURE.md — separate admin JWT + allowlist, console modules with safety rails, exploit-response runbook, MVP non-goals.
- BATTLE_MODEL.md extended: authoritative 12-step mermaid sequence flow (client→API→service tx→engine→apply→notify) + March state machine with CAS resolver exclusivity (sweep/reconcile/worker idempotent vs each other) + attack-incoming early warning note.
- ROADMAP.md rewritten as precise roadmap: per-phase task breakdowns with acceptance criteria, effort sizing (S/M/L), dependency graph (incl. parallelization notes: P9 core can start after P1, P8 panels ship incrementally), top-6 risk register with mitigations.
- README doc table updated to the full 12-view set (12 documents incl. API_DESIGN).
- Quality gate re-run: eslint ✓ tsc ✓ /api/health returns healthy/db up ✓. No production code changed in this revision (docs-only) per "no major implementation" instruction.

Stage Summary:
- Phase 0 now satisfies the expanded deliverable list: all 12 architectures, folder structure, module+dependency boundaries, entities+relationships (DATABASE_DESIGN ERD), initial API endpoints (API_DESIGN), WebSocket/caching/error/logging strategies, logical ERD, complete battle flow, economy transaction flows, precise roadmap.
- Consistency kept with already-merged Phase 0 code (error codes ↔ errors.ts, envelope ↔ response.ts, endpoints ↔ API_DESIGN, schema ↔ prisma/schema.prisma).
- Awaiting approval for PHASE 1 (Database & Authentication).

---
Task ID: 1
Agent: Z.ai Code (orchestrator — senior team role)
Task: PHASE 1a — Project Foundation (TypeScript · lint · formatter · env config · error handling · logging · API structure · frontend/backend structure · testing infra · git config · production build)

Work Log:
- Hardened tsconfig: removed `noImplicitAny:false` override (strict now fully applies), added `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, target ES2022.
- ESLint v2: re-enabled `@typescript-eslint/no-unused-vars` (with ^_ escape hatch) + `prefer-const`/`no-var`/`no-unreachable`; added import-boundary enforcement per ARCHITECTURE.md — UI layer (app pages/providers, components, features, stores, hooks) cannot import lib/db, lib/bot, engines, services, lib/health, config/env; `lib/game/engine/**` purity rule (no db/api/auth/bot/prisma/next-server). Fixed 3 real violations this surfaced (unused vars in page.tsx / game-state.ts; use-toast value-only const converted to type).
- Prettier 3.9.6 installed; `.prettierrc.json` (no-semi, single-quote, w100) + `.prettierignore` (docs/md/public/db/skills excluded); `format` + `format:check` scripts; whole src/tests/config tree formatted.
- Config layer: `src/config/env.ts` — Zod-validated env (DATABASE_URL required; NODE_ENV/LOG_LEVEL enums with defaults; JWT_SECRET ≥32; ADMIN_TELEGRAM_IDS parsed to number[]), pure testable `loadEnv()` + cached `getEnv()`/`getEnvSafe()`, fail-fast ConfigError with issue list; `src/config/app.ts` client-safe constants (APP_NAME/VERSION/PHASE). Updated `.env.example` with LOG_LEVEL.
- Logging: `src/lib/logger/index.ts` — structured single-line JSON contract from BACKEND_ARCHITECTURE.md (level,time,module?,requestId?,playerId?,msg,durationMs?,err), level threshold from LOG_LEVEL, child loggers, deep redaction (token/secret/password/authorization/initData/cookie/apiKey), error serializer, timer() helper, injectable sink for tests.
- Error handling upgraded: `response.ts handle()` now logs request-complete (info) with requestId/method/path/status/durationMs, expected AppError → warn, unknown → error + generic 500; adds `x-response-time-ms` header. `ErrorDetails` made recursively JSON-safe so validation issues can travel in envelopes.
- API structure: `src/lib/api/route-handler.ts` — `defineRoute({body?,query?}, fn)` uniform adapter: JSON parse → Zod validate → typed ctx → handle(); `zodErrorToAppError` (issues with path+message); `parseJsonBody` (empty→undefined, malformed→VALIDATION_ERROR). Health route + new `/api` index rebuilt on the factory.
- Backend module pattern: `src/lib/health/` (health.types.ts + health.service.ts + barrel) as the reference module; `/api/health` is now a thin adapter; version/phase constants come from config (no hard-coded values in routes).
- Frontend structure: `src/app/providers.tsx` (TanStack Query with sensible defaults, wired into layout); `src/features/system/` slice (types + useHealthQuery with 15s polling + barrel); `src/stores/ui.store.ts` (Zustand auto-refresh slice); `src/types/api.ts` type-only re-exports; console page refactored off useEffect-fetch onto the feature hook + store (real wiring, no dead code).
- Testing infra: `tests/unit/` — 25 tests across logger (levels/bindings/redaction/timer), errors (status map/factory), env (valid/invalid/parse/freeze), route-handler (zod mapping, JSON parse). `tests/e2e/api-smoke.test.ts` — real-server contract tests (envelope shape, x-request-id, db probe, `/api` index, page HTML) with top-level-await reachability probe (describe.skipIf captures at registration — beforeAll was too late; found & fixed).
- Git hygiene: `.gitattributes` (eol=lf normalization, binaries, lockfile -diff); **untracked `.env` and `db/custom.db` which were previously committed** (secret-hygiene violation — user rule "no secrets in repo"); added `/db/*.db*` ignores.
- Production build: removed `typescript.ignoreBuildErrors` from next.config.ts (build now typechecks for real), reactStrictMode on; `bun run build` green; standalone server smoke-tested on :3100 (health db up, /api index, / 200) then shut down; dev server restarted.
- Scripts finalized: dev, build, start, test (bun test tests/unit/), test:e2e, lint, typecheck, format, format:check (+ db:* kept). package.json renamed to `warlords`@0.2.0.
- Docs synced: ROADMAP.md — new `PHASE 1a — Project Foundation ✅` contract table, old Phase 1 → `PHASE 1b`, quality gate extended with build+tests; ARCHITECTURE.md boundary note marked enforced; README status + scripts + source-layout updated.
- Quality gate (all green): format:check ✓ · eslint ✓ · tsc ✓ · unit 25/25 ✓ · e2e 3/3 ✓ · `next build` ✓ (typed, standalone) · dev.log zero errors · Agent Browser: desktop + mobile 390px rendered, DATABASE UP real latency, auto-refresh toggle OFF→"UP · PAUSED" (polling stops) ON→"DATABASE UP" (polling resumes, fresh requests in dev.log), sticky footer OK, zero console/page errors.

Stage Summary:
- Phase 1a exit criteria met: project foundation is production-grade — strict TS, boundary-enforcing lint, formatter, Zod env config layer, structured logging, uniform route factory, module pattern, feature/store-based frontend skeleton, unit+e2e infrastructure, hardened git, and a typechecked standalone production build.
- Key decisions: zero new runtime deps (logger & tests are bun-native); bun test instead of vitest (tests/ excluded from tsc, transpiled by bun); `handle()` logs every request (ops-ready JSON in dev.log); `.env` untracked from history going forward (file removed from index only — content was a local sqlite path, no live secrets).
- Awaiting approval for PHASE 1b (Database & Authentication): x-request-id middleware + security headers, baseline migration, initData HMAC verify, session JWT, auth endpoints, rate limiter, catalog seeds, player bootstrap.

---
Task ID: 2
Agent: Z.ai Code (orchestrator — senior team role)
Task: PHASE 2 — Database Foundation (PostgreSQL-first schema → migration → seeds → transactional bootstrap → invariant verification)

Work Log:
- Audited the 45-model Phase 0 schema against the user's 31-model contract. Gap analysis: 25 existed as-is; 6 table renames applied (resource_wallets→resources, unit_types→units, inventory_items→inventory, leaderboard_snapshots→leaderboards, game_events→events, admin_audit_logs→audit_logs); 1 new model (AdminUser → admin_users, explicit admin registry with identity kept on User); model rename UnitType→Unit with FK field unitTypeId→unitId rippled through PlayerUnit/TrainingQueueItem.
- Relation hygiene sweep (all documented in schema header policy): explicit onDelete everywhere — Cascade for owned instance data (units/quests/buildings/notifications/memberships), Restrict for history & ledgers (battles attacker, market orders/transactions, audit actor) and for catalog FKs (unit/item/tech/quest/commander/achievement — soft-disable via isActive, never hard delete), SetNull for optional soft refs (battle defender/territory/boss, march target, territory owner/city, clan-war winner, event target). Fixed one semantic bug: Battle.attacker was Cascade (would destroy battle history on player delete) → Restrict.
- Timestamps: createdAt on every table; updatedAt (@updatedAt) added to all 13 mutable tables that lacked it (PlayerQuest, TrainingQueueItem, March, Battle, ClanMember, ClanWar, MarketOrder, Season, Leaderboard, WorldBoss, GameEvent, Announcement, catalogs, Territory, Clan, CommanderEquipment).
- Indexes added: units(class,tier), technologies(branch,tier), quests(type,sortOrder), player_units(unitId), territories(ownerPlayerId), marches(territoryId), market_transactions(buyer/sellerPlayerId+createdAt), leaderboards(seasonId), seasons(status,endsAt), events(targetPlayerId), players(seasonPoints).
- Baseline migration cut on a fresh dev DB: prisma/migrations/20260829175821_baseline/migration.sql (committed); `prisma migrate dev` + generate green; scripts db:migrate / db:migrate:deploy added, db:push removed (migrate is canonical now).
- Data-driven content layer created — src/lib/game/config/: units.ts (6 units T1–T2, counter triangle Infantry▸Cavalry▸Ranged▸Infantry, 2000–2500 bps), technologies.ts (4 techs incl. prerequisite chain iron_sharpening→advanced_steel), quests.ts (MAIN×3 chain + DAILY×2 repeatables, typed OBJECTIVE_TYPES/REWARD_KEYS), achievements.ts (×4), items.ts (×4), starter.ts (starter wallet/energy/17 buildings/20 militia+10 archers/starter quests/Season 1/dev fixtures), barrel index.ts. Zero balance numbers in logic.
- Transactional sensitive-operation reference implementation: src/lib/game/services/player-bootstrap.service.ts — bootstrapPlayer(tx, …) creates player + wallet + 5 ledger faucet rows (BOOTSTRAP reason, balanceAfter chain) + city + 17 starter buildings + starter army + starter quests (targets read from DB catalog inside tx, hard-fails if catalogs missing) + welcome notification in ONE transaction. Caller owns the tx; seed uses it today, auth reuses it next phase.
- Idempotent seed pipeline: prisma/seed.ts (db:seed + prisma.seed config) — catalog upserts from config, Season 1 ACTIVE, dev admin (env ADMIN_TELEGRAM_IDS precedence), 2 dev players via bootstrapPlayer. Proven idempotent: second run bootstraps 0 players.
- DB invariant verifier: scripts/db-verify.ts (db:verify) — V1 ledger Σdelta==wallet per resource + balanceAfter running-chain check, V2 per-player completeness (wallet/city/17 buildings/ledger/quests/army), V3 in-DB config reference integrity (unit counters, quest prereqs), V4 catalogs non-empty, V5 coordinate uniqueness. Result on seeded DB: ✓ all hold, ledger reconciles exactly.
- Tests: tests/unit/config.test.ts — 20 invariant tests over the config catalogs (unique ids, positive costs/stats, valid enums, counter/prereq reference resolution incl. cycle detection, MAIN chain ordering, starter kit consistency). Suite now 45/45 green.
- Consistency fixes found during review: Player.leaderboardSnapshots type updated to Leaderboard[]; stale comments (unitTypeId) updated; seed JSON fields bridged to Prisma InputJsonValue via typed json() helper; removed a dead variable flagged by lint in db-verify.
- Console/docs: page.tsx phase list renumbered to user phases (00/01/02 COMPLETE, "03? Auth & Player Bootstrap" NEXT) — caught & fixed a duplicate React key bug introduced by the renumber (all planned rows shared id '—'); browser-verified zero console errors after fix. ROADMAP.md: PHASE 2 contract table + old 1b retitled "PROPOSED NEXT (awaiting user phase number)". README: status/scripts/structure. DATABASE_DESIGN.md: implemented-section with 31-table mapping, cascade policy, migration & tx patterns.
- Quality gate: prisma validate ✓ · migrate dev ✓ · generate ✓ · db:seed ✓ (idempotent) · db:verify ✓ · tsc ✓ · eslint ✓ · prettier ✓ · 45 unit ✓ · 3 e2e ✓ · next build ✓ (typed, standalone) · dev server healthy (db up, v0.3.0-phase2) · Agent Browser desktop+mobile ✓ zero console errors.

Stage Summary:
- Phase 2 exit criteria met: the 31-table contract is migrated, seeded, invariant-checked, and proven in a production build; PostgreSQL remains the deploy target (SQLite = sandbox driver only; PG baseline procedure documented in DATABASE_DESIGN.md).
- Key decisions: table names = user contract, Prisma model names = domain-clear; Restrict-vs-Cascade semantics protect history; catalogs soft-disable (isActive) and are never referenced with Cascade; bootstrap service is THE single transactional player-creation path (seed + future auth); balance lives only in src/lib/game/config.
- Awaiting approval for the next phase (proposed: Authentication & Player Bootstrap — initData HMAC, session JWT, auth endpoints, rate limiter, middleware).
