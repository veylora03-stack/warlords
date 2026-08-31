/**
 * WARLORDS — Admin battle inspection service (Phase 21). READ-ONLY.
 *
 * Every battle row is immutable history: the inspector surfaces the real
 * stored data (participants, deterministic seed/config, powers, loot,
 * rounds trace). No redaction, no rewrite path — inspection only.
 */

import { db } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { recordAdminAuditView } from './admin-audit.service'

export interface AdminBattleRow {
  id: string
  type: string
  result: string
  attacker: { playerId: string; name: string | null }
  defender: { playerId: string; name: string | null } | null
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: unknown
  honorDelta: number
  seed: number
  configVersion: number
  startedAt: string
  endedAt: string | null
}

export interface AdminBattleListResult {
  rows: AdminBattleRow[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export async function listBattles(input: {
  playerId?: string
  type?: string
  page: number
  pageSize: number
  actorUserId: string
  ip?: string
}): Promise<AdminBattleListResult> {
  const where = {
    ...(input.playerId
      ? { OR: [{ attackerPlayerId: input.playerId }, { defenderPlayerId: input.playerId }] }
      : {}),
    ...(input.type ? { type: input.type } : {}),
  }
  const [total, rows] = await Promise.all([
    db.battle.count({ where }),
    db.battle.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        attacker: { select: { name: true } },
        defender: { select: { name: true } },
      },
    }),
  ])

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_BATTLES',
    targetType: 'battle',
    reason: `list page ${input.page} → ${total}`,
    ip: input.ip,
  })

  return {
    rows: rows.map((battle) => ({
      id: battle.id,
      type: battle.type,
      result: battle.result,
      attacker: { playerId: battle.attackerPlayerId, name: battle.attacker.name },
      defender: battle.defenderPlayerId
        ? { playerId: battle.defenderPlayerId, name: battle.defender?.name ?? null }
        : null,
      attackerPower: battle.attackerPower.toString(),
      defenderPower: battle.defenderPower.toString(),
      roundsCount: battle.roundsCount,
      loot: battle.loot,
      honorDelta: battle.honorDelta,
      seed: battle.seed,
      configVersion: battle.configVersion,
      startedAt: battle.startedAt.toISOString(),
      endedAt: battle.endedAt?.toISOString() ?? null,
    })),
    page: input.page,
    pageSize: input.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / input.pageSize)),
  }
}

export interface AdminBattleDetail extends AdminBattleRow {
  rounds: Array<{
    roundNumber: number
    side: string
    unitsCommitted: unknown
    unitsLost: unknown
    damageDealt: string
    events: unknown
  }>
  logs: Array<{ id: string; playerId: string; role: string; content: unknown }>
}

export async function getBattleDetail(input: {
  battleId: string
  actorUserId: string
  ip?: string
}): Promise<AdminBattleDetail> {
  const battle = await db.battle.findUnique({
    where: { id: input.battleId },
    include: {
      attacker: { select: { name: true } },
      defender: { select: { name: true } },
      rounds: { orderBy: [{ roundNumber: 'asc' }, { side: 'asc' }] },
      logs: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!battle) throw new AppError('BATTLE_NOT_FOUND', 'Battle not found')

  await recordAdminAuditView({
    actorUserId: input.actorUserId,
    action: 'VIEW_BATTLE_DETAIL',
    targetType: 'battle',
    targetId: battle.id,
    ip: input.ip,
  })

  return {
    id: battle.id,
    type: battle.type,
    result: battle.result,
    attacker: { playerId: battle.attackerPlayerId, name: battle.attacker.name },
    defender: battle.defenderPlayerId
      ? { playerId: battle.defenderPlayerId, name: battle.defender?.name ?? null }
      : null,
    attackerPower: battle.attackerPower.toString(),
    defenderPower: battle.defenderPower.toString(),
    roundsCount: battle.roundsCount,
    loot: battle.loot,
    honorDelta: battle.honorDelta,
    seed: battle.seed,
    configVersion: battle.configVersion,
    startedAt: battle.startedAt.toISOString(),
    endedAt: battle.endedAt?.toISOString() ?? null,
    rounds: battle.rounds.map((round) => ({
      roundNumber: round.roundNumber,
      side: round.side,
      unitsCommitted: round.unitsCommitted,
      unitsLost: round.unitsLost,
      damageDealt: round.damageDealt.toString(),
      events: round.events,
    })),
    logs: battle.logs.map((row) => ({
      id: row.id,
      playerId: row.playerId,
      role: row.role,
      content: row.content,
    })),
  }
}
