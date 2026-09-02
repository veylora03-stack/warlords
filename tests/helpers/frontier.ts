/**
 * WARLORDS — Shared test geography helper (Phase 34).
 *
 * Positional-defense scenarios need a lord and a foe whose holdings touch a
 * common frontier: the lord captures & garrisons cell X, the foe expands into
 * the neighbouring cell Y and assaults X from there. The spawn spiral fills a
 * dense block of capitals at the world edge, so the two-step chain
 * (lord-cap → X ⇄ Y → foe-cap) emerges within a few registrations.
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
  cell: { id: string; x: number; y: number }
  /** The foe-side staging cell: to be captured by the foe before assaulting. */
  foeCell: { id: string }
}

/** True when an UNCLAIMED cell still sits at (x, y). */
async function isUnclaimed(x: number, y: number): Promise<boolean> {
  const row = await db.territory.findUnique({
    where: { x_y: { x, y } },
    select: { status: true },
  })
  return row?.status === 'UNCLAIMED'
}

async function findChain(register: () => Promise<{ playerId: string }>): Promise<FrontierChain> {
  let lord = ''
  let lordCap: { x: number; y: number } | null = null

  for (let attempt = 0; attempt < 24; attempt++) {
    const p = await register()
    const cap = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: p.playerId, isCapital: true },
      select: { x: true, y: true },
    })

    if (lord === '') {
      // The lord needs ONE unclaimed neighbour to expand into — fresh read.
      for (const c of adjacentCoords(cap.x, cap.y)) {
        if (await isUnclaimed(c.x, c.y)) {
          lord = p.playerId
          lordCap = cap
          break
        }
      }
      continue
    }

    // Foe candidate: find an unclaimed X next to the lord's capital and an
    // unclaimed Y next to THIS player's capital with X adjacent to Y — all
    // freshly read from the database.
    for (const lx of adjacentCoords(lordCap!.x, lordCap!.y)) {
      if (!(await isUnclaimed(lx.x, lx.y))) continue
      for (const ny of adjacentCoords(lx.x, lx.y)) {
        if (ny.x === lx.x && ny.y === lx.y) continue
        if (!(await isUnclaimed(ny.x, ny.y))) continue
        const touchesFoe = adjacentCoords(ny.x, ny.y).some((n) => n.x === cap.x && n.y === cap.y)
        if (touchesFoe) {
          const xRow = await db.territory.findUniqueOrThrow({
            where: { x_y: { x: lx.x, y: lx.y } },
            select: { id: true, x: true, y: true },
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
): Promise<FrontierChain> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < rounds; attempt++) {
    try {
      return await findChain(register)
    } catch (error) {
      lastError = error as Error
      console.log(`frontier finder round ${attempt + 1} retrying: ${lastError.message}`)
    }
  }
  throw lastError ?? new Error('no stable two-step frontier chain')
}
