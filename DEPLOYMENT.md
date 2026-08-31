# WARLORDS — Production Deployment Guide

> Phase 26 · Everything needed to take the current codebase to a live deployment.
> Every command below is real and runs from the repository root. No placeholders
> are hidden: fields marked **REQUIRED-IN-PROD** gate the server boot.

---

## 1. Architecture & deployment shape

```
Telegram clients
   │  (Mini App iframe + bot commands)
   ▼
┌───────────────────────────────────────────────────────┐
│  WARLORDS — single Next.js 16 service (Docker)        │
│  ─ Mini App UI (static + RSC)                         │
│  ─ REST API  /api/v1/**  (envelope · auth · Zod v4)   │
│  ─ Telegram webhook POST /api/v1/telegram/webhook     │
│  ─ Probes    /health · /ready · /api/health           │
│  ─ In-process notification drain loop (claim-safe)    │
└───────────────┬───────────────────────────────────────┘
                │ Prisma (dedicated write engine + read pool)
                ▼
        PostgreSQL (Supabase / Render Postgres / …)
```

**One deployable, two viable targets:**

| Target | What runs | Notes |
|---|---|---|
| **A. Container platform** (Render / Railway / Koyeb / Fly / any Docker host) — *recommended* | Full service from `Dockerfile` | Matches the performance model of Phase 25 (long-lived process, in-process worker, in-memory caches). Simplest correct topology. |
| **B. Vercel** | Whole Next.js app (frontend + API routes) | Works for the UI and stateless API routes. Two caveats handled in §5B: the notification drain loop cannot run on timers under serverless (drive it with Vercel Cron calling the admin tick), and the in-memory rate limiter becomes per-instance. |

The database is PostgreSQL in production. All SQL written since Phase 2 is
PG-first (no connector-specific behavior; BigInt money, app-enforced enums),
so the switch is configuration, not code.

---

## 2. Deployment artifacts in this repository

| Artifact | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build → standalone server, non-root, `HEALTHCHECK /health` |
| `docker/docker-entrypoint.sh` | Optional `RUN_MIGRATIONS=true` → `prisma migrate deploy` before boot |
| `docker-compose.yml` | Local production-parity stack (app + PostgreSQL 16) |
| `.dockerignore` | Keeps secrets/DB files/dev artifacts out of the image |
| `prisma/postgres/schema.prisma` | **Production schema source of truth** (provider `postgresql`) |
| `prisma/postgres/migrations/` | Committed, additive, production-safe migration set (baseline `00000000000000_init`) |
| `scripts/telegram/setup-bot.ts` | One command: webhook + commands + Mini App menu button (plus `--status` / `--delete`) |
| `.env.example` | Full environment contract with REQUIRED-IN-PROD markers |
| `src/app/health/route.ts` · `src/app/ready/route.ts` | Liveness / readiness probes |
| `DEPLOYMENT.md` | This guide |

---

## 3. Environment variables

Full annotated template: **`.env.example`** (copy → `.env`, fill, never commit).
Validation lives in `src/config/env.ts` (Zod, fail-fast at boot). Summary:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | always | Postgres connection string (see §6 for Supabase forms) |
| `NODE_ENV` | always | `production` on real deployments |
| `JWT_SECRET` | **REQUIRED-IN-PROD** | Session JWT signing (≥32 chars) — `openssl rand -hex 32` |
| `TELEGRAM_BOT_TOKEN` | **REQUIRED-IN-PROD** | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | **REQUIRED-IN-PROD** | Webhook secret header check — `openssl rand -hex 32` (charset `[A-Za-z0-9_-]`) |
| `APP_URL` | **REQUIRED-IN-PROD** | Public HTTPS base URL (webhook + Mini App + deep links) |
| `ADMIN_SECRET` | for admin auth | Admin console context (Phase 21) |
| `ADMIN_TELEGRAM_IDS` | for admin auth | Comma-separated Telegram ids of staff |
| `LOG_LEVEL` | optional | `debug`/`info`/`warn`/`error` (default `info`) |
| `SESSION_TTL_SECONDS` | optional | Session lifetime (default 7 days) |
| `TELEGRAM_AUTH_MAX_AGE_SECONDS` | optional | initData replay window (default 24 h) |
| `PORT` / `HOSTNAME` | platform-set | Standalone server bind (`0.0.0.0` in containers) |
| `RUN_MIGRATIONS` | containers | `true` → entrypoint runs `prisma migrate deploy` |

**Secrets policy** — verified in Phase 23 and re-verified in Phase 26:
`.env*` is gitignored (`.env.example` with empty values is the only tracked
template); no secret material exists in the repository or its history; secrets
are supplied only through the platform secret store (environment groups,
Docker secrets, Vercel encrypted env vars).

---

## 4. Health endpoints

| Endpoint | Semantics | Dependencies touched | Failure response |
|---|---|---|---|
| `GET /health` | **Liveness** — "process alive?" | none (deliberately dependency-free) | never fails unless the process is dead |
| `GET /ready` | **Readiness** — "route traffic here?" | hard-timeboxed (2 s) `SELECT 1` through the game's Prisma path + (prod only) presence of `JWT_SECRET`/`TELEGRAM_BOT_TOKEN` | `503 {status:"unavailable", checks:{…}}` |
| `GET /api/health` | App-level report (version, phase, DB latency, uptime) for the status console | `SELECT 1` | `200 degraded` envelope if DB down |

Configure the platform: **liveness/restart** → `/health`; **load-balancer
gate / deploy blocking** → `/ready`. Docker `HEALTHCHECK` uses `/health`.

---

## 5. Deployment walk-throughs

### 5A. Container platform (Render / Railway / Koyeb) — recommended

1. **Create the database.** Supabase (next section) or the platform's managed
   Postgres. Note the connection string.
2. **Create the web service** from this repository:
   - Environment: **Docker** (the platform builds `Dockerfile` — no extra config).
   - Health check path: `/ready` (deploy gating) and `/health` (restart).
   - Port: the container listens on `PORT` (default 3000); platforms inject it.
3. **Set environment variables** from §3 (`NODE_ENV=production`, `DATABASE_URL`,
   `JWT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `APP_URL`,
   admin vars). Set `RUN_MIGRATIONS=true` **or** register a pre-deploy command
   (next step) — never both per deploy (double `migrate deploy` is harmless —
   Prisma no-ops — but one mechanism keeps the audit trail clean).
4. **Migrations.** Preferred: platform pre-deploy command:
   ```
   bun x prisma migrate deploy --schema prisma/postgres/schema.prisma
   ```
   (Render: "Pre-Deploy Command"; Railway: start-command prefix; Koyeb: build
   or run command.) `migrate deploy` is append-only and no-ops when up to date.
5. **First deploy.** Watch the log for: migrations applied →
   `notification worker started` → `/health` 200. The deploy gates on `/ready`.
6. **Wire Telegram** (§7) — `APP_URL` is now the platform URL.

### 5B. Vercel

1. Import the repository; framework preset **Next.js** (build command default).
2. Add all §3 variables as encrypted env vars; `APP_URL` = the Vercel domain.
3. Database: Supabase with the **pooled** connection string for runtime
   (serverless opens many short-lived connections; see §6).
4. **Notification worker:** serverless functions cannot keep the interval
   loop alive. Instead schedule **Vercel Cron** hitting
   `POST /api/v1/admin/notifications/worker/tick` every minute with an admin
   bearer token (the route is claim-safe, so concurrent ticks never
   double-deliver).
5. **Rate limiting note:** the in-process limiter becomes per-instance on
   serverless (limits enforced per instance, not globally). Acceptable for
   MVP; run the container target if global principal limits matter now.
6. **Webhook:** point Telegram at `https://<vercel-domain>/api/v1/telegram/webhook`.

### 5C. Local production parity (docker compose)

```bash
docker compose up --build
# app:      http://localhost:3000  (/health · /ready · /)
# postgres: localhost:5432 (warlords / warlords-local)
```
The compose app runs with `RUN_MIGRATIONS=true` against a real PostgreSQL —
the same shape as §5A, entirely local. Placeholder credentials are dev-only.

---

## 6. Database & migrations (production-safe)

**Schema layout.** The repository carries TWO committed schema artifacts:

- `prisma/schema.prisma` — provider `sqlite`, the sandbox/dev driver
  (`file:./db/custom.db`), used by `bun run dev` and the test suites.
- `prisma/postgres/schema.prisma` — provider `postgresql`, the **production**
  schema (identical models; additive-only migration set under
  `prisma/postgres/migrations/`, lock file provider `postgresql`).

A regression test (`tests/unit/deploy/deploy-artifacts.test.ts`) fails the
suite if the two schemas drift or if the PG baseline no longer matches the
schema — the split cannot rot silently.

**Why a committed baseline.** Production runs `migrate deploy`, which only
applies recorded migrations from Git — nothing is generated, diffed or
"fixed" at deploy time. The baseline (`00000000000000_init`) is pure
`CREATE TABLE / CREATE INDEX / ADD CONSTRAINT` — additive DDL, no data
destruction possible, safe to re-run (Prisma records applied migrations in
`_prisma_migrations` and no-ops).

**Workflow.**

```bash
# validate the production schema locally
bun run db:pg:validate

# apply to the production database (or let the platform pre-deploy do it)
DATABASE_URL="postgresql://…direct…" bun run db:pg:deploy

# (maintenance) regenerate the baseline after intentional schema changes
bun run db:pg:baseline > prisma/postgres/migrations/<timestamp>_<name>/migration.sql
```

**Supabase specifics.**

- Migrations: **direct** connection (port `5432`, project region):
  `postgresql://postgres:<PASSWORD>@db.<ref>.supabase.co:5432/postgres`
- Runtime: **pooled** (pgBouncer, port `6543`) with
  `?pgbouncer=true&connection_limit=40&pool_timeout=10` — transaction-mode
  pooling requires Prisma's `pgbouncer=true` flag.
- Row Level Security: leave OFF — the app is the only DB client (Phase 2 decision).
- Backups: enable Supabase PITR / scheduled backups before go-live.

**Policy going forward:** every future schema change lands as a NEW migration
directory in `prisma/postgres/migrations/` generated with
`prisma migrate diff --from-schema-datamodel --to-schema-datamodel` (reviewed
by a human), never by editing old migrations; destructive statements require
an explicit, documented two-phase rollout (stop feature → migrate → deploy).

---

## 7. Telegram Bot production setup

The bot transport is already implemented end-to-end (webhook route, secret
gate, command router, Mini App keyboard). Wiring it to the live bot:

1. **BotFather:** create the bot → copy the token →
   `/setdomain` not needed (Mini App served from your own domain).
2. **Configure everything with one command** (from the deployment environment
   or any machine with the prod env vars):
   ```bash
   bun run telegram:setup
   ```
   It calls, in order: `getMe` (identity sanity) →
   `setWebhook(url=<APP_URL>/api/v1/telegram/webhook, secret_token=<TELEGRAM_WEBHOOK_SECRET>,
   allowed_updates=[message, callback_query])` → `setMyCommands` (the five
   real commands) → `setChatMenuButton` (Mini App web_app button → `APP_URL`)
   → `getWebhookInfo` (verification).
3. **What the bot answers today** (each backed by real server data — nothing
   is faked): `/start` onboarding + Play button · `/help` · `/play` ·
   `/profile` (real player/wallet snapshot) · `/rank` (real live season
   ranking + the caller's standing). Commands from the architecture doc whose
   systems have not shipped (/quests /clan /invite /settings) are
   deliberately NOT advertised until they exist.
4. **Inspect / rollback:**
   ```bash
   bun run telegram:status    # getMe + getWebhookInfo (last delivery errors visible)
   bun run telegram:teardown  # deleteWebhook — instantly stops update delivery
   ```
5. **Requirements:** `APP_URL` must be HTTPS with a valid certificate
   (platform-terminated TLS is fine); the webhook secret must match the
   deployment env; Telegram redelivers on 503 — the pipeline treats those as
   transport retries (command handling is read-only and idempotent).

---

## 8. Logging (production-safe)

- **Format:** single-line JSON per event — `{level, time, module?, requestId?,
  playerId?, msg, durationMs?, err?}` (`src/lib/logger`). Platform log drains
  parse it natively; greppable without a shipper.
- **Redaction:** any field whose key matches
  `/token|secret|password|authorization|initdata|cookie|apikey/i` is printed as
  `[REDACTED]`; errors serialize name/message/code/stack — stack traces only,
  never payloads.
- **Query noise:** Prisma per-query logging exists only outside production
  (`src/lib/db.ts` gates it on `isProd`). Production streams carry `error` +
  `warn` engine events and app-level JSON — no query shapes or parameters leak.
- **Privacy:** webhook logging records `update_id` + the command word — never
  message bodies. Audit truth lives in DB ledgers (`resource_transactions`,
  `admin_audit_logs`), not in logs.
- **Levels:** default `info`; raise to `warn` on noisy incidents; `debug` is a
  dev-only tool.

---

## 9. Rollback

1. **Bot off-switch:** `bun run telegram:teardown` (Telegram stops delivering
   updates; players keep sessions and the Mini App keeps working).
2. **Code:** redeploy the previous image/commit — every deploy is a fresh
   container; state lives in PostgreSQL.
3. **Schema:** migrations are additive; rollbacks never reverse migrations —
   revert code and (if required) ship a NEW forward migration. Restoring a
   backup is the nuclear option (documented RPO = provider's PITR window).

---

## 10. Scaling notes

- The notification queue uses atomic per-row claims (count===1 conditional
  UPDATE) — horizontally scaled app instances drain it without coordination.
- The Phase 25 report (`docs/PHASE25-PERFORMANCE-REPORT.md`) holds the measured
  capacity ladder: ~100 players zero-error on sandbox hardware with SQLite;
  the PostgreSQL + production-container topology carries the 200-player MVP
  target (connection pool already tuned via `DATABASE_URL` parameters).
- First vertical lever: raise `connection_limit` with the platform instance
  size; the read pool and write engine are already split.
- Sessions/rate-limit state is DB + in-process; add a shared store only when
  running many instances and needing global rate limits (see §5B note).

---

## 11. Go-live checklist

- [ ] `.env` (platform env group) holds every REQUIRED-IN-PROD var; `APP_URL` is the final HTTPS domain
- [ ] `bun run typecheck && bun run lint && bun test && bun run test:integration && bun run test:e2e` — all green
- [ ] `bun run build` succeeds (standalone output)
- [ ] `docker compose up --build` boots; `curl -f localhost:3000/health` and `/ready` return 200 (local parity)
- [ ] Database created; `db:pg:deploy` applied cleanly (check `_prisma_migrations`)
- [ ] First platform deploy green; deploy gated on `/ready`
- [ ] `bun run telegram:setup` — webhook verified (`telegram:status` shows no delivery errors)
- [ ] Real `/start` from a Telegram account registers a player; Mini App opens from the menu button
- [ ] Backups/PITR enabled on the database
- [ ] Log drain attached (JSON lines visible); alert on `/ready` 503s

---

## 12. Honest limitations register

- In-memory rate limiting is per-process (global limits need a shared store
  when multi-instance — documented in the Phase 23 security report).
- The notification worker runs in-process by design; on Vercel use the cron
  tick (§5B). On container platforms it self-hosts with zero configuration.
- Sandbox/CI cannot run a live PostgreSQL — the PG migration set is validated
  by `prisma validate`, by the schema/baseline parity tests, and by the local
  `docker compose` parity stack; the first Supabase deploy is the final proof.
- Bot commands cover the systems that exist. /quests /clan /invite /settings
  land with their phases — the router falls back to the help card for anything
  unadvertised, so unshipped features can never fabricate answers.
