import { db } from './src/lib/db'
console.log('territories:', await db.territory.count())
const owned = await db.territory.findMany({ where: { ownerPlayerId: { not: null } }, select: { x: true, y: true, isCapital: true, type: true, status: true, ownerPlayerId: true } })
console.log('owned now:', owned)
const players = await db.player.findMany({ where: { user: { telegramId: { startsWith: '9100032' } } }, select: { id: true, name: true, city: { select: { x: true, y: true } } } })
console.log('leftover test players:', players)
const noRegion = await db.territory.findMany({ where: { regionId: null }, select: { x: true, y: true, type: true, status: true } })
console.log('territories without region:', noRegion)
await db.$disconnect()
