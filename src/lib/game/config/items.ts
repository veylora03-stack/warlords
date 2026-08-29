/**
 * WARLORDS — Item catalog (baseline starter set).
 * Data source for the `items` table seed.
 */

import type { ItemSlot, Rarity } from '@/lib/game/types/common'
import type { RewardKey } from './quests'

export interface ItemCatalogEntry {
  id: string
  name: string
  slot: ItemSlot
  rarity: Rarity
  stats: Record<string, number> // equipment stats (absolute or bps keys)
  effects: Partial<Record<'secondsReduced' | 'grants', number | string[]>> & {
    rewardKeys?: RewardKey[]
  }
  stackable: boolean
  sellable: boolean
  basePrice: number | null
  description: string
}

export const ITEMS: ItemCatalogEntry[] = [
  {
    id: 'speedup-5m',
    name: '5-Minute Order',
    slot: 'CONSUMABLE',
    rarity: 'COMMON',
    stats: {},
    effects: { secondsReduced: 300 },
    stackable: true,
    sellable: true,
    basePrice: 20,
    description: "A courier bearing the warlord's seal — shaves 5 minutes off any timer.",
  },
  {
    id: 'speedup-1h',
    name: 'Hourglass of Command',
    slot: 'CONSUMABLE',
    rarity: 'RARE',
    stats: {},
    effects: { secondsReduced: 3600 },
    stackable: true,
    sellable: true,
    basePrice: 150,
    description: 'Sand that falls only when commanded: removes 1 hour from any timer.',
  },
  {
    id: 'sword-iron',
    name: 'Iron Longsword',
    slot: 'WEAPON',
    rarity: 'RARE',
    stats: { attackBps: 800 },
    effects: {},
    stackable: false,
    sellable: true,
    basePrice: 300,
    description: 'Folded iron, honest edge: +8% attack when equipped on a commander.',
  },
  {
    id: 'chest-starter',
    name: 'Starter Chest',
    slot: 'CHEST',
    rarity: 'COMMON',
    stats: {},
    effects: { grants: ['speedup-5m'], rewardKeys: ['GOLD'] },
    stackable: true,
    sellable: false,
    basePrice: null,
    description: 'Supplies from the crown. Contents revealed on opening.',
  },
]
