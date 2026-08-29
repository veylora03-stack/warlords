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

## PHASE 1a — Project Foundation ✅ (current)

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

## PHASE 2 — Database Foundation ✅ (current)

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

## PROPOSED NEXT — Authentication & Player Bootstrap (M) *(phase number awaits user assignment)*

**Goal: a Telegram user opens the app and becomes a persisted, session-backed player.**

Tasks:
1. `x-request-id` middleware (+ security headers) — logger itself already shipped in Phase 1a (`src/lib/logger`)
2. Prisma baseline migration (`prisma migrate dev --name baseline`) — commit migration files
3. `lib/auth/verify-init-data.ts` — official Telegram HMAC verification (constant-time) + freshness
4. `lib/auth/session.ts` — JWT sign/verify (`jose`), cookie set/clear, sliding refresh; Zod for auth bodies
5. `POST /api/v1/auth/telegram` (+ rate limit) → upsert user → bootstrap tx: player + wallet + city (x,y) + 17 starter buildings + first quests assignment
6. `POST /api/v1/auth/dev-impersonate` (env-guarded, audited) + `POST /api/v1/auth/logout`
7. `lib/rate-limit` sliding window (per user+group) wired into middleware helper
8. Seed pipeline: catalog tables from `game/config` (idempotent upsert) — initial config files for buildings/units baseline
9. Mini App shell v0: boot → initData handshake → session store → HUD skeleton + tab nav placeholder
10. `GET /api/v1/player/me` projection (behind session)

Acceptance: browser dev-impersonate creates real User+Player rows; reload keeps session; banned fixture user gets `BANNED`; rate limiter trips with 429; ledger has bootstrap rows (starter resources).

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
