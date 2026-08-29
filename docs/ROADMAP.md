# WARLORDS — Development Roadmap (Precise)

> Working agreement: every phase ends with the **quality gate** + commit + worklog entry + written report.
> "Done" = lint ✓ typecheck ✓ runtime-verified (browser/API where applicable) ✓ honest report ✓.
> Effort keys: S = one focused session · M = 2–3 sessions · L = multi-session build.

---

## 0. Quality Gate (every phase, non-negotiable)

```
1. bun run lint                → 0 errors
2. bun run typecheck           → 0 errors
3. bun run build               → production build green (typechecked, no ignoreBuildErrors)
4. bun run test / test:e2e     → all green
5. dev server boots            → no fatal errors in dev.log
6. runtime verification        → Agent Browser golden path + API real-data checks
7. git commit                  → conventional, one logical change-set
8. worklog.md                  → append Task section
```

---

## PHASE 0 — Architecture & Planning ✅

| # | Task | Status |
|---|---|---|
| 0.1 | Repo inspection + baseline commit | ✅ |
| 0.2 | 12-view architecture set (this doc tree) | ✅ |
| 0.3 | Prisma schema — 45 entities, validated + pushed | ✅ |
| 0.4 | Domain type contracts (`src/lib/game/types`) | ✅ |
| 0.5 | API envelope + AppError taxonomy + health probe | ✅ |
| 0.6 | Phase console page (verified desktop/mobile) | ✅ |
| 0.7 | Repo hygiene: README, .env.example, typecheck script | ✅ |

**Exit criteria met.** No further implementation until Phase 1 approval.

---

## PHASE 1a — Project Foundation ✅

| # | Task | Status |
|---|---|---|
| 1a.1 | TypeScript hardened: `noImplicitAny` on, `noImplicitOverride`, `noFallthroughCasesInSwitch`, ES2022 target | ✅ |
| 1a.2 | ESLint: unused-vars/const rules on + **import-boundary enforcement** (UI↛db/bot/engine, engine purity) per ARCHITECTURE.md | ✅ |
| 1a.3 | Prettier 3 + `.prettierrc` + `.prettierignore` + `format` / `format:check` scripts | ✅ |
| 1a.4 | Env config layer `src/config/env.ts` — Zod-validated, fail-fast, pure `loadEnv` (tested); client-safe constants `src/config/app.ts` | ✅ |
| 1a.5 | Structured logger `src/lib/logger/` — levels, child bindings, redaction, timers; wired into API envelope `handle()` | ✅ |
| 1a.6 | Route factory `src/lib/api/route-handler.ts` — Zod body/query validation → envelope; health module `src/lib/health/` as reference module pattern | ✅ |
| 1a.7 | Frontend structure: `app/providers.tsx` (TanStack Query), `src/features/system/` slice, `src/stores/ui.store.ts` (Zustand), `src/types/` barrels | ✅ |
| 1a.8 | Testing infra: `bun test tests/unit/` (25 tests) + `tests/e2e/` API smoke vs real server | ✅ |
| 1a.9 | Git hygiene: `.gitattributes`, `.env` + `db/*.db` **untracked** (secret-leak fix), db ignores | ✅ |
| 1a.10 | Production build: `ignoreBuildErrors` removed, `reactStrictMode` on, standalone build verified end-to-end | ✅ |
| 1a.11 | Scripts: `dev build start test test:e2e lint typecheck format format:check` | ✅ |

**Exit criteria met.** Awaiting approval for Phase 1b.

---

## PHASE 2 — Database Foundation ✅

| # | Task | Status |
|---|---|---|
| 2.1 | Schema reviewed & aligned to the 31-table contract: renames (`resources`, `units`, `inventory`, `leaderboards`, `events`, `audit_logs`), new `admin_users`; `UnitType→Unit` model rename + `unitTypeId→unitId` | ✅ |
| 2.2 | Relation hygiene across all models: explicit FKs (FKs, indexes, unique constraints, cascade rules, timestamps) — Cascade for owned data, Restrict for history/catalogs, SetNull for soft refs; `updatedAt` on every mutable table | ✅ |
| 2.3 | Baseline migration committed (`prisma/migrations/…_baseline`); `db:migrate`, `db:migrate:deploy` scripts; `db:push` removed (migrate is canonical) | ✅ |
| 2.4 | Data-driven content config: `src/lib/game/config/` (6 units w/ counter triangle, 4 technologies, 5 quests, 4 achievements, 4 items, starter kit, Season 1) | ✅ |
| 2.5 | Idempotent seed pipeline (`db:seed` + `prisma.seed`): catalogs, season, dev admin, 2 dev players | ✅ |
| 2.6 | Transactional player bootstrap service (`bootstrapPlayer`): player+wallet+ledger+city+17 buildings+army+quests+notification in ONE tx — reused by auth in the next phase | ✅ |
| 2.7 | `db:verify` invariant checker: ledger Σdelta==wallet + balanceAfter chain, per-player completeness, config reference integrity, coord uniqueness | ✅ |
| 2.8 | 20 new config-invariant unit tests (45 total), seed idempotency proven (2nd run = 0 duplicates) | ✅ |

**Acceptance evidence:** migrate+generate ✓ · db:seed ✓ (idempotent) · db:verify ✓ ledger reconciles exactly · tsc/lint/build/test green.

---

## PHASE 3 — Telegram Authentication ✅

| # | Task | Status |
|---|---|---|
| 3.1 | `src/lib/telegram/init-data.ts` — Telegram-official HMAC-SHA256 verification (secret = HMAC("WebAppData", bot token); sorted data_check_string; constant-time compare), `auth_date` freshness (`TELEGRAM_AUTH_MAX_AGE_SECONDS` default 24h, 300s skew), 8 KiB bound, signed-`user` shape validation; single `INVALID_INIT_DATA` 401 code with `details.reason` taxonomy | ✅ |
| 3.2 | `src/lib/auth/` — session config (`resolveAuthConfig` → AUTH_NOT_CONFIGURED 503 when secrets missing), JWT HS256 via `jose` (`sub`=userId, `sid`=session row id, `role` observability-only), cookie/bearer transport (`wl_session` HttpOnly+SameSite=Lax, Secure in prod), sha256 digest helpers | ✅ |
| 3.3 | Transactional session service: user upsert (telegramId identity) → ban check (BANNED 403) → expired-session cleanup → replay resolution → `auth_sessions` row (sha256 initDataHash unique, sha256 tokenHash unique) → `bootstrapPlayer` on first login — ONE tx; per-request `authenticate` re-reads role/ban from DB | ✅ |
| 3.4 | Routes: `POST /api/v1/auth/telegram` (Bearer token + cookie, `replayed` flag), `GET /api/v1/auth/me` (DB-fresh identity + sliding refresh within 48h of expiry), `POST /api/v1/auth/logout` (server-side revocation + cookie clear), `POST /api/v1/auth/dev-impersonate` (Flow B: rate-limit → prod 404 gate → ADMIN_SECRET constant-time → allowlist → audited) | ✅ |
| 3.5 | Authorization guard `requireAuth(request)` composed into protected routes — deliberately NO Next.js edge `middleware.ts` (edge runtime cannot run Prisma; ban check must hit DB on every request) | ✅ |
| 3.6 | `src/lib/rate-limit` — in-memory sliding window, Redis-ready `RateLimitStore` interface, shared per-process store; auth group 10/min per IP enforced BEFORE verification work; 429 `RATE_LIMITED` with `retryAfterSec` | ✅ |
| 3.7 | Env: `TELEGRAM_AUTH_MAX_AGE_SECONDS` (default 86400) + `SESSION_TTL_SECONDS` (default 604800); `JWT_SECRET` + `TELEGRAM_BOT_TOKEN` required in production (fail-fast), dev → 503; `.env.example` updated | ✅ |
| 3.8 | Tests: 84 unit (initData 23 · jwt 6 · rate-limit 8 · config 20 · env 9 · errors 7 · logger 7 · route-handler 4) + 16 integration (full route→DB auth flow) + 7 e2e smoke — covering the 7 attack scenarios: valid auth · invalid hash · expired · missing/malformed · manipulated user data · replay attempt · unauthorized API access (+ ban, revocation, dev-impersonate guards) | ✅ |

**Replay policy (key decision):** a replayed identical initData re-attaches to the SAME `auth_sessions` row (unique `initDataHash`) and rotates its token hash — no session farming, old token invalidated immediately, legit network retries never lock users out; fresh initData (new `auth_date`) mints a new session. Rationale documented in SECURITY.md §6.

**Quality gate:** lint ✓ · typecheck ✓ · unit 84 ✓ · integration 16 ✓ · e2e 7 ✓ · build ✓.

---

## PHASE 4 — Player System ✅

| # | Task | Status |
|---|---|---|
| 4.1 | Data-driven XP/Level curve `src/lib/game/config/leveling.ts` — tuning surface `LEVELING {maxLevel: 30, baseXp: 100, growthBps: 1200}` (12%/level, floored integer compounding); derived once at module load: `XP_REQUIRED_PER_LEVEL`, `CUMULATIVE_XP_BY_LEVEL`, `MAX_TOTAL_XP`; pure `resolveLevelProgress` (level/xpIntoLevel/xpForNextLevel/progressBps) + `applyXpGain` (levelsGained/leveledUp/atMaxLevel, XP clamped at cap — never wasted) | ✅ |
| 4.2 | Power-from-state `src/lib/game/config/power.ts` + `services/power.service.ts` — all-bps/integer weights (unit attackBps 10000 · defenseBps 10000 · healthBps 5000 · tierBonusBps 2000; per-type `buildingWeight` for the 17 building types; per-branch `techBranchWeight`); pure `computeUnitBasePower/StackPower/computeBuildingPower/computeTechPower`; `computePlayerPower` aggregates army stacks × DB unit catalog + buildings × levels + researched tech levels (catalogs read from the seeded DB mirror, never config directly); `recalculatePlayerPower` is the ONLY write path for `Player.power` — clients can never set/push/adjust it, a tampered column heals on the next recalculation | ✅ |
| 4.3 | Statistics catalog + service `src/lib/game/config/stats.ts` + `services/stats.service.ts` — 12 typed counters in 3 categories (COMBAT: battlesWon/battlesLost/attacksLaunched/defensesWon/unitsTrained/unitsLost · ECONOMY: resourcesCollected/resourcesPlundered/resourcesSpent · PROGRESSION: buildingsConstructed/technologiesResearched/questsCompleted); read path normalizes any stored JSON against the catalog (unknown dropped, missing zero-filled, non-conforming zeroed); write path `recordPlayerStats` is append-only positive-integer deltas (VALIDATION_ERROR for unknown keys, INVALID_AMOUNT otherwise) — counters never decrease | ✅ |
| 4.4 | Lazy-tick energy `src/lib/game/config/energy.ts` + `services/energy.service.ts` — `ENERGY {max: 100, regenAmount: 1, regenIntervalSec: 300}`; `computeEnergyState` resolves whole elapsed ticks, preserves partial-tick progress by advancing the anchor exactly by consumed intervals, re-anchors at the cap; `syncPlayerEnergy` persists ONLY when changed (common case = one SELECT) and exposes `nextRegenAtMs` for UI countdowns | ✅ |
| 4.5 | Race-safe registration `services/player-registration.service.ts` — `ensurePlayer(tx, …)` idempotent (existing players short-circuit; unique-race loser re-attaches to the winner's row) + `sanitizePlayerName` (control-char strip, 32-char cap); `withRegistrationLock` in-process promise-chain mutex serializes registration txs; `withWriteRetry` bounded backoff (25/50/100/200/400 ms) for Prisma P2002 unique races + transient SQLite write contention (P1008/BUSY); generous `REGISTRATION_TX_OPTIONS {maxWait: 10s, timeout: 20s}`; `runRegistrationTransaction` composes lock → retry → tx. `issueSession` (auth) wraps the WHOLE login transaction the same way — a retried or concurrent login can never fork a second player | ✅ |
| 4.6 | Routes: `GET /api/v1/player/profile` · `GET /api/v1/player/statistics` · `GET /api/v1/player/state` — protected by the new `requirePlayer` guard (`requireAuth` + player-presence; session without a bootstrapped player → `PLAYER_NOT_FOUND` 404); BigInt amounts (xp/power/honor/gems/wallet) serialize as strings; **power is computed FRESH on every projection**, energy lazily synced before projection; `/api` index lists the player surface | ✅ |
| 4.7 | Bootstrap hardening + frontend — `bootstrapPlayer` now zero-fills `Player.stats` from the typed catalog and calls `recalculatePlayerPower` as its final step (initial power is derived, never hand-set); `src/features/player/` slice (exact DTO mirror types + 3 TanStack Query hooks, 401 → `null` anonymous state); Player System console card renders live profile/statistics/state data | ✅ |
| 4.8 | Tests: 35 new unit (leveling 13 · power 10 — incl. the exact documented starter power 3810 · energy 6 · stats 6) + 24 new integration through real route handlers + DB (authorization 401s on all 3 paths; first-login chain exact starter values incl. power **3810 = 2130 army + 1680 buildings**; duplicate registration idempotency; 6× parallel `ensurePlayer` and 5× parallel first logins converging on ONE player; XP grants → level-up `RANK_CHANGE` outbox notification + cap clamp; `INVALID_AMOUNT` rejections; statistics write validation; energy lazy regen with partial-tick carry + cap) + 3 e2e player-smoke over live HTTP (401 guard contract + full exchange → profile → state → statistics flow) | ✅ |

**Starter power baseline (asserted by unit + integration tests):** 20 militia + 10 archers → army **2130**; 17 starter buildings at level 1 → **1680**; total **3810** (technologies 0).

**Quality gate:** lint ✓ · typecheck ✓ · format ✓ · unit 119 ✓ · integration 40 ✓ · e2e 10 ✓ · build ✓ · browser-verified.

---

## PHASE 5 — Resource & Economy Engine ✅ (current)

| # | Task | Status |
|---|---|---|
| 5.1 | Data-driven economy config `src/lib/game/config/economy.ts` — the ONLY place economy balance numbers live: six canonical resources `ECONOMY_RESOURCES` (GOLD · WOOD · IRON · FOOD · CRYSTAL wallet five + premium GEMS); per-resource `RESOURCE_CAPS` as BigInt literals (GOLD 5e9 · WOOD/IRON/FOOD 2.5e9 · CRYSTAL 1e9 · GEMS 1e8 — tightest on purpose); `MAX_DELTA = 1e15` hard single-mutation ceiling (any \|delta\| above rejected `INVALID_AMOUNT` before any math); `ECONOMY_HISTORY {defaultPageSize: 25, maxPageSize: 100}`; `GRANT_IDEMPOTENCY_TTL_SECONDS 86400` (24h); closed `LEDGER_REASONS` catalog (BOOTSTRAP · QUEST_REWARD · BUILDING_UPGRADE · UNIT_TRAINING · BATTLE_REWARD · MARKET_PURCHASE · MARKET_SALE · ADMIN_ADJUSTMENT — unknown reasons rejected at the write path); pure helpers `creditWithCap` (clamps at cap, returns the applied delta) · `debitBalance` (refuses below zero) · `isEconomyDelta` / `isPositiveAmount` | ✅ |
| 5.2 | Ledger-first write path `services/economy.service.ts` — `applyResourceDeltas(tx, playerId, deltas, meta)` is THE single server-side mutation: validate-ALL-then-write in the caller's transaction (unknown resource/reason → `VALIDATION_ERROR`; non-BigInt/zero/oversized delta → `INVALID_AMOUNT`; duplicate resource in one batch → `VALIDATION_ERROR`); debits beyond balance → typed 409 `INSUFFICIENT_<RESOURCE>` (`details {needed, have}`) with NOTHING written; debits persist via conditional compare-and-decrement (`updateMany where field >= amount`) — the DB-level no-negative guarantee independent of locks; credits clamp at the configured cap and the CLAMPED delta is what the ledger records (Σdelta==balance preserved); a fully-capped credit applies 0 → no wallet write, NO ledger row (`skipped` flag); the storage split (five fields on the `resources` wallet, GEMS on `Player.gems`) flows through the SAME `resource_transactions` ledger | ✅ |
| 5.3 | Idempotent grants — `grantResources` (positive BigInt amounts only; optional `idempotencyKey` ≤128 chars) claims an `IdempotencyKey` row (`action: 'resource_grant'`, sha256 `requestHash` of {playerId, reason, ref, amounts}) committed in the SAME transaction as the payout (`responseBody` = serialized result, `expiresAt` = now + 24h); replay within the TTL returns the ORIGINAL result with `replayed: true`; same key with a different payload → 409 `IDEMPOTENT_REPLAY`; a concurrent duplicate losing the unique race → 409 `IDEMPOTENT_REPLAY` (caller re-issues into the replay path); the key rolls back with the payout if the tx fails; `spendResources` = positive cost BigInts → all-or-nothing debits | ✅ |
| 5.4 | Race-safety layers (documented honestly): (a) per-player in-process FIFO mutex `src/lib/concurrency/mutex.ts` — keyed promise chains, error-isolated (a failing section never poisons the chain), idle-key eviction, deliberately NOT reentrant; (b) interactive-tx atomicity (wallet + ledger + side effects all-or-nothing); (c) conditional-decrement guard = the no-negative invariant holds even multi-process; (d) bounded transient retry (`withWriteRetry` — SQLite BUSY/P1008); (e) unique idempotency keys = duplicate-proof grants. `runEconomyTransaction(playerId, run)` = `withKeyLock('wallet:{playerId}')` → `withWriteRetry` → `db.$transaction` under `ECONOMY_TX_OPTIONS {maxWait: 10s, timeout: 20s}`. PostgreSQL production note: cross-process serialization swaps in `SELECT … FOR UPDATE`/advisory locks — the in-process mutex is per-process | ✅ |
| 5.5 | Audited admin adjustments — `adminAdjustResources` (standalone; runs in its OWN serialized transaction; requires `actorUserId` + note 1–500 chars; signed deltas) writes an `audit_logs` row (`ADJUST_RESOURCES`, before/after balance maps, note) in the SAME transaction; ledger rows carry `metadata {actorUserId, note}`; overdraft refused — an untracked adjustment is structurally impossible | ✅ |
| 5.6 | Read APIs (GET-only, behind `requirePlayer` with Bearer-or-`wl_session` + sliding-refresh Set-Cookie parity with the other player routes): `GET /api/v1/player/resources` → `{playerId, resources[{key, balance, cap, headroom}] ×6 canonical order, updatedAt}` — all amounts BigInt-as-strings, caps/headroom from config so clients render without authority math; `GET /api/v1/player/transactions?limit&cursor&reason` → `{entries[{id, resource, delta, balanceAfter, reason, refType, refId, metadata, createdAt}], nextCursor, hasMore}` — newest first, keyset pagination on (createdAt, id), cursor `"<ISO createdAt>|<id>"`, reason filter validated against the catalog, limit 1–100 default 25, Zod-validated query (invalid → 400 `VALIDATION_ERROR`); only the authenticated player's OWN rows are reachable (playerId from the principal, never input); `/api` index lists both endpoints | ✅ |
| 5.7 | Frontend — `src/features/economy/` slice (exact DTO-mirror types + `useResourcesQuery`/`useTransactionsQuery` hooks, 401 → `null` anonymous state, staleTime 5s) + console "Resource & Economy Engine" card (LEDGER LIVE state: six wallet rows with balance/cap progress bars + resource ledger newest-first with signed colored deltas and reason chips + explanatory invariant footer). Console roadmap: Phase 5 COMPLETE, Phase 6 proposed | ✅ |
| 5.8 | Tests: 20 new unit (config invariants incl. six keys / caps below the ceiling / reasons catalog · `creditWithCap`/`debitBalance` boundary math · predicates · mutex FIFO/parallel/error-isolation/eviction) + 25 new integration over real routes+DB (isolated 9100005… telegramId range, cleaned in afterAll) covering the six required scenarios — negative resource (typed 409 + nothing written; spend-to-zero allowed, then the next debit fails; non-BigInt/zero/oversized rejected; unknown resource/reason/duplicate batch rejected) · duplicate reward (idempotent replay pays once; different payload rejected; distinct keys independent; malformed key rejected) · concurrent update (12 parallel mixed ops converge exactly; 3 contended 1000-gold debits on a limited balance → exactly 1 winner + 2 `INSUFFICIENT_GOLD`; parallel GEMS credits reconcile; ledger reconcile helper asserts Σdelta==balance and balance ≥ 0 for every resource) · overflow (grant to 4e9+1500 clamps exactly at the 5e9 GOLD cap with correct `appliedDelta`; at-cap grant writes nothing) · unauthorized (GET-only module surface — route exports exactly `['GET']`; anon/garbage 401 matrix for both endpoints; strict per-player isolation; `PLAYER_NOT_FOUND` for unknown players) · rollback (mixed batch with one impossible debit persists nothing; crash-after-grant leaves zero ledger+idempotency residue and a retry works fresh) + audited `ADMIN_ADJUSTMENT` + history API (newest-first, string amounts, cursor walk without skips/repeats, reason filter, invalid params 400) + 3 new e2e over live HTTP (401 guard matrix, `/api` index entries, full exchange→wallet→history positive flow when `TELEGRAM_BOT_TOKEN` present) | ✅ |

**Economy invariants (enforced in code, proven by tests):** balances can never go negative (validate-then-write + conditional compare-and-decrement) · credits clamp exactly at the resource cap and record the clamped delta so **Σ(ledger delta) == balance** reconciles per resource regardless of storage target · every delta carries a reason from the closed catalog · wallet + ledger + side effects commit or roll back atomically · the economy HTTP surface is deliberately GET-only — no client write path exists anywhere; every mutation flows through the economy service inside server-owned transactions.

**Quality gate:** lint ✓ · typecheck ✓ · format ✓ · unit 139 ✓ · integration 65 ✓ · e2e 13 ✓ · build ✓ · browser-verified (desktop 1280px + mobile 390px).

---

## PHASE 6 — City & Building System (user-assigned) — ✅ COMPLETE

**User contract:** City System — 17 buildings each with level · upgrade cost · duration · requirements · effects; server-side upgrades (resources checked, requirements checked, resource transaction created, upgrade state recorded); double-spending prevented; construction system with start time / finish time / status; full tests; build/test/typecheck/lint + commit.

| # | Task | Status |
|---|---|---|
| 6.1 | Building catalog (src/lib/game/config/buildings.ts) — all 17 canonical types, data-driven: maxLevel 15 (CASTLE 11 — TH ≥ target+4 chain), per-level upgrade cost via INTEGER-only bps recurrence (`compoundBps`, floor multiply — no floats), duration growth bps, requirements (Town Hall gate `max(floor, L−offset)` · player level for TH · cross-building gates ARMORY→BARRACKS, SPY_CENTER→SCOUT_CENTER), typed effects (productionPerHour GOLD/WOOD/IRON/FOOD linear per level · warehouse storageCapacity 20k+15k·(L−1) · wall defenseBps · TH queueSlots ×2 at TH10 · training/research/equipment/scout/spy speed bps · hospital beds · castle march slots · market fee decay) + pure materializers (`upgradeCostFor` · `upgradeDurationSecFor` · `upgradeRequirementsFor` · `effectsFor` · `constructionQueueSlots` · deterministic `materializeBuildingCatalog`) | ✅ |
| 6.2 | City service (src/lib/game/services/city.service.ts) — THE single construction write path: tx-scoped cores (`startBuildingUpgradeInTx` / `finishBuildingUpgradeInTx`) + standalone wrappers on `runEconomyTransaction` (per-player wallet mutex). Upgrade order: type→catalog · in-flight guard · max-level guard · requirements evaluated from REAL DB state inside the tx (typed `PREREQUISITE_MISSING` with details.missing[]) · queue-slot count vs `constructionQueueSlots(TH)` · cost debited via `spendResources(reason BUILDING_UPGRADE, refType building, metadata from/to/duration)` · timer claimed with conditional updateMany guarded on `isConstructing=false`. Finish: server clock is the only timing authority (`CONSTRUCTION_NOT_COMPLETE` + remainingSec) · conditional level application guarded on in-flight state → `CONSTRUCTION_COMPLETE` notification → `recalculatePlayerPower` — one transaction, retries typed `CONSTRUCTION_NOT_ACTIVE` | ✅ |
| 6.3 | Read models — `getCityView` (17 buildings in catalog order with derived status IDLE·CONSTRUCTING·COMPLETABLE + effects + nextUpgrade preview with server-evaluated requirementsMet/unmetRequirements[], aggregate production sums, warehouse storage, queue activeCount/queueSlots) · `getBuildingCatalogView` (fully materialized 17×levels catalog, costs as display strings per BigInt policy) | ✅ |
| 6.4 | APIs — GET /api/v1/city · GET /api/v1/city/buildings · POST /api/v1/city/buildings/:type/upgrade · POST /api/v1/city/buildings/:type/finish behind defineRoute + requirePlayer; `defineRoute` extended ADDITIVELY with Zod-validated dynamic `params` (Next.js Promise params, backward compatible); new typed error codes: BUILDING_NOT_FOUND 404 · MAX_LEVEL_REACHED 409 · CONSTRUCTION_IN_PROGRESS 409 · CONSTRUCTION_NOT_COMPLETE 409 · CONSTRUCTION_NOT_ACTIVE 409; /api index lists all four | ✅ |
| 6.5 | Frontend — src/features/city slice (DTO-mirror types + useCityQuery with in-flight 3s polling + useBuildingCatalogQuery + useUpgradeBuildingMutation/useFinishBuildingMutation with cross-surface invalidation city·wallet·ledger·player) + console "City & Building System" card (capital/production/storage summary, per-building rows with level, status badges, live countdown tick, cost+duration+requirement preview, UPGRADE/FINISH actions, inline typed error surfacing incl. details.missing); roadmap/deliverables/footer → Phase 6; APP_VERSION 0.7.0-phase6 | ✅ |
| 6.6 | Tests: 26 new unit (config invariants: 17 types exact, max levels, monotonic integer costs/durations, first-upgrade affordability vs starter wallet, requirement reachability ≤ LEVELING.maxLevel / ≤ BUILDING_MAX_LEVEL, castle TH-chain, armory/spy cross-building gates, TH player-level gate, linear effect growth, queue-slot thresholds, market fee floor, bps compounder determinism, empty L1 cost, isBuildingType guard) + route-handler params tests (Promise params pass-through · default empty · Zod rejection 400 · static-route backward compat) + 25 new integration over real routes+DB (isolated 9100007… range): upgrade happy path (exact catalog debit, per-resource BUILDING_UPGRADE ledger rows with building ref + metadata, timer ≈ now+duration, reconcile invariant) · same-building/different-building queue refusals · INSUFFICIENT_GOLD zero-writes · SPY_CENTER prerequisite details · MAX_LEVEL_REACHED · unknown type 404 · early finish NOT_COMPLETE + remainingSec · finish claim (level+timer clear+power delta exactly TH/FARM weight+notification) · claim retry NOT_ACTIVE · 5 parallel finishes → 1 winner · 8 parallel same-building upgrades → 1 winner + exactly-once debit · 2-building queue race · crash-mid-start rollback (cost+timer+ledger zero residue) · crash-mid-finish rollback (level/power/notification untouched) · 401 matrix + verb-surface export check · cross-player isolation + 3 new e2e (guard matrix · /api index · deterministic positive construction cycle on a fresh per-run identity with in-flight claim helper) | ✅ |
| 6.7 | Quality gate: lint ✓ · typecheck ✓ · format ✓ · unit 165 ✓ · integration 90 ✓ · e2e 16 ✓ · dev.log clean (only expected typed-refusal warns) · sandbox rule respected (`bun run build` intentionally NOT run — compile validity proven by tsc strict + all routes exercised live on the dev server by e2e; production build deferred to the deployment phase) · browser-verified: anonymous → dev-impersonate → city card live (17 buildings, TH-gated buttons, aggregates) → TH upgrade (wallet 1500→1100 Au / 800→550 Wd, queue 1/1, BUILDING_UPGRADE ledger pair, countdown) → READY badge (3s poll flip) → FINISH → lv2/15 + power 4,010 + notification + 0/1 queue · desktop 1280px + mobile 390px screenshots · sticky footer intact · zero console errors | ✅ |

**City invariants (enforced in code, proven by tests):** every amount/duration/requirement/effect comes from server config — the client supplies only a type name · requirements are evaluated against REAL DB state inside the upgrade transaction · the cost debit and the construction claim share ONE per-player-serialized transaction with the economy service's validate-ALL-then-write + conditional decrement as the double-spend backstop · the construction claim is a conditional UPDATE guarded on the idle state (mutex backstop) · the finish claim is guarded on the in-flight state and applies the level at most once · the server clock is the only timing authority · power is recalculated from real state on completion (never hand-set).

**Deferred from the original city block (not in the Phase 6 user contract):** `POST .../cancel` (refund policy) · `GET /city/collect` (production accrual lazy-tick — rates already computed + exposed). Both are first-class candidates for the economy/world phases.

**Awaiting approval for PHASE 7 — Army & Training** (unit training queue, army composition, hospital/casualties — original plan block below).

---

## Phase plan (original numbering — superseded by user-assigned phases above; contract tables are the source of truth)

> Deferred from the original auth proposal, still open: Mini App shell v0 (boot → initData handshake → HUD skeleton). The `GET /api/v1/player/me` projection landed in Phase 4 as the three `/api/v1/player/{profile,statistics,state}` endpoints; the ledger/economy core of the original "Phase 2" block below (ledger-first write path, idempotent grants, race-safe debits) landed in Phase 5.

## PHASE 2 — Player, Resources & Economy Core (M)

Tasks: reconciler service (`reconcilePlayerState`) · collect endpoint (ECONOMY §3.1) · warehouse capacity model · energy regen · XP/level/power progression engine · ledger query endpoint · notifications outbox + unread badge + mark-read · BigInt→string serialization audit on all responses · UI: HOME panel (resources, energy, level, quick collect) + PROFILE basics.
**Acceptance:** fuzz endpoint with concurrent collects → no negative/over-cap/double-credit (verified via repeated parallel requests); ledger balances reconcile exactly.

## PHASE 3 — City & Buildings (M)

Tasks: full building config (17 types, costs/durations/effects/prereqs per level) · upgrade/cancel endpoints (ECONOMY §3.2) · production & capacity effects by level · CITY panel with live countdowns + cost display + queue state.
**Acceptance:** full TOWN_HALL→unlock chain works; timers complete via reconciler; cancel refunds per policy; prerequisites enforced (attempts → `PREREQUISITE_MISSING`).

## PHASE 4 — Army (S)

Tasks: unit catalog config (10 units, counters as data) · train/cancel endpoints (ECONOMY §3.3) · upkeep in production math · ARMY panel (roster, queue, counters info).
**Acceptance:** training completes into player_units; food net-rate reflects upkeep; cannot train without barracks level; cost math matches config exactly.

## PHASE 5 — Battle Engine (L) — MVP core

Tasks: `game/config/battle.ts` (BattleConfig v1) · seeded PRNG util · pure `simulate()` per BATTLE_MODEL §3 · march service (create/resolve/cancel, CAS status transitions per §8) · attack/scout endpoints + early-warning notification · protection rules · loot/honor/reputation application (ECONOMY §3.4) · reports + round viewer panel · replay endpoint + integrity self-check · scout reports TTL.
**Acceptance:** two fixture accounts fight; same seed replays byte-identical; all validation paths return exact codes; concurrent attack on same units cannot double-commit (CAS proven); defender shield respected.

## PHASE 6 — Quests, Ranking, World & Clan Basics (L)

Tasks: quest engine (objective hooks) + main/daily assignment + claim (idempotent) · achievements · tech tree config + research endpoints · world map generation (seeded territories around player cities) + viewport endpoint + fog of war · territory capture (PvE) · leaderboard snapshots + rankings endpoint (cached) · clan CRUD + roles + join/leave + chat table (polling) · bot dispatcher wired to outbox.
**Acceptance:** fresh player guided by MAIN quests to first attack; rankings match `players.power` ordering; viewport hides unscouted intel; clan role rules enforced (officer-only invite etc.).

## PHASE 7 — Telegram Bot (M)

Tasks: webhook adapter + secret verification · dev long-poll runner · command handlers (9 commands) · referral attribution + rewards · notification delivery queue (per-user throttle, mute prefs, deep-link buttons) · `/settings` inline keyboard.
**Acceptance:** real bot (dev token) round-trips: /start → open app → attack → both players get bot alerts; referral credit granted once (idempotent).

## PHASE 8 — Mini App UI (full client) (L)

Tasks: all panels to production polish per FRONTEND_ARCHITECTURE (city view, world map viewport, battle reports cinematic summary, commander roster, inventory/equip, quests center, rankings with pagination, clan screens, settings, onboarding FTUE) · i18n fa/en · haptics/theme/BackButton wiring · virtualized long lists · dynamic panel loading.
**Acceptance:** every P2–P7 feature usable at 390px; 60fps scroll on rankings/ledger; sticky footer correct; zero console errors; fa + en switch clean.

## PHASE 9 — Admin Panel (M)

Per ADMIN_ARCHITECTURE: admin auth + allowlist · player search/inspect · ban/unban · adjust-resources (idempotent) · economy overview (mint/burn) · battle inspection + replay verify · announcements · event controls · audit viewer.
**Acceptance:** every mutation visible in audit log with before/after; impersonated admin cannot escalate beyond allowlist.

## PHASE 10 — Security Hardening & Verification Pass (M)

Tasks: permission-matrix exercise script (attack spam, negative amounts, cross-user ids, clan role escalation, replay/cooldown bypass, idempotency replay, shield dodge attempts) · economy invariant sweep (ledger reconciliation endpoint) · rate-limit tuning · error-code contract audit · headers/CSP pass · secrets audit.
**Acceptance:** scripted abuse run produces only expected codes; ledger reconciles to zero discrepancy; findings fixed or filed with severity.

## PHASE 11 — Deployment Prep (S)

Tasks: PG migration baseline vs Supabase + CHECK constraints · env manifest finalization · Vercel config + standalone build verification · bot webhook registration procedure + runbook · backup/restore runbook · staging smoke checklist.

## PHASE 12 — Load Testing (S)

Tasks: 33-CCU scenario script (collect/build/train/attack mix, realistic think-times) · measure p95 latency per endpoint class · bottleneck report (expected: DB pool, sweep contention) · index verify + fix · rate-limit headroom check.

## PHASE 13 — Polish & Balance (M)

Tasks: economy tuning via config (no code) · FTUE polish · UI polish pass · season 0 dry-run · final security review · release tagging.

---

## Dependency Graph

```
P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 ──► P7
 │      │      │      │      │      └─► P8 (UI full client)
 │      │      │      │      └────────► P6 needs battle results for quests/rank
 └───── P9 (needs users/audit from P1; richer inspection grows with P2–P6)
        P10 (needs P5 economy+battle surfaces; pre-deploy)
        P11 → P12 → P13 (deployment chain)
```

Parallelization notes: P9 core (auth+player inspect) can start once P1 lands; P8 panels land incrementally per phase (each phase ships its panel) — P8 as a phase is the *polish/integration* pass, not the first appearance of UI.

## Risk Register (top risks → mitigation)

| Risk | Impact | Mitigation |
|---|---|---|
| SQLite dev vs PG prod behavior drift (locks, Json) | late surprises | PG-first schema, tx shapes documented, Phase 11 staging on Supabase before launch |
| Deterministic engine regressions | replay integrity | replay-verify endpoint + sweep in P5/P10; configVersion snapshots |
| Economy exploits (dupes, negative) | economy death | ledger-first + in-tx re-reads + idempotency + P10 abuse script |
| Telegram webview quirks (background JS) | missed timers UX | server-anchored lazy-tick (truth never depends on client being online) |
| Sandbox single-port constraint | realtime limits | polling MVP; socket.io mini-service only when justified (P6+) |
| Scope creep (post-MVP systems) | MVP never ships | ROADMAP is the contract; post-MVP backlog stays out of phases 1–9 |
