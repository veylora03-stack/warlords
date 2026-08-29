# WARLORDS — Development Roadmap & Phase Contracts

> Working agreement: every phase ends with a **quality gate** and a **commit**, then a written report. "Done" = build ✓ typecheck ✓ lint ✓ runtime-verified ✓ (browser/E2E where applicable).

---

## 0. Quality gate (applies to EVERY phase)

```
1. bun run lint          → 0 errors
2. bun run typecheck     → 0 errors
3. bun run dev (or build for release) → server boots, no fatal in dev.log
4. Runtime verification  → Agent Browser: page renders, golden-path interactions work,
                           API returns real data, no hydration/console errors
5. git commit            → conventional message, one logical change-set
6. worklog.md            → append section (Task ID, what/why/decisions)
```

## 1. Phase contracts

### PHASE 0 — Architecture & Repository Setup ✅ (current)
Deliverables: docs set (architecture, DB design, API design, battle model, security, roadmap) · full Prisma schema · domain type contracts · API envelope/error infrastructure · health endpoint · repo hygiene (README, .env.example, gitignore, typecheck script) · baseline commits.
Exit criteria: schema validates against DB driver; typecheck/lint clean; `/` renders the phase console; `/api/health` returns real DB probe.

### PHASE 1 — Database & Authentication
Prisma migrate baseline · Telegram initData verification (`WebAppData` HMAC) · session JWT cookie · auth routes + dev-impersonate (guarded, audited) · middleware (request id, ban check, rate limit) · structured logger · Player+Wallet+City+starter buildings bootstrap transaction · seed pipeline for catalogs (from config) · Mini App shell boots into session.
Exit: opening the app in Telegram (or dev impersonation) creates a real User+Player and the session persists across reloads.

### PHASE 2 — Player, Resources & Economy Core
Lazy-tick reconciler · collect endpoint · warehouse capacity · ledger writes on every delta · energy regen · XP/level/power progression service · notifications outbox + polling · transactions history UI panel.
Exit: resources accrue, collect is capped and ledgered, no negative-balance path reachable via API fuzzing.

### PHASE 3 — City & Buildings
Config-driven building catalog (17 types) · upgrade flow (cost/requirements/queue slot/timers) · cancel policy · production & storage effects of levels · city UI panel with live timers.
Exit: full upgrade chain Town Hall → others works with prerequisites; timers complete via reconciler.

### PHASE 4 — Army
Unit catalog (10 types, 4 classes) · training queue (cost/time/upkeep) · cancel policy · upkeep affecting food accrual · army UI panel.
Exit: training completes into `player_units`; food drain visible and ledgered.

### PHASE 5 — Battle Engine (MVP core)
Pure battle engine per BATTLE_MODEL.md · march/attack/scout endpoints · protection & cooldown rules · loot/honor/reputation application · reports + round viewer · replay endpoint · scout reports with TTL.
Exit: two dev accounts can fight; results deterministic (same seed = same outcome); replay matches original; all validations hold (shield, newbie, energy, army lock).

### PHASE 6 — Quests, Ranking & World
Quest engine + daily/weekly assignment · achievements · technology tree research · world map viewport + territories + fog of war · territory capture (PvE first) · leaderboard categories with cached snapshots · clan basics (create/join/leave/roles/chat) · notifications wired to bot dispatcher.
Exit: main quest line guides a fresh player to first attack; leaderboard reflects real power.

### PHASE 7 — Telegram Bot
Bot module (webhook + dev long-poll) · command set (/start /help /play /profile /rank /quests /clan /invite /settings) · deep links with referral tracking · notification delivery (attack incoming/result, construction/training done, clan events) with mute settings.
Exit: full loop playable from Telegram: bot → Mini App → bot alerts.

### PHASE 8 — Mini App UI (full game client)
Dark-fantasy game UI (not admin-dashboard aesthetic): bottom nav HOME·CITY·ARMY·WORLD·CLAN·QUESTS·RANKING·PROFILE · city view with buildings · map viewport · battle reports cinematic summary · commander roster · inventory · settings · onboarding flow · optimistic UI only where safe.
Exit: all features from P2–P7 usable on a phone-sized viewport; sticky footer; 60fps scrolling lists (virtualized where long).

### PHASE 9 — Admin Panel
Admin auth (secret + allowlist) · player search/inspect · ban/unban · resource adjust (idempotent, audited) · battle/economy inspection · announcements · event controls · audit log viewer.
Exit: every admin action visible in audit log with before/after.

### PHASE 10 — Security Hardening & Test Pass
Rate-limit tuning · idempotency coverage audit · permission matrix fuzzing (attack spam, negative amounts, cross-user ids, clan role escalation, replay/cooldown bypass) · economy invariants checks · replay verification sweep.
(Where the sandbox permits a test runner, suites are added; otherwise verification is executed as scripted API exercise + browser flows, reported honestly.)

### PHASE 11 — Deployment Preparation
PG-compatible migration baseline against Supabase target · env manifest · Vercel config · bot webhook registration procedure · backup/restore runbook · staging smoke checklist.

### PHASE 12 — Load Testing
Scenario scripts (33 CCU baseline: collect/build/attack mix) · bottleneck report (expected: Prisma pool + SQLite→PG delta) · index/verify plan.

### PHASE 13 — Polish & Balance
Economy tuning via config (no code) · onboarding FTUE polish · visual polish pass · season 0 dry-run · final security review.

## 2. Post-MVP backlog (architecture-ready, not yet implemented)

Market escrow · diplomacy (alliance/peace/war/trade/embargo) · spy missions & counter-intel · world boss raids with damage leaderboard · seasons & seasonal resets · full clan wars (preparation/battle phases, territory scoring) · clan research & quests · WebSocket chat via mini-service.

## 3. Git conventions

- `feat|fix|docs|refactor|chore|test(scope): imperative summary`
- One commit per logical change-set; phase exit = release-tagged commit `phase-N-complete`.
- Never overwrite unreviewed existing work; architecture changes require doc update in the same commit.
