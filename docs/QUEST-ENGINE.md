# WARLORDS — Quest + Achievement Engine (Phase 31)

Status: **PRODUCTION READY (with documented scope boundaries)** · Baseline: Phase 28 battle
engine (643 tests) → Phase 31 total: **702/702 tests green** (343 unit · 310 integration ·
49 E2E).

---

## 1. Architecture

```
GAME ACTION (real service transaction)
  battle.service.attack()          city.service.finishBuildingUpgradeInTx()
  army.service.completeTrainingInTx()  power.service.recalculatePlayerPower()
  progression.service.grantXp()    economy.service.applyResourceDeltas()
        │  (same transaction, after the real mutation)
        ▼
applyQuestEventInTx(tx, playerId, typedEvent)
        │
        ├─ ensureQuestAssignmentsInTx   — lazy expiry + unique-guarded assignment
        ├─ matchesObjective (pure)      — strict filters (buildingType/unitId/resource/level)
        ├─ eventContribution (pure)     — INCREMENT (delta) or SET (monotonic value)
        ├─ applyContribution (pure)     — clamped at target, never decreasing
        └─ on completion: questsCompleted stat + QUEST_COMPLETED notification
        ▼
status: ACTIVE → COMPLETED  (reward becomes CLAIMABLE)
        ▼
POST /api/v1/quests/[id]/claim   (the ONLY player-triggered mutation)
        │  one economy transaction:
        ├─ guarded transition updateMany(status='COMPLETED') → count===1 arbiter
        ├─ grantResources(QUEST_REWARD, idempotencyKey)
        ├─ grantXp (CAS) + honor increment
        └─ REWARD notification
        ▼
LEDGER  (Σ ledger deltas == balance invariant preserved)
```

Achievements run as a parallel permanent layer over the same events:
`evaluateAchievementsInTx` (called by the battle/city/army services after their stats
writes) → DB-unique unlock → auto reward (ACHIEVEMENT_REWARD ledger / XP / honor) →
ACHIEVEMENT_UNLOCKED notification.

**Server-authoritative by construction** — the client has NO write surface for quest
progress, completion, rewards, event payloads or eligibility. The claim route reads the
player id from the session, the reward from the DB catalog; the body is empty by contract.

## 2. Quest types (data-driven)

| `type`    | Cycle id                          | Reset boundary (UTC server clock)        | Instance expiry                    |
| --------- | --------------------------------- | ---------------------------------------- | ---------------------------------- |
| MAIN      | `'0'` (permanent)                 | never                                    | never                              |
| DAILY     | `YYYY-MM-DD`                      | UTC midnight                             | next UTC midnight                  |
| WEEKLY    | ISO-8601 `YYYY-Wnn`               | Monday 00:00 UTC                         | next Monday 00:00 UTC              |
| SEASONAL  | season number                     | season lifecycle                         | `season.endsAt` (rewards EXPIRE)   |
| ACHIEVEMENT / CLAN / EVENT | `'0'`           | (reserved — not seeded this phase)       | —                                  |

Objective taxonomy (`objectiveType` → progress mode):

* **INCREMENT** — `WIN_BATTLES` (+1 per won battle, either role) · `BUILD_UPGRADE` (+1,
  optional buildingType/level gates) · `TRAIN_UNITS` (+batch count, optional unitId gate) ·
  `EARN_RESOURCE` (+credited amount, optional resource gate) · `SPEND_RESOURCE` (+debited)
* **SET** (monotonic — can never decrease) — `REACH_POWER` · `REACH_LEVEL`
* **Reserved extension points** (no events exist — inert by construction):
  `CAPTURE_TERRITORIES`, `CONTROL_TERRITORIES`, `DEFEND_TERRITORIES`, `JOIN_CLAN`,
  `SCOUT_TARGET`.

**Honest scope note:** the World/Territory engine has NOT landed in this repository
(verified: no commits, no service, `db.territory` unused). The Phase 31 spec's
territory quests (CONQUEROR / LAND LORD / DEFENDER) are therefore **not seeded** — the
engine must never consume fake events. The extension points above + the typed event union
are the drop-in surface for that phase.

## 3. Initial catalog (seeded)

* **MAIN chain**: First Steps (earn 200 gold) → Raise an Army (10 swordsmen) → Give Your
  Home Teeth (Town Hall 2) → **First Battle** (win 1) → **Warlord** (win 10). Prerequisite
  chains unlock on CLAIM.
* **DAILY**: Gold Tribute (500 gold) · Blood and Steel (2 wins) · Drill Yard (20 units).
* **WEEKLY**: Master Builder (5 upgrades) · Recruiter (100 units) · Resource Tycoon
  (5,000 gold).
* **Achievements (permanent, never reset)**: First Blood · Town Rising · Hoarder ·
  Warlord · Centurion (100 wins) · Grand Marshal (1,000 units) · Veteran Commander (lvl
  10) · Season Champion (top 3) · Season Veteran (top 50 — evaluated at settlement via
  the SEASON_TOP metric).

## 4. Progress model

* Per-player instances (`PlayerQuest`) unique on **(playerId, questId, cycle)** at the DB
  level — assignment is idempotent under concurrency (pre-read + createMany; the unique
  constraint is the cross-system backstop).
* `target` is snapshotted from the catalog at assignment; progress is clamped
  (`min(target, …)`), SET-mode is monotonic.
* Eligibility (server-decided): active catalog + computable cycle + `minLevel` gate + all
  `prerequisiteQuestIds` CLAIMED.
* Assignment sweeps run on every quest event **and** on the board read (documented
  deviation from transaction-free read paths: assignment is a bounded per-player upsert
  behind the process-wide write mutex — it is what makes daily/weekly quests appear
  without gameplay).

## 5. Exactly-once & idempotency

| Guarantee                        | Mechanism                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Action replay ⇒ no double progress | Battle/grant idempotency replays short-circuit **before** their tx (and thus before the event hook) |
| Immediate duplicate event delivery | `lastEventKey` per instance — same event identity is a no-op                |
| Concurrent claims (10×)          | Guarded status transition `updateMany({id, status: 'COMPLETED'})` — the DB is the arbiter; one winner, nine typed `QUEST_ALREADY_CLAIMED` |
| Reward granted once              | Status flip + `grantResources(idempotencyKey=quest_claim:{player}:{quest}:{cycle})` in ONE tx; rollback reverts both |
| Achievement unlock once          | `PlayerAchievement @@unique([playerId, achievementId])` + P2002 skip         |
| Achievement reward once          | Unlock row + ledger payout commit in the same tx (idempotent grant key)      |

**Threat-model note:** quest events are not transportable messages — they are function
calls inside their producing transaction. There is no event bus that can redeliver an old
event; the dedupe layers above cover redelivery-at-the-source (retried requests, replayed
grants).

## 6. Economy integration

* Quest rewards: `LEDGER_REASONS.QUEST_REWARD` (new in Phase 28 schema, now live).
* Achievement rewards: `LEDGER_REASONS.ACHIEVEMENT_REWARD` (added, additive).
* XP via the existing `grantXp` (CAS) → level ups ride `RANK_CHANGE`; honor via the player
  column (same pattern as battles).
* No second wallet. `Σ ledger deltas == balance` is asserted by tests after claims.
* Unsupported reward keys (e.g. `ITEM`, `ENERGY`, `COMMANDER`) **fail the claim CLOSED**
  (`QUEST_REWARD_INVALID`, 500) — a reward can never silently shrink.
* Resource-activity hook: `recordLedgerActivityInTx` runs at the end of
  `applyResourceDeltas` — the single choke point for ALL credits/debits. Exclusions
  (documented): `BOOTSTRAP` (welcome gift ≠ collection; prevents auto-completing early
  objectives) and `ADMIN_ADJUSTMENT` (operator corrections are not gameplay).
* Stats backfilled at hook points: `questsCompleted`, `unitsTrained`,
  `buildingsConstructed`, `resourcesCollected`, `resourcesSpent` (catalog keys that
  existed but were never written before Phase 31).

## 7. Season integration

* SEASONAL quests bind to the **ACTIVE** season (`resolveSeasonStateInTx`, extracted into
  the dependency-free `season-state.service` leaf to avoid import cycles).
* Decision (spec §18): **unclaimed seasonal rewards EXPIRE at the season boundary**
  (`expiresAt = season.endsAt`; claim past the boundary → typed `QUEST_EXPIRED`).
  Completed daily/weekly rewards remain claimable (player-friendly, documented).
* No cross-season pollution: a new season = new cycle = fresh instances (tested at the
  boundary).

## 8. API

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /api/v1/quests?filter=active\|completed\|claimable\|all` | player | Board + counts; assigns due quests |
| `GET /api/v1/quests/[id]` | player | Single-quest detail |
| `POST /api/v1/quests/[id]/claim` | player | The only mutation; empty body by contract |
| `GET /api/v1/quests/achievements` | player | Permanent board + progress |
| `POST /api/v1/admin/quests/[id]/active` | `quests.manage` | Enable/disable (assignment stops; instances untouched) |
| `POST /api/v1/admin/players/[id]/quests/[questId]/reset` | `quests.manage` | Delete instance(s), optional cycle |
| `POST /api/v1/admin/players/[id]/quests/[questId]/grant` | `quests.manage` | Mark COMPLETED — reward still flows through the normal claim (no injection surface) |
| `POST /api/v1/admin/players/[id]/quests/[questId]/revoke` | `quests.manage` | Delete COMPLETED-unclaimed instance; **claimed rewards are never clawed back** |

All admin ops are transactional + audited (`quest.set_active`, `quest.reset_player_quest`,
`quest.grant_completion`, `quest.revoke_completion`). RBAC: `quests.view` (moderator+),
`quests.manage` (admin only) — added to the ADMIN_SCOPES matrix.

## 9. Database changes (additive only)

```text
Quest         +minLevel Int @default(0)     — server-side eligibility gate
              +@@index([isActive])          — assignment sweep filters the active subset
PlayerQuest   +cycle String @default("0")   — assignment period (permanent/date/week/season)
              +lastEventKey String?         — audit: source event identity of last write
              +@@unique([playerId, questId, cycle]) — idempotent re-assignment
Achievement   +metric String @default("STAT") — STAT|BUILDING_LEVEL|PLAYER_LEVEL|PLAYER_POWER|SEASON_TOP
              +meta Json?                   — metric qualifier ({statKey}|{buildingType}|{rank})
```

Migrations: `prisma/migrations/20260901000000_quest_engine` (SQLite, table-rebuild form)
and `prisma/postgres/migrations/20260901000000_quest_engine` (additive ALTERs). Both
schemas remain model-identical (deploy-artifacts test guards this).

## 10. Security matrix (tested)

Forged progress — impossible (no client-write surface; claim body is empty) · claim
incomplete → 409 `QUEST_NOT_COMPLETED` · claim another player's instance → unreachable
(scoped queries; 404/409) · double claim → 409 `QUEST_ALREADY_CLAIMED` ×9 under 10-way
concurrency · replay event → no-op · modified quest id → 404 · modified reward →
impossible (server catalog) · expired quest → 409 `QUEST_EXPIRED` · season mismatch → not
assigned / 409 · anonymous → 401 · disabled quest → not assigned · minLevel gate → not
assigned.

## 11. Performance (measured, SQLite dev baseline)

| Scale | Path | Result |
| --- | --- | --- |
| 100 events | per-event economy tx (realistic) | ~9.7 ms/event |
| 1,000 events | batched 100/tx | ~3.8 ms/event |
| 10,000 events | batched 500/tx | ~3.5 ms/event — **flat, no N+1** |
| Immediate redelivery ×250 | same tx | zero progress change (no-op) |
| Board read (12 quests) | single projection | ~25–29 ms |

Query shape per event: 1 player read + 1 catalog read + 1 expiry updateMany + 2 instance
reads + O(matched) updates. Board: fixed query count regardless of scale.

## 12. Mini App

`Quests & Achievements` section (`src/features/quests/*` + integration into
`src/app/page.tsx`): DAILY / WEEKLY / MAIN / ACHIEVEMENTS tabs, counts strip, progress
bars, reward chips, `[ CLAIM ]` with typed-failure toasts, CLAIMED ✓ / EXPIRED / locked
states with prerequisite + level reasons. Real data only — no mock state. Verified live in
a real browser: board render → server-driven completion → CLAIM click → toast → counts
update; no console errors; no horizontal overflow at 390 / 768 / 1280 px.

## 13. Files

* Engine: `src/lib/game/engine/quest/progress.ts` (pure), `quest-events.service.ts`,
  `quest.service.ts`, `achievement.service.ts`, `season-state.service.ts` (extraction).
* Wiring: `battle.service.ts`, `city.service.ts`, `army.service.ts`, `economy.service.ts`
  (ledger choke point), `power.service.ts`, `progression.service.ts`.
* Schema/seed: `prisma/schema.prisma`, `prisma/postgres/schema.prisma`, both migration
  folders, `prisma/seed.ts`, `config/quests.ts`, `config/achievements.ts`,
  `config/economy.ts`, `config/notifications.ts`, `config/admin.ts`, `config/stats.ts`
  (unchanged), `types/common.ts`, `api/errors.ts`, `config/starter.ts` (unchanged).
* APIs: `src/app/api/v1/quests/**` (4 routes), `src/app/api/v1/admin/quests/**`,
  `src/app/api/v1/admin/players/[id]/quests/[questId]/**` (3 routes).
* Frontend: `src/features/quests/**`, `src/app/page.tsx` (additive section).
* Tests: `tests/unit/game/quest-engine.test.ts` (22), `tests/integration/quests/
  quest-engine.test.ts` (22), `tests/integration/quests/quest-load.test.ts` (5),
  `tests/e2e/quests-journey.test.ts` (10). Updated invariants:
  `notifications-config.test.ts` (13 types), `catalogs-config.test.ts` (cycle-based reset
  contract).

## 14. Known limitations

1. **Territory quests deferred** — the World/Territory engine (claimed as "Phase 30") is
   not present in this repository; CONQUEROR/LAND LORD/DEFENDER style quests and the
   TERRITORY_* events will land with that phase (extension points ready).
2. **Production build not executed in this sandbox** — the environment forbids
   `bun run build`; compensating controls: clean `tsc --noEmit`, clean eslint, clean
   prettier, all routes compile in the dev server, 702/702 tests green.
3. Assignment sweep on `GET /quests` writes (bounded, unique-guarded) — a documented
   deviation from transaction-free read paths.
4. Season-settlement evaluation of SEASON_TOP achievements is wired through the metric +
   context parameter; hooking it into the settlement service remains a follow-up if
   settlement-phase achievement grant behavior is desired before next season.
5. `lastEventKey` dedupe covers immediate redelivery; events carry globally-unique
   per-occurrence identities by construction (battleId, queueItemId, ledger ref) so no
   broader replay window exists to defend.
