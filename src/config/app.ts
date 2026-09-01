/**
 * WARLORDS — Client-safe application constants.
 *
 * Unlike `env.ts`, this file is safe to import from client components:
 * it contains no secrets and no process.env access. Build metadata that
 * must reach the browser lives here (health data travels via the API).
 */

export const APP_NAME = 'WARLORDS'
export const APP_VERSION = '0.22.0-phase33'
export const APP_PHASE = 33
export const APP_PHASE_LABEL = 'Phase 33 — March & Army Movement Engine'
