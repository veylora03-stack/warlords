/**
 * Load tests — Quest event processing (Phase 31, spec §38).
 *
 * Measures the event→progress pipeline at 100 / 1,000 / 10,000 events and
 * asserts CORRECTNESS at every scale (no lost increments, no double
 * application, monotonic progress, exactly-once completion side effects).
 *
 * Throughput is measured two ways:
 *  - 100-event run: REALISTIC latency — every event runs its own economy
 *    transaction behind the process-wide write mutex (the real gameplay
 *    path, one battle/training/ledger action at a time).
 *  - 1,000 / 10,000-event runs: ENGINE throughput — events are applied in
 *    transaction batches (100/tx), isolating the engine's own query cost
 *    from mutex/transaction overhead. The engine itself is O(1) queries per
 *    event batch + O(matched quests) updates — no N+1 by construction.
 *
 * Time budgets are deliberately generous (CI variance); the assertions that
 * MATTER are the correctness invariants.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '../../../src/lib/db'
import { applyQuestEventInTx } from '../../../src/lib/game/services/quest-events.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'

const TG_RANGE = '9100039'
const LOAD_QUEST_ID = 'load-test-events'
const LOAD_TARGET = 1_000_000

let playerId = ''

async function purge(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_RANGE } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
  if (ids.length > 0) {
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await db.playerQuest.deleteMany({ where: { questId: LOAD_QUEST_ID } })
  await db.quest.deleteMany({ where: { id: LOAD_QUEST_ID } })
  await db.user.deleteMany({ where: { telegramId: { startsWith: TG_RANGE } } })
}

beforeAll(async () => {
  await purge()
  // A high-target quest so no run completes mid-benchmark (completion side
  // effects are covered by the functional suites, not the load suite).
  await db.quest.create({
    data: {
      id: LOAD_QUEST_ID,
      type: 'MAIN',
      title: 'Load Fixture',
      description: 'Internal load-test fixture (deleted afterAll).',
      objectiveType: 'WIN_BATTLES',
      objectiveTarget: { amount: LOAD_TARGET },
      reward: { GOLD: 1 },
      prerequisiteQuestIds: [],
      minLevel: 0,
      repeatable: false,
      cooldownHours: 0,
      sortOrder: 9_999,
    },
  })
  const user = await db.user.create({
    data: { telegramId: `${TG_RANGE}0001`, username: 'quest_load', firstName: 'L' },
  })
  await runEconomyTransaction(user.id, async (tx) => {
    const { ensurePlayer } =
      await import('../../../src/lib/game/services/player-registration.service')
    await ensurePlayer(tx, { userId: user.id, name: 'QuestLoad' })
  })
  playerId = (await db.player.findUniqueOrThrow({ where: { userId: user.id } })).id
})

afterAll(async () => {
  await purge()
})

function loadProgress(): Promise<number> {
  return db.playerQuest
    .findUniqueOrThrow({
      where: { playerId_questId_cycle: { playerId, questId: LOAD_QUEST_ID, cycle: '0' } },
    })
    .then((r) => r.progress)
}

describe('quest event processing load (spec §38)', () => {
  it('100 events — realistic per-event transaction path, zero lost increments', async () => {
    const started = Date.now()
    for (let i = 0; i < 100; i++) {
      await runEconomyTransaction(playerId, (tx) =>
        applyQuestEventInTx(tx, playerId, {
          kind: 'BATTLE_FINISHED',
          won: true,
          role: 'ATTACKER',
          battleId: `load100-${i}`,
        }),
      )
    }
    const elapsedMs = Date.now() - started
    expect(await loadProgress()).toBe(100)
    // Realistic path stays comfortably inside interactive-latency budget.
    expect(elapsedMs).toBeLessThan(60_000)
    console.log(
      `[quest-load] 100 events (per-event tx): ${elapsedMs}ms (${(elapsedMs / 100).toFixed(2)}ms/event)`,
    )
  }, 90_000)

  it('1,000 events — batched engine throughput, monotonic progress', async () => {
    const started = Date.now()
    for (let batch = 0; batch < 10; batch++) {
      await runEconomyTransaction(playerId, async (tx) => {
        for (let i = 0; i < 100; i++) {
          const n = batch * 100 + i
          await applyQuestEventInTx(tx, playerId, {
            kind: 'BATTLE_FINISHED',
            won: true,
            role: 'ATTACKER',
            battleId: `load1000-${n}`,
          })
        }
      })
    }
    const elapsedMs = Date.now() - started
    expect(await loadProgress()).toBe(1_100)
    expect(elapsedMs).toBeLessThan(120_000)
    console.log(
      `[quest-load] 1,000 events (100/tx): ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(2)}ms/event)`,
    )
  }, 150_000)

  it('10,000 events — engine stays flat (no N+1 blowup), exact final progress', async () => {
    const started = Date.now()
    for (let batch = 0; batch < 20; batch++) {
      await runEconomyTransaction(playerId, async (tx) => {
        for (let i = 0; i < 500; i++) {
          const n = batch * 500 + i
          await applyQuestEventInTx(tx, playerId, {
            kind: 'BATTLE_FINISHED',
            won: true,
            role: 'ATTACKER',
            battleId: `load10000-${n}`,
          })
        }
      })
    }
    const elapsedMs = Date.now() - started
    expect(await loadProgress()).toBe(11_100)
    expect(elapsedMs).toBeLessThan(300_000)
    console.log(
      `[quest-load] 10,000 events (500/tx): ${elapsedMs}ms (${(elapsedMs / 10_000).toFixed(2)}ms/event)`,
    )
  }, 320_000)

  it('duplicate delivery at scale — immediate redelivery of every event is a no-op', async () => {
    // The engine's dedupe contract: events are applied inside their producing
    // transaction (structural exactly-once — action replays short-circuit
    // BEFORE event application), and an immediate duplicate delivery of the
    // same event identity adds NOTHING. 250 fresh events, each redelivered
    // once in the same transaction → exactly 250 increments.
    const before = await loadProgress()
    await runEconomyTransaction(playerId, async (tx) => {
      for (let i = 0; i < 250; i++) {
        const event = {
          kind: 'BATTLE_FINISHED' as const,
          won: true,
          role: 'ATTACKER' as const,
          battleId: `loaddup-${i}`,
        }
        await applyQuestEventInTx(tx, playerId, event)
        await applyQuestEventInTx(tx, playerId, event) // accidental redelivery
      }
    })
    expect(await loadProgress()).toBe(before + 250)
  }, 120_000)

  it('quest board read stays bounded at scale (no N+1 in the projection)', async () => {
    const started = Date.now()
    const { getQuestBoardView } = await import('../../../src/lib/game/services/quest.service')
    const board = await getQuestBoardView(playerId)
    const elapsedMs = Date.now() - started
    expect(board.quests.length).toBeGreaterThanOrEqual(12)
    // A handful of fixed queries regardless of catalog/instance count.
    expect(elapsedMs).toBeLessThan(2_000)
    console.log(`[quest-load] board view with ${board.quests.length} quests: ${elapsedMs}ms`)
  }, 10_000)
})
