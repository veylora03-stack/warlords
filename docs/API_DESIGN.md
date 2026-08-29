# WARLORDS — API Design

> Base path: `/api/v1` · Protocol: REST/JSON · All bodies validated with Zod.
> Versioning: breaking changes introduce `/api/v2`; within v1 only additive changes.

---

## 1. Conventions

### 1.1 Response envelope (every endpoint, success or failure)

```jsonc
// success
{ "ok": true, "data": { ... }, "meta": { "requestId": "req_9f2c", "serverTime": "2025-01-01T00:00:00Z", "page"?: 1, "total"?: 120 } }

// failure
{ "ok": false, "error": { "code": "INSUFFICIENT_GOLD", "message": "Not enough gold: need 5000, have 3200", "details"?: { "needed": 5000, "have": 3200 } }, "meta": { "requestId": "req_9f2c" } }
```

- HTTP status is **transport-level**; `error.code` is the machine-readable game-level truth.
- BigInt values are serialized as **strings**.

### 1.2 Error code taxonomy (stable contract — clients may switch on these)

| Group | Codes |
|---|---|
| Auth (401) | `UNAUTHORIZED`, `INVALID_INIT_DATA`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `BANNED` (403) |
| Auth infrastructure (503) | `AUTH_NOT_CONFIGURED` (server misconfiguration — e.g. `JWT_SECRET`/`TELEGRAM_BOT_TOKEN` missing in dev; production fails fast at env load) |
| Permission (403) | `FORBIDDEN`, `CLAN_ROLE_REQUIRED`, `PROTECTED_TARGET` (newbie shield), `SELF_TARGET` |
| Validation (400) | `VALIDATION_ERROR`, `INVALID_TARGET`, `INVALID_AMOUNT`, `ARMY_EMPTY` |
| State (409) | `INSUFFICIENT_GOLD`, `INSUFFICIENT_WOOD`, `INSUFFICIENT_IRON`, `INSUFFICIENT_FOOD`, `INSUFFICIENT_CRYSTAL`, `INSUFFICIENT_GEMS`, `INSUFFICIENT_ENERGY`, `INSUFFICIENT_UNITS`, `WAREHOUSE_FULL`, `BUILDING_QUEUE_BUSY`, `PREREQUISITE_MISSING`, `ALREADY_IN_CLAN`, `NOT_IN_CLAN`, `ORDER_NO_LONGER_OPEN`, `IDEMPOTENT_REPLAY`, `ACTION_ON_COOLDOWN` |
| Throttling (429) | `RATE_LIMITED` (+ `details.retryAfterSec`) |
| Not found (404) | `NOT_FOUND` (generic), `PLAYER_NOT_FOUND`, `TERRITORY_NOT_FOUND`, `BATTLE_NOT_FOUND`, `QUEST_NOT_FOUND`, `ORDER_NOT_FOUND`, `CLAN_NOT_FOUND` |
| Server (500) | `INTERNAL_ERROR` |

### 1.3 Auth & headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization: Bearer <session JWT>` *(or HttpOnly cookie `wl_session`)* | client→server | Credential for every protected route — Bearer header wins over the cookie; both carry the JWT issued by `POST /auth/telegram` |
| `x-request-id` | both | Correlation ID (server generates if absent, echoes back) |
| `Idempotency-Key: <uuid>` | client→server | Required on: attack, market fill/cancel, reward claim, admin adjustments |
| — | client→server | Raw Telegram `initData` travels in the **JSON body** of `POST /auth/telegram` (`{ initData }`) — never in a header |

### 1.4 Rate limits (sliding window, per user+route group)

| Group | Limit |
|---|---|
| Reads | 120 / min |
| Game actions (build/train/collect) | 60 / min |
| Combat (attack/scout) | 20 / min |
| Market writes | 30 / min |
| Auth | 10 / min per IP |

Exceeded → `429 { error.code: "RATE_LIMITED", details.retryAfterSec }`.

---

## 2. Endpoint catalog

### 2.1 System

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness + DB probe (used by status console & uptime checks) |

### 2.2 Auth — Phase 3 ✅

All auth routes share the auth rate-limit group (10/min per IP, enforced before verification work — see §1.4). Session = JWT HS256 (`sub`/`sid`/`role`) + `auth_sessions` row; transport = `Authorization: Bearer` or HttpOnly `wl_session` cookie.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/telegram` | Body `{initData}` → Telegram-official HMAC-SHA256 verification (freshness ≤ `TELEGRAM_AUTH_MAX_AGE_SECONDS`) → ONE tx: user upsert by telegramId → ban check → replay resolution (unique initDataHash re-attach + token rotation) → `auth_sessions` row → `bootstrapPlayer` on first login → `{ token, tokenType: "Bearer", expiresAt, replayed, user, player, session }` + Set-Cookie `wl_session` |
| GET | `/api/v1/auth/me` | Protected. DB-fresh identity + player projection + session info; inside the 48h sliding window re-issues the session (Set-Cookie + `refreshed.token`) |
| POST | `/api/v1/auth/logout` | Protected. Revokes the `auth_sessions` row server-side (token dies → `SESSION_REVOKED` afterwards) and clears the cookie. Idempotent |
| POST | `/api/v1/auth/dev-impersonate` | **Non-production only (404 in production).** Rate limit 5/min per IP → `NODE_ENV` gate → `ADMIN_SECRET` constant-time compare → `ADMIN_TELEGRAM_IDS` allowlist → audited (`DEV_IMPERSONATE`) session for the allowlisted identity (dev user auto-created + bootstrapped) |

Failure codes: `INVALID_INIT_DATA` 401 (with `details.reason`), `UNAUTHORIZED` 401, `SESSION_EXPIRED` 401, `SESSION_REVOKED` 401, `BANNED` 403, `AUTH_NOT_CONFIGURED` 503, `RATE_LIMITED` 429, `NOT_FOUND` 404 (dev-impersonate in production) — full map in AUTHENTICATION.md §5.

### 2.3 Player — Phase 4 ✅ (profile surface implemented)

Auth = session credential (see §1.3): `Authorization: Bearer` wins, else the `wl_session` cookie — enforced by the `requirePlayer` guard (`requireAuth` + player-presence). Reads accept no client input beyond the authenticated player id.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/player/profile` | Progression snapshot: level + XP-curve position (`xpIntoLevel`, `xpForNextLevel`, `levelProgressBps` — derived from the data-driven curve), honor, reputation, season points, city, clan stub, **lazily-regenerated energy** (`energy`, `energyMax`, `energyNextRegenAtMs`) and **freshly computed power** (`power` + `powerBreakdown{units, buildings, technologies}`) |
| GET | `/api/v1/player/statistics` | Lifetime counters from the typed catalog (`config/stats.ts` — 12 keys, COMBAT/ECONOMY/PROGRESSION), normalized server-side (unknown dropped, missing zero-filled) |
| GET | `/api/v1/player/state` | Full Mini App bootstrap payload in one call: `profile` + `wallet` (gold/wood/iron/food/crystal) + capital `city` + `buildingCount` + `army` roster |

Serialization & freshness notes:
- BigInt amounts (`xp`, `power`, `honor`, `gems`, wallet balances) are serialized as **strings** — clients do display math only.
- `power` is **computed fresh from real state (army × catalog + buildings + technologies) on every request** — never read from the cached `Player.power` column, never client-supplied.
- Energy regen is resolved lazily on read (lazy-tick): whole ticks credited, partial tick carried, cap never accumulates.

Failure codes: `UNAUTHORIZED` 401 (missing/invalid/expired/revoked session), `PLAYER_NOT_FOUND` 404 (valid session whose user has no bootstrapped player — a server-side inconsistency, not a client-fixable state).

Still planned (original Phase 2 catalog, not yet implemented):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/player/:id` | Public profile (no wallet detail, no army detail) |
| GET | `/api/v1/player/me/transactions?resource=&cursor=` | Personal ledger (paginated) |

### 2.4 City & buildings — Phase 3

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/city` | City + buildings + production rates + capacity + running constructions |
| POST | `/api/v1/city/buildings/:type/upgrade` | Validates cost/requirements/queue slot → debits wallet (ledger) → sets timer |
| POST | `/api/v1/city/buildings/:type/cancel` | Refund %, clear slot (audited) |
| GET | `/api/v1/city/collect` | Materialize accrued production up to capacity (ledger rows) |

### 2.5 Army — Phase 4

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/army` | Units, upkeep, training queue |
| POST | `/api/v1/army/train` | `{unitTypeId, count}` → cost+time from config → debit → queue rows |
| POST | `/api/v1/army/train/:id/cancel` | Refund policy-based, remove queue item |

### 2.6 Battle — Phase 5

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/battle/attack` | `{targetPlayerId \| territoryId, composition}` → full server validation (energy, shield, cooldown, march time) → creates March; on arrival executes engine |
| POST | `/api/v1/battle/scout` | `{targetPlayerId}` → energy cost → ScoutReport with TTL |
| GET | `/api/v1/battle/marches` | Active marches of me |
| GET | `/api/v1/battle/:id` | Battle detail (rounds) — 404 unless participant/clanmate |
| GET | `/api/v1/battles?cursor=` | My battle reports inbox |
| GET | `/api/v1/battle/:id/replay` | Deterministic replay: `{seed, configVersion, inputs}` re-simulated server-side |

### 2.7 Commanders & inventory — Phase 5/6

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/commanders` | Catalog + my unlocks + effective stats |
| POST | `/api/v1/commanders/:id/summon` | Gacha/quest unlock path (gem cost, pity counter) |
| POST | `/api/v1/commanders/:playerCommanderId/activate` | Set active commander (affects next battles) |
| POST | `/api/v1/inventory/equip` | `{inventoryItemId, playerCommanderId, slot}` — validates slot/level |
| POST | `/api/v1/inventory/:itemId/use` | Consumables |

### 2.8 Technology — Phase 6

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/technologies` | Tree + my progress |
| POST | `/api/v1/technologies/:id/research` | Level+1 if prerequisites met; single research slot |

### 2.9 Quests — Phase 6

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/quests` | Active/completed/claimable (auto-assigned dailies) |
| POST | `/api/v1/quests/:id/claim` | Idempotent claim → rewards + ledger + XP (Idempotency-Key required) |

### 2.10 World map — Phase 6

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/world/map?x0=&y0=&x1=&y1=` | Viewport cells respecting fog of war (scouted or radius-known) |
| GET | `/api/v1/world/territories/:id` | Territory detail (public info; defense hidden unless scouted) |

### 2.11 Rankings — Phase 6

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/rankings?category=POWER&period=ALL_TIME&page=` | Cached leaderboard (30s TTL), includes my rank |

### 2.12 Clans — Phase 6/8

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/clans?query=` | Search |
| POST | `/api/v1/clans` | Create (cost, name/tag unique) → creator = LEADER |
| GET | `/api/v1/clans/:id` | Profile + roster + stats |
| POST | `/api/v1/clans/:id/join` · `/leave` | Membership transitions (transactional) |
| POST | `/api/v1/clans/:id/invite` · `/kick` · `/promote` · `/demote` | Role-gated (`CLAN_ROLE_REQUIRED`) |
| GET/POST | `/api/v1/clans/:id/chat` | History / send (rate-limited; socket.io later) |
| POST | `/api/v1/clans/:id/donate` | Treasury contribution → contribution score |

### 2.13 Notifications — Phase 2+

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/notifications?unread=` | Inbox |
| POST | `/api/v1/notifications/read` | `{ids[]}` mark read |

### 2.14 Market (post-MVP)

`GET/POST /api/v1/market/orders`, `POST /api/v1/market/orders/:id/fill`, `DELETE /api/v1/market/orders/:id`, `GET /api/v1/market/transactions` — escrowed, fully ledgered (see DATABASE_DESIGN §5).

### 2.15 Telegram bot — Phase 7

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/telegram/webhook` | Verified via `X-Telegram-Bot-Api-Secret-Token`; handles `/start /help /play /profile /rank /quests /clan /invite /settings`; deep links `?startapp=` into Mini App |
| GET | `/api/v1/telegram/updates` *(dev only)* | Long-poll drain used when no public webhook exists |

### 2.16 Admin — Phase 9 (`role ∈ {ADMIN, SUPERADMIN}`, all actions audited)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/admin/login` | `ADMIN_SECRET` + Telegram id allowlist → admin session |
| GET | `/api/v1/admin/players?q=&page=` | Search by name/telegram id |
| GET | `/api/v1/admin/players/:id` | Full player inspection (wallet, army, ledger tail, battles tail) |
| POST | `/api/v1/admin/players/:id/ban` · `/unban` | Reason required → audit |
| POST | `/api/v1/admin/players/:id/adjust-resources` | `{resource, delta, reason}` → ledger with `reason=admin_adjust` (Idempotency-Key required) |
| GET | `/api/v1/admin/battles?cursor=` · `/api/v1/admin/audit-logs` | Inspection feeds |
| POST | `/api/v1/admin/announcements` | Broadcast (ALL/CLAN/PLAYER) |
| GET/POST | `/api/v1/admin/events` | Spawn/stop server-driven events |
| GET | `/api/v1/admin/economy/overview` | Total supply per resource, mint/burn 24h — anomaly detection |

---

## 3. Sequence examples

### 3.1 Attack (happy path)

```
Client                     API                              Service                 Engine
  │ POST /battle/attack ───▶│                                 │                       │
  │  {targetId, units}     │ auth→rate-limit→zod             │                       │
  │                        │──────── reconcile ─────────────▶│ (finalize timers)     │
  │                        │──────── validateAttack ────────▶│ shields/cooldowns/    │
  │                        │                                 │ energy/army lock      │
  │                        │                                 │──── create March ────▶│ (tx: lock units, ledger energy)
  │ 202 {marchId, eta} ◀───│                                 │                       │
  │      … eta …           │                                 │ on arrival/sweep:     │
  │                        │──────── resolveMarch ──────────▶│──── simulate ────────▶│ pure(seed, cfg, sides)
  │                        │                                 │ persist Battle+Rounds │
  │                        │                                 │ apply loot/ledger     │
  │                        │                                 │ notify both players   │
```

### 3.2 Idempotent reward claim

```
POST /quests/123/claim   Idempotency-Key: 7c9e…
  → key exists & same request hash?  → return original result (no double reward)
  → tx: re-check status=COMPLETED → mark CLAIMED → grant rewards → ledger rows → write key
```

---

## 4. Client integration notes (Mini App)

- TanStack Query for all GETs (stale-while-revalidate); Zustand for session/UI.
- After any mutating POST, invalidate the affected query keys — **never** mutate game state client-side.
- `serverTime` from `meta` drives all countdown timers (device clocks are untrusted).
- Poll `/api/v1/battle/marches` + `/api/v1/notifications` every 30s while the app is open (sweep duty).
