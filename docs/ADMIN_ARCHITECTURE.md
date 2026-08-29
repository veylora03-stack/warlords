# WARLORDS — Admin Architecture

> Phase 0 baseline · Implementation: Phase 9 · Principle: powerful, precise, and permanently auditable.

---

## 1. Access Model

| Aspect | Decision |
|---|---|
| Login | `POST /api/v1/admin/login` — `ADMIN_SECRET` (constant-time) **+** `telegramId ∈ ADMIN_TELEGRAM_IDS` allowlist → admin JWT 8h in **separate** cookie `wl_admin` (never mixed with player session) |
| Roles | `ADMIN` (all ops) ⊂ `SUPERADMIN` (role grants, allowlist management) |
| Rate limit | admin login 5/min/IP; admin reads 120/min; mutations additionally idempotency-keyed |
| Audit | **every** mutation → `admin_audit_logs {actorUserId, action, targetType, targetId, before, after, reason, ip, requestId}` — before/after are JSON snapshots, writes happen in the same tx as the mutation |

## 2. Console Modules

| Module | Capabilities | Safety rails |
|---|---|---|
| **Players** | search (name/telegramId/clan), full inspect (wallet, army, ledger tail, battles tail, sessions) | read-only |
| **Moderation** | ban / unban (reason required; temp via `banExpiresAt`) | ban instantly blocks via middleware; both audited |
| **Economy ops** | adjust-resources `{resource, delta≥? signed, reason}` (idempotency-key) | ledger `reason=admin_adjust`; clamp ≥0; player notified; 24h mint/burn dashboard |
| **Economy insight** | `/admin/economy/overview` — supply per resource, mint/burn 24h/7d, top balances, market velocity (ledger aggregates) | read-only |
| **Battle inspection** | battle list/detail/rounds + **replay verify** (re-run engine vs stored result) | read-only; integrity sweep mode |
| **Clans & world** | clan inspect/transfer leadership/disband (with cascading audit); territory inspect; event spawn/stop | destructive ops require typed confirmation phrase |
| **Announcements** | audience ALL/CLAN/PLAYER, schedule, preview before publish | preview-first; deactivatable |
| **Audit viewer** | filter by actor/action/target/time; CSV export | read-only |

## 3. Operational Runbooks (encoded as guided flows)

- **Exploit response**: freeze (ban) → inspect ledger/battles → replay-verify suspect battles → rollback policy = targeted compensating ledger entries (`reason=admin_compensation`, audited) — never manual DB edits.
- **Balance hotfix**: config change + deploy (no data migration); battle history safe via `configVersion` snapshots.
- **Event ops**: spawn GOLD_RUSH/NPC_INVASION with config payload; auto-expiry; participation metrics from ledger/events.

## 4. Non-Goals (MVP)

No inline SQL console, no bulk-edit UI (scripts with audit path instead), no cross-server tooling — single world.
