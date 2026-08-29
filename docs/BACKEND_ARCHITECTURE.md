# WARLORDS — Backend Architecture

> Phase 0 baseline · Framework-agnostic application core with thin HTTP/Bot adapters.
> Swapping Route Handlers for Fastify/NestJS later = rewriting only `src/app/api/**`.

---

## 1. Runtime Model

- One Next.js 16 process (Node runtime) serving UI + REST `/api/v1` + Telegram webhook adapter.
- No Server Actions (project rule: REST API only). No Edge runtime for game routes (needs Prisma/BigInt stability).
- Concurrency model: async/await on the Node loop; correctness via DB transactions + in-tx re-reads (see ECONOMY_ARCHITECTURE.md), not process locks.
- Optional future worker: same codebase, `WORKER=1` env runs only the reconciler sweep loop + notification dispatcher — zero model change.

## 2. Module Boundaries & Dependency Rules (hard)

```
ADAPTERS (no game logic)
  src/app/api/v1/**      (HTTP)
  src/lib/bot/handlers   (Telegram commands)
        │ allowed imports: lib/api, lib/auth, lib/rate-limit, lib/logger,
        │                 game/services, game/types (DTO re-exports), lib/db (health only)
        ▼
SERVICES (transactions + authorization + orchestration)
  src/lib/game/services/**
        │ allowed imports: game/engine, game/config, game/types, lib/db,
        │                 lib/api/errors, lib/logger, lib/cache, lib/bot (notify only)
        ▼
ENGINES (PURE — determinism contract)
  src/lib/game/engine/**
        │ allowed imports: game/types, game/config, game/utils  — NOTHING else
        │ forbidden: lib/db, next/*, Date.now (clock injected), Math.random (seeded PRNG injected)
        ▼
CONFIG (leaf)
  src/lib/game/config/**  imports game/types only
```

| Rule | Why |
|---|---|
| Engines never touch DB/network/clock | battles replayable; logic testable without infra |
| Only services open transactions | one place to audit concurrency |
| Adapters contain zero business rules | authorization & validation only |
| `components/**` never import lib/db / lib/bot / engines | UI isolation from server internals |
| Infra leaves (logger/cache/rate-limit) import nothing game-* | no cycles; Redis swap never touches game code |

Enforcement: documented now; ESLint `import/no-restricted-paths` rules added in Phase 1 tooling pass.

## 3. Request Lifecycle (every game endpoint)

```
1. middleware            request-id (honor x-request-id) · security headers · (Phase 1: ban check)
2. authN                 session cookie/JWT → req.user {userId, role}   (AUTHENTICATION.md)
3. rate limit            per user + route group (API_DESIGN.md §1.4)
4. validate              Zod parse body/query/params → typed input; unknown keys stripped
5. service call          opens tx → reconcilePlayerState (lazy-tick) → authorize → engine(input) → persist
6. envelope              ok(data, meta.requestId) | fail(AppError) — never raw Prisma/zod leaks
```

## 4. Error Handling Strategy

Three failure classes, one contract:

| Class | Source | Handling |
|---|---|---|
| **Expected** | game rule violations | thrown as `AppError(code, msg, details)` → envelope with stable machine code + HTTP status from `ERROR_CODES` |
| **Unexpected** | bugs, contract drift | caught by `handle()` wrapper → structured error log (stack, requestId) → generic `INTERNAL_ERROR` envelope (no internals leaked) |
| **Infrastructure** | DB down, Bot API down, cache cold | DB down → endpoints 500 generic + `/api/health` reports `degraded`; Bot delivery failure → outbox stays pending, retried with backoff — **never blocks or rolls back the game transaction** |

Mappings implemented in the adapter/service seam:

| Source | Mapped to |
|---|---|
| Zod parse failure | `VALIDATION_ERROR` (+ field paths in `details`) |
| Prisma `P2002` unique violation | domain code (`ALREADY_IN_CLAN`, `CLAN_NAME_TAKEN`…) re-thrown by service after pre-check |
| Prisma `P2025` not found | respective `*_NOT_FOUND` code |
| `Idempotency-Key` replay | original stored response (`IDEMPOTENT_REPLAY` only on hash mismatch) |

Client contract rule: error codes are **additive-only**; clients switch on codes, never on message text.

## 5. Logging Strategy

Single-line structured JSON via `lib/logger`:

```json
{"level":"info","time":"…","requestId":"req_9f2c","playerId":"plr_12","module":"battle","msg":"attack resolved","durationMs":42,"battleId":"btl_7"}
```

| Level | Use |
|---|---|
| error | unexpected failures + infra failures (with stack) |
| warn | recoverable anomalies: retrying bot delivery, rate-limit hits, idempotent replays |
| info | command accepted / action applied / march resolved (one line per meaningful state change) |
| debug | dev only |

Rules: **never** log `initData`, tokens, secrets, full IPs (hash/omit); long arrays truncated; PII = playerId only. Query logging off in prod (Prisma `log` config env-tuned). Correlation: `requestId` from middleware + `playerId` after authN. Audit truth (economy/combat/admin) is persisted in DB tables (`resource_transactions`, `battle_rounds`, `admin_audit_logs`) — logs are operational, not forensic.

## 6. Caching Strategy

| Layer | What | TTL / policy |
|---|---|---|
| **L1 process memory** (`lib/cache`, Redis-ready iface: get/set/del/`withLock`/single-flight) | leaderboard pages · world-map viewport tiles · catalog configs (units/buildings/tech/quests — process-lifetime, invalidated by config deploy) | 30s · 10s · ∞ |
| **TanStack Query** (client) | all GET projections | staleTime per entity (player 5s, city 10s, rankings 30s) |
| **HTTP** | API responses | `no-store` (game state mutates; correctness > caching at the HTTP layer) |
| **Static assets** | fonts, images, SVG | immutable, hashed filenames |
| **Prisma** | catalog tables | read-once into L1 at boot (they change only via deploy/seed); player rows never cached server-side |

Rules: cache keys versioned (`lb:power:all:p3`); stampede protection via single-flight promise map; **never** cache anything used inside an economic transaction; Redis interface shaped now (`withLock` for market fills / march resolution) so the Phase-12 scale-out is a driver swap, not a refactor.

## 7. WebSocket Strategy (honest & phased)

| Phase | Mechanism | Justification |
|---|---|---|
| MVP (P1–P6) | 30s polling sweep from client (`/battle/marches` + `/notifications`) | 33 CCU; timers are server-anchored anyway; zero infra cost |
| P6+ | **socket.io mini-service on :3003** (independent bun project, `--hot`), gateway-forwarded via `/?XTransformPort=3003` | clan chat, live world-boss HP, instant march alerts |
| Scale | Redis adapter for socket.io + room sharding | only when >1 node |

Socket design: JWT in handshake (`auth.token`) → verify → join `player:{id}`; clan membership → `clan:{id}`; boss room `boss:{id}`. Server pushes are **events, not state** — client refetches affected queries (single source of truth stays the API). Polling path is preserved as permanent fallback (Telegram webview suspends JS in background; sockets die — polling recovers cleanly).

## 8. Background Work (Phase-gated)

- Reconciler-on-access covers correctness entirely; the client sweep adds liveness.
- `WORKER=1` mode (later): loop { resolve due marches → finalize timers → dispatch outbox } every 5s. Same service functions as the on-access path — no duplicate logic.
- No message broker in MVP; outbox table IS the queue (at-least-once, backoff, visible in admin).
