/**
 * WARLORDS — UI state (Zustand).
 *
 * Client-only presentation state lives here — never server data (that is
 * TanStack Query's domain, see src/features/**). Keep slices small and
 * feature-scoped; a single `ui` slice is enough until the Mini App shell lands.
 */

import { create } from 'zustand'

interface UiState {
  /** Console/system status auto-refresh (15s health polling). */
  autoRefresh: boolean
  toggleAutoRefresh: () => void
}

export const useUiStore = create<UiState>()((set) => ({
  autoRefresh: true,
  toggleAutoRefresh: () => set((state) => ({ autoRefresh: !state.autoRefresh })),
}))
