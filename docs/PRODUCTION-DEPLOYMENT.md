# WARLORDS — Production Deployment & Launch Readiness (Phase 34.5)

> Status document produced by the Phase 34.5 audit. **Mechanics** (how to build,
> configure and deploy) live in the Phase 26 guide [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
> — this document records what was VERIFIED at Phase 34.5, what each launch
> dependency's status is, and every known gap, so an operator never has to
> trust an unaudited claim.

## 0. Verification snapshot (Phase 34.5, HEAD at audit)

| Area | Status | Evidence |
|---|---|---|
| Test baseline | **926/926 ×3 consecutive** | unit 428 · integration 420 · e2e 78, three full consecutive green runs |
| Typecheck / ESLint / Prettier | ✅ clean | executed at audit HEAD |
| DB invariants (`db:verify`) | ✅ ledger reconciles exactly | executed |
| Production build | ✅ **succeeded** (`bun run build`, exit 0, standalone output + static copy) | executed — earlier "sandbox forbids build" notes no longer apply |
| Production startup | ✅ standalone server boots, `/api/health` healthy, `/ready` gates | executed (see §2) |
| Fail-safe env gate | ✅ auth refuses (500, no info leak) and `/ready` returns **503** when REQUIRED-IN-PROD secrets are absent | executed (see §2) |
| PostgreSQL schema | ✅ `prisma validate` on `prisma/postgres/schema.prisma` | offline validation |
| **Real PostgreSQL migration run** | ⚠️ **NOT VERIFIED — no PostgreSQL server reachable from this environment** (no Docker) | the docker-compose parity stack exists (`docker compose up --build`) and is the intended verification path |
| Telegram webhook end-to-end | ⚠️ **NOT VERIFIED — EXTERNAL CREDENTIAL REQUIRED** | real bot token + public HTTPS URL do not exist in this sandbox |
| Monitoring / backups | ⚠️ **NOT CONFIGURED — hosting-side task** | see §6/§7 |

## 1. Launch checklist (ordered)

1. Provision managed PostgreSQL (Supabase / Render Postgres / …) — direct
   (non-pooled) URL for migrations, pooled URL for runtime (see
   `DEPLOYMENT.md §6` for exact Supabase connection forms).
2. Set environment variables from **`.env.example`** — every
   **REQUIRED-IN-PROD** field gates readiness: `JWT_SECRET`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `APP_URL` (must be
   HTTPS), plus `ADMIN_SECRET` + `ADMIN_TELEGRAM_IDS` for admin surfaces.
   Generate secrets with `openssl rand -hex 32`.
3. Deploy the image (`Dockerfile`, non-root, HEALTHCHECK) or run the
   standalone build. Set `RUN_MIGRATIONS=true` **or** run
   `prisma migrate deploy --schema prisma/postgres/schema.prisma` as a
   pre-deploy step (never `migrate reset` / `db:push` against production).
4. First boot creates the world lazily and idempotently:
   `ensureWorldGenerated()` (region-count guard, `db:write` lock, inner
   re-check) inserts the 41×41 grid (1,681 territories, 36 regions,
   deterministic seed 20260901). Running twice inserts nothing new; the
   catalog seed (`db:seed`) is upsert-based and safe to re-run, but is NOT
   required in production (admin/staff provisioning is via ADMIN_TELEGRAM_IDS).
5. Register the bot once: `bun run telegram:setup` (idempotent; sets webhook
   with the shared secret + Mini App menu button). Verify with
   `bun run telegram:status`.
6. Point Telegram at `APP_URL` (HTTPS mandatory — Mini Apps require it),
   confirm `/ready` returns 200, then open the Mini App.

## 2. Startup & fail-safe behavior (verified live)

Executed against the real standalone artifact (`bun run build` →
`bun .next/standalone/server.js`, `NODE_ENV=production`):

- **Secrets present** → `/api/health` `status:"healthy", db:"up"`;
  `/ready` 200 with `config: "required secrets present"`.
- **Secrets absent** → the process boots but every authenticated surface
  fails closed: `/api/v1/auth/telegram` answers `500 INTERNAL_ERROR`
  (the Zod env gate throws on first `getEnv()`; no secret material and no
  stack trace reach the client), and `/ready` returns **503
  unavailable** — orchestrators should treat a non-ready container as the
  deploy gate. Health (liveness) stays 200 so the platform does not
  flap-restart into the same state.
- Production sets `Secure` on the session cookie (`HttpOnly`,
  `SameSite=Lax`), HSTS (`max-age=31536000; includeSubDomains`) and the
  full header set (CSP `frame-ancestors 'self' https://web.telegram.org
  https://*.telegram.org`, nosniff, Referrer-Policy, Permissions-Policy)
  — see `next.config.ts` (Phase 23 audit).

**Artifact hygiene (fixed in this phase):** `next build` copies the
build-host's `.env` into `.next/standalone/.env`; the build script now strips
`.env*` from the artifact (`rm -f .next/standalone/.env …`). The Docker path
was already safe (`.dockerignore` excludes `.env*`). Never build the artifact
on a machine whose `.env` contains production secrets without this strip.

## 3. Environment audit

`.env.example` is the complete contract (validated against the Zod schema in
`src/config/env.ts` — every key the server reads is listed with a safe
placeholder). Secret scan results at audit time:

- No real secrets in tracked files. Two benign fixtures flagged by pattern
  scans: the AWS documentation placeholder key inside a `skills/` design
  template, and explicit fake bot tokens in `tests/unit/telegram/`
  (`…-not-a-real-secret`) — both inert.
- Git history: an early `.env` (initial commit, removed in Phase 1a)
  contained only a local SQLite path — **no secret rotation required**.
- `.env*` is gitignored; only `.env.example` (empty values) is tracked.

## 4. Database procedures

- **Migrations:** committed, additive, ordered under `prisma/postgres/migrations/`
  (baseline `00000000000000_init` + incremental). Apply with
  `prisma migrate deploy` (entrypoint gate or platform pre-deploy). Unit
  tests assert the committed migration set creates every mapped table and
  contains no destructive DDL.
- **Rollback:** the additive-only policy means roll-back is *forward-fix or
  restore-from-backup* — document the choice per migration in the release
  notes; never hand-edit schema state.
- **Initialization:** `db:seed` is idempotent (upserts by unique keys;
  verified by double-run: no duplicated players/territories/regions/quests).
  Production does not need the seed catalogs — the game boots against
  migrations + lazy world generation alone.
- **Data safety:** production startup cannot reset or reseed anything —
  destructive flows (`db:reset`, `db:push`) are dev-only scripts and are not
  invoked by the server, entrypoint, or Docker.
- **Connection behavior:** dedicated write engine + read pool (Phase 25),
  `connection_limit=40&pool_timeout=10` guidance in the compose stack;
  transactions are short (the engines serialize through advisory locks
  rather than long-held write transactions). **Under real PostgreSQL this
  remains NOT VERIFIED — verify pool saturation with a staging load test
  before public launch.**

## 5. Security posture (verified + findings)

Verified live (all refusals are typed, zero-write, pre-auth where possible):
unauthenticated API access → 401; malformed JSON → 400; webhook without the
secret header → **401 (constant-time compare)**; SQL-injection and
path-traversal patterns → stopped at the auth/Zod boundary; oversized bodies
→ bounded by `REQUEST_BODY_MAX_BYTES`. Rate limiting: sliding-window,
per-IP pre-auth + per-principal post-auth groups (Phase 23).

**Findings:**

1. **`X-Forwarded-For` trust (documented gap — open):** `clientIp()` trusts
   the LAST hop of the header. Behind the platform's edge proxy this is the
   correct client address; reached DIRECTLY, an attacker can rotate the
   header to evade the pre-auth per-IP limiter (auth brute-force remains
   bounded by HMAC verification and the principal limiter bounds everything
   post-auth). **Operator requirement:** terminate the app only behind the
   platform proxy and configure it to overwrite (not append) client IP
   headers, or deploy a trusted-proxy-aware limiter before public launch.
2. **Standalone artifact `.env` strip (fixed this phase)** — see §2.
3. **World data integrity (fixed this phase):** capitals claimed before the
   world grid materializes now inherit their deterministic
   `strategicValue`/`defenseStrength` from the pure generator (previously
   schema defaults persisted forever, degrading garrison capacity).

## 6. Observability

- `/health` (liveness), `/ready` (readiness: db + config + worker checks),
  `/api/health` (public JSON: version, phase, db latency) — all verified.
- Structured JSON logs (`src/lib/logger`) with sensitive-key redaction
  (`token|secret|password|authorization|initdata|cookie|apikey`), message
  bodies never logged; request ids on every API log line; game-domain
  lifecycle logs (march/battle/clan/garrison/auth failures).
- **External monitoring (APM, alerting, uptime): NOT CONFIGURED.** Minimum
  pre-launch set: uptime probe on `/ready`, 5xx-rate alert, DB connection
  error alert, webhook 401/503 alert. Honest status: nothing is wired — an
  operator must configure this hosting-side before launch.

## 7. Backups & recovery

**Status: NOT CONFIGURED — hosting-side requirement (do not launch a
persistent-economy game without it).**

Requirement spec for the operator:

- Managed PostgreSQL automated snapshots: **daily minimum**, retention ≥ 14
  days, plus point-in-time recovery (WAL shipping) if the provider offers it
  (Supabase/Render do on paid tiers).
- Restore drill BEFORE launch: restore the latest snapshot into a scratch
  instance, run `prisma migrate deploy` (no-op), boot the app against it,
  verify `/ready` 200 and a player login. Document the measured restore time.
- The world grid is deterministic and re-creatable; player-owned state
  (armies, garrisons, clans, ledger) is NOT — it exists only in backups.
- Application rollback: redeploy the previous image tag (migrations are
  additive; old images run against newer schemas — verify per-release).

## 8. Performance snapshot (dev-server numbers — production will differ)

Executed during the audit (single dev process, 40 concurrent requests per
surface, all 200s): `/api/health` avg 13.1 ms · player-territories 15.1 ms ·
march list 7.6 ms · clan search 11.6 ms. Engine-level load measurements live
in the committed suites (garrison-load L1–L5, march-load, world-load,
battle benchmarks — e.g. 19-reinforcement stack 1.16 s, garrison view ~4 ms,
assault vs 20-contributor garrison ~100 ms). **A production-shape load test
against real PostgreSQL is a pre-launch requirement** (docker-compose parity
stack is the intended vehicle; not runnable in this sandbox).

## 9. Real-device / webhook verification status

- **Mini App browser E2E: VERIFIED** in-sandbox (agent-browser, mobile +
  desktop viewports, zero console errors, no horizontal overflow at 390 px,
  signed-in golden path: clans → world map → garrison deploy/withdraw →
  marches with live countdown). *Telegram-iframe-specific behavior
  (menu button, theme params, fullscreen) remains NOT VERIFIED without a
  real bot.*
- **Telegram webhook E2E: NOT VERIFIED — EXTERNAL CREDENTIAL REQUIRED.**
  The pipeline (secret gate → bounded read → Zod update schema → idempotent
  command router → reply) is unit/integration-tested with fixture tokens;
  a live round-trip needs a real bot token + public HTTPS URL.

## 10. Troubleshooting (common production failures)

| Symptom | Likely cause | Action |
|---|---|---|
| `/ready` 503 `config skipped` | REQUIRED-IN-PROD env missing | set secrets, redeploy (the detail text says "non-production run" when the env gate failed — check all four keys) |
| `/api/health` `db:"down"` | bad `DATABASE_URL` / PG unreachable / pool exhausted | verify direct + pooled URLs; check provider connection limits |
| 401 on every webhook | `TELEGRAM_WEBHOOK_SECRET` mismatch | re-run `bun run telegram:setup` after rotating the secret |
| Auth 500s at boot | env gate threw (missing JWT/bot token in production) | the process is fail-closed by design — fix env, restart |
| Webhook retry storms | permanent send failures are ACKed 200 by design | check logs for `telegram send failed (permanent)` entries |
| Mini App blank inside Telegram | `APP_URL` not HTTPS or not registered | `telegram:setup` after HTTPS is live; check CSP `frame-ancestors` |

## 11. Launch verdict inputs

Green: build · startup · fail-safe gates · migrations (structure) ·
security posture · test baseline · documentation.
Open (own them before public launch): real-PG migration run, live webhook
round-trip, monitoring wiring, backup configuration + restore drill,
production load test, trusted-proxy IP configuration.
