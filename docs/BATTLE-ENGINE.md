# WARLORDS — Battle Engine (Phase 28)

> The complete server-authoritative combat pipeline:
> **ATTACK → COMBAT → CASUALTIES → REWARDS → RANKING → NOTIFICATION → HISTORY**
>
> Golden rule: the client sends **only a target player id** (plus an optional
> idempotency key). Armies, the seed, casualties, loot, honor, XP, season
> points, cooldowns and protection are resolved server-side.

---

## 1. Architecture

```
src/lib/game/config/battle.ts          ← ALL balance numbers (versioned, data-driven)
src/lib/game/types/battle.ts           ← engine contracts (BattleInput/SimulationResult/Config)
src/lib/game/engine/battle/simulator.ts ← PURE deterministic simulator (no I/O, no clock, no Math.random)
src/lib/game/services/battle.service.ts ← orchestration: validations → tx → simulate → apply
src/app/api/v1/battles/*               ← HTTP adapters (thin)
src/features/battle/*                  ← Mini App feature client (TanStack Query)
```

Layering follows the house rule: **adapters → services → engines → config**.
The simulator NEVER touches the database; the service NEVER embeds balance
numbers. Determinism guarantee:

```
(seed, configVersion, attackerSide, defenderSide)  ⇒  identical outcome
```

The seed is `crypto.randomInt(0, 2^31)` (server-generated, never
client-supplied) and `configVersion` pins the exact balance snapshot, so any
historical battle can be re-simulated byte-exactly from its stored inputs
(seed + armies + modifiers are all persisted in the battle log content).

## 2. Battle flow (one transaction)

```
POST /api/v1/battles/attack { targetPlayerId, idempotencyKey? }
  1. authN (DB-backed session) → authZ (player present, not banned)
  2. principal rate limit (playerWrite group)
  3. Zod body validation → typed 400s
  4. idempotency fast-path (read-only replay of a committed response)
  5. runBattleTransaction  [battle:engine → db:write mutex → SQLite tx]
       a. idempotency claim (IdempotencyKey row, action BATTLE_ATTACK)
       b. validate target: exists · not self · not banned
       c. validate season: an ACTIVE season exists (lazy state machine)
       d. validate cooldown: last PVP_ATTACK startedAt + cooldown ≤ now
       e. validate protection: newbie · inactive · level-gap · repeated-raids
       f. energy: lazy-tick sync + CAS decrement (energy ≥ cost, never < 0)
       g. load BOTH armies (PlayerUnit ⋈ Unit catalog) + defender wall level
       h. build BattleInput (seed, config snapshot, modifiers)
       i. simulateBattle(input)               ← pure, milliseconds
       j. persist: Battle row · BattleRound rows (per side per round)
       k. casualties: CAS-guarded PlayerUnit decrements (count ≥ loss)
       l. loot: spendResources(defender) + grantResources(attacker),
          both reason BATTLE_REWARD refType=battle refId=battleId
       m. rewards: honor (+, never negative) · XP (grantXp CAS) ·
          season points (victor, awardSeasonPointsInTx)
       n. statistics: attacksLaunched/battlesWon/battlesLost/defensesWon/
          unitsLost/resourcesPlundered (append-only counters)
       o. power recalculation for BOTH players (derived metric heals)
       p. BattleLog rows (per-participant pre-formatted report)
       q. notifications: ATTACK_RESULT ×2 via the outbox
       r. idempotency response stored IN the same tx
  6. COMMIT → response (or typed AppError with zero writes)
```

**Every step above shares ONE transaction** — a failure anywhere rolls back
everything (no phantom loot, no ghost casualties, no orphan battle rows).

### Unguarded cities

A defender with zero units does not crash the simulator — the city **falls
without a fight** (documented rule): result `ATTACKER_WIN`, zero rounds, no
defender casualties, loot capped by the attacker's carry capacity.

## 3. Formula

### Effective stats (per stack)

```
effAttack  = base.attack  × (1 + side.attackBps[class]  / 10_000)
effDefense = base.defense × (1 + side.defenseBps[class] / 10_000)
effHealth  = base.health  × (1 + side.healthBps[class]  / 10_000)
```

### Round loop

```
for round r = 1 … maxRounds (12):
  ATTACKER side acts first, then DEFENDER side
    each alive stack, in class initiative order (CAVALRY ▸ INFANTRY ▸ RANGED ▸ SIEGE):
      target  = counter target if the actor is strong against any alive enemy stack
                else the enemy stack with the lowest remaining total HP
                (deterministic — the PRNG is used ONLY for damage variance)
      raw     = count × effAttack × counterMult × variance × terrainMult
      dmg     = floor(raw × defenseDivisorBase / (defenseDivisorBase + effDefense_target))
      kills   = min(aliveCount, floor(dmg / effHealth_target))
  a side wiped ⇒ the other wins (a battle may END MID-ROUND — the attacker
  strikes first, so defender-side round records can be one fewer)
maxRounds reached ⇒ higher remaining total effective HP wins, equal ⇒ DRAW
```

- `variance = (10_000 − varianceBps + floor(rng() × 2 × varianceBps)) / 10_000`
  (mulberry32 seeded PRNG; default ±15%).
- `counterMult = 1 + (strongBps + weakBps) / 10_000` where strong comes from
  the unit catalog (`strongAgainst`, +2500 bps edges) and weak is the negated
  `weakAgainst` penalty. Both are CLAMPED to the config maxima
  (`maxStrongBps` / `maxWeakBps`), so a catalog edit can never exceed the
  configured balance envelope.

### Side power (stored on the battle row)

`attackerPower` / `defenderPower` = Σ over initial stacks of
`count × (effAttack + effDefense + effHealth)` — the engagement's scale,
recorded for ranking/inspection, NOT the Player.power metric (that is the
separately derived building/army/tech power, recalculated after every battle).

## 4. Counters (data-driven)

The triangle lives **per unit** in `src/lib/game/config/units.ts`:

```
INFANTRY ▸ CAVALRY ▸ RANGED ▸ INFANTRY      (2500 bps edges, symmetric)
SIEGE: no field counters, weak to fast cavalry
```

`strongAgainst: [{unitId, bonusBps}]` and `weakAgainst: [{unitId, penaltyBps}]`
are seeded into the `units` table and snapshotted into the battle input —
combat code contains **no hard-coded numbers**. Rebalancing = edit the catalog
config + reseed; the battle config clamps the maximum edge.

## 5. Casualties

- Losses are per stack: `initial − survivors`; the service decrements with a
  conditional `UPDATE … WHERE count >= loss` — **counts can never go negative**,
  and `casualties ≤ initial`, `survivors ≥ 0` are structural invariants.
- Attacker losses are always permanent (`attackerDeathBps = 10_000`).
- `defenderHospitalBps` (default 0) returns a policy share of DEFENDER losses
  home wounded. The standalone hospital pool is a future system (the HOSPITAL
  building effect `hospitalCapacity` is pre-declared in the buildings catalog);
  today hospitalized troops simply survive at home.

## 6. Rewards (through the Economy Engine — always the ledger)

| Outcome | Attacker | Defender |
|---|---|---|
| ATTACKER_WIN | loot (carry-capped share of defender wallet) · honor `+attackWinHonor` · XP `attackWinXp` · season `victorySeasonPoints` | XP `defenseParticipationXp` |
| DEFENDER_WIN | XP `attackParticipationXp` | honor `+defenseWinHonor` · XP `defenseWinXp` · season `victorySeasonPoints` |
| DRAW | XP `attackParticipationXp` | XP `defenseParticipationXp` |

- Loot = `min(Σ surviving carryCapacity, floor(balance × defenderLootableBps))
  per resource, scaled proportionally when the pool exceeds the carry` —
  BigInt math, drawn ONLY from the five wallet resources (GEMS are never
  plundered), never exceeding the defender's real balances.
- Every loot unit crosses `resource_transactions` (defender debit, attacker
  credit, reason `BATTLE_REWARD`, refType `battle`, refId battleId) — the
  ledger always reconciles to the wallets.
- **No reward is ever negative** and defeats never destroy progression.
- Duplicate rewards are impossible: the battle row is created once inside the
  transaction; ledger rows reference it; the idempotency key replays the
  original response.

## 7. Cooldown

Server clock only — `battles.startedAt` of the attacker's latest PVP_ATTACK +
`attackCooldownSec` (60s default) must be in the past. Client timestamps are
never read. A second attack inside the window is a typed
`ACTION_ON_COOLDOWN` (429) carrying `retryAfterSec`.

## 8. Energy

The existing lazy-tick pool (`Player.energy`, regen 1/300s, cap 100) is the
single energy system. The attack synchronizes the pool inside the transaction,
then decrements with a CAS guard (`WHERE energy >= cost`) — `energy < 0` is
structurally impossible, and a parallel double-spend loses with
`INSUFFICIENT_ENERGY` (409). Cost: `energy.attackCost` (10).

## 9. Protection (anti-bullying, all configurable)

Evaluated server-side against real rows, before any write:

| Rule | Config | Effect |
|---|---|---|
| Newbie shield | `newbieLevelCap: 5`, `newbieAgeHours: 48` | target protected while below the level cap OR account younger than the age |
| Inactive shield | `inactiveProtectDays: 7` | no login for N days → protected |
| Level gap | `maxLevelGap: 25` | `|attacker.level − target.level|` above the gap → protected |
| Repeated raids | `maxAttacksPerTargetPerDay: 5` | > N attacks by the same attacker onto the same target in a rolling 24h → protected |
| Attack cooldown | `attackCooldownSec: 60` | global per-attacker rate limit |

Violations are one typed error — `PROTECTED_TARGET` (403) with machine-readable
`reasons: ['NEWBIE_SHIELD' | 'INACTIVE_SHIELD' | 'LEVEL_GAP' | 'REPEATED_RAIDS']`.
Banned targets are `INVALID_TARGET`; self-attacks `SELF_TARGET`.

## 10. Concurrency

- Battles run behind the dedicated `battle:engine` FIFO mutex **and** the
  process-wide `db:write` mutex — the same barrier every other game mutation
  uses (Phase 25 architecture). A battle therefore cannot interleave with
  training, construction, or another battle; a second attack on the same
  defender observes post-first-battle state.
- Lock order `battle:engine → db:write` is consistent with every other
  call-site (wallet locks are acquired inside the economy paths, always before
  `db:write`) — the composition is deadlock-free.
- DB-level backstops remain: unit decrements and energy spend are conditional
  UPDATEs (`count >= loss`, `energy >= cost`), so counts stay correct even if
  the in-process mutex were bypassed (multi-instance future).
- PostgreSQL production: the same code is correct (row-level CAS is the
  multi-instance authority); swap the in-process mutex for advisory locks when
  horizontally scaling.

## 11. Idempotency

- The client MAY send `idempotencyKey` (1…64 chars, e.g. `crypto.randomUUID()`).
- The key is claimed in the SAME transaction as the battle
  (`IdempotencyKey` table, action `BATTLE_ATTACK`, request hash over
  `attacker|target|configVersion`, 24h TTL).
- A replay returns the ORIGINAL response (`replayed: true`) — a double-click
  can never create a second battle.
- A key reused for a DIFFERENT target → `IDEMPOTENT_REPLAY` (409).
- A key claimed by an in-flight request → `IDEMPOTENT_REPLAY` ("retry shortly").
- Attackers without a key are still safe: the cooldown serializes repeat fire,
  and the transaction serialization resolves concurrent duplicates into
  exactly one battle.

## 12. Database

No schema change was required — Phase 2 already shipped the battle contract:

| Table | Role |
|---|---|
| `battles` | one row per engagement: type, seed, configVersion, result, powers, roundsCount, loot (JSON), honorDelta, energySpent, startedAt/endedAt |
| `battle_rounds` | per (battle, roundNumber, side): committed stacks, losses, damageDealt, ordered action trace |
| `battle_logs` | per-participant pre-formatted report (both armies, both casualty lists, loot, seed, config version) |
| `idempotency_keys` | attack double-submit protection (shared with economy grants) |

Battles are immutable history: participants are `Restrict`-deleted; rounds and
logs cascade with their battle.

## 13. API

| Route | Purpose |
|---|---|
| `POST /api/v1/battles/attack` | `{targetPlayerId, idempotencyKey?}` → full battle result |
| `GET /api/v1/battles/targets?limit=` | caller readiness (energy, cooldown, army size) + public target roster (name, level, power, honor, reputation, protection reasons) — **armies are never included** |
| `GET /api/v1/battles?page=&pageSize=` | caller's battle history (both roles, caller-perspective outcome) |
| `GET /api/v1/battles/:id` | participant-only detail: result, round trace, own report |

Error taxonomy (all typed, all zero-write):
`SELF_TARGET(400) · INVALID_TARGET(400) · ARMY_EMPTY(400) ·
VALIDATION_ERROR(400) · PROTECTED_TARGET(403) · PLAYER_NOT_FOUND(404) ·
IDEMPOTENT_REPLAY(409) · INSUFFICIENT_ENERGY(409) · SEASON_NOT_ACTIVE(409) ·
ACTION_ON_COOLDOWN(429)`.

Admin inspection of the same battle rows already exists from Phase 21
(`/api/v1/admin/battles`, RBAC-guarded).

## 14. Mini App

The console (src/app/page.tsx) renders a **Battle Engine** card:

1. readiness strip — energy pool, attack cost, cooldown countdown, army size;
2. target roster — public info only; protected targets are visibly badged
   with their reasons;
3. attack order — attacker vs target power, energy cost, risk indicator, a
   two-step **ATTACK → CONFIRM ATTACK** confirmation;
4. result panel — 🏆 VICTORY / ☠️ DEFEAT / ⚖️ DRAW with casualties, loot, XP,
   honor, season points, seed;
5. battle history — outcome badges, loot summary, expandable round-by-round
   report with the deterministic seed.

The UI mutates exclusively through `src/features/battle` (TanStack Query);
a successful attack invalidates wallet/ledger/player/army/season/battle queries.

## 15. Testing

| Suite | Coverage |
|---|---|
| `tests/unit/game/battle-simulator.test.ts` | determinism (same seed ⇒ identical), seed variance, outcomes (win/lose/draw/max-rounds), counter edges both directions, casualty & loot invariants, hospital share, input validation, BpsModifiers extension point |
| `tests/unit/game/battle-config.test.ts` | config invariants (versioning, initiative coverage, bps ranges, protection active, non-negative rewards) |
| `tests/integration/battle/battle-system.test.ts` | security matrix: unauthenticated/self/ghost/banned/protected/repeated-raid/energy/cooldown/empty-army/garbage-body refusals; the full winning pipeline (battle row, rounds, CAS casualties, ledger both sides, honor, XP, season, stats, power, logs, notifications, history, detail authorization); unguarded city; idempotency replay + conflict; parallel double-submit ⇒ one battle; two attackers on one defender; energy non-negativity |
| `tests/e2e/battle-journey.test.ts` | the complete journey on real routes and real state: scout targets → attack → immutable battle row → both perspectives in history → round report → ledger/statistics → LIVE season ranking → ATTACK_RESULT notifications for both → cooldown gate |
| `scripts/bench/battle-load.ts` | 100 and 500 concurrent full-pipeline attacks (results in `docs/bench/`) |

## 16. Performance (measured)

| Scenario | Result | p50 | p95 | Throughput | Errors |
|---|---|---|---|---|---|
| 100 concurrent attacks | 100/100 resolved | 2.8 s | 4.7 s | 20.3/s | 0 |
| 500 concurrent attacks | 500/500 resolved | 15.2 s | 24.3 s | 19.7/s | 0 |

Throughput is bounded by the deliberately serialized write path (Phase 25:
SQLite has exactly one writer; every write transaction is globally serialized
in-process). Steady-state ≈ **20 full battles/s per instance**; large fan-outs
queue honestly rather than corrupting state (zero inconsistencies, zero typed
refusals, zero 5xx). On PostgreSQL the same code parallelizes reads and the
per-instance serialization becomes a single-node policy — scale-out guidance
in DEPLOYMENT.md.

## 17. Changing battle balance

1. Edit `src/lib/game/config/battle.ts` (all caps, costs, policy) and/or
   `src/lib/game/config/units.ts` (counter edges, unit stats).
2. **Bump `BATTLE.version`** — historical battles keep their old snapshot
   (`configVersion`), so replays never shift under the players.
3. Reseed the unit catalog if unit rows changed: `bun run db:seed`
   (runtime combat reads the DB catalog, never the config folder).
4. Run `bun test tests/unit/game/battle-simulator.test.ts
   tests/unit/game/battle-config.test.ts` — the invariant pins will catch a
   broken config before any battle runs.

## 18. Extension points (declared, not faked)

- **Commanders / equipment / technology** — none of these systems exist yet;
  their bonuses enter through `BattleSide.modifiers` (`BpsModifiers`,
  aggregated in bps per class). The service currently applies only REAL state
  (defender wall level from the WALL building); when a commander/equipment/tech
  system lands it aggregates its rows into the same modifiers — the simulator
  is already general.
- **Morale / formation** — reserved fields in the config; not applied (documented
  honestly rather than faked).
- **Terrain** — `terrainAttackBps` table with CITY (0) today; the territory/map
  phase passes the real terrain into `BattleInput.context`.
- **Hospital pool** — `defenderHospitalBps` machinery + HOSPITAL building
  capacity pre-declared; a standalone recovery queue can replace
  "survive-at-home" without touching the simulator's contract.
- **Asynchronous marches** — the `March` table and the `ATTACK_INCOMING`
  notification type remain schema/catalog-ready for travel-time combat; the
  current engine resolves synchronously by design (one transaction, one
  authoritative result).
