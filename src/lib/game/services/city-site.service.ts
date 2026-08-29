/**
 * WARLORDS — City site selection (world geometry, game layer).
 *
 * Deterministic spiral search from the world origin: the first free (x, y)
 * cell wins. Coordinates are unique per City (@@unique([x, y])), so new
 * players always get a provably free site. Reads existing cities ONCE and
 * resolves against an in-memory set — O(cities) per signup, fine for MVP
 * scale and replaced by a spatial index when the world grows.
 */

import type { Tx } from '@/lib/game/services/player-bootstrap.service'

/** Hard cap so a corrupt world can never spin forever. */
const MAX_RADIUS = 512

export async function findFreeCityCoordinate(tx: Tx): Promise<{ x: number; y: number }> {
  const cities = await tx.city.findMany({ select: { x: true, y: true } })
  const taken = new Set(cities.map((c) => `${c.x},${c.y}`))

  if (!taken.has('0,0')) return { x: 0, y: 0 }

  for (let r = 1; r <= MAX_RADIUS; r++) {
    // Top & bottom rows of the ring
    for (let x = -r; x <= r; x++) {
      if (!taken.has(`${x},${-r}`)) return { x, y: -r }
      if (!taken.has(`${x},${r}`)) return { x, y: r }
    }
    // Left & right columns (corners already covered above)
    for (let y = -r + 1; y <= r - 1; y++) {
      if (!taken.has(`${-r},${y}`)) return { x: -r, y }
      if (!taken.has(`${r},${y}`)) return { x: r, y }
    }
  }
  throw new Error(`No free city coordinate within radius ${MAX_RADIUS}`)
}
