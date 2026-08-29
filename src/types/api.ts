/**
 * WARLORDS — Shared client/server DTO re-exports.
 * Type-only barrel: importing types from here never pulls server code
 * into client bundles (all exports are erased at compile time).
 */

export type { ApiEnvelope, ApiSuccess, ApiErrorBody, ApiMeta } from '@/lib/api/response'
export type { ErrorCode } from '@/lib/api/errors'
