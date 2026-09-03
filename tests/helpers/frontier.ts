/**
 * WARLORDS — Shared test geography helper (Phase 34, hardened Phase 34.5).
 *
 * Positional-defense scenarios need a lord and a foe whose holdings touch a
 * common frontier: the lord captures & garrisons cell X, the foe expands into
 * the neighbouring cell Y and assaults X from there. The spawn spiral fills a
 * dense block of capitals at the world edge, so the two-step chain
 * (lord-cap → X ⇄ Y → foe-cap) emerges within a few registrations.
 *
 * Hardening (Phase 34.5 — full-suite parallel runs on a fresh world):
 *  1. STALE-LORD RESET — the first lord is picked once and his unclaimed
 *     neighbours can be consumed by PARALLEL suites' registrations while this
 *     suite is still searching for a foe. A centre lord whose ring filled is
 *     worthless; the helper now re-validates the lord on every attempt and
 *     re-selects from the newest (edge) registrations instead of exhausting
 *     the budget on dead geography.
 *  2. MIN STRATEGIC VALUE — the lord-side cell X is an arbitrary unclaimed
 *     cell (~12% of the world is SV 0). Callers whose scenario needs capacity
 *     (multi-contributor stacking) declare `minStrategicValue` so the chain
 *     only forms on cells whose garrison capacity fits the scenario.
 *
 * Every candidate check is a FRESH database read — there is no snapshot map
 * to go stale — so the moment a chain is verified, no further registrations
 * happen and the geography is race-free.
 */

import { db } from '../../src/lib/db'
import { adjacentCoords } from '../../src/lib/game/engine/world/generator'

export interface FrontierChain {
  lord: { playerId: string }
  foe: { playerId: string }
  /** The lord-side cell: to be captured & garrisoned by the lord. */
  cell: { id: string; x: number; y: number; strategicValue: number }
  /** The foe-side staging cell: to be captured by the foe before assaulting. */
  foeCell: { id: string }
}

export interface FrontierOptions {
  /** Minimum strategicValue for the LORD-side cell X (capacity drivers). */
  minStrategicValue?: number
}

type Cap = { x: number; y: number }

/** True when an UNCLAIMED cell (SV ≥ min) still sits at (x, y). */
async function isUnclaimed(x: number, y: number, minSv = 0): Promise<boolean> {
  const row = await db.territory.findUnique({
    where: { x_y: { x, y } },
    select: { status: true, strategicValue: true },
  })
  return row?.status === 'UNCLAIMED' && row.strategicValue >= minSv
}

async function hasUnclaimedNeighbour(cap: Cap, minSv = 0): Promise<boolean> {
  for (const c of adjacentCoords(cap.x, cap.y)) {
    if (await isUnclaimed(c.x, c.y, minSv)) return true
  }
  return false
}

async function findChain(
  register: () => Promise<{ playerId: string }>,
  minSv: number,
): Promise<FrontierChain> {
  let lord = ''
  let lordCap: Cap | null = null

  for (let attempt = 0; attempt < 24; attempt++) {
    const p = await register()
    const cap = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: p.playerId, isCapital: true },
      select: { x: true, y: true },
    })

    if (lord !== '') {
      // The world keeps filling from PARALLEL suites — a lord whose ring
      // filled is dead geography. Re-validate; fall through to re-selection.
      if (!(await hasUnclaimedNeighbour(lordCap!, minSv))) {
        lord = ''
        lordCap = null
      }
    }

    if (lord === '') {
      // The lord needs ONE unclaimed (SV ≥ minSv) neighbour to expand into.
      if (await hasUnclaimedNeighbour(cap, minSv)) {
        lord = p.playerId
        lordCap = cap
      }
      continue
    }

    // Foe candidate: find an unclaimed X next to the lord's capital and an
    // unclaimed Y next to THIS player's capital with X adjacent to Y — all
    // freshly read from the database.
    for (const lx of adjacentCoords(lordCap!.x, lordCap!.y)) {
      if (!(await isUnclaimed(lx.x, lx.y, minSv))) continue
      for (const ny of adjacentCoords(lx.x, lx.y)) {
        if (ny.x === lx.x && ny.y === lx.y) continue
        if (!(await isUnclaimed(ny.x, ny.y))) continue
        const touchesFoe = adjacentCoords(ny.x, ny.y).some((n) => n.x === cap.x && n.y === cap.y)
        if (touchesFoe) {
          const xRow = await db.territory.findUniqueOrThrow({
            where: { x_y: { x: lx.x, y: lx.y } },
            select: { id: true, x: true, y: true, strategicValue: true },
          })
          const yRow = await db.territory.findUniqueOrThrow({
            where: { x_y: { x: ny.x, y: ny.y } },
            select: { id: true },
          })
          return {
            lord: { playerId: lord },
            foe: { playerId: p.playerId },
            cell: xRow,
            foeCell: yRow,
          }
        }
      }
    }
  }
  throw new Error('no two-step frontier chain within 24 registrations')
}

export async function findTwoStepFrontier(
  register: () => Promise<{ playerId: string }>,
  rounds = 3,
  options: FrontierOptions = {},
): Promise<FrontierChain> {
  const minSv = options.minStrategicValue ?? 0
  let lastError: Error | null = null
  for (let attempt = 0; attempt < rounds; attempt++) {
    try {
      return await findChain(register, minSv)
    } catch (error) {
      lastError = error as Error
      console.log(`frontier finder round ${attempt + 1} retrying: ${lastError.message}`)
    }
  }
  throw lastError ?? new Error('no stable two-step frontier chain')
}
