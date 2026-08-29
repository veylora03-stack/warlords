# WARLORDS — System Architecture

> Version: 1.0 · Phase 0 · Status: APPROVED-BASELINE (changes require a written rationale in this doc)

---

## 1. Overview

WARLORDS is a persistent, server-authoritative MMO strategy game delivered as:

```
Telegram Client
│
├── Telegram Bot  (onboarding, commands, notifications, deep links)
│
└── Telegram Mini App  (game UI — single-page, tab navigation)
        │
        ▼
REST API  (Next.js App Router Route Handlers — versioned under /api/v1)
        │
        ├── Auth Layer        (Telegram initData verification → session JWT)
        ├── Rate Limiter      (in-memory sliding window, Redis-ready interface)
        ├── Validation        (Zod schemas on every request)
        │
        ├── Game Engines      (pure, deterministic, unit-testable)
        │     ├── Economy Engine    (resource accrual, ledger, market escrow)
        │     ├── Battle Engine     (seeded, replayable simulation)
        │     ├── Quest Engine      (objective tracking, reward granting)
        │     ├── Progress Engine   (XP, level, power, commander/item scaling)
        │     └── World Engine      (territories, map, fog of war)
        │
        ├── Application Services  (transactions, authorization, orchestration)
        │
        ├── Notification Dispatcher  (in-app + Bot delivery, user prefs)
        │
        └── Admin Module      (RBAC-protected, fully audit-logged)
                │
                ▼
        Prisma ORM → PostgreSQL (production) / SQLite (local sandbox dev)
```

**Golden rule enforced by architecture: NEVER TRUST THE CLIENT.**
The Mini App is a *renderer and command sender*. All state mutations are computed,
validated, and persisted server-side.

---

## 2. Stack Decisions (and justified deviations from the original brief)

| Concern | Brief asked for | We ship | Rationale |
|---|---|---|---|
| Frontend | Next.js + React + TS + Tailwind | **Next.js 16 (App Router) + React 19 + TS 5 + Tailwind 4 + shadcn/ui** | Matches brief; shadcn/ui gives premium game-capable components fast. |
| Backend | NestJS or Fastify, separate service | **Next.js Route Handlers (REST) + isolated application layer** | The runtime is a single Next.js deployable (sandbox + free-tier friendly). The entire game logic lives in framework-agnostic modules (`src/lib/game/**`) with a thin HTTP adapter. Extracting to Fastify/NestJS later is mechanical: swap `src/app/api/**` adapters, keep services. |
| Database | PostgreSQL + Prisma | **Prisma ORM, PostgreSQL-first schema; SQLite only as the local sandbox dev driver** | Schema avoids SQLite-only types; `datasource` swap = one line + `DATABASE_URL`. Supabase Postgres is the production target. |
| Cache | None in MVP, Redis later | **In-memory TTL cache behind `src/lib/cache` interface** | Interface mirrors a future Redis client (`get/set/del/withLock`). Swappable without touching game code. |
| State (client) | Zustand / React Query | **Zustand (session/UI state) + TanStack Query (server state)** | Already in deps; standard, proven combo. |
| Bot | Telegram Bot API | **Bot module with webhook adapter (`/api/v1/telegram/webhook`) + long-poll worker fallback for local dev** | Webhook needs a public URL; long-poll keeps local development honest without tunnels. |
| Validation | Zod / class-validator | **Zod v4** | Single schema language shared by HTTP layer and engine inputs. |
| WebSocket | Only where truly needed | **Phase-gated. Clan chat & live boss HP → socket.io mini-service (port 3003) behind gateway.** | Nothing in MVP core requires realtime; we do not pay the complexity tax early. |
| Auth | — | **Custom JWT session (`jose`), HttpOnly + SameSite=Lax cookie** | next-auth v4 is geared to OAuth flows, not Telegram initData. A 200-line verified implementation beats a forced framework. |

### 2.1 Why Route Handlers are enough for ~33 concurrent players (and beyond)

- Node event loop handles this concurrency trivially; Prisma connection pool is the real ceiling.
- Every hot path is *lazy-tick* (see §5) — no cron storms.
- Read endpoints are cache-friendly; leaderboard reads go through the cache layer.
- Horizontal scale-out path: stateless app servers + Postgres + Redis (lock/cache) — already anticipated in module boundaries.

---

## 3. Repository / Folder Structure

```
warlords/
├── docs/                        # Architecture-as-code (this set of documents)
│   ├── ARCHITECTURE.md
│   ├── DATABASE_DESIGN.md
│   ├── API_DESIGN.md
│   ├── BATTLE_MODEL.md
│   ├── SECURITY.md
│   └── ROADMAP.md
├── prisma/
│   └── schema.prisma            # Single source of truth for persistence
├── db/                          # SQLite dev database files (gitignored)
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Root shell, metadata, fonts
│   │   ├── page.tsx             # Mini App entry — the ONLY user-visible route (SPA with tab nav)
│   │   ├── globals.css
│   │   └── api/
│   │       ├── health/route.ts  # Liveness + DB readiness probe
│   │       └── v1/              # Versioned REST API (Phase 1+)
│   │           ├── auth/          player/          city/
│   │           ├── army/          battle/          world/
│   │           ├── quests/        rankings/        clans/
│   │           ├── market/        admin/           telegram/
│   ├── components/
│   │   ├── ui/                  # shadcn/ui primitives (preinstalled)
│   │   ├── game/                # Game UI: city, army, battle, map… (Phase 8+)
│   │   └── layout/              # App shell, bottom nav, sticky footer
│   ├── hooks/                   # React hooks (preinstalled + game hooks later)
│   ├── lib/
│   │   ├── db.ts                # Prisma client singleton
│   │   ├── utils.ts             # cn() etc.
│   │   ├── api/                 # HTTP-layer infrastructure
│   │   │   ├── response.ts      # Standard envelope {ok, data, error, meta}
│   │   │   └── errors.ts        # AppError taxonomy + mapping to HTTP
│   │   ├── auth/                # initData verification, session JWT, RBAC (Phase 1)
│   │   ├── rate-limit/          # Sliding-window limiter, Redis-ready (Phase 1)
│   │   ├── cache/               # TTL cache interface + memory impl (Phase 6)
│   │   ├── bot/                 # Telegram Bot API client, notification dispatcher (Phase 7)
│   │   ├── logger/              # Structured JSON logger w/ request IDs (Phase 1)
│   │   └── game/
│   │       ├── types/           # Domain contracts (game state, battle model) — Phase 0
│   │       ├── config/          # DATA-DRIVEN content: buildings, units, tech, quests…
│   │       ├── engine/          # Pure engines: economy, battle, quest, progress
│   │       └── services/        # Transactional application services
│   ├── stores/                  # Zustand stores
│   └── types/                   # Shared DTO/type re-exports
├── mini-services/               # Independent processes (e.g. socket.io chat) — Phase 6+
├── examples/                    # Sandbox reference implementations
├── worklog.md                   # Cross-agent work journal (append-only)
└── .env.example
```

### 3.1 Layering rules (enforced in code review & by import direction)

```
app/api (HTTP adapters)  →  services  →  engines  →  config/types
        │                     │
        └── auth/rate-limit   └── db (Prisma) — engines NEVER import db
```

- **Engines are pure functions**: input state + config → output events/state deltas. No I/O, no clock, no randomness (seeded PRNG injected). This is what makes battles deterministic, replayable and unit-testable.
- **Services own transactions**: all multi-table mutations happen inside `db.$transaction`.
- **HTTP adapters validate + authorize + shape responses.** Zero game logic in adapters.

---

## 4. Game State Model

### 4.1 Authority & representations

| Representation | Lives where | Purpose |
|---|---|---|
| **Persistent state** | PostgreSQL | Players, cities, buildings, armies, ledgers, battles, clans… |
| **Derived state** | Computed on demand | Production accrual, warehouse capacity, power score, effective stats |
| **Projection (DTO)** | API responses | Read-only shapes the client renders; contains no secrets (never bot token, never other players' hidden data unless scouted) |
| **Command** | API request bodies | Player intent: `AttackTarget`, `UpgradeBuilding`, `TrainUnits`… validated by Zod, executed atomically |

### 4.2 Lazy-tick model (no cron dependency for correctness)

Time-based progress is **resolved on access**, not by background polling:

- Resource production: `accrued = rate * (now - lastCollectedAt)`, capped by warehouse capacity. Collected explicitly (tap) or auto-resolved when a dependent action runs.
- Construction/training/research completion: any read or mutating action first runs `reconcilePlayerState(playerId)` which finalizes finished timers inside the same transaction as the action.
- Marches/battles: arrival time is stored; battle executes when the *defender or attacker* interacts, when the target is scanned by anyone, or via the lightweight sweep endpoint called by the client every 30s (good enough for 33 CCU; a scheduler worker can be attached later without model change).

**Invariant:** a player can never observe or spend resources before they are materialized by the reconciler — no negative balances, no double-collection (each collection moves `lastCollectedAt` forward inside the DB transaction).

### 4.3 Core aggregates

```
User (identity)             1 ─ 1  Player (game persona)
Player                      1 ─ 1  ResourceWallet   (gold/wood/iron/food/crystal/gems)
Player                      1 ─ 1  City             1 ─ N  Building
Player                      1 ─ N  PlayerUnit       (per unit type)
Player                      1 ─ N  PlayerCommander  1 ─ N  CommanderEquipment (slot-bound)
Player                      1 ─ N  PlayerTechnology, PlayerQuest, PlayerAchievement
Player                      1 ─ N  InventoryItem
City                        1 ─ 0..1 Territory (world map anchor, unique x,y)
Battle                      1 ─ N  BattleRound / BattleLog (reports per participant)
Clan                        1 ─ N  ClanMember (player has ≤1 clan), ClanMessage, ClanInvitation
Season                      1 ─ N  LeaderboardSnapshot
```

Full ERD: `docs/DATABASE_DESIGN.md`.

### 4.4 Numeric policy

- Currency/resource/HP/power fields are **BigInt** in DB (SQLite INTEGER-64 / PG BIGINT) to survive late-game inflation.
- The API layer serializes BigInt → string (`jsonBigInt` util). Clients never parse them as numbers for math; they only display.
- Ratios/percentages in config are **basis points** (integers, e.g. `1800` = +18%) — no floating point in economy math.

---

## 5. Engine Map

| Engine | Owns | Key invariants |
|---|---|---|
| **Economy** | production rates, capacity, transfer, market escrow | No negative balances; every delta writes a `ResourceTransaction`; sensitive ops are idempotent |
| **Battle** | simulation, counters, modifiers, casualties, loot | Deterministic from `(seed, configVersion, inputs)`; fully server-side |
| **Quest** | objective progress hooks, reward granting | Progress events are idempotent per quest instance |
| **Progress** | XP curves, levels, power formula, commander/item stat aggregation | Power formula versioned; recomputed server-side only |
| **World** | territories, map viewport, fog of war, capture | Territory x,y unique; capture writes audit + battle linkage |

Game content (units, buildings, tech, quests, items, commanders, counter tables) is **data-driven** from typed config modules in `src/lib/game/config/` — battle logic contains zero hard-coded numbers. Battle rows store `configVersion` so historical battles replay against the exact numbers used at fight time.

---

## 6. Notification Architecture

```
Domain event (inside service, post-commit)
   → outbox row (Notification table, deliveredVia=IN_APP|BOT|BOTH)
   → Dispatcher (in-process, debounced):
        - IN_APP: client polls GET /api/v1/notifications (badge count)
        - BOT:    Telegram sendMessage via Bot API (respects user mute prefs,
                  secret token verified webhook / long-poll in dev)
```

Outbox pattern guarantees at-least-once delivery without blocking game transactions.

---

## 7. Observability

- **Structured JSON logs** (`level, time, requestId, module, msg, …`) via a tiny logger wrapper (Phase 1).
- **Request IDs**: middleware generates `x-request-id` (or honors inbound), attaches to logs and error envelopes.
- **Audit trails**: `resource_transactions` (economy), `battles + battle_rounds` (combat), `admin_audit_logs` (admin actions with before/after JSON).
- **Health**: `GET /api/health` → `{db: up|down, uptime, version}` for uptime probes.
- **Error budget**: all API errors flow through `AppError` → single mapper → consistent envelope + log with stack.

---

## 8. Deployment Architecture

### 8.1 Sandbox (current environment)

```
Browser / Telegram
   → Caddy gateway :443 (only exposed port)
        → Next.js dev/standalone :3000   (Mini App + REST API)
        → mini-services :3003+           (only via ?XTransformPort= query — gateway-rewritten)
```

### 8.2 Production target (free-tier friendly)

```
Telegram Mini App (HTTPS, served by Telegram webview)
   → Vercel (Next.js app: UI + Route Handlers)         ── OR ──  single Render/Railway node
        → Supabase PostgreSQL (DATABASE_URL, pooled)
        → Telegram Bot API (webhook: APP_URL/api/v1/telegram/webhook, secret_token header)
```

- **Env vars** (never committed): `DATABASE_URL, TELEGRAM_BOT_TOKEN, APP_URL, JWT_SECRET, ADMIN_SECRET, TELEGRAM_WEBHOOK_SECRET, NODE_ENV`.
- **Migrations**: `prisma migrate deploy` in release step; schema is PG-compatible by design.
- **Scale path**: 33 CCU → single node; 1k CCU → +Redis (cache/locks/rate-limit), move battle sweep to a worker, keep Postgres (Supabase) or add read replica for leaderboards.

---

## 9. Module maturity matrix (Phase mapping)

| Module | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 |
|---|---|---|---|---|---|---|---|---|---|---|
| Docs & repo | ● | | | | | | | | | |
| Domain types | ● | + | + | + | + | + | | | | |
| Auth (Telegram/JWT/RBAC) | | ● | | | | | | | | |
| Infra (logger, rate-limit) | | ● | | | | | | | | |
| Player/Economy | | | ● | | | | | | | |
| City/Buildings | | | | ● | | | | | | |
| Army/Training | | | | | ● | | | | | |
| Battle Engine | | | | | | ● | | | | |
| Quest/Ranking | | | | | | | ● | | | |
| Bot | | | | | | | | ● | | |
| Mini App UI | | | | | | | | | ● | |
| Admin Panel | | | | | | | | | | ● |

● = deliverable of that phase. Post-MVP systems (market, diplomacy, spy, world boss, seasons, clan wars) are schema-and-type-ready from Phase 0 but implemented after MVP per ROADMAP.
