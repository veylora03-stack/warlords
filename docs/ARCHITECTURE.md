# WARLORDS — Master Architecture (12 Views)

> Version: 2.0 · Phase 0 (revised) · Supersedes v1.0 (preserved in git history)
> This is the single entry point. Each view links to its deep-dive document.
> Baseline rule: nothing in the repo is changed without a written rationale.

---

## View 1 — System Architecture

```
┌────────────────────────────── Telegram ──────────────────────────────┐
│   Bot (private chat)                    Mini App (HTTPS webview)     │
│   commands · alerts · deep links        full game UI (SPA shell)     │
└────────────┬────────────────────────────────┬────────────────────────┘
             │ Bot API (webhook/long-poll)    │ HTTPS (initData handshake)
             ▼                                ▼
┌────────────────────────── WARLORDS Deployment ───────────────────────┐
│  Caddy gateway (only exposed port)                                   │
│    └─ Next.js 16 App Router  :3000                                   │
│         ├── UI shell (single user route /)                           │
│         ├── REST /api/v1  (thin HTTP adapters — zero game logic)     │
│         ├── /api/v1/telegram/webhook  (Bot adapter)                  │
│         └── middleware: request-id · security headers · ban check    │
│                                                                      │
│  Application layer (framework-agnostic, src/lib/**)                  │
│    auth · rate-limit · cache · logger · bot                          │
│    game/services (transactions, authorization, orchestration)        │
│    game/engine  (PURE: economy · battle · quest · progress · world)  │
│    game/config  (data-driven balance: units, buildings, quests…)     │
│                                                                      │
│  Persistence: Prisma ORM → PostgreSQL (prod, Supabase) / SQLite(dev) │
│  Notification outbox → dispatcher → Bot API / in-app polling         │
└──────────────────────────────────────────────────────────────────────┘
```

**Load-bearing decisions**

| # | Decision | Rationale |
|---|---|---|
| D1 | Single Next.js deployable (UI + API) | Free-tier constraint, 33 CCU MVP; service layer keeps future extraction to Fastify/NestJS mechanical |
| D2 | Engines are pure functions (no db/clock/random) | Deterministic battles, replayability, testability |
| D3 | Ledger-first economy | Auditable, non-negative by construction, exploit forensics |
| D4 | Lazy-tick world (resolve timers on access + client 30s sweep) | No cron infrastructure; correctness first, scheduler can attach later |
| D5 | BigInt + basis-points integer math | No float rounding exploits; late-game inflation proof |
| D6 | Notification outbox | At-least-once delivery without blocking game transactions |
| D7 | Config-driven balance (`game/config`), versioned into battles | Balance patches never corrupt history or require migrations |

---

## View 2 — Frontend Architecture

Deep dive: [`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md)

- **Single user-visible route `/`** — SPA shell with bottom tab navigation (HOME · CITY · ARMY · WORLD · CLAN · QUESTS · RANKING · PROFILE); tab switch = Zustand state, not navigation (instant, preserves scroll/queries).
- **Layered components**: `app/page.tsx` (shell) → `components/layout/*` (AppShell, BottomNav, HUD, sticky footer) → `components/game/*` (feature panels) → `components/ui/*` (shadcn primitives).
- **State split**: TanStack Query = all server state (typed query-key factory, invalidation matrix); Zustand = session + navigation + UI prefs. **Client never computes game math** — it renders projections and sends command intents.
- **Telegram integration** behind a thin wrapper (`lib/telegram/client.ts`): initData, theme, haptics, BackButton, viewport — with browser-dev fallback.
- Time anchoring: every countdown uses `meta.serverTime`; device clocks untrusted.
- Mobile-first (360–440px), touch targets ≥44px, safe-area insets, dark-fantasy theme (amber/zinc, no blue/indigo), skeletons + toasts everywhere, long lists virtualized, panels lazy-loaded (`next/dynamic`) to keep first paint small.

## View 3 — Backend Architecture

Deep dive: [`BACKEND_ARCHITECTURE.md`](BACKEND_ARCHITECTURE.md)

- HTTP adapters (`src/app/api/**`) are dumb: authenticate → rate-limit → Zod-validate → call service → envelope. Zero game logic.
- Services (`game/services`) own DB transactions, authorization, and orchestration; they call pure engines and persist results.
- Engines (`game/engine`) import ONLY `game/types` + `game/config` — purity contract makes battles replayable and logic unit-testable.
- Full request lifecycle, error-handling strategy, logging strategy, caching strategy, WebSocket strategy — documented in the deep dive.

## View 4 — Database Architecture

Deep dive: [`DATABASE_DESIGN.md`](DATABASE_DESIGN.md) (ERD, 45 entities, indexes, transactions)

- Prisma ORM; PostgreSQL-first schema (Supabase prod), SQLite only as sandbox dev driver.
- 45 tables across: identity, player/economy (ledger!), city/buildings, army/marches, commanders/items, tech, world/territory, battles/rounds/reports, quests/achievements, clans/wars, market, seasons/leaderboards, bosses/events, notifications/announcements, admin/audit, idempotency, post-MVP diplomacy & spy.
- Catalog/instance split: balance data lives in catalog tables seeded from typed config — patches need no migration.
- Money/power/HP = BigInt; enums = strings validated app-side (Prisma enums unsupported on SQLite).

## View 5 — Telegram Architecture

Deep dive: [`TELEGRAM_ARCHITECTURE.md`](TELEGRAM_ARCHITECTURE.md)

- **Bot**: webhook (prod, `X-Telegram-Bot-Api-Secret-Token` verified) + long-poll worker (dev). Commands: `/start /help /play /profile /rank /quests /clan /invite /settings`. `/start` payload grammar for referrals (`ref_<playerId>`) and campaigns. Delivery queue with per-user rate limiting and mute preferences.
- **Mini App**: opened via bot button / deep link → initData handshake → session → game shell. Theme params, haptics, BackButton handled in the client wrapper.
- **Deep links**: `?startapp=` into specific screens (battle report, clan invite, quest).

## View 6 — Authentication Architecture

Deep dive: [`AUTHENTICATION.md`](AUTHENTICATION.md)

- Mini App: Telegram `initData` → HMAC-SHA256 (key `WebAppData` derived from bot token) → constant-time compare → freshness check (≤24h) → upsert User by `telegramId` → bootstrap Player → session JWT (HS256, 7d, sliding) in `HttpOnly; Secure; SameSite=Lax` cookie.
- Admin: `ADMIN_SECRET` + Telegram-id allowlist → short-TTL admin-scoped JWT.
- Dev impersonation exists **only** when `NODE_ENV !== 'production'` and is audited — never in prod builds.
- Ban check runs in middleware on every request, not only at login.

## View 7 — Battle Engine Architecture

Deep dive: [`BATTLE_MODEL.md`](BATTLE_MODEL.md) — full flow diagram + March state machine

- Pipeline: validate → commit march (units locked, energy spent) → resolve on arrival → simulate (pure, seeded) → apply (casualties, loot, honor, XP, quests) → notify both sides.
- Determinism: `simulate(seed, configSnapshot, sides)` — same inputs ⇒ byte-identical outcome; every battle stores everything needed for server-side replay verification.
- Counters, initiative, variance, terrain, walls: all basis-point values from versioned `BattleConfig` — zero hard-coded combat numbers.

## View 8 — Economy Architecture

Deep dive: [`ECONOMY_ARCHITECTURE.md`](ECONOMY_ARCHITECTURE.md) — six transaction flows with sequence diagrams

- Every mutation = single DB transaction with in-tx re-validation + ledger append (`delta`, `balanceAfter`, `reason`, `refType/refId`).
- Six canonical flows specified: production collect · building upgrade spend · unit training · battle loot transfer · market escrow fill · admin adjust.
- Faucets/sinks table for inflation control; idempotency-keys on all sensitive ops; negative balance structurally impossible.

## View 9 — Notification Architecture

```
domain event (post-commit inside service)
  → INSERT notifications (outbox; deliveredVia = IN_APP | BOT | BOTH)
  → dispatcher (in-process, debounced):
       IN_APP → client polls GET /api/v1/notifications (badge)
       BOT    → Telegram sendMessage queue (per-user 1/s, global 30/s,
                respects per-type mute prefs, deep-link button back into app)
  → delivery failure ⇒ retry with backoff, NEVER rolls back the game tx
```

Types: ATTACK_INCOMING · ATTACK_RESULT · CONSTRUCTION_COMPLETE · TRAINING_COMPLETE · QUEST_COMPLETED · REWARD · CLAN_INVITE · CLAN_WAR · WORLD_BOSS · EVENT · RANK_CHANGE.

## View 10 — Admin Architecture

Deep dive: [`ADMIN_ARCHITECTURE.md`](ADMIN_ARCHITECTURE.md)

- Separate admin-scoped JWT; RBAC: `ADMIN` ⊂ `SUPERADMIN`.
- Modules: player search/inspect · ban/unban · resource adjust (idempotent, reason-required) · battle & economy inspection (mint/burn 24h) · announcements · event controls · audit log viewer · clan/world management.
- **Every** admin mutation writes `admin_audit_logs` with before/after JSON, actor, reason, IP, requestId.

## View 11 — Security Architecture

Deep dive: [`SECURITY.md`](SECURITY.md)

- NEVER TRUST THE CLIENT — full anti-cheat matrix (what client controls vs. server derives).
- Zod on every route · per-route-group rate limits · idempotency keys · tx re-reads · referential visibility checks (fog of war) · output filtering (public profiles leak nothing).
- Secrets register + gitignore discipline; zero secrets in client bundle or logs.

## View 12 — Deployment Architecture

Deep dive: [`ROADMAP.md`](ROADMAP.md) Phase 11

| Environment | Topology |
|---|---|
| Sandbox (now) | Caddy gateway → Next.js :3000 (+ future mini-services via `?XTransformPort=`), SQLite `db/custom.db` |
| Production | Vercel (or Render/Railway single node) → Supabase PostgreSQL; bot webhook `APP_URL/api/v1/telegram/webhook`; secrets via env |
| Scale-out | + Redis (cache/locks/rate-limit/queue), worker mode (`WORKER=1`) for sweeps, read replica for leaderboards |

Env manifest: `DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL, JWT_SECRET, ADMIN_SECRET, ADMIN_TELEGRAM_IDS, NODE_ENV` (see `.env.example`).

---

## Folder Structure

```
warlords/
├── docs/                    # 12-view architecture set (this directory)
├── prisma/schema.prisma     # persistence source of truth
├── src/
│   ├── app/
│   │   ├── page.tsx                 # ONLY user-visible route (SPA shell)
│   │   ├── layout.tsx · globals.css
│   │   └── api/
│   │       ├── health/route.ts
│   │       └── v1/
│   │           ├── auth/ player/ city/ army/ battle/ world/
│   │           ├── quests/ rankings/ clans/ market/ notifications/
│   │           ├── telegram/ (webhook + dev long-poll)
│   │           └── admin/
│   ├── components/
│   │   ├── ui/              # shadcn primitives (preinstalled)
│   │   ├── layout/          # AppShell · BottomNav · HUD · StickyFooter
│   │   └── game/            # panels: city · army · world · battle · quests · clan · ranking · profile
│   ├── hooks/ stores/       # react hooks · zustand slices
│   ├── lib/
│   │   ├── db.ts            # Prisma singleton
│   │   ├── api/             # response envelope · AppError taxonomy
│   │   ├── auth/            # initData verify · session JWT · RBAC guards
│   │   ├── rate-limit/      # sliding window (memory impl, Redis-ready iface)
│   │   ├── cache/           # TTL cache + single-flight (memory impl, Redis-ready iface)
│   │   ├── logger/          # structured JSON logger
│   │   ├── bot/             # Bot API client · command handlers · delivery queue
│   │   ├── telegram/        # client-side WebApp wrapper
│   │   └── game/
│   │       ├── types/       # domain contracts (Phase 0 ✅)
│   │       ├── config/      # data-driven content + BattleConfig snapshots
│   │       ├── engine/      # PURE: economy · battle · quest · progress · world
│   │       ├── services/    # transactional application services
│   │       └── utils/       # bigint math · seeded PRNG · time
│   └── types/               # shared DTO re-exports
├── mini-services/           # optional realtime (socket.io) — Phase 6+
├── worklog.md               # append-only engineering journal
└── .env.example
```

## Module & Dependency Boundaries (hard rules)

```
app/api (HTTP adapter) ──┐
lib/bot (Bot adapter) ───┤→ lib/auth · lib/rate-limit · lib/api → game/services → game/engine → game/config · game/types
                         │                                  └→ lib/db (services ONLY)
game/engine ── imports NOTHING but game/types + game/config  (purity contract: no db, no clock, no Math.random)
lib/cache · lib/logger · lib/rate-limit ── leaf infra, imported by any layer, import nothing game-*
components/** ── never import lib/db, lib/bot, or engines; UI talks to /api/v1 only
```

Violations = review-blocking. (Enforced since Phase 1a via `no-restricted-imports` in `eslint.config.mjs`: UI layer cannot import db/bot/engine/services; engines cannot import db/adapters.)

## Cross-Cutting Strategies (summary — details in BACKEND_ARCHITECTURE.md)

| Concern | Strategy |
|---|---|
| Errors | 3 failure classes: expected (AppError→envelope), unexpected (catch-all→log+500 generic), infra (degrade & retry; never block game tx). Stable machine codes = client contract. |
| Logging | Single-line structured JSON: `level,time,requestId,playerId?,module,msg,durationMs,err`. No initData/tokens/full-IP. Audit truth lives in DB ledgers, not logs. |
| Caching | L1 in-memory TTL + single-flight (leaderboards 30s, viewport 10s, catalogs process-lifetime) behind Redis-ready interface · TanStack Query client cache · API responses no-store · stampede-safe. |
| WebSocket | MVP: 30s polling sweep (sufficient for 33 CCU). Phase 6+: socket.io mini-service :3003 behind gateway (`/?XTransformPort=3003`) for clan chat, live boss HP, march alerts — JWT handshake, rooms `player:{id}`/`clan:{id}`/`boss:{id}`, polling always preserved as fallback. |
| Realtime scheduler | Optional `WORKER=1` process later reuses the same reconciler — no model change needed. |
