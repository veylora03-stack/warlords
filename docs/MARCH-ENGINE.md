# WARLORDS — March & Army Movement Engine (Phase 33)

> Server-authoritative army movement: CITY → ARMY → MARCH → TRAVEL →
> DESTINATION → ARRIVAL → ACTION → RETURN / RETREAT. Built on top of the
> EXISTING battle, world/territory, economy, quest, achievement, ranking,
> notification, season, idempotency and locking systems — no engine is
> duplicated and no new infrastructure is introduced.

## 1. Architecture

```
POST /api/v1/marches                    (create: validate → reserve → travel math → EN_ROUTE)
GET  /api/v1/marches                    (list; lazily processes due marches first)
GET  /api/v1/marches/[id]               (one march, owner-only)
POST /api/v1/marches/[id]/cancel        (recall while EN_ROUTE)
POST /api/v1/marches/[id]/process       (server-clock progress check)
        │
        ▼
march.service (march:engine → db:write lock order)
  ├─ engine/march/movement.ts   PURE: distance, stacks, state machine
  ├─ config/march.ts            PURE: travel-time function, versioned policy
  ├─ resolveTerritoryAssaultInTx  (world.service — ONE assault pipeline)
  │    └─ simulateBattle        (engine/battle — PURE, deterministic)
  └─ ScoutReport                (existing Phase 2 contract, first producer)
```

**Locking.** Marches take `march:engine` then `db:write` — the same order as
battle/world services. No code path ever takes both an engine key and
`march:engine`, so the composition is deadlock-free. All actual state changes
are serialized by `db:write`; `simulateBattle` is pure and needs no lock.

**Lazy processing, no new worker.** Mirrors the energy/quest/building
precedent: due marches are advanced on read (list/get/process). The
`march-processor.ts` facade exposes the same exactly-once pipelines for a
future worker; the routes and any worker share ONE processing path.

## 2. State machine

Extended from the Phase 2 March contract (additive vocabulary):

| Status      | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `EN_ROUTE`  | army is traveling to the destination (units reserved)            |
| `RESOLVING` | arrival/return processing claim — transient inside the processing transaction; **never observable committed** |
| `RETURNING` | survivors are traveling home (`returnsAt` is the deadline)       |
| `ARRIVED`   | **reserved** for a future stationed-garrison model — never persisted by this engine |
| `COMPLETED` | terminal — units restored exactly once / detachment delivered    |
| `CANCELLED` | terminal — recalled while `EN_ROUTE`, units restored, energy NOT refunded |
| `LOST`      | terminal — every committed unit died at the destination          |

Legal transitions (the single server oracle, `MARCH_TRANSITIONS`):

```
EN_ROUTE  → RESOLVING | CANCELLED
RESOLVING → RETURNING | COMPLETED | LOST
RETURNING → RESOLVING
COMPLETED / CANCELLED / LOST  (terminals; ARRIVED reserved)
```

Every transition is arbitrated by a **conditional `updateMany`** on the
status column — the exactly-once claim. A second processor's claim hits 0
rows and resolves as an idempotent no-op. `ENGAGED` (from the spec's example
vocabulary) is deliberately not persisted: the battle and the state flip
happen inside one atomic transaction.

## 3. Army reservation

- `POST /marches` **deducts** the requested stacks from `player_units` inside
  the creation transaction (CAS: `count >= requested`, decrement). Units that
  are marching are *not at home*: they cannot defend, be counted in power
  lists from `player_units`, or be reserved again.
- The committed stacks are stored ONCE as the immutable `March.units`
  manifest (canonical `{unitId, count}[]`, sorted).
- Restoration (cancel / homecoming / delivery) **increments from the
  manifest exactly once**, driven by the status claim. Survivors are stored
  as `March.survivors` at arrival resolution; homecoming restores exactly
  that manifest.
- Invariant: `player_units.count` can never go negative; the same units can
  never serve two marches (verified under 10-way concurrency).

## 4. Distance

**Manhattan metric** `|dx| + |dy|` — consistent with the 4-directional
(N/S/E/W) territory adjacency of the Phase 32 world. There is no diagonal
movement, so Chebyshev would be wrong here; it is deliberately not used.
The origin is the player's **capital cell** (server-derived at departure,
stored as `originX/originY`, never client-supplied).

## 5. Travel time

All numbers come from the versioned `MARCH` config (v1) — never the client:

```
distance           = |dx| + |dy|                                   (Manhattan)
armySpeed          = min(unit.speed over committed/surviving stacks)
armySpeedFactorBps = clamp(round(referenceSpeed × 10_000 / armySpeed), 2_000, 20_000)
terrainFactorBps   = TERRAIN[destination].moveCostBps               (config/world.ts)
scoutBonusBps      = SCOUT only: SCOUT_CENTER scoutSpeedBps (≥ 10_000)
travelSeconds      = clamp(ceil(distance × secondsPerCell
                              × terrainFactorBps / 10_000
                              × armySpeedFactorBps / 10_000
                              × 10_000 / scoutBonusBps),
                          30, 21_600)
```

- `secondsPerCell = 20`, `referenceSpeed = 5` (the catalog speed that marches
  at exactly 20 s/cell).
- Terrain move costs live in the SINGLE terrain catalog
  (`TERRAIN[*].moveCostBps`, 10_000–16_000 bps; swamp is costliest) — the
  march engine does not duplicate terrain definitions.
- The **return leg** uses the surviving composition and CITY terrain
  (the capital cell) over the same Manhattan distance.
- Deterministic and integer-safe: `ceil` on the final product; clamped to
  `[30 s, 6 h]`.

## 6. Arrival

A march is `EN_ROUTE` until `serverNow >= arrivesAt`. The browser may render
a countdown from server timestamps (`arrivesAt`, `serverNowMs`); it can never
decide arrival — only `POST /marches/[id]/process` (or a read path) advances
state, and only when the **server clock** says the march is due. Processing
before due is a typed no-op (`processed: false`).

## 7. Attack

`ATTACK` arrival, inside one transaction:

1. Claim `EN_ROUTE → RESOLVING` (exactly-once).
2. **Re-validate the destination against CURRENT state** — stale intel never
   fights: `LOCKED`, capital, self-owned, vanished owner/banned owner, or a
   closed season → the detachment turns around (`RETURNING`, outcome
   `aborted`, **no battle**, no fake combat).
3. Build the defender from CURRENT state: a real owner's `player_units`
   (with the terrain defense modifier) or the deterministic virtual garrison
   from `(WORLD.seed, x, y)` — identical rules to a direct assault.
4. Build the attacker from the **march manifest** + the real unit catalog via
   the shared `toBattleStack` (one stack builder exists).
5. `simulateBattle` — the existing pure, deterministic simulator.
6. `resolveTerritoryAssaultInTx` (world.service) — the ONE persistence
   pipeline: battle row (+ rounds, `marchId` stamped, unique) → casualties →
   capture spoils through the ledger (`TERRITORY_CAPTURE`) → conditional
   exactly-once capture + append-only `TerritoryHistory` → honor → XP →
   season points → statistics → power → quest events (`BATTLE_FINISHED`,
   `TERRITORY_CAPTURED`/`DEFENDED`/`LOST`) → achievements → battle logs →
   `ATTACK_RESULT` notifications.
7. Attacker casualties settle against the **survivors manifest**
   (`attackerUnitsInTransit` sink) — in-transit units are not
   `player_units` rows. Survivors > 0 → `RETURNING`; none → `LOST`.

## 8. Defense and reinforcement (honest scope)

The Phase 32 defense model is **realm-wide**: a player's whole home army
defends every holding, wherever it sits. There is no per-territory player
garrison table and the baseline battle suites would break if defense
semantics changed — so, per the spec's own rule ("do not fake persistent
per-territory garrisons"):

- `DEFEND` / `REINFORCE` are accepted **only to the caller's own territories**
  (`MARCH_DESTINATION_NOT_OWNED` otherwise).
- On arrival, the detachment is **restored to the home army** — under the
  realm-wide model that IS "the army becomes available for defense according
  to the actual architecture". The real gameplay cost of movement is the
  travel window: units are reserved (unavailable) while `EN_ROUTE`.
- If the destination stopped being ours while the march traveled (e.g. the
  season settlement stripped it), the detachment turns around and heads home.
- Stationed detachments with positional defense are a future system: the
  reserved `ARRIVED` status and the `RETURN` type literal are the extension
  points. This limitation is stated, not hidden.

## 9. Scouting

`SCOUT` arrival writes one `ScoutReport` (the existing Phase 2 contract —
this is its first producer) and **never creates a battle**. The report
carries the PUBLIC data class only — the same fields the map/detail views
expose: coordinates, name, terrain, status, owner type/name, capital flag,
strategic value, garrison **size** hint, resource type, capture count.
Private army composition, wallets and server-only values are never included
(enforced by test). Reports expire after `MARCH.scoutReportTtlHours` (24 h).
Scout marches ride faster through the reserved `SCOUT_CENTER.scoutSpeedBps`
building effect.

## 10. Return

After combat or a scout mission the survivors start the return leg
automatically (`RETURNING`, `returnsAt = now + returnTravelSeconds`).
Homecoming claims `RETURNING → RESOLVING` (exactly-once), restores the
survivors manifest, records `marchesCompleted`, fires `MARCH_COMPLETED`
(quest progress) and `MARCH_RETURNED`, evaluates achievements, and completes
the march. A second processor can never double-restore. There is no
`POST /marches/[id]/return` endpoint: return legs are engine-internal
phases of the expedition row (the `RETURN` type literal stays reserved).

## 11. Cancellation

- Legal **only while `EN_ROUTE`** (`MARCH_NOT_CANCELLABLE` otherwise,
  including races the arrival claim won).
- Exactly-once through the same conditional claim that the arrival processor
  uses — cancel × arrival races produce exactly one winner.
- Restores the full reservation manifest; emits `MARCH_CANCELLED`.
- **Mobilization energy is never refunded** (`MARCH.cancelRefundEnergyBps`
  fixed at 0 — documented policy; cancelling an in-flight army cannot be
  exploited for free scouting).
- The `CANCELLED` row remains as history; marching history is never rewritten.

## 12. Economy

Marches consume **energy only** (never wallet resources): `ATTACK` = 10
(`WORLD_ATTACK.energyCost`), `SCOUT` = 3 (`BATTLE.energy.scoutCost`),
`DEFEND`/`REINFORCE` = 5 (`MARCH.repositionEnergyCost`). Energy is charged at
the decision point (creation) through the lazy-tick sync + CAS decrement;
arrival charges nothing. Capture spoils and production continue to flow
through the existing Ledger — `Σ ledger deltas == wallet balance` holds
(re-verified in tests). No wallet mutation exists anywhere in the march code.

## 13. Notifications

- `ATTACK_INCOMING` (existing type, pre-designed march payload
  `{marchId, attackerName, targetCoord, arrivesInSeconds}`) — produced at
  creation to the CURRENT player-owner of the destination. Ownership changes
  mid-flight are handled by the arrival battle's own `ATTACK_RESULT`.
- `MARCH_RETURNED` / `MARCH_CANCELLED` (new types; Zod-validated payloads,
  IN_APP channel, server-rendered, dedupe-keyed by march id).
- Battle results reuse the existing `ATTACK_RESULT` from the shared pipeline.

## 14. Quest & achievement integration

Real typed domain events, raised inside the transactions that completed the
work — never client-constructible:

- `MARCH_COMPLETED {marchId, action}` — once per march, on the homecoming
  (successful completions only; `LOST` marches never complete). Event
  identity: `MARCH_COMPLETED:march:<id>` — replays cannot re-advance.
- `MARCH_SCOUTED {marchId, territoryId}` — one per scout march.
- The reserved `SCOUT_TARGET` objective (Phase 2) is now ACTIVATED; a new
  `MARCHES_COMPLETED` objective joins the catalog.
- Seeded quests: `weekly-patrol` (complete 5 marches / week),
  `weekly-recon` (scout 3 territories / week).
- Statistics (append-only, catalog-validated): `marchesLaunched`,
  `marchesCompleted`, `marchesScouted`, `marchBattlesWon`.
- Achievements (existing STAT metric engine): `ach-pathfinder` (1 march),
  `ach-scout-10`, `ach-marcher-25`, `ach-march-victor-10`.
- Battle quests keep working through `BATTLE_FINISHED`, which the shared
  pipeline already emits.

## 15. Idempotency

- Creation: action `MARCH_CREATE`, request hash over
  `playerId|territoryId|type|canonicalUnits|MARCH.version`. Same request →
  stored response replay (no duplicate units/energy/notifications/march);
  same key + different payload → typed `IDEMPOTENT_REPLAY` 409. The claim
  commits with the march row (same transaction).
- Arrival / return / cancel are keyless and exactly-once through the
  conditional status claims (state-machine arbiters).

## 16. Security

The client supplies only destination, action, unit stacks and an idempotency
key. Origin, distance, speed, terrain, travel time, arrival, battle result,
casualties, survivors, capture, rewards and every restoration are
server-derived. Zod strips unknown payload fields (forged
`distance/speed/arrivesAt/origin/status/survivors/outcome` are inert).
Verified refusal matrix (zero writes): unknown/foreign destinations,
capitals, own/locked/non-adjacent targets, foreign DEFEND/REINFORCE,
unknown/inactive units, negative/zero/fractional/oversized counts,
insufficient units/energy, slot exhaustion, cooldown, inactive season,
cross-player read/cancel/process (404, no existence leak), replay abuse,
cancel-after-combat, double-return, forged progress.

## 17. Concurrency (verified with real parallelism)

| Race | Guarantee |
| --- | --- |
| same units × 10 creations | exactly the CAS-fitting reservations land; counts never negative; no double reservation |
| same march × 10 arrival processors | exactly one battle (`Battle.marchId` unique) |
| same march × 10 homecoming processors | exactly one restoration |
| cancel × arrival (10 + 10) | exactly one state transition wins |
| same march × 10 cancellations | exactly one `CANCELLED`, units released once |
| route replay × 3 (same key) | one march row, three replays |

## 18. Performance (measured, sandbox SQLite)

| Scenario | Result |
| --- | --- |
| realistic creation (service path, 9 marches) | avg 15.8 ms/march, max 19 ms |
| list 100 marches (due-sweep + projection) | 8 ms |
| bulk to 1,000 rows | +69 ms; list 6 ms (projection capped at 100) |
| bulk to 10,000 rows | +581 ms; list at 10k rows 12 ms |
| ~10k due marches sweep | 744 ms (batched, `take` 50) |
| single arrival at 10k rows | 11 ms |

Read paths are per-player indexed (`(playerId, status)`, `(arrivesAt,
status)` — existing indexes; no new index needed because processing is
per-player lazy, not a global sweep). The read model caps the projection at
100 rows. No N+1 by construction (batched catalog loads, one projection
query).

## 19. Known limitations

1. **DEFEND/REINFORCE converge** by design under the realm-wide defense
   model; positional garrisons need a garrison table + a defense-consumption
   change in the battle engine (future phase; `ARRIVED` reserved).
2. **Foreign reinforcement** (helping another player) is refused — same
   reason as (1).
3. **No global march sweeper**: marches advance when their owner touches the
   API (or any future worker calls the processor facade). A disconnected
   player's march resolves on their next request — all timing rules are
   server-clock based, so nothing can be exploited by waiting.
4. **Production build not run** — the sandbox forbids `bun run build`
   (documented since Phase 25); compensating controls: `next dev` runtime
   verification, full typecheck, lint, 800-test regression.
5. Marches are **season-agnostic**: an in-flight march crossing a settlement
   boundary re-validates the destination at arrival (stale-intel aborts turn
   the army around); no stale ownership can leak into a capture.
