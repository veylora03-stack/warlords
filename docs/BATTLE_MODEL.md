# WARLORDS — Battle Model (Design Specification)

> Implementation: Phase 5 · Engine lives in `src/lib/game/engine/battle/` as PURE functions.
> Golden rule: the client only ever sends **who to attack and with what**. Everything else is computed server-side.

---

## 1. Guarantees

| Property | Mechanism |
|---|---|
| **Deterministic** | Seeded PRNG (`seed = hmac(JWT_SECRET-independent server secret, battleNonce)`) — same inputs ⇒ same output |
| **Replayable** | `battles` stores `(seed, configVersion, attackerComposition, defenderSnapshot, modifiers)`. `GET /battle/:id/replay` re-runs the pure engine and MUST equal the stored result (verification endpoint; also the regression test oracle) |
| **Server-authoritative** | Composition is validated against `player_units` with row locks inside the attack transaction |
| **Auditable** | Every round persisted (`battle_rounds`), every loot delta ledgered |

## 2. Battle pipeline (service orchestration)

```
REQUEST attack(target, composition)
  1. VALIDATE
     attacker: session, not banned, energy ≥ cost, no attack cooldown
     defender: exists, no newbie protection (level/<48h), no shield active,
               not same clan (unless clan-war rules), terrain known
     army:     composition ⊆ locked player_units, total ≤ marchCapacity
  2. COMMIT MARCH (tx)
     lock units → deduct energy → insert march(arrivesAt = now + travelTime(dist, speed))
  3. RESOLVE ON ARRIVAL (reconciler or sweep)
     snapshot defender forces (units + building defense + tech + commander + equipment)
     SIMULATE (pure, below)
  4. APPLY (tx)
     casualties to both sides · loot transfer (ledger rows) · honor/reputation deltas ·
     territory ownership if assault · XP to commanders · quests progress hooks ·
     battle + rounds + reports persisted · notifications outbox (both sides)
```

## 3. Simulation model (pure)

### 3.1 Inputs

```ts
interface BattleInput {
  seed: number;                       // 32-bit from hmac
  config: BattleConfig;               // versioned snapshot (see §5)
  attacker: BattleSide;               // stacks + aggregated modifiers
  defender: BattleSide;
  context: { type: BattleType; terrain: TerrainType; wallLevel: number };
}
```

### 3.2 Effective stack power

For each stack `s` of unit type `u`:

```
effAttack  = u.attack  * (1 + Σ attacker.attackBps[s.class])        // bps = basis points
effDefense = u.defense * (1 + Σ defender.defenseBps[s.class])
effHealth  = u.health  * (1 + Σ side.healthBps[s.class])
```

Modifier sources aggregated before combat (order-independent, additive in bps):
commander passives & active skill · equipment per slot · technology per branch · clan perks · terrain · wall (defender only, siege attacks walls directly) · morale from reputation (small, bounded ±5%).

### 3.3 Counter matrix (data-driven, basis points)

From `unit_types.strongAgainst/weakAgainst` — combat code contains **no hard-coded numbers**:

```
INFANTRY(counters) → CAVALRY   CAVALRY(counters) → RANGED   RANGED(counters) → INFANTRY   SIEGE(counters) → WALL/BUILDING
damageMultiplier(stack → target) = 1 + strongBps(1000 default = +10%)  or  1 − weakBps(−10%)
```

### 3.4 Round loop

```
round r = 1…
  initiative order: CAVALRY → INFANTRY → RANGED → SIEGE (configured order list)
  for each acting stack (alive, ordered, PRNG-shuffled within class):
     pick target: class-preferred target rule + lowest effective HP ratio (config-weighted)
     dmg = Σ over stacks: count * effAttack * counterMult * variance(0.9..1.1, PRNG)
                       * classVsClassBase(config) * wallPenalty
     apply to target side pool: casualties = min(alive, floor(dmg / effHealth))
     record round event {attacker, target, dmg, kills}
  until: one side has no non-siege stacks OR round = maxRounds(config, default 12)
  if timeout → DRAW resolved by remaining total effective HP (config tiebreak)
```

### 3.5 Outcomes

- **Attacker win**: loot = min(warehouseCarryCapacity, defenderLootable% (config), defender free balances) split across surviving carry capacity; honor +; reputation shift by target reputation delta rules.
- **Defender win**: attacker retreats; defender honor +; attacker loses more (morale penalty config).
- **Hospital**: a configurable % of defender casualties land in hospital (recoverable, Phase 6) — rest are dead. Siege units never enter hospital.
- **Draw**: minor loot, no honor.

## 4. Energy, cooldowns & protection (config-driven)

| Rule | Default (config, changeable without code) |
|---|---|
| Attack energy cost | 10 (regen 1/5min, cap 100) |
| Scout cost | 3 |
| Attack cooldown per attacker | 60s |
| Revenge window (attacker becomes targetable) | 24h |
| Newbie protection | level < 5 OR account < 48h |
| Shield item | blocks attacks; broken on outgoing attack |
| Same-clan protection | blocked outside clan war |

## 5. Versioned BattleConfig (excerpt of shape)

```ts
interface BattleConfig {
  version: number;                    // stored on each battle row
  maxRounds: number;
  varianceBps: number;                // ±damage spread
  classInitiative: UnitClass[];
  counters: { strongBps: number; weakBps: number };
  loot: { defenderLootableBps: number; carryPerSiege: number; carryPerCavalry: number; ... };
  casualties: { defenderHospitalBps: number; attackerDeathBps: number };
  protection: { newbieLevelCap: number; newbieAgeHours: number; revengeHours: number; ... };
  energy: { attackCost: number; scoutCost: number; regenPerMinBps: number; ... };
}
```

Config is authored in `src/lib/game/config/battle.ts`, snapshotted into each battle row — balance patches never corrupt historical replays.

## 6. Anti-exploit notes

- Composition lock: units are deducted (`player_units`) at march time — no "ghost army" double-spend; survival returns units on RETURN march.
- Target lock: defender state is snapshotted at resolution, never at request time — stale screenshots cannot be abused.
- All random draws flow from the single seeded stream in fixed order — no client seed influence; client never sends RNG.
- Replays are computed from DB snapshots only; a tampered client cannot forge inputs because inputs are not client-supplied.
