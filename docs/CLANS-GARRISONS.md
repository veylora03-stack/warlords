# Clans & Positional Territory Garrisons (Phase 34)

Phase 34 turns three previously-abstract ideas into real, persistent,
server-authoritative systems: **clan membership**, **positional military
presence** (a garrison that physically sits on a territory and defends it),
and the march actions that feed them (**DEFEND**, **REINFORCE**, withdrawal).
It extends the Phase 32 World/Territory engine and the Phase 33 March engine —
it does not replace or duplicate either.

```
PLAYER → CLAN MEMBERSHIP → MARCH ENGINE → TERRITORY GARRISON
       → BATTLE ENGINE → WORLD/TERRITORY ENGINE → ECONOMY/QUEST/ACHIEVEMENT/NOTIFICATION
```

ONE of every engine. No second march engine, no second battle engine, no
second territory system. Every write happens inside the caller's locked
transaction (`march:engine → db:write`, `battle:engine → db:write`,
`clan:engine → db:write`), and every lifecycle edge is a conditional claim
(rowcount-guarded state transition), so racing callers converge on exactly one
outcome.

## Schema (additive — SQLite + PostgreSQL twins, migration `20260904000000_clans_garrisons`)

**TerritoryGarrison** — one row per deployed march (a *contribution record*):

| column      | notes                                                              |
| ----------- | ------------------------------------------------------------------ |
| id          | cuid                                                               |
| territoryId | FK → territories (cascade)                                         |
| playerId    | FK → players (cascade) — the contributor                            |
| marchId     | FK → marches (cascade), `@unique` — the immutable deployment audit  |
| clanId      | snapshot of the contributor's clan at deployment (audit: which clan)|
| units       | JSON `[{unitId, count}]` — **current survivors**, not the original manifest |
| deployedAt  | ordering key for deterministic loss distribution                    |

There is deliberately **no status column**: the march carries the lifecycle
(`EN_ROUTE` = deploying, `ARRIVED` = active/stationed, `RETURNING` =
withdrawing, `LOST` = destroyed in combat or routed by a capture). A row
exists exactly while the contribution is stationed. There is no version
column either: `db:write` serialization plus conditional claims arbitrate
races (documented decision; the C1–C9 suite proves the invariant).

Clans reuse the Phase 2 contract models **as-is** (`Clan`, `ClanMember` — one
membership per player — `ClanInvitation`, `Player.clanId/clanRole`
denormalized). No new clan tables.

## Clan domain

### Roles and authority (server-only)

`LEADER > OFFICER > MEMBER` (`roleRank` in `clan.service.ts`). The matrix:

| action                | who                                      |
| --------------------- | ---------------------------------------- |
| create                | any clanless player (`CLAN_CREATE` idempotency key) |
| join                  | any clanless player when `joinPolicy=OPEN`, or via a claimed invitation (`INVITE_ONLY`) |
| invite                | OFFICER and above                        |
| remove                | OFFICER may remove MEMBERs only          |
| promote / demote      | LEADER only, and only `MEMBER ↔ OFFICER` (the role route can never mint a LEADER) |
| transfer leadership   | LEADER → any member (the old leader becomes OFFICER) |
| leave                 | anyone EXCEPT a leader who has not transferred first (`CLAN_LEADER_SUCCESSION`) |

Every mutation is transactional, state-guarded and replay-safe: repeating the
same action hits a typed refusal (`ALREADY_IN_CLAN`, `NOT_A_MEMBER`,
`CLAN_LEADER_SUCCESSION`, `CLAN_INVITATION_INVALID`, …), never a double
effect. Player.clanId/clanRole are updated **inside the same transaction** as
the membership row. Config (`config/clan.ts`): name 3–24 chars, tag 2–5
`[A-Z0-9]` (both unique), member cap 50, invite TTL 24h, join policies
`OPEN | INVITE_ONLY`.

## Garrison capacity (STEP 9 — minimal, documented)

`config/garrison.ts`:

```
capacity(territory) = capacityBase (400) + capacityPerStrategicValue (250) × territory.strategicValue
maxContributionsPerTerritory = 20
```

Capacity is checked twice: a **soft pre-check at march creation** (counts
currently stationed troops only — in-flight marches are not yet real) and a
**hard re-check at arrival** (the authoritative one; a mid-flight landing that
would exceed capacity bounces the ENTIRE detachment home — it never splits,
never partially stations). The bounce rides the existing return leg; the
homecoming restores the full manifest exactly once.

## Deployment — the march engine is the ONLY path

`POST /api/v1/world/territories/[id]/garrison` is a thin front for
`createMarch`:

* **DEFEND** — only onto a territory the caller owns (server-side ownership
  check; the client's words are irrelevant).
* **REINFORCE** — onto the caller's own holding **or** a territory owned by a
  player of the caller's **current clan** (`resolveGarrisonAuthorization`,
  pure + unit-tested). Authorization is resolved server-side from CURRENT
  membership — at creation AND again **in-transaction at arrival**. Leaving
  the clan, being kicked, or the owner changing hands mid-flight bounces the
  detachment home (`DESTINATION_NOT_AUTHORIZED`), exactly like an
  over-capacity arrival.

At arrival (march engine, `march:engine → db:write`): conditional
`EN_ROUTE → ARRIVED` claim → re-authorization → capacity re-check →
`deployGarrisonInTx` creates the contribution from the **immutable
march.units manifest** (the client can never state a count here — the units
were CAS-reserved from `player_units` at creation) → march outcome
`{ delivered, garrisoned, destinationCoord }` → `GARRISON_DEPLOYED` stat +
quest event. Stationed (`ARRIVED`) marches consume **no march slot** — the
castle's slots gate travelling armies, not standing garrisons.

## Battle integration (ONE engine)

`resolveTerritoryAssaultInTx` (the shared Phase 32/33 pipeline, simulator
untouched) builds the defender for an OWNED territory in two tiers:

1. **Positional garrison first** — if `TerritoryGarrison` rows exist for the
   territory, the garrison stacks are the defender (`wasReal: true`, credited
   to the territory owner). The home army does NOT defend.
2. **Realm-wide fallback** — no garrison rows → the owner's home army defends
   (Phase 33 behavior preserved, regression-locked by the march suites).
3. Unclaimed cells keep the deterministic **virtual garrison** (unchanged;
   its losses are never persisted anywhere).

Casualties flow through `applyGarrisonCasualtiesInTx`:

* `distributeGarrisonLosses` (pure, unit-tested) splits the simulator's
  authoritative defender losses across contributions **proportionally**, in a
  fixed order (`deployedAt ASC, id ASC`), with the integer remainder assigned
  deterministically. Invariants: `Σ distributed == min(loss, Σ holdings)`,
  no negative rows.
* Survivors are written back per contribution; the march's `survivors`
  manifest mirrors the contribution at all times.
* A contribution wiped to zero is deleted and its march transitions
  `ARRIVED → LOST` with outcome `{ garrisonDestroyed: true, battleId }` — and
  the contributor receives a `GARRISON_DESTROYED` notification
  (`garrison_destroyed:{marchId}` dedupe key).
* When the attacker WINS and the territory falls, `destroyGarrisonInTx`
  routes every surviving contribution: rows deleted, marches
  `ARRIVED → LOST` with outcome `{ garrisonRouted: true, battleId }` (routed
  defenders do NOT teleport home — no second movement system was invented),
  and `GARRISON_DESTROYED` notifications go to every affected contributor.

## Multi-contributor truth (STEP 12)

Any clan can stack up to 20 contributions on one territory. Every row answers
the audit questions directly: **who** (`playerId`), **how much now**
(`units`), **which clan** (`clanId` snapshot), **when** (`deployedAt`), and
how they died (`march.outcome` `garrisonDestroyed` / `garrisonRouted`).
Aggregation is a plain sum over rows — no ownership flattening ever happens.

## Withdrawal (STEP 13)

`POST /api/v1/world/territories/[id]/garrison/withdraw { marchId }` (and the
march-level `POST /api/v1/marches/[id]/withdraw`):

1. The march must be the caller's OWN and `ARRIVED`.
2. Conditional claim `ARRIVED → RETURNING` (exactly-once — racing callers or
   a battle resolution converge on one winner), survivors = the contribution's
   current units, the row is deleted.
3. `returnsAt` is computed by the existing travel-time math; the **unchanged**
   homecoming processor restores the survivors to `player_units` exactly once.

Dead troops can never withdraw — the contribution only holds survivors. A
withdrawal racing a battle is arbitrated by the claims: whoever claimed first
decided (C3/C5/E6).

## Season settlement

`releaseTerritoryGarrisonsInTx` (called by the season-settlement service when
`TERRITORY_OWNERSHIP` is stripped) sends every stationed detachment home
(`ARRIVED → RETURNING` via the existing return leg) and deletes the
contributions — mobilization ends with the season.

## Concurrency (STEP 16 — all proven by tests)

`tests/integration/garrison/garrison-concurrency.test.ts` (C1–C9):

| race | guarantee proven |
| ---- | ---------------- |
| C1 two clansmen reinforce simultaneously | two distinct contributions, exact totals |
| C2 two in-flight reinforcements exceed capacity together | exactly one stations, the other bounces whole |
| C3 withdraw × battle on one contribution | exactly one claim wins the `ARRIVED` march |
| C4 battle × reinforcement arrival | serialized outcomes; contribution lives (mirrored), dies (LOST), or bounces — never duplicated |
| C5 multi-contributor wipe racing withdrawals | `survivors + restored + destroyed == committed` |
| C6 one lord's deploy+deploy+withdraw concurrently | slot-safe, unit-conserving |
| C7 ten concurrent FOREIGN reinforce attempts | every one a typed refusal, zero writes |
| C8 ten duplicate deploys, one idempotency key | one march, one reservation |
| C9 same key, different destination | typed `IDEMPOTENT_REPLAY`, one march |

## Exactly-once invariants (STEP 17)

```
player army before = after + reserved-in-marches − legitimately returned
garrison total     = Σ contribution.units                       (no split, no clone)
destroyed + surviving + withdrawn = originally committed        (per contribution)
```

No unit is ever created from nothing, and destruction happens only through
battle settlement or documented routing.

## Security & exploits (STEP 18 / 30)

`garrison-security.test.ts` (S1–S9): fake territory/march ids → typed 404s
with no existence oracle; fake unit manifests → zero-write refusals; fake
ownership → refused; fake clan membership → authorization dies mid-flight;
cross-player withdrawal impossible at every layer; replayed withdrawal /
deployment cannot double-restore or double-deploy; the garrison view exposes
unit manifests **only** to the owner and contributors
(`viewerSeesComposition`); forged timestamps cannot rush arrival or
homecoming; zero unauthorized writes across the whole matrix. The public map
and detail views expose a resistance HINT (`defenseStrength`) for unclaimed
cells only — never a composition.

Audit finding fixed in this phase: a garrison annihilated **in combat**
(previously silent) now notifies its contributor (`GARRISON_DESTROYED`), the
same audit surface as capture routing.

## Catalogs

* **Quest events**: `CLAN_CREATED`, `CLAN_JOINED` (activates the reserved
  `JOIN_CLAN` objective), `GARRISON_DEPLOYED` (`MARCH_COMPLETED` identity
  `march:{id}` prevents double-counting at homecoming).
* **Stats**: `clansJoined`, `garrisonsDeployed`, `garrisonWithdrawals`.
* **Achievements**: first clan joined, garrison captain, garrison general.
* **Notifications**: `CLAN_JOINED`, `CLAN_LEADERSHIP_CHANGED`,
  `GARRISON_DEPLOYED`, `GARRISON_WITHDRAWN`, `GARRISON_DESTROYED` (+ existing
  `CLAN_INVITE`), all through `enqueueNotificationInTx` with dedupe keys —
  one logical event, at most one notification.
* **Error codes** (10 new): `CLAN_NAME_TAKEN`, `CLAN_TAG_TAKEN`,
  `CLAN_FULL`, `CLAN_LEADER_SUCCESSION`, `CLAN_INVITATION_INVALID`,
  `MARCH_GARRISON_FULL`, `MARCH_NOT_WITHDRAWABLE`, `GARRISON_NOT_FOUND`,
  plus the march engine's existing typed refusals reused verbatim.

## API surface

```
POST   /api/v1/clans                              create (idempotency key)
GET    /api/v1/clans                              browse (name/tag/counts)
GET    /api/v1/clans/[id]                         detail + members
POST   /api/v1/clans/[id]/join                    open policy or claimed invite
POST   /api/v1/clans/[id]/leave                   non-leader exit
POST   /api/v1/clans/[id]/invite                  officer+ (24h TTL)
POST   /api/v1/clans/[id]/members/[playerId]/role leader (MEMBER ↔ OFFICER)
POST   /api/v1/clans/[id]/members/[playerId]/remove officer+ (members only)
POST   /api/v1/clans/[id]/transfer                leadership succession
GET    /api/v1/clans/invitations                  my open invitations
GET    /api/v1/world/territories/[id]/garrison    public strength; manifests filtered
POST   /api/v1/world/territories/[id]/garrison    DEFEND/REINFORCE (march engine)
POST   /api/v1/world/territories/[id]/garrison/withdraw   recall own contribution
POST   /api/v1/marches/[id]/withdraw              march-level recall
```

All routes: session-guarded, rate-limited, zod-validated, standard envelope,
typed error codes — no internal DB state ever exposed.

## Mini App

* **Clans panel** — my clan (name/tag/level/roster/role), role-gated actions,
  create form (bounds mirrored client-side), clan browser with join,
  invitations.
* **Territory detail** — `🛡 GARRISONED` badge, strength/capacity bar,
  capacity remaining, contributors (manifests only when permitted), DEFEND /
  REINFORCE deploy controls (roster from the server's army verdict), withdraw.
* **Marches** — `STATIONED` badge for `ARRIVED` garrison marches with a
  WITHDRAW action.

Every panel renders server verdicts only; refusals surface the server's typed
error codes verbatim.

## Known limitations (honest)

1. **Clan ownership of territories is implicit.** A territory's owner is
   always a player; "clan control" is expressed through membership-based
   REINFORCE authorization and the clanId snapshot on contributions. A
   dedicated `Territory.clanId` was deliberately NOT added (the world model's
   ownership invariants are player-keyed; a clan column would require
   re-plumbing capture/settlement for zero behavioral gain today).
2. **Routed defenders do not return home.** A captured territory's survivors
   are disbanded (`LOST`), not teleported — documented design, no second
   movement system.
3. **No clan treasury/wars/levels yet.** `Clan.treasury/level/xp/trophies`
   exist as contract columns; Phase 34 wires membership + garrisons only.
4. **No garrison upkeep or decay.** Stationed troops cost nothing over time.
5. **Capacity is config-only** (base + strategic value), not building- or
   tech-driven — deliberately minimal for v1, upgrade path is a pure function
   swap in `capacityForTerritory`.
6. **The garrison view's `viewerSeesComposition`** trusts only server-side
   membership/ownership computed per request — clients cache nothing
   authoritative.
7. Production build is not runnable in this sandbox (policy forbids
   `bun run build`); verification relies on dev-server + full test suites.
