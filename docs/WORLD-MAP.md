# WARLORDS — World Map + Territory Engine (Phase 32)

Status: **implemented, tested, browser-verified** — 786/786 tests green (381 unit · 344 integration · 61 e2e), typecheck + eslint + prettier clean, DB invariant verifier green.

---

## 1. Architecture

```
WORLD (deterministic 41×41 grid, seed 20260901)
  └── REGIONS (6×6 = 36 persistent rectangular blocks, 7×7 cells each)
        └── TERRITORIES (one per cell — 1,681 total; extends the Phase 2 contract table)
              ├── ownership: NONE | PLAYER (clan ownership is a future extension)
              ├── states: UNCLAIMED | CONTROLLED | LOCKED
              └── history: append-only TerritoryHistory (SPAWN · CAPTURE · SEASON_RESET · ADMIN · WORLD_INIT)
```

Everything is **server-authoritative**. The client supplies only a territory id (plus an
optional idempotency key). Terrain, adjacency, ownership, garrisons, seeds, casualties,
spoils, capture results, rewards, production and cooldowns are derived from server state
and the data-driven configs (`config/world.ts`, `config/battle.ts`) inside ONE globally
serialized transaction (NEVER TRUST THE CLIENT).

No existing system was rebuilt. The engine reuses: the battle engine + pure simulator,
the Economy/Ledger (CAS credits, cap clamping, ledger reasons), the Quest event engine
(Phase 31), the Achievement engine (Phase 31), the Notification queue (Phase 22), the
Season state machine + settlement (Phase 20), IdempotencyKey, Admin RBAC + audit
(Phase 21), and the route-handler envelope stack.

## 2. World generation

`src/lib/game/engine/world/generator.ts` — a PURE function:

```
generateWorld({ seed, sizeX, sizeY, regionSize }) → { regions, territories }
```

- No I/O, no clock reads, no Prisma. The only randomness is the seeded `mulberry32`
  PRNG **shared with the battle engine** — the same seed always produces the
  byte-identical world (same regions, coordinates, terrain, special sites, names).
- Determinism, structure, terrain legality, special-site distinctness and naming are
  pinned by unit tests (`tests/unit/game/world-generator.test.ts`).
- The generator NEVER assigns ownership — every generated cell is UNCLAIMED or LOCKED.
- World materialization is lazy + idempotent: `ensureWorldGenerated()` (world.service)
  takes the `db:write` lock, re-checks the region count inside the transaction,
  pre-reads occupied (x,y) cells (capitals created before the grid), inserts the rest,
  backfills region links and converts legacy cities into capitals. Concurrent callers
  converge on exactly one generation.

## 3. Regions

Persistent `Region` rows (`world_regions` table): id (`r{col}-{row}`), deterministic
name (16×12 name pool, deduped per generation), inclusive bounds, `metadata` audit JSON,
`isActive`. Bounds are the only stored geometry — adjacency is derived, never stored.
`@@unique([minX, minY])` + `@@index([isActive])`.

## 4. Territories

The Phase 2 `Territory` contract model was **extended, not duplicated** (additive
columns; both SQLite and PostgreSQL schema twins + committed migrations):

| addition | meaning |
|---|---|
| `regionId` | world region membership (nullable only for pre-grid rows; backfilled) |
| `name` | deterministic display name from the generator (capitals carry the city name) |
| `terrain` | TERRAIN_TYPES — combat/production modifiers resolve from server config only |
| `status` | UNCLAIMED \| CONTROLLED \| LOCKED |
| `ownerType` | NONE \| PLAYER (future: CLAN) |
| `isCapital` | server-side protection rule — never attackable, survives seasons |
| `resourceType`, `productionRate`, `productionCollectedAt` | lazy production |
| `captureCount` | lifetime capture counter |

DB-level guarantees: `@@unique([x, y])` (pre-existing), FKs for owner/city/region,
indexes on `regionId`, `status`, `ownerPlayerId` (pre-existing). The unique pair also
serves the map viewport range scan.

Legacy `type` column usage: `PLAYER_CITY` (capital) · `NPC_VILLAGE` (garrison cell) ·
`RESOURCE_ZONE` (producing cell) · `SPECIAL` (locked site).

## 5. Terrain

Data-driven catalog in `config/world.ts` — nine types:
`PLAINS · FOREST · MOUNTAINS · DESERT · SWAMP · HILLS · RIVER · COAST · CITY`
(CITY is never generated — capitals are allocated).

Each entry carries: attacker `attackBps` (mirrored into `BATTLE.terrainAttackBps`,
battle config version bumped **1 → 2**), defender `defenseBps` (applied through the
existing `BattleSide.modifiers`), `productionMultiplierBps`, generation `weight`,
produced `resource`, and a UI `color` token. The simulator itself is untouched.

## 6. Adjacency

4-directional (N/S/E/W), derived from coordinates by pure functions
(`adjacentCoords`, `areAdjacent`). Never stored, never client-supplied. An assault
requires the attacker to own a territory adjacent to the TARGET (N/S/E/W of ANY owned
cell) — expansion fronts grow with the empire.

## 7. Spawn & capital

- `city-site.service.findFreeCityCoordinate` spirals **within the world grid**,
  avoiding occupied city coordinates AND unclaimable territory cells (LOCKED,
  capitals, owned). Cities therefore always sit on real world cells.
- `player-bootstrap.service` claims the capital INSIDE the registration transaction
  via `world-capital.service.claimCapitalTerritory`: the generated cell is converted
  conditionally (`ownerPlayerId IS NULL AND isCapital = false AND status = 'UNCLAIMED'`),
  or created standalone when the grid does not exist yet (region backfilled later).
  A `TerritoryHistory` row (reason `SPAWN`) lands in the same transaction.
- Capital rules (all server-enforced): permanently bound to its city (`cityId @unique`),
  type `PLAYER_CITY`, terrain `CITY`, never attackable, never capturable, never
  admin-reassignable, survives season settlement.

## 8. Battle integration (the assault pipeline)

`world.service.attackTerritory` — one transaction behind the SAME
`battle:engine → db:write` lock order as city raids:

1. idempotency fast-path (action `TERRITORY_ASSAULT`, request hash includes battle +
   world config versions)
2. territory validation (exists · not own · not capital · not LOCKED)
3. season gate (ACTIVE season)
4. adjacency check (4-dir from ANY owned cell)
5. shared regroup cooldown (last battle of `PVP_ATTACK` OR `TERRITORY_ASSAULT`)
6. energy CAS (`syncPlayerEnergy` + conditional decrement)
7. attacker = REAL army rows; defender =
   - player-owned → the owner's REAL army + terrain defense modifier (no wallet
     loot — territory assaults pay config-defined spoils instead), or
   - unclaimed → the deterministic VIRTUAL GARRISON
8. existing pure `simulateBattle({ type: 'TERRITORY_ASSAULT', terrain, coordinate })`
9. apply: battle row (`territoryId` set, `defenderPlayerId` null for garrisons) ·
   rounds · CAS-guarded casualties · spoils ledger · honor · XP (`grantXp`) · season
   points · stats · power recalculation · capture · history · quest events ·
   achievements · battle logs · outbox notifications · idempotency claim

### Virtual garrison (documented NPC contract)

Unclaimed territories are held by a garrison generated on the fly from
`(WORLD.seed, x, y, strategicValue)` over the REAL unit catalog, with deterministic
per-cell composition jitter (±1500 bps). It does NOT represent a real player army: it
is never persisted, its losses are never written anywhere, it cannot be scouted,
looted or reinforced, and it exposes only its SIZE (`defenseStrength`) as a public
resistance hint — never its composition.

## 9. Capture

ONLY on `ATTACKER_WIN`, inside the same transaction, via a conditional
`updateMany` (`ownerPlayerId IS NULL OR ≠ attacker`) — exactly-once under the engine
lock. Writes: owner/ownerType/status/lastCapturedAt/production cursor reset +
`captureCount` increment + an append-only `TerritoryHistory` row (reason `CAPTURE`,
both owner ids, battle id, season number).

## 10. Economy & production

- New ledger reasons: `TERRITORY_CAPTURE` (assault spoils) and `TERRITORY_PRODUCTION`
  (lazy collection). Both flow through the EXISTING `grantResources` (CAS credits, cap
  clamping, `Σ ledger deltas == balance` — asserted by tests). Both count as earned
  resources for EARN_RESOURCE quest objectives (`EARNED_LEDGER_REASONS`).
- Spoils = `strategicValue × 25` units of the cell's resource, capped at 2,500 —
  config-driven, never client-supplied, never raided from a defender wallet.
- Production is LAZY: `collectTerritoryProduction` (owner-only, inside the player's
  economy mutex) computes `rate × elapsed × terrain multiplier`, clamped at
  `capHours × rate` (8h), gated by a 300 s minimum interval; the cursor
  (`productionCollectedAt`) advances in the same transaction — double collection is
  structurally impossible. New stat counters: `territoriesCaptured`,
  `territoriesDefended`, `territoriesLost`.

## 11. Quest integration (real events, no fakes)

The Phase 31 quest engine's reserved territory objectives are now LIVE through typed
domain events raised inside the capture transaction:

| event | matches | progress mode |
|---|---|---|
| `TERRITORY_CAPTURED` (+ `ownedCount`) | `CAPTURE_TERRITORIES` / `CONTROL_TERRITORIES` | INCREMENT / SET(snapshot) |
| `TERRITORY_DEFENDED` (defender held: win or costly draw) | `DEFEND_TERRITORIES` | INCREMENT |
| `TERRITORY_LOST` (defender's cell captured) | — (event parity/audit) | — |
| `BATTLE_FINISHED` (both roles) | existing `WIN_BATTLES` chain | INCREMENT |

Seeded quests: `main-06-first-territory` (MAIN chain) · seasonal
`conqueror` (3 captures) · `land-lord` (hold 5 simultaneously — SET snapshot) ·
`defender` (5 successful defenses). Event identity = the battle id, so idempotent
replays can never re-advance progress. Simultaneous-hold is deliberately a SET quest
objective: monotonic achievement counters cannot express a snapshot.

## 12. Achievement integration

Seeded permanent achievements through the EXISTING engine (STAT metrics on the new
counters): `ach-first-territory` (1 capture) · `ach-conqueror` (10 captures) ·
`ach-defender` (5 defenses). Auto-granted exactly-once by the DB-unique unlock +
ledger reward, evaluated in the assault transaction.

## 13. Season integration

The settlement's `TERRITORY_OWNERSHIP` wipe is capital-aware: it strips CONQUERED
territories only (owner → null, status → UNCLAIMED, production cursor cleared) and
writes an append-only `SEASON_RESET` history row per stripped cell. Player capitals
are permanent and survive. Achievements and history persist; seasonal territory
statistics are the counters themselves (documented: they do not reset — only seasonal
quest instances expire with the season).

## 14. API

Player (authenticated, standard route conventions, `defineRoute` + envelope):

| endpoint | purpose |
|---|---|
| `GET /api/v1/world/map?minX&maxX&minY&maxY` | viewport query; server clamps bounds, enforces the 441-cell area cap (the world is never serialized in full); no bounds → server-picked capital-centered viewport |
| `GET /api/v1/world/territories/[id]` | public detail + caller-specific attackability verdict + production readiness; NEVER defender army composition |
| `POST /api/v1/world/territories/[id]/attack` | the assault (body: `idempotencyKey?` only) |
| `GET /api/v1/world/territories/[id]/history` | append-only public ownership record, paged, no private data |
| `POST /api/v1/world/territories/[id]/collect` | lazy production collection |
| `GET /api/v1/world/player-territories` | caller-scoped holdings + readiness |

Admin (RBAC scopes `world.view` / `world.manage`, transactional audit + history):

| endpoint | scope |
|---|---|
| `GET /api/v1/admin/world/territories/[id]` | `world.view` (inspection, audited best-effort) |
| `POST /api/v1/admin/world/territories/[id]/lock` | `world.manage` (LOCKED ⇄ UNCLAIMED/CONTROLLED) |
| `POST /api/v1/admin/world/territories/[id]/ownership` | `world.manage` (grant/strip + `ADMIN` history row; capitals immutable) |

## 15. Mini App

`src/features/world/*` — the World Map console card (zinc/amber design language,
`md:col-span-2` stacked layout): terrain-colored grid with ownership tints and
capital/locked markers, pan + recenter controls (edge-clamped, server re-clamps),
region badges, lazily-loaded territory detail (name, coordinates, region, terrain,
owner, status, resource/production, capture count, strategic value), server-driven
attackability (attack button + every refusal reason mapped to human text), collect
block for own producing cells, attack-result strip (outcome, spoils, honor, season
points), and a paginated collapsible ownership history. Real API data only; anonymous
sign-in prompt; skeletons/error/empty states. Browser-verified at 390/430/768/1280 px
— no horizontal overflow, no console errors, real assault executed live through the UI.

## 16. Security

Tested matrix (`tests/integration/world/world-security.test.ts`): forged battle
fields (winner/seed/terrain/casualties/spoils/capture/progress/reward/ownedCount/
defenderId/seasonPoints) are stripped/ignored — every number is server-derived;
replayed idempotency keys return the ORIGINAL response and never re-consume energy,
units, captures or quests; a used key on a different target is a typed 409;
capitals are unattackable by everyone including their owner; locked territories
refuse assault; non-adjacent assaults are zero-write refusals; foreign collection is
403; fake ids are 404s with zero writes; player-territories is strictly caller-scoped;
territory history is an authenticated PUBLIC world record that contains no private
data (no armies, no wallets, no ledger); admin ops are RBAC-walled, audited
transactionally and refuse capital reassignment.

## 17. Concurrency

`tests/integration/world/world-concurrency.test.ts`: simultaneous A-vs-B assaults on
one territory resolve serially behind the battle-engine lock (consistent single
owner, second attacker fights the first attacker's real army, history battle ids are
unique per capture); 10 parallel assaults by one player admit at most ONE real
battle (cooldown + serialization); 10 parallel double-submits of the same key produce
exactly one battle; 8 parallel production collections credit exactly once. Post-storm
invariants: no negative unit counts, `Σ ledger == wallet` per resource, no duplicate
quest progress per event key, no structurally corrupt territory rows.

## 18. Performance (real measurements)

`tests/integration/world/world-load.test.ts`:

| measurement | result |
|---|---|
| pure generator, 100 cells | ~2 ms |
| pure generator, 1,024 cells | ~2 ms |
| pure generator, 10,000 cells | ~7 ms (≈0.7 µs/cell) |
| map API, 100 / 400 / 441-cell viewports | ~15–28 ms |
| full-grid DB scan, 1,681 rows | ~46–51 ms, **2 SQL statements** (N+1 probe — batched owner join) |
| 25 parallel territory details | ~147 ms total (≈5.9 ms avg) |
| 20 sequential REAL assaults (full pipeline) | avg ≈75 ms, max ≈200 ms per assault |

API viewports are capped at 441 cells by policy (`WORLD_MAP_POLICY.maxViewportArea`);
10k-cell generation is therefore measured at the pure-generator + DB level, which is
where scale actually lives.

## 19. Testing

- Unit: `tests/unit/game/world-config.test.ts` (16), `tests/unit/game/world-generator.test.ts` (21)
- Integration: `world-system` (14) · `world-security` (10) · `world-concurrency` (5) · `world-load` (5)
- E2E: `tests/e2e/world-journey.test.ts` (12) — LOGIN → MAP → CAPITAL → SELECT →
  TERRAIN → ATTACK → REAL BATTLE → CASUALTIES → SPOILS → CAPTURE → QUEST PROGRESS →
  LEDGER → RANKING → NOTIFICATION → HISTORY → UPDATED MAP, zero mocks
- Regression: **786/786 green** (baseline 702 preserved + 84 new); the three contract
  updates are design decisions, not weakenings (battle config version 1 → 2;
  deploy-artifacts now validates baseline + committed migrations; env contract
  excludes the derived worker flag like the other derived flags)

## 20. Known limitations

- The sandbox dev DB is a SHARED fixture: suites clean their own players and (via
  `tests/helpers/cleanup.ts`) reset their territories. Abandoned capitals from
  pre-Phase-32 cleanup semantics were repaired once; the helper now prevents
  recurrence. If a future seed changes `WORLD.seed`, existing worlds are NOT
  regenerated (regions already exist) — a deliberate operator migration.
- Armies are realm-wide: a player-owned territory is defended by the owner's whole
  army + terrain (no per-territory garrisons or marches yet — `March` remains a
  Phase 2 contract table for the future march phase).
- Territory assaults never loot a defender's wallet (config spoils only) — a
  deliberate balance decision keeping city raids unique.
- A real Telegram bot token configured in a dev/QA environment makes the in-process
  worker dial real APIs; set `NOTIFICATION_WORKER_DISABLED=true` (new documented ops
  flag) when a dedicated worker drains the queue or when tests must own the queue.
- The production build (`bun run build`) cannot execute in this sandbox by policy;
  typecheck + lint + dev-server compile + full route coverage substitute for it.
