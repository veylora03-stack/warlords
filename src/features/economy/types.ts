/**
 * WARLORDS — Economy feature types (mirror of the server DTOs).
 *
 * All amounts cross the API as strings (BigInt policy) — the UI performs
 * display formatting only, never authority math.
 */

export interface EconomyResourceView {
  key: string
  balance: string
  cap: string
  headroom: string
}

export interface EconomyWallet {
  playerId: string
  resources: EconomyResourceView[]
  updatedAt: string
}

export interface EconomyLedgerEntry {
  id: string
  resource: string
  delta: string
  balanceAfter: string
  reason: string
  refType: string | null
  refId: string | null
  metadata: unknown
  createdAt: string
}

export interface EconomyLedgerPage {
  entries: EconomyLedgerEntry[]
  nextCursor: string | null
  hasMore: boolean
}

/** Display metadata for the six canonical economy resources. */
export const ECONOMY_RESOURCE_LABELS: Record<string, string> = {
  GOLD: 'Gold',
  WOOD: 'Wood',
  IRON: 'Iron',
  FOOD: 'Food',
  CRYSTAL: 'Crystal',
  GEMS: 'Gems',
}
