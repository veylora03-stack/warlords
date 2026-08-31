# WARLORDS — FINAL PRODUCTION REPORT (Phase 27)

> Date: 2026-08-31 · Scope: whole project, release readiness audit.
> Method: full-repo inspection (55 API routes · 16 services · 54 tables enumerated),
> complete test matrix, live browser journey verification, real-timer release
> journey test, production build + standalone smoke evidence (Phase 26).
> **No new features were added.** The only code changes are: one release-acceptance
> test suite, console metadata (version/phase rows), and test-expectation fixes.

---

## 1. VERDICT — honest, per the release contract

> ### 🟡 CONDITIONALLY READY — infrastructure READY, game content NOT complete.
>
> **The platform is release-grade.** Authentication, player bootstrap, city,
> economy, army training, seasons, notifications, the admin panel, security
> hardening and the deployment stack all carry working-software evidence:
> 589 green tests, a real-timer end-to-end release journey, live browser
> verification, a production build and a smoke-tested standalone server.
>
> **The game is not yet a complete MMO for real players.** The PvP core
> (battle engine), quests, market, clans, technology, commanders/equipment,
> spy, diplomacy, world boss and the world map are **not implemented** — they
> exist as schema + admin inspection surfaces awaiting their roadmap phases.
> Launching to real players *tomorrow* would ship a polished economy/city/
> army/season sandbox with no combat.
>
> **Recommendation:** do not market-launch until the Battle Engine (Phase 8)
> and the remaining player systems ship. If a closed technical alpha of the
> current loop is the goal, the deployment guide (DEPLOYMENT.md) is a
> checklist away from go-live.

Evidence chain: `bun run build` ✓ (standalone) · 589/589 tests ✓ ·
`db:pg:validate` ✓ · Agent-Browser live journey ✓ (zero console errors) ·
Phase 26 standalone smoke (/health /ready /auth 401 /webhook 401 /real
Telegram round-trip) ✓ · worklog Phases 0–27.

---

## 2. THE 27-AREA RELEASE MATRIX

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | **Telegram Bot** | ✅ PRODUCTION-READY | Webhook pipeline (constant-time secret, bounded read, Telegram-native status contract) · 5 real commands · `telegram:setup/--status/--delete` · Phase 26 smoke hit the REAL Bot API |
| 2 | **Telegram Mini App** | ✅ READY (console-grade UX) | initData HMAC login wired end-to-end · signed-in game surface (player/wallet/ledger/city/army/season/notifications) · web_app button from bot · polished consumer UX still pending (see limitations) |
| 3 | **Authentication** | ✅ | Official HMAC-SHA256 initData verification · DB-backed JWT sessions · replay defense · transport hardening · 107 tests (Phase 3) |
| 4 | **Player creation** | ✅ | Transactional bootstrap (user+player+wallet+city+starter kit) · journey-tested live |
| 5 | **City** | ✅ | 17-building catalog · lazy-tick timers · queue 1/1 gate verified LIVE (typed `BUILDING_QUEUE_BUSY`) |
| 6 | **Resources** | ✅ | Ledger-first (Σdelta==balance invariant · V-verified) · caps/headroom server-computed · read-only HTTP |
| 7 | **Buildings** | ✅ | Server-side upgrade/finish · exact debits asserted · early-claim 409 · TownHall requirement gating verified LIVE |
| 8 | **Army** | ✅ | 11 units · data-driven counters · FIFO training queue (22 s/unit) · cancel policy refund · upkeep |
| 9 | **Battle** | ❌ NOT IMPLEMENTED | Models + admin inspection only; no player route (journey test records the evidence) — blocks release |
| 10 | **Quests** | ❌ CATALOG ONLY | 5 quests seeded, prerequisite graph validated; no player-facing claim/progress API |
| 11 | **Ranking** | ✅ | Live season ranking (deterministic tie-break) · tiers · materialized history |
| 12 | **World** | ❌ MODEL ONLY | territories schema present; no map API |
| 13 | **Clan** | ❌ ADMIN-INSPECT ONLY | models + admin roster/disband; no user clan APIs |
| 14 | **Market** | ❌ MODEL ONLY | market_orders/transactions schema; no user APIs |
| 15 | **Commander** | ❌ MODEL ONLY | catalog table; no user APIs |
| 16 | **Equipment** | ❌ MODEL ONLY | items/inventory schema; no user APIs |
| 17 | **Technology** | ❌ CATALOG ONLY | 4 techs seeded; no player research API |
| 18 | **Spy** | ❌ MODEL ONLY | spy_missions (post-MVP-ready design); no APIs |
| 19 | **Diplomacy** | ❌ MODEL ONLY | diplomacy_relations schema; no APIs |
| 20 | **Events** | ✅ ADMIN / ❌ PLAYER | Admin create/finish/cancel/list + announcements fan-out shipped; no player event feed yet |
| 21 | **World Boss** | ❌ MODEL ONLY | world_bosses schema; no APIs |
| 22 | **Seasons** | ✅ PRODUCTION-READY | Lifecycle state machine · points · tiers · EXACT tier payouts through the ledger · transactional settlement (at-most-once) · permanent progression + titles |
| 23 | **Notifications** | ✅ PRODUCTION-READY | Queueable engine · dedupe by event identity · claim-safe worker (multi-instance safe) · Telegram channel · inbox + idempotent mark-read (journey-tested) |
| 24 | **Admin Panel** | ✅ | RBAC (admin/moderator) · audited operations · players/ban/resources · economy · battles/clans/events inspection · announcements broadcast · audit viewer · staff · season settle (typed confirmation) · 1,429-line live admin UI |
| 25 | **Security** | ✅ AUDITED | Phase 23: 15 fixes across auth/CAS/claim-guard/rate-limits/transport; 33 dedicated regression tests; secrets scan clean (re-verified Phase 26/27) |
| 26 | **Database** | ✅ | 54 tables · 49+ indexes · 6 applied migrations (SQLite dev) · committed PG baseline (54 tables · 82 indexes, additive-only) · invariant verifier incl. WAL self-heal · schema-parity regression test |
| 27 | **Deployment** | ✅ (validated, not yet live-hosted) | Multi-stage Dockerfile (non-root · HEALTHCHECK) · /health + /ready · migrate-deploy workflow · bot setup tooling · compose parity stack · complete DEPLOYMENT.md |

Legend: ✅ shipped with evidence · ❌ pending its roadmap phase (honest, not hidden).

---

## 3. CRITICAL USER JOURNEY — VERIFIED END-TO-END

`Telegram → /start → PLAY → Mini App → Authentication → Create Player → City
→ Collect Resources → Upgrade Building → Train Army → [Attack → Battle Result
→ Reward] → Ranking`

- `tests/integration/deploy/release-journey.test.ts` — **8/8 PASS** in one
  continuous session: bot `/start` answers with greeting + **PLAY** web_app
  button → initData exchange bootstraps player/city/wallet (starter gold
  asserted exactly) → `/auth/me` → city roster (≥10 buildings) → resources +
  ledger (bootstrap faucet is a real ledger row) → **REAL 12 s** Farm
  construction (exact debit, early-claim 409, +20 season points) → **REAL 22 s**
  swordsman training (exact debit, early-claim 409, roster 20→21) → live
  season standing 22 pts and present in the LIVE ranking → CONSTRUCTION_COMPLETE
  + TRAINING_COMPLETE delivered to the inbox → mark-read idempotent.
- **Attack Player → Battle Result → Reward: not executable** — recorded as
  evidence in the test (`no battle route exists`), consistent with §2 #9.
  The Reward step exists for season rewards (ledger-verified, Phase 20) and
  will attach to battle payouts when the engine ships.
- **Live browser run (Agent-Browser)** — anonymous console → dev session →
  SIGNED IN → started a Town Hall upgrade through the UI → second upgrade
  correctly refused with visible `BUILDING_QUEUE_BUSY (1/1)` → claimed the
  matured construction via the FINISH button → MY SEASON POINTS 20 · rank #1 →
  notification bell 1 unread → mark-all-read → 0 unread → mobile 390 px (no
  horizontal scroll, footer pushes naturally) → **zero console errors**.

---

## 4. BUG REGISTER

### Critical bugs
**None open.** No critical product defect was found in this audit.

### Medium bugs
**None open.**

### Low bugs / issues resolved during this phase
| ID | Severity | Finding | Disposition |
|---|---|---|---|
| L-1 | low | `.gitignore` `.env*` glob silently excluded `.env.example` from version control | **FIXED (Phase 26)** — `!.env.example` negation; template now tracked + tested |
| L-2 | low | Phase 25 report recorded schema.prisma L156 as corrupted (`@@index(onor])`) | **NOT A DEFECT** — hexdump proved a sandbox terminal display ghost (`([h` rendered as `(o`); real bytes always valid; regression test now locks `players_honor_idx` |
| L-3 | low | Notification-queue integration tests can race the live dev server's worker when both drain the shared dev DB | **Test-infra only** — product claims are atomic (count===1); suites pass standalone; documented here for CI guidance (run suites against a dedicated DB or accept the rare retry) |

### Test-expectation corrections made in Phase 27 (product untouched)
Release-journey authoring corrected five wrong assumptions in the NEW test
itself (response field names `resources`/`entries`/`units`/`unreadCount`,
training window = 22 s per unit, starter roster = 20 swordsmen). The product
 behaved correctly in every case — the E2E suite had already locked the true
contracts.

---

## 5. SECURITY STATUS — READY

- Telegram initData HMAC (official algorithm), replay-window enforcement, DB-backed JWT sessions with sliding refresh.
- **NEVER TRUST THE CLIENT holds everywhere audited**: server-side pricing, timers, queue gates, RBAC; read-only HTTP for resources.
- Ledger-first economy with balance-guarded debits, cap-clamped credits, CAS guards (credits, XP) and DB-level conditions that survive multi-instance PostgreSQL.
- Phase 23 audit: transport hardening (64 KiB body cap, foreign-Origin rejection, typed 413), principal-keyed rate limits, staff-ban rails, claim-guarded delivery, admin confirmation phrases — each with regression tests.
- Secrets: none in repo/history (scanned again today); dev `.env` carries labeled placeholders only; production secrets via platform stores.
- Logging redacts sensitive keys; webhook logs carry no message content.
- Honest limitations: in-memory rate limiter is per-process (global limits need a shared store at multi-instance scale); limiter shared bucket for unknown-IP callers (documented in Phase 23 report).

## 6. PERFORMANCE STATUS — MEASURED, ADEQUATE FOR MVP

- Phase 25 capacity ladder (harness committed): ~100 concurrent players
  zero-error on sandbox hardware; 122× write-collapse fix (dedicated write
  engine); state N+1 17→7 queries; memoized catalogs; WAL mode.
- Live check today: db probe 1–4 ms; console interactions snappy under the
  full test-load history of the dev DB.
- Production target (200 players) rests on PostgreSQL + container deployment
  (§8) — the SQLite numbers are the floor, not the ceiling.

## 7. QUALITY GATES — ALL GREEN (today)

| Gate | Result |
|---|---|
| `bun run typecheck` | ✓ clean |
| `bun run lint` | ✓ clean |
| `bun run format:check` | ✓ clean |
| `bun run test` (unit) | ✓ **294/294** |
| `bun run test:integration` | ✓ **265/265** (incl. NEW release-journey 8/8) |
| `bun run test:e2e` (real server) | ✓ **30/30** |
| **Total** | **589 tests · 0 failures · ~10.6k assertions** |
| `bun run build` | ✓ standalone (compiled 8 s, 40/40 pages) |
| `db:pg:validate` + `db:verify` | ✓ |
| Agent-Browser live UI journey | ✓ zero console errors |

## 8. DEPLOYMENT STATUS — ARTIFACTS READY, HOSTING PENDING

- Docker multi-stage image (non-root, HEALTHCHECK) — built from this exact tree config; first platform deploy is the remaining proof.
- Probes `/health` (liveness) + `/ready` (readiness, 503-gates deploys) — smoke-verified on the standalone server (Phase 26).
- Migrations: committed additive PostgreSQL baseline; `migrate deploy` only; schema-parity test blocks drift.
- Telegram: one-command webhook/commands/menu-button setup with status/rollback.
- DEPLOYMENT.md: platform walk-throughs (Render/Railway/Koyeb/Vercel + Supabase direct-vs-pooled URLs), go-live checklist, rollback switch.
- **Not yet done (honest):** no live Supabase/Render/Vercel account has been
  provisioned from this sandbox — DNS, TLS and the first real `migrate deploy`
  against production are operator steps.

## 9. KNOWN LIMITATIONS (the honest list)

1. **Game content scope** — battle/quests/market/clan/tech/commander/equipment/spy/diplomacy/world-boss/map are not implemented (see §2). The release is a verified foundation, not the full design.
2. **Mini App UX** — the functional game console is developer-grade (dense panels, dev hints); a consumer-grade themed UI, deep-link routing (battle/clan/quest payloads) and the map view are pending.
3. **Single-region / single-writer assumptions** — SQLite dev serializes writes (by design, mutex+engine isolation); PostgreSQL removes the single-writer but global rate limits still need a shared store.
4. **Notifications channel** — Telegram push is at-least-once with bounded retries; in-app inbox is the durable surface. Delivery requires the real bot token at runtime (sandbox placeholders make channels SKIP/FAIL honestly, never fake success).
5. **Bot command surface** — only the five data-backed commands are advertised; `/quests /clan /invite /settings` arrive with their systems (router falls back to help; nothing fabricated).
6. **Observability** — structured JSON logs + probes exist; metrics dashboards/alerting are not wired (listed as next step).
7. **Test-runtime note** — real-timer journey tests take ~30–80 s by design; CI should use a dedicated database to avoid the L-3 drain race.

## 10. RECOMMENDED NEXT STEPS (priority order)

1. **Battle Engine (roadmap Phase 8)** — the missing core of the journey (attack → rounds → result → loot/rewards → notifications). Models, admin inspection and the notification plumbing already exist for it.
2. **Player-facing quests & technologies** — catalogs are seeded and validated; add claim/progress APIs + panels to convert content into gameplay.
3. **Consumer-grade Mini App UI** — themed game client (mobile-first), deep-link routing per TELEGRAM_ARCHITECTURE §4, map view once territories ship.
4. **Provision production** — Supabase project + one container platform; run the DEPLOYMENT.md checklist end-to-end; schedule backups/PITR.
5. **Observability** — ship JSON logs to a drain; alert on `/ready` 503s, queue depth, and `_prisma_migrations` drift.
6. **Global rate limiting** (multi-instance) — shared store when scaling beyond one instance.
7. **Clans & market** — social/economy layers after battle; admin inspection surfaces already cover them.

---

*Report generated as the Phase 27 exit artifact. Every ✅ above traces to a
named test, a live verification, or a committed command run today; every ❌ is
a roadmap fact, not a hidden gap.*
