# WARLORDS — PHASE 24 Test Coverage Report

**Role:** Senior QA Engineer · **Date:** 2026-08-31 · **Baseline:** Phase 23 (`50720e3`)

---

## 1. Executive Summary

| Metric | Baseline (Phase 23) | After Phase 24 | Δ |
|---|---|---|---|
| Unit tests | 235 | **261** | +26 |
| Integration tests | 185 | **243** | +58 |
| E2E tests | 19 | **27** | +8 |
| **Total tests** | **439** | **531** | **+92 (+21%)** |
| Failing | 0 | **0** | — |
| Typecheck (`tsc --noEmit`) | pass | **pass** | — |
| Lint (ESLint) | pass | **pass** | — |

**Verification commands:** `bun run test` · `bun run test:integration` · `bun run test:e2e` · `bun run typecheck` · `bun run lint` — all green, 0 failures, 0 skips.

**Product bugs found & fixed:** 1 (§4). **Test defects found & fixed during QA:** 6 (§5).

---

## 2. Critical Scenario Coverage Matrix

| # | Scenario | Layer(s) | Suite(s) | Status |
|---|---|---|---|---|
| 1 | **Registration** | API/E2E | `auth-flow` (scenarios 1–7), `full-journey` STEP 1 | ✅ PASS |
| 2 | **Authentication** | Unit/Int/E2E | `jwt.test`, `init-data.test`, `auth-flow`, `negative-matrix` (expired/wrong-secret/garbage tokens) | ✅ PASS |
| 3 | **City** | Int/E2E | `city-system` (upgrade/double-spend/timers/rollback), `full-journey` STEP 3–4 | ✅ PASS |
| 4 | **Resources** | Unit/Int/E2E | `economy-engine`, `economy-config`, CAS credit tests (Phase 23), `full-journey` ledger assertions | ✅ PASS |
| 5 | **Building Upgrade** | Int/E2E | `city-system` (6 required scenarios), `full-journey` STEP 4 (real 12 s timer) | ✅ PASS |
| 6 | **Army Training** | Int/E2E | `army-system`, `negative-matrix` (queue-cap race), `full-journey` STEP 5 (real 44 s batch) | ✅ PASS |
| 7 | **Battle** | — | **Not implemented as a user-facing API.** Battle models + admin read/inspection routes exist and are covered (`admin-system`: battles view; `admin-battles.service`). No user battle flow to test yet. | ⚪ N/A (documented) |
| 8 | **Rewards** | Int | **NEW `season-system`**: exact tier payout through the ledger (GOLD/CRYSTAL/GEMS), ledger reconciliation, replay = `alreadyClaimed`, concurrent claims converge on exactly one payout | ✅ PASS |
| 9 | **Quest** | Unit | **NEW `catalogs-config`**: quest graph acyclicity, prerequisite integrity, reward-key/benefit validation. (Quest *engine* API not yet implemented — data layer is validated.) | ✅ PASS (config) |
| 10 | **Ranking** | Int | **NEW `season-system`**: deterministic order (points desc, id-asc tie-break), tier boundaries 1–3/4–10/11–50, min-score filter, limit abuse → 400, settled-history leaderboard | ✅ PASS |
| 11 | **Clan** | Int | `admin-system` (typed-confirmation disband, denormalized-field clearing, list endpoints). Game-side clan API not yet implemented. | ✅ PASS (admin) |
| 12 | **Market** | — | **Not implemented as a user-facing API.** No market service/routes exist yet — nothing to test. Schema model present. | ⚪ N/A (documented) |
| 13 | **Commander** | Unit/Int | **NEW `catalogs-config`** (starter units integrity) + season settlement grants permanent/seasonal commanders (wipe assertion in settlement report). No user commander API yet. | ✅ PASS (partial) |
| 14 | **Technology** | Unit | **NEW `catalogs-config`**: prerequisite reachability, tier ordering, cost/effect domains, no negative costs (money-printing impossible) | ✅ PASS (config) |
| 15 | **Notifications** | Int/E2E | `notification-system` (queueable pipeline, dedupe, exactly-once), **NEW `season-system`** (RANK_CHANGE fan-out per ranked player), **NEW `full-journey`** STEP 7 (inbox + mark-read idempotency) | ✅ PASS |

---

## 3. Negative Testing Matrix (all NEW — `tests/integration/negative/negative-matrix.test.ts`)

| Abuse class | Verdict (server behavior) | Tests |
|---|---|---|
| **Invalid IDs** — empty / oversized / injection-flavored (`'; DROP TABLE players;--`) unit ids, unknown building types, malformed queue-item ids | Typed 400/404 envelopes, **zero writes** (wallet & queue byte-identical), Prisma parameterization blocks injection | 3 |
| **Negative amounts** — count 0 / −5 / −1 000 000 / 1.5 / NaN / 1e12 | 400 `VALIDATION_ERROR`, wallet untouched | 2 |
| **Huge amounts** — 1 000 000 passes zod but service ceiling (per-batch 1 000) refuses; list `limit` abuse → 400; garbage pagination cursor → typed 400 (never 500) | 400 envelopes | 4 |
| **Duplicate requests** — same initData replayed twice → same session (no farming); mark-read ×2 → second updates 0 | Idempotent | 2 |
| **Expired requests** — initData older than 24 h window → 401; JWT signed with attacker secret → 401; negative-TTL JWT → 401 `SESSION_EXPIRED`; DB-expired session row → 401 | 401, server clock authoritative | 4 |
| **Unauthorized requests** — 8 route families × anonymous + garbage bearer + POST trio | 401 `UNAUTHORIZED` envelope everywhere, no data leakage | 12 |
| **Concurrent requests** — 8 parallel train batches, one player | Exactly 5 win (FIFO cap), exactly 3 × `TRAINING_QUEUE_FULL` 409, money debited exactly 5× cost, wallet never negative | 1 |
| **Malformed payloads** — invalid JSON → 400; wrong-shape body (string/array) → 400; >64 KiB body → 413 `BODY_TOO_LARGE` pre-parse; foreign Origin → 403 `FORBIDDEN_ORIGIN` | Never a 500 | 4 |

Additional negative coverage added in the **season suite**: query-abuse loop (`limit` = 0/1.5/1000/NaN/−5), malformed claim bodies, pre-settlement claim refusals (404/409), unranked-player claim (IDOR impossible by composite key), title-equip ownership check (`TITLE_NOT_OWNED`), settlement RBAC + confirmation rails.

---

## 4. Product Bug Found & Fixed (reproduce → diagnose → fix → regression test)

### BUG-24/01 — Season-settle replay reports the wrong typed error
- **Reproduce:** execute `POST /api/v1/admin/season/settle/execute` twice with the same `seasonNumber`; the second call returned **409 `SETTLEMENT_NOT_PENDING`** (“seasonNumber does not match the current season”).
- **Diagnose:** after a successful settlement the *latest* season is the newly created NEXT season; the route’s belt-and-braces number check fired before the service’s at-most-once claim could report the truthful `SEASON_ALREADY_SETTLED`. The operation was safe (nothing settled twice) but the operator-facing diagnosis was misleading on the most likely mistake (re-running a completed reset).
- **Fix:** `src/app/api/v1/admin/season/settle/execute/route.ts` — when the requested `seasonNumber` exists and is settled, return **409 `SEASON_ALREADY_SETTLED`**; only otherwise `SETTLEMENT_NOT_PENDING`.
- **Regression test:** `tests/integration/season/season-system.test.ts` — “settles the ENDED season … at-most-once” asserts the replay returns `SEASON_ALREADY_SETTLED`.

### Observations verified as CORRECT (no fix needed)
- `seasonPointsForBuildingLevelUp` awards **10 × newLevel** (level-proportional) — asserted at 20 for Farm L2 (E2E STEP 4).
- Training window is **per-unit × batch size** (2 swordsmen = 44 s at Barracks L1) — asserted by the E2E real-timer claim.
- `drainNotificationQueue` default batch = 25 — the worker is designed to re-tick; test drains loop until quiescent.

---

## 5. Test Defects Found & Fixed During This Phase (QA-of-the-QA)

1. `negative-matrix`: Request helper passed raw objects as body → stringified (suite now runs).
2. `negative-matrix`: stale-initData expectation used 3 h (inside the 24 h `TELEGRAM_AUTH_MAX_AGE_SECONDS` window) → corrected to 2 days.
3. `negative-matrix`: inline identities were not tracked for cleanup → all registrations centralized in a tracked `register()` + self-healing `beforeAll` range wipe (isolation restored; repeat runs stable).
4. `negative-matrix`: `5 * 120n` BigInt/Number mix → literal `600n`.
5. `season-system`: tie-break twin polluted settlement tier counts → twin re-zeroed after the tie-break assertion.
6. `full-journey`: wrong field name (`items` → `notifications`) and bun 5 s default timeout on real-timer steps → 90 s explicit timeouts.

---

## 6. New Test Assets

| File | Type | Tests | Focus |
|---|---|---|---|
| `tests/unit/game/catalogs-config.test.ts` | Unit | 26 | Quest/Technology/Item/Achievement/Starter catalog invariants: uniqueness, acyclic prerequisite graphs, reward-key domains, positive amounts, no money-printing holes, starter-kit referential integrity |
| `tests/integration/season/season-system.test.ts` | Integration | 30 | Season view & rules, deterministic live ranking + tier boundaries + tie-break + min-score, claim refusals, **transactional settlement** (RBAC, confirmation, clock authority, tiers, wipe, next season, at-most-once, BUG-24/01 regression), **idempotent & concurrency-safe reward claims** with exact ledger reconciliation, permanent-progression grants + title-equip ownership (IDOR), RANK_CHANGE delivery, materialized history |
| `tests/integration/negative/negative-matrix.test.ts` | Integration | 28 | Cross-cutting abuse catalog (§3) |
| `tests/e2e/full-journey.test.ts` | E2E | 8 | Continuous real-session journey: register → me → city → **real 12 s construction** → ledger-exact assertions → **real 44 s training** → roster → season standing (24 pts) → ranking → notification fan-out + mark-read → state/statistics |

**Also modified (product):** `src/app/api/v1/admin/season/settle/execute/route.ts` (BUG-24/01 fix).

---

## 7. Honest Gaps (not testable today — feature work, not QA work)

1. **Battle, Market, Commander, Technology, Quest *user-facing APIs* do not exist yet** — the schema, catalogs and admin-side management exist and are tested; the player-facing flows are future phases. No test can exercise an endpoint that isn’t there.
2. **Telegram push transport** is exercised only through injected seams (`fetchImpl`) by design — no real network calls in tests.
3. **Load/performance testing** (soak, sustained RPS) is out of scope for the sandbox; concurrency correctness is covered transactionally.

---

## 8. Final Verification

```
bun run test              → 261 pass / 0 fail   (20 files)
bun run test:integration  → 243 pass / 0 fail   (10 files)
bun run test:e2e          →  27 pass / 0 fail   ( 7 files)
bun run typecheck         → clean
bun run lint              → clean
Total: 531 tests, 0 failures, 9 639 assertions
```

**Verdict: PASS.** WARLORDS is regression-hardened at 531 tests; one product bug found, fixed, and regression-locked.
