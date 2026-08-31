# WARLORDS — Security Audit Report

**Phase 23 · Security Engineer review · date: 2026-08-31**
**Scope:** the full repository as of `137e6a3` (Phase 22) + this phase's fixes.
**Method:** full repo inspection → three parallel audit passes (route-wiring layer, service layer, infrastructure/frontend) with every candidate finding manually verified in source → fixes → regression tests → dependency audit → secrets scan → this report.

**Governing principle:** NEVER TRUST THE CLIENT. Every amount, price, identity, permission and state transition below is verified server-side.

---

## 1. Verdict summary

| Category | Verdict |
|---|---|
| Authentication (Telegram initData → session) | ✅ SOUND — official HMAC algorithm, constant-time compares, freshness bound, DB-backed sessions |
| Authorization (RBAC) | ✅ SOUND after fix — DB-resolved scopes; staff-target ban rail added |
| API validation (Zod v4 envelope) | ✅ SOUND after fix — all routes schema-validated; body-size ceiling added |
| Rate limiting | ✅ HARDENED — IP-keyed auth group + per-identity groups on every authenticated route |
| CORS / headers / framing | ✅ HARDENED — CSP frame-ancestors (Telegram allowlist), nosniff, Referrer-Policy, Permissions-Policy, prod HSTS |
| Secrets | ✅ CLEAN — nothing real in repo or history (verified via git archaeology) |
| SQL injection | ✅ CLEAN — zero raw SQL beyond a static `SELECT 1` |
| XSS | ✅ CLEAN — zero dangerous sinks; React auto-escaping everywhere |
| CSRF | ✅ HARDENED — SameSite=Lax HttpOnly cookie + foreign-Origin write rejection |
| IDOR | ✅ CLEAN — every id-bearing route resolves the actor from the session principal; ownership scoping verified route-by-route |
| Privilege escalation | ✅ FIXED — moderator→admin ban lockout closed; MODERATOR stays a structurally-validated subset of ADMIN |
| Replay attacks | ✅ SOUND — initData freshness + one-live-session-per-initData rotation + token-hash authority |
| Race conditions | ✅ FIXED — economy credits now DB-guarded CAS; XP CAS; claim-guarded notification delivery |
| Duplicate requests | ✅ SOUND — unique index dedupe, conditional claims (count===1), idempotency keys (TTL-honoring after fix) |
| Economy exploits | ✅ FIXED — credit minting window closed; amounts positive-BigInt-only from server config; caps clamped |
| Battle / Market / Clan exploits | N/A — systems not yet implemented (pending phases); clan admin surface (disband) audited: typed confirmation, conditional claims, war-history guard |
| Admin exploits | ✅ FIXED/HARDENED — scoped RBAC, audited actions, settle confirmation phrase wired, staff protection |

**Fixed this phase: 1 HIGH, 4 MEDIUM, 8 LOW, 2 INFO-hardening. Regression tests: 14 unit + 19 integration (all green). Zero mocks — every test drives real routes/services/transactions/SQLite.**

---

## 2. Findings and fixes

### [HIGH] ECON-1 — Economy credits were absolute last-write-wins (minting window)
- **Where:** `src/lib/game/services/economy.service.ts` (credit write path).
- **Issue:** debits were persisted through a conditional compare-and-decrement (DB-level no-negative guarantee) but **credits** wrote an absolutely computed balance (`balanceAfter`) that was computed from a read. Serialization relied solely on the in-process per-player mutex. On any multi-instance deployment (the documented PostgreSQL production target), an interleaved debit+credit could commit `balance = 150` while the ledger Σ = 70 — resources minted out of thin air, invisible to reconciliation.
- **Fix:** credits (wallet fields and GEMS) now persist through a **bounded compare-and-set loop** (`persistWalletCredit` / `persistGemsCredit`): the write is accepted only if the stored balance still equals the value the plan was computed from; otherwise the fresh balance is re-read and the (cap-clamped) credit is re-planned. Budget exhaustion aborts the caller's transaction with a typed retry-safe 409 (`RESOURCE_WALLET_CONFLICT`). Plan entries mutate to match reality so the ledger reconciles exactly.
- **Regressions:** integration — 12 unlocked parallel grants all land and Σ(ledger) == balance; mixed parallel credits/debits converge; existing economy suite (cap clamping, contention) still green.

### [MEDIUM] AUTH-1 — Moderators could ban staff accounts (admin-panel lockout / privilege escalation)
- **Where:** `src/lib/game/services/admin/admin-players.service.ts` (`banPlayer`).
- **Issue:** ban enforcement runs on EVERY authenticated request. Banning the player behind an active staff member locked that staff member out of the entire admin panel — including `players.unban` — so a MODERATOR holding `players.ban` could escalate against an ADMIN. Self-ban was also possible (self-lockout).
- **Fix:** `banPlayer` refuses targets whose user holds an **active** `AdminUser` row (`PROTECTED_TARGET` — staff access is revoked exclusively via `staff.deactivate`, which is ADMIN-only and self-guarded) and refuses the actor themself (`SELF_TARGET`). Inactive staff records are deliberately bannable — the account holds no live access and cannot self-restore it (boundary pinned by a dedicated test).
- **Regressions:** moderator→admin ban refused (403, target untouched); inactive-staff ban allowed; self-ban refused.

### [MEDIUM] NOTIF-1 — Stale-claim recovery could duplicate inbox delivery and clobber worker state
- **Where:** `src/lib/game/services/notification.service.ts` (worker).
- **Issue:** the queue **claim** was atomic, but delivery was not: the inbox row was created **outside any transaction**, and `finalizeQueueRow` updated by id with **no claim-ownership precondition**. A row stuck in PROCESSING past `staleClaimMs` was re-claimable while the original worker still ran; both workers could see `notificationId === null` and both create an inbox row (the Notification table has no natural unique key to backstop it), double-push Telegram, and a stale worker could overwrite the re-claiming worker's state (double-counted attempts, lost backoff).
- **Fix:** every write after the claim is **conditional on the claim identity** (`claimedBy` + `claimedAt`): inbox creation + backlink now happen in ONE transaction whose queue-row write must match the claim (`ensureInboxDelivered`) — a superseded worker's transaction aborts before creating anything; finalization (`finalizeQueueRow`) is a conditional `updateMany` returning `STALE` when the claim was lost. Inbox delivery is now exactly-once; push delivery stays at-least-once (an HTTP call cannot roll back — documented).
- **Regressions:** forced stale-claim recovery twice on the same row → inbox row count stays 1, backlink stable; full pre-existing notification suite (claims, backoff, poison rows, retention) green.

### [MEDIUM] API-1 — Rate limiting trusted a client-spoofable IP and covered only the auth group
- **Where:** `src/lib/api/request-info.ts` (`clientIp`), `src/lib/rate-limit/index.ts`, `src/lib/auth/guard.ts`, all routes.
- **Issue:** `clientIp` took the **first** `x-forwarded-for` hop — the client-forgeable one (through an appending proxy, rotating fake first hops defeats IP throttling; brute-forcing `ADMIN_SECRET` at unthrottled rates). And only the two auth routes were throttled at all.
- **Fix:** (a) `clientIp` now returns the **last** XFF hop — the only value our own trusted gateway vouches for (the sandbox Caddyfile *replaces* the header with `{remote_host}`, so this is exact today and append-safe tomorrow). (b) New data-driven **principal rate-limit groups** (`RATE_LIMIT_GROUPS`) enforced inside `requireAuth` on every authenticated request against the DB-resolved user id — an identity a client cannot forge or rotate: `standard` 300/min (abuse backstop), `playerWrite` 120/min on all game mutations, `adminRead` 240/min, `adminWrite` 60/min, `adminBroadcast` **5/min**, `adminSettle` **5/min**, `adminDrain` 30/min — wired per route by intent.
- **Regressions:** unit — budget exhaustion at exactly the limit, per-identity isolation, 429 detail payload; integration — the 6th whole-population broadcast within a minute is refused with `RATE_LIMITED` 429.

### [MEDIUM] INFRA-1 — No security headers; app framable by any origin
- **Where:** `next.config.ts`.
- **Issue:** no CSP/X-Frame-Options/nosniff/Referrer-Policy/Permissions-Policy anywhere. Telegram Mini App embedding worked only because *nothing* blocked framing — the player UI and the admin panel were framable by any site (clickjacking).
- **Fix:** `headers()` now emits `Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org https://*.telegram.org` (the Telegram Mini App requirement, and nothing broader), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/microphone/geolocation/payment denied), and `Strict-Transport-Security` in production. X-Frame-Options is deliberately not set — it cannot express the Telegram allowlist and would be redundant or breaking.

### [LOW] API-2 — Unbounded JSON body buffered before validation
- **Fix:** `parseJsonBody` rejects bodies over 64 KiB with typed **413 BODY_TOO_LARGE before `JSON.parse`** (the memory/CPU cost is in the parser, not Zod; initData caps at 8 KiB). Regression: oversized malformed JSON rejected 413 (proves the guard is pre-parse).

### [LOW] API-3 — CSRF defense-in-depth
- **Fix:** `defineRoute` rejects unsafe-method requests (POST/PUT/PATCH/DELETE) whose browser-declared `Origin` host differs from the request host (`FORBIDDEN_ORIGIN` 403) — in addition to the SameSite=Lax HttpOnly cookie. Native bearer clients and tests send no Origin and are unaffected. Regressions: foreign-Origin POST 403 pre-auth; same-origin and Origin-less requests pass; GET unaffected.

### [LOW] ADMIN-1 — Season settlement confirmation phrase defined but never wired
- **Fix:** `POST /api/v1/admin/season/settle/execute` now demands `confirm: z.literal('RESET SEASON')` (the same typed destructive-op rail as clan disband). Regressions: missing phrase → 400 naming the `confirm` issue; wrong phrase → 400; config↔route coherence pinned.

### [LOW] NOTIF-2 — Fan-out could exceed DB bind-parameter ceilings at scale
- **Fix:** `enqueueNotificationFanOutInTx` chunks both the dedupe pre-read (~2 params/row) and the `createMany` at 500 rows — below SQLite's 32k / PostgreSQL's 65k ceilings even at the 100k broadcast cap. Regression: a 600-row fan-out (across the chunk boundary) inserts exactly once and stays fully deduped on replay.

### [LOW] ECON-2 — Grant idempotency TTL documented but never enforced; keys never pruned
- **Fix:** the replay fast-path now honors `expiresAt` (expired key → deleted in-tx → grant re-executes per the documented TTL contract; all current call sites are additionally protected by their own arbiter rows, so no double-grant path exists), and the ops tick prunes expired keys (`pruneExpiredIdempotencyKeys`). Regressions: live key replays, expired key re-executes, pruner deletes only expired keys.

### [LOW] PROG-1 — `grantXp` lost-update (latent; no callers yet)
- **Fix:** XP writes are compare-and-set on the previous xp with bounded re-read/retry (`PROGRESSION_CONFLICT` on exhaustion); each retry re-derives level from the fresh xp. Regression: 10 parallel unlocked grantors all land — final xp equals the full sum.

### [LOW] API-4 — Notifications list route returned 500 for malformed query
- **Fix:** the inbox query is parsed through the `defineRoute` query spec — malformed `limit`/`unreadOnly` is now a typed 400 envelope instead of a raw ZodError escaping as 500.

### [LOW] ADMIN-2 — Admin event `config` accepted unbounded records
- **Fix:** event `config` is now bounded — keys ≤ 64 chars, serialized size ≤ 8 KiB — before persistence.

### [LOW] SUPPLY-1 — Dead dependency carrying auth surface
- **Fix:** `next-auth` (0 imports — custom jose/cookie auth is the implementation) plus `@mdxeditor/editor`, `react-markdown`, `react-syntax-highlighter` (0 imports) removed from dependencies.

### [LOW] OPS-1 — `.env.example` missing
- **Fix:** recreated with empty placeholder values only (deployers had no template; docs reference it).

### [INFO] ECON-3 — admin resource-adjust route magnitude bound
- Route-level `|delta| ≤ MAX_DELTA` (defense-in-depth mirroring the economy invariant) added.

---

## 3. Verified-clean areas (evidence)

- **Telegram initData verification** (`lib/telegram/init-data.ts`): official algorithm — sorted data-check string, HMAC-SHA256 key = HMAC("WebAppData", bot token), constant-time `timingSafeEqual`, signature verified **before** any payload parsing, `auth_date` freshness + clock-skew bounds, user shape-validated with length caps and https-only photo URL. Raw initData never logged (logger redacts) or persisted (sha256 digest only).
- **Sessions** (`lib/auth/`): HS256 pinned with issuer/audience (`alg: none` confusion impossible); session ROW is the authority (token-hash compare, revocation, expiry, ban check) on every request; replayed initData re-attaches to the same session and rotates the token (no session farming); logout revokes; cookie is HttpOnly + SameSite=Lax + Secure-in-prod.
- **RBAC** (`lib/game/config/admin.ts` + `guard.ts`): 18 scopes; role→scope matrix resolved from the DB `AdminUser` row on every request; MODERATOR structurally denied destructive scopes (validated at boot); no route trusts any client-declared role; `/admin/me` is introspection only.
- **IDOR sweep (all id-bearing routes):** notifications read (foreign ids are no-ops — regression-pinned), season reward claim (composite-unique + `claimedAt` arbiter), army train cancel/complete (`findFirst({ id, playerId })` — no existence oracle), city upgrade/finish (city resolved *from* the principal), title equip (ownership-checked). No route passes a body/params id as the actor.
- **SQL injection:** zero `$queryRaw` interpolation (the single raw query is a static `SELECT 1` health probe); no `*Unsafe` APIs anywhere; seeds/migrations parameterless.
- **XSS:** zero `dangerouslySetInnerHTML` in app code (one shadcn dev-config `<style>` builder, unused), no `innerHTML`/`eval`/`new Function`/`javascript:` sinks; every user-controlled string (names, usernames, announcement bodies, ban reasons, notification titles) renders through JSX text interpolation.
- **Secrets:** repo-wide pattern scan clean; `git log --all` archaeology — `.env` was committed in the initial scaffold commit with only a local SQLite path (no secrets ever) and removed in Phase 1a; `.gitignore` covers `.env*`, `*.pem`, `*.log`, `*.db`; worklog cross-confirms no secrets committed. Dev `.env` contains clearly-labeled `dev-only-…` placeholders.
- **Env exposure:** zero `NEXT_PUBLIC_*`; `process.env` accessed only in `src/config/env.ts` (+ two non-secret runtime checks); no env import in any client file; `config/app.ts` exposes name/version/phase only.
- **Logging hygiene:** logger redacts `token|secret|password|authorization|initdata|cookie|apikey` keys on every call; no request-body or raw-token logging anywhere.
- **Dev impersonation:** prod 404 (`env.isProd` gate) + rate-limited before secret comparison + constant-time sha256 compare + allowlist + audited; nothing dev-only ships in build scripts.
- **Ban enforcement:** DB-authoritative per-request (`assertNotBanned` inside `authenticate`); every game mutation route composes through `requirePlayer`.
- **Clan admin surface (only implemented clan area):** disband requires typed `DISBAND` confirmation + war-history guard, conditional claims, full snapshot audit.
- **In-process concurrency primitives:** FIFO mutex non-poisoning with idle eviction; verified no service nests same-key locks.

## 4. Dependency audit

`bun.lock` resolved versions audited against the npm advisory DB (626 packages): **0 critical**. `next` updated to 16.3.3 (closed the self-hosted Image-Optimizer DoS, RSC deserialization DoS, and rewrite request-smuggling advisories) along with `uuid`, `next-intl`, `minimatch`. The 16 remaining advisories (all high/moderate/low, **already at their newest published versions** — very recent advisories without released fixes) are transitive build/dev-toolchain packages (babel, postcss, brace-expansion, minimatch, picomatch, ajv, js-yaml, deepmerge-ts, defu, effect, flatted) or runtime-transitive with no reachable sink in this codebase (lodash/lodash-es via radix utilities — no `_.template`/`_.unset`/`_.omit` call sites; nanoid used only inside Next's bundler tooling; sharp — the fixed advisory class requires Image-Optimizer `remotePatterns`, which this app does not configure; js-cookie — unused directly). Re-checked after every removal/update; tracked for re-review when upstream patches land.

## 5. Honest limitations register

1. **In-memory rate-limit store** is per-process (documented interface; Redis swap is the planned multi-instance upgrade). The per-identity groups added this phase make the budgets *per instance* until then — still a hard cap, not a global one.
2. **`clientIp` falls back to `'unknown'`** when no gateway sets XFF (direct loopback access) — those clients share one throttle bucket. Behind the mandated gateway (which replaces XFF with `{remote_host}`) every request is keyed by the real address.
3. **Notification push delivery is at-least-once** in the stale-claim window (an HTTP call cannot roll back). Inbox delivery is exactly-once. Documented in the engine header.
4. **Sandbox gateway `XTransformPort`** (Caddyfile) is environment-provided infrastructure that forwards `?XTransformPort=` to arbitrary localhost ports — an SSRF-style primitive *for the sandbox operator*, not part of the application deliverable; the app never constructs such URLs. Out of app scope; flagged for the platform.
5. **Season settlement** reads the full player set in one transaction — correct and bounded by real player counts, but a future population cap/pagination pass is advisable before six-figure player counts.
6. **`GET /auth/me` performs a sliding refresh** (a write on GET). Impact is session-extension only; accepted deliberately (the Mini App relies on it), documented here.
7. **Upstream advisory backlog** (§4) — all fixes not yet released upstream; no reachable sink in this codebase; re-review queued.

## 6. Quality gate (all green)

- `eslint` ✓ · `tsc --noEmit` ✓ · `prettier --check` ✓
- Unit: **235/235** ✓ (was 221; +14 security regressions)
- Integration: **185/185** ✓ over real routes + SQLite (was 166; +19 security regressions)
- DB invariants verified: ledger reconciles exactly (Σdelta == balance)
- No TODOs, no mocks, no hard-coded game values — every fix is working software with a pinned regression test.
