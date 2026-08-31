/**
 * WARLORDS — Telegram integration layer (public surface).
 * Phase 3: initData verification · Phase 22: bot message transport ·
 * Phase 26: bot command router + production webhook pipeline.
 */
export {
  InitDataError,
  verifyInitData,
  deriveSecretKey,
  buildDataCheckString,
  safeHexEqual,
  INIT_DATA_MAX_LENGTH,
  AUTH_DATE_MAX_CLOCK_SKEW_SECONDS,
} from './init-data'
export type {
  TelegramInitDataUser,
  VerifiedInitData,
  VerifyInitDataOptions,
  InitDataFailureReason,
} from './init-data'
export {
  BOT_COMMANDS,
  MINIAPP_BUTTON_LABEL,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  createBotRouter,
  miniAppKeyboard,
  parseStartPayload,
  telegramUpdateSchema,
  truncateTelegramText,
} from './bot'
export type {
  BotCommandSpec,
  BotPlayerSnapshot,
  BotRankedRow,
  BotRankingSnapshot,
  BotReply,
  BotRouter,
  BotRouterDeps,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  StartPayloadKind,
  TelegramUpdate,
} from './bot'
export {
  TELEGRAM_WEBHOOK_HEADER,
  createDefaultWebhookDeps,
  handleWebhookRequest,
  loadPlayerSnapshotByTelegramId,
  loadRankingSnapshot,
  verifyWebhookSecret,
} from './webhook.service'
export type { WebhookDeps } from './webhook.service'
export {
  sendTelegramMessage,
  resolveTelegramDeliveryConfig,
  TelegramDeliveryError,
  isRetryableTelegramStatus,
} from './send-message'
