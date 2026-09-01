/**
 * WARLORDS — City site selection (world geometry, game layer).
 *
 * Deterministic spiral search from the world origin: the first free (x, y)
 * cell wins. Coordinates are unique per City (@@unique([x, y])), so new
 * players always get a provably free site. Reads existing cities + unclaimable
 * world cells ONCE and resolves against an in-memory set — O(cells) per
 * signup, fine for MVP scale and replaced by a spatial index when the world
 * grows.
 *
 * Phase 32: the chosen cell must ALSO be claimable as a capital territory —
 * LOCKED cells, generated capitals and player-owned territories are avoided
 * up-front so the bootstrap capital claim can never race a special site.
 */

import type { Tx } from '@/lib/game/services/player-bootstrap.service'
import { WORLD } from '@/lib/game/config/world'

/** Hard cap so a corrupt world can never spin forever. */
const MAX_RADIUS = 512

/**
 * Deterministic spiral search WITHIN the world grid (Phase 32): every city —
 * and therefore every capital territory — sits on a real world cell. The
 * taken-set covers city rows AND unclaimable territory cells (LOCKED,
 * capitals, owned), so the bootstrap capital claim can never race a blocked
 * site. Throws when the world is full (operator problem, not a silent leak).
 */
export async function findFreeCityCoordinate(tx: Tx): Promise<{ x: number; y: number }> {
  const [cities, blockedCells] = await Promise.all([
    tx.city.findMany({ select: { x: true, y: true } }),
    tx.territory.findMany({
      where: {
        OR: [{ status: 'LOCKED' }, { isCapital: true }, { ownerPlayerId: { not: null } }],
      },
      select: { x: true, y: true },
    }),
  ])
  const taken = new Set(cities.map((c) => `${c.x},${c.y}`))
  for (const cell of blockedCells) taken.add(`${cell.x},${cell.y}`)

  const maxX = WORLD.sizeX - 1
  const maxY = WORLD.sizeY - 1
  const inBounds = (x: number, y: number): boolean => x >= 0 && x <= maxX && y >= 0 && y <= maxY

  if (!taken.has('0,0')) return { x: 0, y: 0 }

  const maxRadius = Math.max(maxX, maxY, 1)
  for (let r = 1; r <= Math.min(MAX_RADIUS, maxRadius); r++) {
    // Top & bottom rows of the ring (in-grid cells only)
    for (let x = Math.max(-r, 0); x <= Math.min(r, maxX); x++) {
      if (inBounds(x, -r) && !taken.has(`${x},${-r}`)) return { x, y: -r }
      if (inBounds(x, r) && !taken.has(`${x},${r}`)) return { x, y: r }
    }
    // Left & right columns (corners already covered above)
    for (let y = -r + 1; y <= r - 1; y++) {
      if (inBounds(-r, y) && !taken.has(`${-r},${y}`)) return { x: -r, y }
      if (inBounds(r, y) && !taken.has(`${r},${y}`)) return { x: r, y }
    }
  }
  throw new Error('The world is full — no free city coordinate remains')
}
