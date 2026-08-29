# WARLORDS — Authentication Architecture

> Phase 0 baseline · Implementation: Phase 1 · Zero custom crypto — everything below is Telegram-official + stdlib.

---

## 1. Identity Model

| Concept | Storage | Rule |
|---|---|---|
| **Identity** | `users.telegramId` (unique, int64-as-string) | username is display-only, NEVER identity |
| **Game persona** | `players` (1:1 user) | created in the same tx as first login |
| **Session** | JWT HS256, 7d, sliding refresh | cookie `wl_session` HttpOnly+Secure+SameSite=Lax+Path=/ |
| **Roles** | `users.role` ∈ USER·ADMIN·SUPERADMIN | checked per request by middleware + route guards |

## 2. Flow A — Mini App Login (primary)

```mermaid
sequenceDiagram
    participant T as Telegram WebApp
    participant C as Mini App (client)
    participant S as API /auth/telegram
    participant DB as PostgreSQL

    T->>C: opens app (initData, start_param)
    C->>S: POST { initData }
    S->>S: parse + sort fields → data_check_string
    S->>S: key = HMAC_SHA256("WebAppData", BOT_TOKEN)
    S->>S: calc = HMAC_SHA256(key, data_check_string)
    S->>S: constant-time compare with `hash`
    S->>S: auth_date freshness ≤ 24h ? user not banned ?
    S->>DB: tx: upsert users (by telegramId) → ensure players (bootstrap city+wallet+starter buildings) → referral attribution if start_param
    S->>S: issue JWT { sub: userId, role, iat, exp: +7d } signed JWT_SECRET
    S-->>C: 200 { ok, data: player } + Set-Cookie wl_session
    C->>C: seed session store → boot shell
```

Notes:
- `initData` is accepted from the request body **once** and never echoed/logged/stored.
- Verification failures → `INVALID_INIT_DATA` (401). Stale auth_date → same code (client re-opens app to refresh).
- Sliding refresh: authenticated requests with `exp - now < 48h` get a fresh cookie (silent session continuity).
- Every subsequent request: middleware validates JWT + ban status (`users.isBanned`, with `banExpiresAt` support for temp bans) → 401/403 codes.

## 3. Flow B — Dev Impersonation (non-production ONLY)

```mermaid
sequenceDiagram
    participant C as Browser (dev)
    participant S as API /auth/dev-impersonate
    S->>S: NODE_ENV !== 'production' ? else 404
    S->>S: body { telegramId?, username?, secret=ADMIN_SECRET ? allowlist? }
    S->>S: rate-limit 5/min per IP
    S->>S: upsert/find target user → issue session JWT (claim: impersonated=true)
    S->>S: write admin_audit_logs { action: DEV_IMPERSONATE, reason }
    S-->>C: session cookie (clearly flagged in logs)
```

Purpose: exercise the Mini App in a plain browser during development. Guarded by env + secret + allowlist + audit; **compiled out of production behavior** (route returns 404 when NODE_ENV=production).

## 4. Flow C — Admin Login

```mermaid
sequenceDiagram
    participant A as Admin console
    participant S as API /admin/login
    A->>S: POST { telegramId, secret }
    S->>S: secret == ADMIN_SECRET (constant-time) ? telegramId ∈ ADMIN_TELEGRAM_IDS ?
    S->>S: rate-limit 5/min per IP
    S-->>A: admin JWT { sub, role: ADMIN|SUPERADMIN, exp: +8h } — separate cookie wl_admin
```

Admin cookie is **separate** from player session (a admin browsing the game as player never carries admin powers in the player context). All admin routes require the admin cookie + role guard + audit.

## 5. Guards & Failure Map

| Check | Failure code |
|---|---|
| missing/expired session | `UNAUTHORIZED` / `SESSION_EXPIRED` |
| bad initData signature/age | `INVALID_INIT_DATA` |
| banned user (perm or until banExpiresAt) | `BANNED` (+ reason + expiry in details) |
| role too low | `FORBIDDEN` |
| clan role insufficient | `CLAN_ROLE_REQUIRED` |

## 6. Secrets (summary — full register in SECURITY.md §5)

`JWT_SECRET` ≥32 random bytes, env-only, rotation kills sessions (acceptable, documented). `ADMIN_SECRET` never used as a bearer token by itself — always paired with allowlisted telegramId. `TELEGRAM_BOT_TOKEN` used for HMAC derivation + Bot API only, server-side only.
