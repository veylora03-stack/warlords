import { db } from './src/lib/db'
const players = await db.player.findMany({ select: { id: true } })
const ids = new Set(players.map((p) => p.id))
const owned = await db.territory.findMany({
  where: { ownerPlayerId: { not: null } },
  select: { id: true, x: true, y: true, ownerPlayerId: true, isCapital: true },
})
const orphans = owned.filter((t) => !ids.has(t.ownerPlayerId!))
console.log('owned total:', owned.length, '| orphans:', orphans.map((t) => `${t.x},${t.y}`))
const users = await db.user.findMany({ where: { telegramId: { startsWith: '9100032' } }, select: { id: true } })
console.log('leftover 9100032 users:', users.length)
await db.$disconnect()
