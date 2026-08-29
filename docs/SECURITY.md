# WARLORDS — Security Model

> Principle: **NEVER TRUST THE CLIENT.** The client is a rendering surface and a command sender. Every value that matters is derived, validated, and persisted server-side.
> §1 authentication is ✅ implemented in Phase 3 (`src/lib/telegram`, `src/lib/auth`, `/api/v1/auth/*`); webhook/admin sections note their target phase.

---

## 1. Authentication (Telegram Mini App)

### 1.1 initData verification (Telegram official algorithm — `src/lib/telegram/init-data.ts`)

1. Mini App opens with `initData` in `window.Telegram.WebApp.initData` (URL-encoded) and POSTs it **in the request body** to `/api/v1/auth/telegram`.
2. Bounds first (attacker-controlled input): non-empty, ≤ 8 KiB (`INIT_DATA_MAX_LENGTH`), `hash` present, `auth_date` a positive unix integer.
3. Build `data_check_string` (every field except `hash`, sorted `key=value` lines, `\n`-joined).
4. Derive key: `secret = HMAC_SHA256(key="WebAppData", message=BOT_TOKEN)`.
5. Compute `HMAC_SHA256(secret, data_check_string)` — **signature check comes FIRST** (nothing else in the payload is trusted until it passes); constant-time compare with `hash`.
6. Enforce `auth_date` freshness: ≤ `TELEGRAM_AUTH_MAX_AGE_SECONDS` (default 24h) with 300s clock skew (`auth_date_in_future` beyond it).
7. Only after the signature check: parse the signed `user` JSON and shape-validate it (safe-integer `id`, bounded strings, https-only `photo_url`, boolean flags).
8. On success: ONE transaction — upsert `users` by `telegramId` (username is display-only, **never identity**) → ban check → replay resolution → session row → `bootstrapPlayer` on first login.

All verification failures throw one client-facing code — `INVALID_INIT_DATA` (401) — with a machine-readable `details.reason` (`empty|too_long|missing_hash|missing_auth_date|invalid_auth_date|invalid_hash|auth_date_in_future|expired|missing_user|invalid_user`) meant for server logs and tests, never for attacker guidance.

### 1.2 Session (implemented)

- JWT (HS256 via `jose`), claims: `sub=userId`, `sid=auth_sessions.id`, `role` — `role` is a snapshot for **observability only**; authorization re-reads role from the DB on every request. Issuer `warlords`, audience `warlords-mini-app`. TTL `SESSION_TTL_SECONDS` (default 7d), sliding refresh on activity.
- Every session is a **`auth_sessions` row + JWT pair**: the raw token is never persisted — only `sha256(token)` (`tokenHash`, unique); `sha256(initData)` (`initDataHash`, unique) makes replays idempotent (§6). The row is **revocable** (`revokedAt` set by logout) — the JWT only speeds up signature verification, the row is the revocation + token-hash authority.
- **Sliding refresh**: when remaining session life < 48h (`SESSION_REFRESH_THRESHOLD_SECONDS`), `/auth/me` re-issues the token (rotates `tokenHash`, extends `expiresAt`) and returns it via Set-Cookie + `refreshed.token`.
- Transport: `HttpOnly; SameSite=Lax; Path=/` cookie (`wl_session`), `Secure` added in production; `Authorization: Bearer` takes precedence for native contexts.
- `JWT_SECRET` ≥ 32 bytes random, env-only; **`JWT_SECRET` + `TELEGRAM_BOT_TOKEN` are required in production** (fail-fast at env load) — in dev their absence yields `AUTH_NOT_CONFIGURED` (503) from auth endpoints.
- Logout revokes the session row server-side (`SESSION_REVOKED` afterwards) **and** clears the cookie; ban check happens on **every** request (`requireAuth` → DB), not just login. Rate limiting (auth group 10/min per IP) runs BEFORE any verification work.

### 1.3 Bot webhook (Phase 7)

`X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (constant-time), else drop with 401. Admin `ADMIN_SECRET` login additionally requires Telegram-id allowlist (`ADMIN_TELEGRAM_IDS`). As of Phase 3 the same `ADMIN_SECRET` (constant-time sha256 compare, rate-limited 5/min per IP, allowlisted, audited) guards the non-production `POST /api/v1/auth/dev-impersonate` route (404 in production) — see AUTHENTICATION.md Flow B.

---

## 2. Authorization & anti-cheat matrix

| Client controls | Client cannot control (server-derived) |
|---|---|
| command intent (`upgrade building X`) | costs, durations, requirements |
| target selection (`attack player Y`) | battle result, casualties, loot |
| quantity requests (`train 50 archers`) | resource amounts, wallet math |
| UI preferences | XP, levels, power, honor, reputation |
| chat text (sanitized, length-capped) | cooldowns, energy, protection rules |
| | quest/achievement eligibility & rewards |

Additional layers:

1. **Zod validation** on every route (body, query, params) — unknown keys stripped.
2. **Rate limiting** per user/IP + route-group (see API_DESIGN §1.4) — **implemented (Phase 3, `src/lib/rate-limit`)**: in-memory sliding window behind a Redis-ready `RateLimitStore` interface, one shared store per process; the auth group (10/min per IP) is enforced BEFORE any verification work, dev-impersonate gets 5/min per IP. Exceeding → `RATE_LIMITED` (429) with `details.retryAfterSec`.
3. **Idempotency** on sensitive POSTs (`Idempotency-Key` → `idempotency_keys` table) — replay returns the original response, no double effect.
4. **DB transactions** for every multi-write operation; wallet updates always re-read inside the tx (no read-then-write races).
5. **BigInt integer-only economy math** (basis points) — no float rounding exploits.
6. **Referential integrity**: target ids validated to exist *and* be visible to the caller (fog of war, clan protections).
7. **Output filtering**: public profiles never leak wallet/army/tech details; scout data TTLs; admin endpoints behind role check + audit.

## 3. RBAC

| Role | Capabilities |
|---|---|
| USER | game endpoints |
| ADMIN | admin read/inspection, ban, adjust-resources, announcements, events |
| SUPERADMIN | ADMIN + admin login allowlist management, role grants |

Role lives on `users.role`; middleware + per-route guards enforce; **every** admin mutation writes `admin_audit_logs` (actor, action, target, before/after JSON, reason, ip, requestId).

## 4. Input hardening

- No raw SQL — Prisma parameterizes everything (SQLi off by default).
- Chat/announcement strings: length-capped, escaped on render (React default), no markdown passthrough to Bot messages without sanitization.
- File uploads: none in MVP (avatars are Telegram photo URLs, host-validated).
- Numbers: parsed as integers with explicit min/max bounds; BigInt handled server-side only.
- CORS: same-origin (Mini App served by the same deployment); API rejects cross-origin mutations; cookies SameSite=Lax.

## 5. Secrets & configuration

| Secret | Where | Never |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | env (server) | in client bundle, in logs, in git |
| `JWT_SECRET` | env (server) | rotated on compromise; old sessions die |
| `ADMIN_SECRET` | env (server) | brute-force guarded (rate limit 5/min) |
| `TELEGRAM_WEBHOOK_SECRET` | env (server) | — |
| `DATABASE_URL` | env (server) | — |

Non-secret **auth tunables** (env, Zod-validated in `src/config/env.ts`, defaults in `.env.example`):

| Tunable | Default | Purpose |
|---|---|---|
| `TELEGRAM_AUTH_MAX_AGE_SECONDS` | `86400` (24h) | initData `auth_date` freshness bound — bounds the replay window (client re-opens the Mini App to refresh) |
| `SESSION_TTL_SECONDS` | `604800` (7d) | Server-side session lifetime for issued JWT sessions |

`.env*` is gitignored; `.env.example` documents keys without values. Client receives **zero** secrets; `/api/v1/config` exposes only public game constants if needed.

## 6. Anti-replay & race conditions

**initData replay (implemented decision).** A replayed byte-identical `initData` is NOT hard-rejected: the unique `auth_sessions.initDataHash` re-attaches the replay to the SAME session row and **rotates its token hash** (`replayed: true`). Chosen over rejection because:

1. **Retry safety** — network retries of the login POST are common in mobile/webview contexts; hard rejection would lock legitimate users out of their own session.
2. **No session farming** — the unique hash guarantees one live session per initData; no attacker (or client bug) can mint unbounded session rows from a captured payload.
3. **Old token dies immediately** — the rotation invalidates the previously issued token in the same tx, so a replay cannot be used to keep a stolen token alive.
4. **Bounded exposure** — only **fresh** initData (new `auth_date`) mints a new session, so any captured payload's usable lifetime is capped by `TELEGRAM_AUTH_MAX_AGE_SECONDS`. Residual risk (documented, Telegram design limit): raw initData stolen within that window can re-attach/mint a session; mitigation is transport security + the fact that raw initData is never logged or persisted.

Other anti-replay/race layers:

- Sensitive ops require `Idempotency-Key` (server dedupes within 24h TTL).
- Wallet mutations: single transaction with `balanceAfter` re-computation — negative balances are structurally impossible (engine asserts, DB check constraint on PG, service-level guard on SQLite).
- Market fills: order row locked/re-checked in-tx; partial fills tracked via `filledQuantity`.
- Attack concurrency: units deducted at march creation under row lock — an army cannot be committed twice.

## 7. Logging, monitoring, incident response

- Structured logs with `requestId`; errors include stack + sanitized context (no tokens, no full initData ever logged).
- Economy anomaly alarms (Phase 9): mint/burn 24h deltas per resource from ledger (`/admin/economy/overview`).
- Battle anomaly checks: replay verification endpoint doubles as an integrity audit.
- Ban flow: `users.isBanned` → middleware blocks instantly + optional bot message; unban audited.

## 8. Known limitations (honesty register)

- In-memory rate limiting/locks are **implemented per-process** (`src/lib/rate-limit`, shared store); multi-instance deployments must back the `RateLimitStore` interface with Redis (swap the store, keep `enforceRateLimit` unchanged).
- Ban/role enforcement requires a DB hit per request by design — hence route-composed `requireAuth` instead of a Next.js edge `middleware.ts` (edge runtime cannot run Prisma).
- SQLite dev mode serializes writes — fine for sandbox, not a production statement; Postgres is the production path.
- Replay verification depends on `configVersion` snapshots existing for all historical battles — enforced by engine tests at Phase 5 and never bypassed.
