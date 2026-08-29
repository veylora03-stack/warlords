/**
 * WARLORDS — Telegram integration layer (public surface).
 * Phase 3 ships initData verification only; the bot transport arrives later.
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
