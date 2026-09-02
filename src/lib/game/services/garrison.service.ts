/**
 * WARLORDS — Positional Territory Garrison service (Phase 34).
 *
 * A TerritoryGarrison row is ONE contributor's positional detachment on ONE
 * territory: it is created by a DEFEND/REINFORCE march arrival, defended by
 * the EXISTING battle engine when the territory is assaulted, mutated ONLY
 * by battle settlement / withdrawal inside locked transactions, and removed
 * by withdrawal (units go home through the march return leg), capture
 * (garrison routed) or season settlement (mobilization ends).
 *
 * SINGLE-SYSTEM RULES honored here:
 *  - No second battle engine: garrison stacks are ordinary BattleSides fed
 *    into the existing `simulateBattle`; losses flow back through the
 *    deterministic distribution below.
 *  - No second march engine: deployment/withdrawal are march states
 *    (EN_ROUTE → ARRIVED → RETURNING); this service never moves units on its
 *    own — it only reads manifests and writes survivor manifests.
 *  - No duplicated terrain/energy/economy logic: callers attach terrain
 *    modifiers from the single TERRAIN catalog; this module is a leaf.
 *
 * CONCURRENCY: every write happens inside the CALLER'S locked transaction
 * (march:engine → db:write or battle:engine → db:write). The in-process
 * db:write mutex serializes transaction bodies, and every lifecycle edge is
 * a conditional claim (march status rowcount), so racing callers converge on
 * exactly one outcome (C1–C9 in the Phase 34 test suites).
 *
 * SECURITY: the client can never state a unit count here. Contributions are
 * built from the IMMUTABLE March.units manifest, which was CAS-reserved from
 * player_units at march creation. Losses come only from the battle simulator.
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { AppError } from '@/lib/api/errors'
import type { Tx } from './player-bootstrap.service'
import { GARRISON, garrisonCapacity } from '@/lib/game/config/garrison'
import { toBattleStack } from './battle.service'
import {
  readStoredStacks,
  subtractStacks,
  totalUnits,
  type MarchStack,
} from '@/lib/game/engine/march/movement'
import type { BattleUnitStack } from '@/lib/game/types/battle'

type ReadClient = Tx | PrismaClient

// ── Pure loss distribution (unit-tested — the ONLY casualty allocation) ──────

/** A garrison contribution as seen by the pure algebra (no Prisma types). */
export interface GarrisonContributionManifest {
  contributionId: string
  marchId: string
  units: MarchStack[]
}

/**
 * Distributes aggregate defender losses across garrison contributions
 * DETERMINISTICALLY: proportional to each contribution's holding of the
 * lost unit type, with the integer remainder assigned in the contributions'
 * fixed order (deployedAt ASC, id ASC — enforced by the caller's query).
 *
 * Invariants (unit-tested, STEP 17):
 *   Σ distributed per unit type == min(loss, Σ holdings)  (exact)
 *   no contribution goes negative; extra losses beyond holdings are
 *   impossible (the battle side was built from these very manifests).
 */
export function distributeGarrisonLosses(
  contributions: readonly GarrisonContributionManifest[],
  losses: readonly { unitTypeId: string; count: number }[],
): Map<string, { unitTypeId: string; count: number }[]> {
  const plan = new Map<string, { unitTypeId: string; count: number }[]>()
  for (const contribution of contributions) plan.set(contribution.contributionId, [])

  for (const loss of losses) {
    if (loss.count <= 0) continue
    // Contributions holding this unit type, in their fixed order.
    const holders = contributions.filter((c) =>
      c.units.some((s) => s.unitId === loss.unitTypeId && s.count > 0),
    )
    const available = holders.reduce(
      (sum, c) => sum + (c.units.find((s) => s.unitId === loss.unitTypeId)?.count ?? 0),
      0,
    )
    if (available < loss.count) {
      // The simulator can only lose units it was given — fail closed.
      throw new AppError(
        'INTERNAL_ERROR',
        `Garrison casualty invariant violated for ${loss.unitTypeId}: need ${loss.count}, garrison holds ${available}`,
      )
    }
    if (available === loss.count) {
      // Whole type wiped — every holder pays in full.
      for (const holder of holders) {
        const count = holder.units.find((s) => s.unitId === loss.unitTypeId)!.count
        plan.get(holder.contributionId)!.push({ unitTypeId: loss.unitTypeId, count })
      }
      continue
    }
    // Proportional shares (floor) + remainder in fixed order.
    const shares = holders.map((holder) => {
      const count = holder.units.find((s) => s.unitId === loss.unitTypeId)!.count
      return { holder, count, share: Math.floor((loss.count * count) / available) }
    })
    let assigned = shares.reduce((sum, s) => sum + s.share, 0)
    for (const entry of shares) {
      while (assigned < loss.count && entry.share < entry.count) {
        entry.share += 1
        assigned += 1
      }
    }
    if (assigned !== loss.count) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Garrison loss remainder invariant violated for ${loss.unitTypeId}`,
      )
    }
    for (const entry of shares) {
      if (entry.share > 0) {
        plan
          .get(entry.holder.contributionId)!
          .push({ unitTypeId: loss.unitTypeId, count: entry.share })
      }
    }
  }
  return plan
}

/** Sums manifests across contributions (pure). */
export function sumContributionUnits(
  manifests: readonly MarchStack[][],
): MarchStack[] {
  const merged = new Map<string, number>()
  for (const stacks of manifests) {
    for (const stack of stacks) {
      merged.set(stack.unitId, (merged.get(stack.unitId) ?? 0) + stack.count)
    }
  }
  return [...merged.entries()]
    .map(([unitId, count]) => ({ unitId, count }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0))
}

/** The deterministic capacity for a territory (config-only policy). */
export function capacityForTerritory(strategicValue: number): number {
  return garrisonCapacity(strategicValue)
}

/** Pure authorization matrix (STEP 14) — unit-tested; the ONLY authority. */
export function resolveGarrisonAuthorization(input: {
  type: 'DEFEND' | 'REINFORCE'
  playerId: string
  playerClanId: string | null
  territoryOwnerPlayerId: string | null
  territoryOwnerClanId: string | null
}): { authorized: boolean; reason?: string } {
  const { type, playerId, playerClanId, territoryOwnerPlayerId, territoryOwnerClanId } = input
  if (territoryOwnerPlayerId === null) return { authorized: false, reason: 'UNCLAIMED' }
  if (type === 'DEFEND') {
    // Only the owner stations a DEFEND detachment on their own holding.
    return territoryOwnerPlayerId === playerId
      ? { authorized: true }
      : { authorized: false, reason: 'NOT_OWNER' }
  }
  // REINFORCE: the owner themselves, or a SAME-CLAN comrade of the owner.
  if (territoryOwnerPlayerId === playerId) return { authorized: true }
  if (
    playerClanId !== null &&
    territoryOwnerClanId !== null &&
    playerClanId === territoryOwnerClanId
  ) {
    return { authorized: true }
  }
  return { authorized: false, reason: 'NOT_SAME_CLAN' }
}

// ── Deployment (called by march.service arrival — inside its tx) ─────────────

export interface DeployGarrisonInput {
  marchId: string
  territoryId: string
  playerId: string
  clanId: string | null
  committed: readonly MarchStack[]
  now: Date
}

/** Creates the positional contribution from the immutable march manifest. */
export async function deployGarrisonInTx(
  tx: Tx,
  input: DeployGarrisonInput,
): Promise<void> {
  await tx.territoryGarrison.create({
    data: {
      territoryId: input.territoryId,
      playerId: input.playerId,
      marchId: input.marchId,
      clanId: input.clanId,
      units: input.committed as unknown as Prisma.InputJsonValue,
      deployedAt: input.now,
    },
  })
}

// ── Battle settlement (called by world.service / march assault — same tx) ────

/**
 * Applies simulator defender losses to the REAL positional garrison.
 * Deterministic distribution; fully-destroyed contributions are deleted and
 * their march transitions ARRIVED → LOST (outcome garrisonDestroyed).
 */
export async function applyGarrisonCasualtiesInTx(
  tx: Tx,
  territoryId: string,
  losses: readonly { unitTypeId: string; count: number }[],
  battleId: string,
  now: Date,
): Promise<void> {
  const hasLosses = losses.some((loss) => loss.count > 0)
  if (!hasLosses) return

  const rows = await tx.territoryGarrison.findMany({
    where: { territoryId },
    orderBy: [{ deployedAt: 'asc' }, { id: 'asc' }],
  })
  if (rows.length === 0) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Garrison casualties for ungarrisoned territory ${territoryId}`,
    )
  }

  const manifests: GarrisonContributionManifest[] = rows.map((row) => ({
    contributionId: row.id,
    marchId: row.marchId,
    units: readStoredStacks(row.units),
  }))
  const plan = distributeGarrisonLosses(manifests, losses)

  for (const [contributionId, contributionLosses] of plan) {
    if (contributionLosses.length === 0) continue
    const manifest = manifests.find((m) => m.contributionId === contributionId)!
    const survivors = subtractStacks(manifest.units, contributionLosses)
    if (survivors.length === 0) {
      // Contribution wiped — the row disappears and its march is LOST.
      const deleted = await tx.territoryGarrison.deleteMany({
        where: { id: contributionId },
      })
      if (deleted.count !== 1) {
        throw new AppError(
          'INTERNAL_ERROR',
          `Garrison contribution ${contributionId} vanished mid-settlement`,
        )
      }
      const claim = await tx.march.updateMany({
        where: { id: manifest.marchId, status: 'ARRIVED' },
        data: {
          status: 'LOST',
          completedAt: now,
          survivors: [] as unknown as Prisma.InputJsonValue,
          outcome: { garrisonDestroyed: true, battleId } as unknown as Prisma.InputJsonValue,
        },
      })
      if (claim.count !== 1) {
        throw new AppError(
          'INTERNAL_ERROR',
          `March ${manifest.marchId} was not ARRIVED while its garrison died`,
        )
      }
    } else {
      await tx.territoryGarrison.update({
        where: { id: contributionId },
        data: {
          units: survivors as unknown as Prisma.InputJsonValue,
          updatedAt: now,
        },
      })
      await tx.march.update({
        where: { id: manifest.marchId },
        data: { survivors: survivors as unknown as Prisma.InputJsonValue },
      })
    }
  }
}

/**
 * CAPTURE ROUTING (STEP 11): when a garrisoned territory falls, the entire
 * positional garrison is destroyed — surviving defenders are routed, they do
 * not teleport home (no second movement system is invented for this).
 * Every affected march transitions ARRIVED → LOST with an auditable outcome.
 * Returns the routed contributions (for post-capture notifications).
 */
export async function destroyGarrisonInTx(
  tx: Tx,
  territoryId: string,
  battleId: string,
  now: Date,
): Promise<{ playerId: string; marchId: string; unitsLost: number }[]> {
  const rows = await tx.territoryGarrison.findMany({
    where: { territoryId },
    select: { id: true, marchId: true, playerId: true, units: true },
  })
  const routed: { playerId: string; marchId: string; unitsLost: number }[] = []
  for (const row of rows) {
    const units = readStoredStacks(row.units)
    const claim = await tx.march.updateMany({
      where: { id: row.marchId, status: 'ARRIVED' },
      data: {
        status: 'LOST',
        completedAt: now,
        survivors: [] as unknown as Prisma.InputJsonValue,
        outcome: { garrisonRouted: true, battleId } as unknown as Prisma.InputJsonValue,
      },
    })
    if (claim.count !== 1) {
      throw new AppError(
        'INTERNAL_ERROR',
        `March ${row.marchId} was not ARRIVED while its territory was captured`,
      )
    }
    routed.push({ playerId: row.playerId, marchId: row.marchId, unitsLost: totalUnits(units) })
  }
  const deleted = await tx.territoryGarrison.deleteMany({ where: { territoryId } })
  if (deleted.count !== rows.length) {
    throw new AppError('INTERNAL_ERROR', 'Garrison capture invariant violated')
  }
  return routed
}

// ── Defense-side loading (called by assault pipelines — same tx) ─────────────

export interface GarrisonDefense {
  stacks: BattleUnitStack[]
  totalCount: number
  manifests: GarrisonContributionManifest[]
  /** unitTypeId → display name (battle-log rendering). */
  names: Map<string, string>
}

/**
 * Loads the positional garrison of an OWNED territory as battle stacks
 * (aggregated per unit type through the REAL unit catalog). Returns null
 * when the territory holds no contributions — the caller then falls back to
 * the realm-wide defense model (Phase 33 contract preserved).
 */
export async function loadGarrisonDefenseInTx(
  tx: Tx,
  territoryId: string,
): Promise<GarrisonDefense | null> {
  const rows = await tx.territoryGarrison.findMany({
    where: { territoryId },
    orderBy: [{ deployedAt: 'asc' }, { id: 'asc' }],
  })
  if (rows.length === 0) return null

  const manifests = rows.map((row) => ({
    contributionId: row.id,
    marchId: row.marchId,
    units: readStoredStacks(row.units),
  }))
  const totals = sumContributionUnits(manifests.map((m) => m.units))
  if (totals.length === 0) return null

  const unitIds = totals.map((stack) => stack.unitId)
  const catalog = await tx.unit.findMany({ where: { id: { in: unitIds } } })
  const catalogRows = new Map(catalog.map((row) => [row.id, row]))
  const stacks: BattleUnitStack[] = []
  for (const stack of totals) {
    const row = catalogRows.get(stack.unitId)
    if (!row) {
      throw new AppError(
        'INTERNAL_ERROR',
        `Garrison manifest references unknown unit ${stack.unitId}`,
      )
    }
    stacks.push(toBattleStack(stack.count, row))
  }
  return {
    stacks,
    totalCount: stacks.reduce((sum, stack) => sum + stack.count, 0),
    manifests,
    names: new Map<string, string>(catalog.map((row) => [row.id, row.name])),
  }
}

// ── Read model (map / territory detail / clan panel) ─────────────────────────

export interface GarrisonContributorView {
  marchId: string
  playerId: string
  playerName: string
  clanId: string | null
  units: MarchStack[]
  unitCount: number
  deployedAt: string
}

export interface TerritoryGarrisonView {
  territoryId: string
  garrisoned: boolean
  totalUnits: number
  capacity: number
  availableCapacity: number
  contributionCount: number
  /** Unit-level composition is visible only to the owner and contributors. */
  viewerSeesComposition: boolean
  contributors: GarrisonContributorView[]
}

/**
 * Read-side aggregation. Strength/capacity/contributor presence is public
 * map intel (the same data class scout reports expose); unit-level manifests
 * are restricted to the owner and contributors (server-side filter).
 */
export async function getTerritoryGarrisonView(
  client: ReadClient,
  territoryId: string,
  viewerPlayerId: string | null,
): Promise<TerritoryGarrisonView> {
  const territory = await client.territory.findUnique({
    where: { id: territoryId },
    select: { id: true, strategicValue: true, ownerPlayerId: true },
  })
  if (!territory) throw new AppError('TERRITORY_NOT_FOUND', 'Territory not found')

  const rows = await client.territoryGarrison.findMany({
    where: { territoryId },
    orderBy: [{ deployedAt: 'asc' }, { id: 'asc' }],
    include: { player: { select: { name: true } } },
  })

  const manifests = rows.map((row) => ({
    row,
    units: readStoredStacks(row.units),
  }))
  const stationedUnits = manifests.reduce((sum, entry) => sum + totalUnits(entry.units), 0)
  const capacity = capacityForTerritory(territory.strategicValue)
  const viewerSeesComposition =
    viewerPlayerId !== null &&
    (territory.ownerPlayerId === viewerPlayerId ||
      rows.some((row) => row.playerId === viewerPlayerId))

  const contributors: GarrisonContributorView[] = manifests.map(({ row, units }) => ({
    marchId: row.marchId,
    playerId: row.playerId,
    playerName: row.player.name,
    clanId: row.clanId,
    units: viewerSeesComposition ? units : [],
    unitCount: totalUnits(units),
    deployedAt: row.deployedAt.toISOString(),
  }))

  return {
    territoryId,
    garrisoned: rows.length > 0,
    totalUnits: stationedUnits,
    capacity,
    availableCapacity: Math.max(0, capacity - stationedUnits),
    contributionCount: rows.length,
    viewerSeesComposition,
    contributors,
  }
}

/** Re-exported for services that need the policy without config imports. */
export { GARRISON }
