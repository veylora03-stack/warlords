/**
 * Unit tests — Telegram bot command router (Phase 26).
 *
 * The router is leaf-pure: every data provider is injected, so the full
 * command surface is exercised without network or database. The integration
 * suite (tests/integration/deploy/webhook.test.ts) drives the REAL loaders
 * against the real database on top of the same router.
 */

import { describe, it, expect } from 'bun:test'
import {
  BOT_COMMANDS,
  createBotRouter,
  miniAppKeyboard,
  parseStartPayload,
  telegramUpdateSchema,
  truncateTelegramText,
  type BotPlayerSnapshot,
  type BotRankingSnapshot,
  type BotRouterDeps,
} from '../../../src/lib/telegram/bot'

const APP_URL = 'https://warlords.example.com'

function makeSnapshot(overrides: Partial<BotPlayerSnapshot> = {}): BotPlayerSnapshot {
  return {
    playerId: 'player-1',
    name: 'Aurelius',
    level: 7,
    power: 4200n,
    seasonPoints: 128,
    wallet: { gold: 12345n, wood: 678n, iron: 90n, food: 12n, crystal: 3n },
    ...overrides,
  }
}

function makeRanking(overrides: Partial<BotRankingSnapshot> = {}): BotRankingSnapshot {
  return {
    me: { rank: 4, score: 128 },
    top: [
      { rank: 1, playerName: 'Maximus', score: 900 },
      { rank: 2, playerName: 'Livia', score: 700 },
      { rank: 3, playerName: 'Cato', score: 200 },
    ],
    ...overrides,
  }
}

function makeDeps(overrides: Partial<BotRouterDeps> = {}): BotRouterDeps {
  return {
    appUrl: APP_URL,
    getSnapshotByTelegramId: async () => makeSnapshot(),
    getRankingSnapshot: async () => makeRanking(),
    ...overrides,
  }
}

describe('BOT_COMMANDS (advertised surface)', () => {
  it('advertises exactly the five real, data-backed commands', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual(['start', 'help', 'play', 'profile', 'rank'])
  })

  it('satisfies the Telegram command constraints (lowercase, unique, ≤256 chars)', () => {
    const names = BOT_COMMANDS.map((c) => c.command)
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9_]{1,32}$/)
    }
    expect(new Set(names).size).toBe(names.length)
    for (const spec of BOT_COMMANDS) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(spec.description.length).toBeLessThanOrEqual(256)
    }
  })
})

describe('parseStartPayload (reserved grammar — parsed, never acted on blindly)', () => {
  it('classifies ref/camp/none/unknown', () => {
    expect(parseStartPayload('')).toBe('none')
    expect(parseStartPayload('  ')).toBe('none')
    expect(parseStartPayload('ref_67fabc')).toBe('ref')
    expect(parseStartPayload('camp_autumn')).toBe('camp')
    expect(parseStartPayload('rm -rf /')).toBe('unknown')
    expect(parseStartPayload('ref_')).toBe('unknown')
  })
})

describe('command router', () => {
  const router = createBotRouter(makeDeps())

  it('/start greets the Telegram first name and always carries the Mini App button', async () => {
    const reply = await router.handleCommand('1001', '/start', { firstName: 'Neo' })
    expect(reply.text).toContain('Welcome to WARLORDS, Neo!')
    const button = reply.replyMarkup?.inline_keyboard[0]?.[0]
    expect(button?.web_app?.url).toBe(APP_URL)
  })

  it('/start strips the @BotName suffix and classifies invite payloads', async () => {
    const reply = await router.handleCommand('1001', '/start@WarlordsBot ref_abc123', {
      firstName: 'Neo',
    })
    expect(reply.text).toContain('Welcome to WARLORDS')
    expect(reply.text).toContain('invite context')
  })

  it('/start without an appUrl stays honest instead of rendering a dead button', async () => {
    const bare = createBotRouter(makeDeps({ appUrl: null }))
    const reply = await bare.handleCommand('1001', '/start', { firstName: 'Neo' })
    expect(reply.replyMarkup).toBeUndefined()
    expect(reply.text).toContain('being configured')
  })

  it('/help lists every advertised command', async () => {
    const reply = await router.handleCommand('1001', '/help')
    for (const spec of BOT_COMMANDS) {
      expect(reply.text).toContain(`/${spec.command}`)
    }
    expect(reply.replyMarkup).toBeUndefined()
  })

  it('/play opens the Mini App', async () => {
    const reply = await router.handleCommand('1001', '/play')
    expect(reply.replyMarkup?.inline_keyboard[0]?.[0]?.web_app?.url).toBe(APP_URL)
  })

  it('/profile renders the real snapshot (name, level, power, treasury)', async () => {
    const reply = await router.handleCommand('1001', '/profile')
    expect(reply.text).toContain('Aurelius — Level 7')
    expect(reply.text).toContain('Power 4,200')
    expect(reply.text).toContain('Treasury')
    expect(reply.text).toContain('Gold 12,345')
    expect(reply.text).toContain('Crystal 3')
  })

  it('/profile without wallet omits the treasury block', async () => {
    const bare = createBotRouter(
      makeDeps({ getSnapshotByTelegramId: async () => makeSnapshot({ wallet: null }) }),
    )
    const reply = await bare.handleCommand('1001', '/profile')
    expect(reply.text).toContain('Aurelius')
    expect(reply.text).not.toContain('Treasury')
  })

  it('/profile for an unenlisted telegramId is an enlistment card, never fake data', async () => {
    const bare = createBotRouter(makeDeps({ getSnapshotByTelegramId: async () => null }))
    const reply = await bare.handleCommand('1001', '/profile')
    expect(reply.text).toContain('not enlisted')
    expect(reply.replyMarkup?.inline_keyboard[0]?.[0]?.web_app?.url).toBe(APP_URL)
  })

  it('/rank renders top rows with medals and the caller standing', async () => {
    const reply = await router.handleCommand('1001', '/rank')
    expect(reply.text).toContain('🏆 Season ranking')
    expect(reply.text).toContain('🥇 Maximus')
    expect(reply.text).toContain('🥉 Cato')
    expect(reply.text).toContain('Your standing: #4')
  })

  it('/rank for an unranked player says so instead of inventing a rank', async () => {
    const bare = createBotRouter(
      makeDeps({
        getRankingSnapshot: async () => makeRanking({ me: { rank: null, score: 0 }, top: [] }),
      }),
    )
    const reply = await bare.handleCommand('1001', '/rank')
    expect(reply.text).toContain('No warlords are ranked yet')
    expect(reply.text).toContain('You are unranked')
  })

  it('/rank for an unenlisted telegramId redirects to enlistment', async () => {
    const bare = createBotRouter(
      makeDeps({ getSnapshotByTelegramId: async () => null, getRankingSnapshot: async () => null }),
    )
    const reply = await bare.handleCommand('1001', '/rank')
    expect(reply.text).toContain('not enlisted')
  })

  it('/rank when no season exists reports unavailability (loader returned null)', async () => {
    const bare = createBotRouter(makeDeps({ getRankingSnapshot: async () => null }))
    const reply = await bare.handleCommand('1001', '/rank')
    expect(reply.text).toContain('ranking is not available')
  })

  it('unknown commands fall back to the help card (no fabricated success)', async () => {
    const reply = await router.handleCommand('1001', '/totally_new_command')
    expect(reply.text).toContain('WARLORDS — commands')
  })
})

describe('update envelope schema', () => {
  it('accepts a minimal message update and strips unknown fields', () => {
    const parsed = telegramUpdateSchema.parse({
      update_id: 1,
      unknown_future_field: true,
      message: { message_id: 5, from: { id: 1001, first_name: 'Neo' }, text: '/start' },
    })
    expect(parsed.update_id).toBe(1)
    expect(parsed.message?.from?.id).toBe(1001)
    expect(parsed.message?.text).toBe('/start')
  })

  it('rejects updates without update_id or sender id', () => {
    expect(
      telegramUpdateSchema.safeParse({ message: { message_id: 5, from: { id: 1 } } }).success,
    ).toBe(false)
    expect(
      telegramUpdateSchema.safeParse({ update_id: 1, message: { message_id: 5 } }).success,
    ).toBe(false)
  })
})

describe('message cap', () => {
  it('truncates over-4096-char replies to the Telegram hard cap', () => {
    const long = 'x'.repeat(5000)
    expect(truncateTelegramText(long).length).toBe(4096)
    expect(truncateTelegramText('short')).toBe('short')
  })

  it('miniAppKeyboard shape matches the Bot API inline keyboard', () => {
    expect(miniAppKeyboard(APP_URL)).toEqual({
      inline_keyboard: [[{ text: '⚔️ Play WARLORDS', web_app: { url: APP_URL } }]],
    })
  })
})
