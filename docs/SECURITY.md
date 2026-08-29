# WARLORDS — Security Model

> Principle: **NEVER TRUST THE CLIENT.** The client is a rendering surface and a command sender. Every value that matters is derived, validated, and persisted server-side.

---

## 1. Authentication (Telegram Mini App)

### 1.1 initData verification (Telegram official algorithm)

1. Mini App opens with `initData` in `window.Telegram.WebApp.initData` (URL-encoded).
2. Server parses `hash` + all other fields, builds `data_check_string` (sorted `key=value` lines, `\n`-joined).
3. Derive key: `secret = HMAC_SHA256(key="WebAppData", message=BOT_TOKEN)`.
4. Compute `HMAC_SHA256(secret, data_check_string)` — constant-time compare with `hash`.
5. Enforce `auth_date` freshness (≤ 24h) and optional `auth_context` checks.
6. On success: upsert `users` by `telegramId` (username is display-only, **never identity**), issue session.

### 1.2 Session

- JWT (HS256 via `jose`), claims: `sub=userId, role, iat, exp` — 7d TTL, sliding refresh on activity.
- Transport: `HttpOnly; Secure; SameSite=Lax; Path=/` cookie (`wl_session`) + optional Bearer for native contexts.
- `JWT_SECRET` ≥ 32 bytes random, env-only.
- Logout clears cookie; ban check happens on **every** request (middleware), not just login.

### 1.3 Bot webhook

`X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` (constant-time), else drop with 401. Admin `ADMIN_SECRET` login additionally requires Telegram-id allowlist (`ADMIN_TELEGRAM_IDS`).

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
2. **Rate limiting** per user+route-group (see API_DESIGN §1.4), in-memory sliding window with Redis-ready interface.
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

`.env*` is gitignored; `.env.example` documents keys without values. Client receives **zero** secrets; `/api/v1/config` exposes only public game constants if needed.

## 6. Anti-replay & race conditions

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

- In-memory rate limiting/locks are per-process; multi-instance deployments must back them with Redis (interface already shaped for it).
- SQLite dev mode serializes writes — fine for sandbox, not a production statement; Postgres is the production path.
- Replay verification depends on `configVersion` snapshots existing for all historical battles — enforced by engine tests at Phase 5 and never bypassed.
