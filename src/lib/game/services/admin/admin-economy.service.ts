/**
 * WARLORDS — Admin economy inspection service (Phase 21). READ-ONLY.
 *
 * Supply-side truth from the LEDGER (not from caches): per-resource money
 * supply across wallets, the flow by reason over the policy window, the
 * recent admin adjustments and the ledger's overall shape. Everything is a
 * server-side aggregate — the client cannot forge a single number here.
 */

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ECONOMY_RESOURCES } from '@/lib/game/config/economy'
import { ADMIN_PANEL_POLICY } from '@/lib/game/config/admin'
import { recordAdminAuditView } from './admin-audit.service'

export interface AdminEconomyOverview {
  generatedAt: string
  flowWindowDays: number
  supply: Record<string, string>
  playerCount: number
  walletsCount: number
  ledger: { totalRows: number; rowsInWindow: number }
  flowByReason: Array<{
    reason: string
    resource: string
    count: number
    net: string
    minted: string
    burned: string
  }>
  recentAdjustments: Array<{
    id: string
    actorUserId: string
    targetId: string | null
    reason: string | null
    after: unknown
    createdAt: string
  }>
}

export async function getEconomyOverview(input: {
  actorUserId: string
  ip?: string
}): Promise<AdminEconomyOverview> {
  const windowStart = new Date(Date.now() - ADMIN_PANEL_POLICY.flowWindowDays * 24 * 3600 * 1000)

  const [
    walletAgg,
    gemsAgg,
    playerCount,
    walletsCount,
    ledgerTotal,
    ledgerWindow,
    flowRaw,
    recentAdjustments,
  ] = await Promise.all([
    db.resourceWallet.aggregate({
      _sum: { gold: true, wood: true, iron: true, food: true, crystal: true },
      _count: { id: true },
    }),
    db.player.aggregate({ _sum: { gems: true }, _count: { id: true } }),
    db.player.count(),
    db.resourceWallet.count(),
    db.resourceTransaction.count(),
    db.resourceTransaction.count({ where: { createdAt: { gte: windowStart } } }),
    db.resourceTransaction.groupBy({
      by: ['reason', 'resource'],
      _count: { id: true },
      _sum: { delta: true },
      where: { createdAt: { gte: windowStart } },
      _min: { delta: true },
    }),
    db.auditLog.findMany({
      where: { action: 'ADJUST_RESOURCES' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ])

  const supply: Record<string, string> = {
    GOLD: (walletAgg._sum.gold ?? 0n).toString(),
    WOOD: (walletAgg._sum.wood ?? 0n).toString(),
    IRON: (walletAgg._sum.iron ?? 0n).toString(),
    FOOD: (walletAgg._sum.food ?? 0n).toString(),
    CRYSTAL: (walletAgg._sum.crystal ?? 0n).toString(),
    GEMS: (gemsAgg._sum.gems ?? 0n).toString(),
  }
  for (const resource of ECONOMY_RESOURCES) {
    if (!(resource in supply)) supply[resource] = '0'
  }

  const flowByReason = flowRaw
    .map((row) => {
      const net = row._sum.delta ?? 0n
      const minted = net > 0n ? net : 0n
      const burned = net < 0n ? -net : 0n
      return {
        reason: row.reason,
        resource: row.resource,
        count: row._count.id,
        net: net.toString(),
        minted: minted.toString(),
        burned: burned.toString(),
      }
    })
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.resource.localeCompare(b.resource))

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_ECONOMY',
    targetType: 'season', // world-level inspection — targetType kept generic
    reason: `flow window ${ADMIN_PANEL_POLICY.flowWindowDays}d`,
    ip: input.ip,
  })

  return {
    generatedAt: new Date().toISOString(),
    flowWindowDays: ADMIN_PANEL_POLICY.flowWindowDays,
    supply,
    playerCount,
    walletsCount,
    ledger: { totalRows: ledgerTotal, rowsInWindow: ledgerWindow },
    flowByReason,
    recentAdjustments: recentAdjustments.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      targetId: row.targetId,
      reason: row.reason,
      after: row.after as Prisma.JsonValue | null,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}
