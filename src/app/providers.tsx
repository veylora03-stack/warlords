'use client'

/**
 * WARLORDS — Client providers.
 *
 * TanStack Query is the single server-state owner (FRONTEND_ARCHITECTURE.md):
 * all /api traffic flows through query hooks in src/features/**; no ad-hoc
 * fetch-with-useEffect anywhere. Zustand handles client-only UI state
 * (src/stores/**) — the two stores never duplicate each other.
 */

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  )

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
