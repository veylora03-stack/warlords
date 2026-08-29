# WARLORDS — Telegram Architecture

> Phase 0 baseline · Bot + Mini App + Deep Links — built strictly on official Telegram Bot API / Mini App behavior.

---

## 1. Components

```
Telegram Platform
├── Bot (@WarlordsBot — placeholder name)
│     private chats: commands, alerts, deep links, rewards
│     (group chats: out of MVP scope — roadmap item)
└── Mini App (WebApp)
      full game UI, opened via bot button / menu button / deep link
```

## 2. Bot Delivery Modes

| Mode | When | Mechanism |
|---|---|---|
| **Webhook** | production | `setWebhook(url=APP_URL/api/v1/telegram/webhook, secret_token=TELEGRAM_WEBHOOK_SECRET, allowed_updates=[message,callback_query])`; adapter verifies `X-Telegram-Bot-Api-Secret-Token` constant-time, else 401 |
| **Long-poll** | local dev (no public URL) | `/api/v1/telegram/updates` (dev-only route, env-guarded) drains `getUpdates` — same handler pipeline as webhook |

Both modes feed one **update pipeline**: parse → auth (telegramId) → command/callback router → services → reply (HTML subset, length-capped, no user-supplied markdown passthrough).

## 3. Command Surface (MVP)

| Command | Behavior |
|---|---|
| `/start` | onboarding card + **Play** button (opens Mini App). Payload grammar: `ref_<playerId>` referral credit (idempotent, both-sides reward, audited) · `camp_<tag>` campaign attribution |
| `/help` | command list + short guide |
| `/play` | Mini App launch button (deep link preserves context) |
| `/profile` | compact stats card + button "open in app" |
| `/rank` | current power rank + top-5 preview |
| `/quests` | active quests summary + claim reminders |
| `/clan` | clan card (if member) or join hints |
| `/invite` | generates personal referral deep link |
| `/settings` | notification preferences (per-type mute) inline keyboard |

All replies include a **Mini App keyboard button** — the bot funnels into the app; the app is the product.

## 4. Deep Links

```
https://t.me/<bot>/<app>?startapp=<payload>
payload grammar (v1):
  battle:<battleId>      → open battle report
  clan:<clanId>          → clan profile
  clanInvite:<clanId>    → clan join sheet
  quest:<questId>        → quest detail
  territory:<x>,<y>      → map viewport centered
```

Client parses at boot (`lib/telegram/client.ts`), then routes to tab + dialog. Server-side counterpart for referral attribution lives in the `/auth/telegram` upsert transaction (single place, idempotent).

## 5. Mini App Lifecycle (client contract)

```
boot → read initData (+ start_param) → POST /api/v1/auth/telegram {initData}
     ← 200 {player projection} + Set-Cookie wl_session
     → expand viewport · apply theme mapping · bind BackButton · haptics enabled
idle → 30s sweep poll (marches + notifications)
background → Telegram suspends JS; on visibility resume → immediate sweep + query invalidate
exit → nothing to flush: all state server-side by design
```

## 6. Notification Delivery Pipeline (Bot side)

```
notifications (outbox, deliveredVia=BOT|BOTH)
  → dispatcher (in-process): per-user FIFO queue (1 msg/s), global bucket (30 msg/s)
  → sendMessage(html, reply_markup=inline "Open" deep-link button)
  → failure: retry w/ backoff (3 attempts) → mark undelivered (visible in admin) — never blocks game tx
Preferences: per-type mute (settings table via /settings + in-app Profile); critical types
(ATTACK_INCOMING, ATTACK_RESULT) default ON, marketing-ish (EVENT, RANK_CHANGE) default digest.
```

## 7. Security Rules (Telegram-specific)

- Bot token server-only; never in Mini App bundle, never logged.
- Webhook secret-token checked on every delivery; updates without it dropped silently (log warn).
- `initData` accepted ≤24h fresh, verified per AUTHENTICATION.md; username from Telegram treated as display-only (identity = `telegramId`).
- All bot-sourced state changes go through the same services + validation as HTTP — no privileged side door.
- Rate limiting: bot commands share the same per-user limiter groups as API (prevents bot-flood abuse of game actions).

## 8. MVP Non-Goals (explicit)

Group/clan chats inside Telegram, payments (Stars), inline games, web-app-inside-groups — recorded in ROADMAP post-MVP backlog with entry criteria.
