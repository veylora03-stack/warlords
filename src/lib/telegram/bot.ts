/**
 * WARLORDS — Telegram bot command router (Phase 26).
 *
 * Pure LEAF module (imports nothing app-internal) so both the webhook
 * pipeline and tests can drive it with injected data providers.
 *
 * Delivery mode (TELEGRAM_ARCHITECTURE.md §2): webhook in production —
 * `setWebhook(url=APP_URL/api/v1/telegram/webhook, secret_token=…)`.
 *
 * Honesty rule: ONLY commands with real server-side data are advertised in
 * BOT_COMMANDS. The remaining MVP-surface commands from the architecture doc
 * (/quests /clan /invite /settings) depend on systems that have not shipped
 * and are NOT configured until their phases land — a bot must never answer
 * with fabricated data.
 *
 * Reply safety: messages are sent WITHOUT parse_mode (plain text) — player
 * and Telegram-supplied names can therefore never inject markup. All
 * outbound text passes through the 4096-char Telegram cap.
 */

import { z } from 'zod'

// ── Command surface (what setMyCommands advertises) ─────────────────────────

export interface BotCommandSpec {
  command: string
  description: string
}

export const BOT_COMMANDS: readonly BotCommandSpec[] = [
  { command: 'start', description: 'Enlist and open the game' },
  { command: 'help', description: 'How to play WARLORDS' },
  { command: 'play', description: 'Open the WARLORDS Mini App' },
  { command: 'profile', description: 'Your warlord profile' },
  { command: 'rank', description: 'Season ranking — top warlords' },
]

/** Hard Telegram cap: message text is counted in UTF-16 code units (JS length). */
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096

export function truncateTelegramText(
  text: string,
  max: number = TELEGRAM_MESSAGE_MAX_LENGTH,
): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function sanitizeName(name: string, max = 64): string {
  const collapsed = name.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed.slice(0, max) : 'Warlord'
}

// ── Inline keyboard (the Mini App funnel) ────────────────────────────────────

export interface InlineKeyboardButton {
  text: string
  web_app?: { url: string }
  url?: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export const MINIAPP_BUTTON_LABEL = '⚔️ Play WARLORDS'

export function miniAppKeyboard(
  appUrl: string,
  label: string = MINIAPP_BUTTON_LABEL,
): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: label, web_app: { url: appUrl } }]] }
}

// ── Update envelope (only the fields the pipeline consumes) ─────────────────

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int(),
      from: z.object({
        id: z.number().int(),
        is_bot: z.boolean().optional(),
        username: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        language_code: z.string().optional(),
      }),
      text: z.string().max(4096).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string().min(1),
    })
    .optional(),
})

export type TelegramUpdate = z.output<typeof telegramUpdateSchema>

// ── Data the commands render (injected — keeps this module leaf-pure) ───────

export interface BotPlayerSnapshot {
  playerId: string
  name: string
  level: number
  power: bigint
  seasonPoints: number
  wallet: {
    gold: bigint
    wood: bigint
    iron: bigint
    food: bigint
    crystal: bigint
  } | null
}

export interface BotRankedRow {
  rank: number
  playerName: string
  score: number
}

export interface BotRankingSnapshot {
  me: { rank: number | null; score: number }
  top: BotRankedRow[]
}

export interface BotRouterDeps {
  /** Public HTTPS Mini App base URL (APP_URL). null → web_app buttons omitted. */
  appUrl: string | null
  getSnapshotByTelegramId(telegramId: string): Promise<BotPlayerSnapshot | null>
  getRankingSnapshot(playerId: string): Promise<BotRankingSnapshot | null>
}

export interface BotReply {
  text: string
  replyMarkup?: InlineKeyboardMarkup
}

// ── /start payload grammar (reserved — parsed, safely ignored for now) ──────

export type StartPayloadKind = 'none' | 'ref' | 'camp' | 'unknown'

/**
 * Referral (`ref_<playerId>`) and campaign (`camp_<tag>`) attribution ships
 * with its own phase. The grammar is recognized here so the future wiring
 * point is explicit; until then payloads are ignored — never acted on
 * blindly (NEVER TRUST THE CLIENT).
 */
export function parseStartPayload(arg: string): StartPayloadKind {
  const trimmed = arg.trim()
  if (trimmed.length === 0) return 'none'
  if (/^ref_[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return 'ref'
  if (/^camp_[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return 'camp'
  return 'unknown'
}

// ── Command replies ──────────────────────────────────────────────────────────

function startReply(deps: BotRouterDeps, firstName: string, arg: string): BotReply {
  const payloadKind = parseStartPayload(arg)
  const lines = [
    `⚔️ Welcome to WARLORDS, ${sanitizeName(firstName)}!`,
    '',
    'Found a city, train armies and climb the season ranking — the whole game runs right here in Telegram, and every rule is enforced on the server.',
  ]
  if (payloadKind === 'ref' || payloadKind === 'camp') {
    lines.push('', 'Your invite context was received and will be applied with the referral update.')
  }
  if (deps.appUrl) {
    lines.push('', 'Tap the button below to enlist.')
    return {
      text: truncateTelegramText(lines.join('\n')),
      replyMarkup: miniAppKeyboard(deps.appUrl),
    }
  }
  lines.push('', 'The Mini App link is being configured on this deployment — check back shortly.')
  return { text: truncateTelegramText(lines.join('\n')) }
}

function helpReply(): BotReply {
  const lines = [
    '⚔️ WARLORDS — commands',
    '',
    ...BOT_COMMANDS.map((c) => `/${c.command} — ${c.description}`),
    '',
    'All game systems are server-authoritative: construction, training, economy and ranking run in the Mini App with full ledger protection.',
  ]
  return { text: truncateTelegramText(lines.join('\n')) }
}

function playReply(deps: BotRouterDeps): BotReply {
  if (deps.appUrl) {
    return {
      text: truncateTelegramText('⚔️ WARLORDS awaits, warlord. Your city remembers everything.'),
      replyMarkup: miniAppKeyboard(deps.appUrl),
    }
  }
  return {
    text: truncateTelegramText(
      'The Mini App link is being configured on this deployment — check back shortly.',
    ),
  }
}

function profileReply(deps: BotRouterDeps, snapshot: BotPlayerSnapshot | null): BotReply {
  if (!snapshot) {
    const text = [
      'You have not enlisted yet.',
      '',
      'Open WARLORDS to found your city — registration is automatic on first launch.',
    ].join('\n')
    return deps.appUrl ? { text, replyMarkup: miniAppKeyboard(deps.appUrl) } : { text }
  }

  const lines = [
    `⚔️ ${sanitizeName(snapshot.name)} — Level ${snapshot.level}`,
    `Power ${snapshot.power.toLocaleString('en-US')} · Season points ${snapshot.seasonPoints.toLocaleString('en-US')}`,
  ]
  if (snapshot.wallet) {
    lines.push(
      '',
      'Treasury',
      `Gold ${snapshot.wallet.gold.toLocaleString('en-US')}`,
      `Wood ${snapshot.wallet.wood.toLocaleString('en-US')}`,
      `Iron ${snapshot.wallet.iron.toLocaleString('en-US')}`,
      `Food ${snapshot.wallet.food.toLocaleString('en-US')}`,
      `Crystal ${snapshot.wallet.crystal.toLocaleString('en-US')}`,
    )
  }
  if (deps.appUrl) {
    lines.push('', 'Open the app to build, train and conquer.')
    return {
      text: truncateTelegramText(lines.join('\n')),
      replyMarkup: miniAppKeyboard(deps.appUrl),
    }
  }
  return { text: truncateTelegramText(lines.join('\n')) }
}

function rankReply(snapshot: BotRankingSnapshot | null): BotReply {
  if (!snapshot) {
    return {
      text: truncateTelegramText(
        'The ranking is not available right now — no season is running on this deployment.',
      ),
    }
  }
  const medal = (rank: number): string =>
    rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`
  const lines = ['🏆 Season ranking — top warlords', '']
  if (snapshot.top.length === 0) {
    lines.push('No warlords are ranked yet — earn season points in the Mini App.')
  } else {
    for (const row of snapshot.top) {
      lines.push(
        `${medal(row.rank)} ${sanitizeName(row.playerName)} — ${row.score.toLocaleString('en-US')}`,
      )
    }
  }
  lines.push('')
  if (snapshot.me.rank === null) {
    lines.push('You are unranked — earn season points to enter the standings.')
  } else {
    lines.push(
      `Your standing: #${snapshot.me.rank} — ${snapshot.me.score.toLocaleString('en-US')} pts`,
    )
  }
  return { text: truncateTelegramText(lines.join('\n')) }
}

// ── Router ───────────────────────────────────────────────────────────────────

export interface BotRouter {
  /**
   * Dispatches a `/command` text. Unknown or empty commands fall back to the
   * help card (never a fabricated success). Data-backed commands resolve
   * through the injected providers. `ctx` carries the Telegram-supplied
   * message metadata the router may use for greetings (never for identity —
   * identity is ALWAYS the telegramId resolved server-side).
   */
  handleCommand(
    telegramId: string,
    rawText: string,
    ctx?: { firstName?: string },
  ): Promise<BotReply>
}

export function createBotRouter(deps: BotRouterDeps): BotRouter {
  return {
    async handleCommand(
      telegramId: string,
      rawText: string,
      ctx?: { firstName?: string },
    ): Promise<BotReply> {
      const text = rawText.trim()
      const [rawCommand = '', ...rest] = text.split(/\s+/)
      // "/start@BotName" → "start" (Telegram appends the bot username in groups).
      const command = rawCommand.replace(/^\//, '').split('@')[0]!.toLowerCase()
      const arg = rest.join(' ')

      switch (command) {
        case 'start':
          return startReply(deps, await resolveDisplayName(deps, telegramId, ctx?.firstName), arg)
        case 'help':
          return helpReply()
        case 'play':
          return playReply(deps)
        case 'profile':
          return profileReply(deps, await deps.getSnapshotByTelegramId(telegramId))
        case 'rank': {
          const snapshot = await deps.getSnapshotByTelegramId(telegramId)
          if (!snapshot) {
            return profileReply(deps, null)
          }
          return rankReply(await deps.getRankingSnapshot(snapshot.playerId))
        }
        default:
          return helpReply()
      }
    },
  }
}

/** Greeting name: Telegram-supplied first, else the DB player name, else neutral. */
async function resolveDisplayName(
  deps: BotRouterDeps,
  telegramId: string,
  telegramFirstName?: string,
): Promise<string> {
  if (telegramFirstName && telegramFirstName.trim().length > 0) return telegramFirstName
  const snapshot = await deps.getSnapshotByTelegramId(telegramId)
  return snapshot?.name ?? 'Warlord'
}
