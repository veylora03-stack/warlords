/**
 * WARLORDS — Notification feature: inbox list, unread badge, mark-read.
 *
 * The ONLY way UI code touches the notification endpoints — no raw fetch in
 * components (feature-boundary rule). The unread counter polls so the bell
 * badge reflects queue deliveries that landed while the tab was idle; the
 * list itself refetches on window focus and after each mark-read.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiEnvelope } from '@/types/api'
import type { MarkReadResult, NotificationsView, UnreadCountView } from '../types'

export const notificationKeys = {
  list: (limit: number) => ['notifications', 'list', limit] as const,
  unread: ['notifications', 'unread'] as const,
}

interface ApiErrorBody {
  error?: { code?: string; message?: string }
}

async function fetchNotificationData<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  if (res.status === 401) return null // not signed in — expected UI state
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'NOTIFICATION_ENDPOINT_ERROR'),
    { code: body.error?.code, message: body.error?.message },
  )
}

async function postNotificationData<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    ...(payload !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  })
  const body = (await res.json()) as ApiEnvelope<T> & ApiErrorBody
  if (body.ok) return body.data
  throw Object.assign(
    new Error(body.error?.message ?? body.error?.code ?? 'NOTIFICATION_MUTATION_ERROR'),
    { code: body.error?.code, message: body.error?.message },
  )
}

export function useUnreadCountQuery(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () =>
      fetchNotificationData<UnreadCountView>('/api/v1/player/notifications/unread-count'),
    enabled,
    refetchInterval: 30_000, // badge stays honest between worker ticks
  })
}

export function useNotificationsQuery(options: { enabled?: boolean; limit?: number } = {}) {
  const { enabled = true, limit = 20 } = options
  return useQuery({
    queryKey: notificationKeys.list(limit),
    queryFn: () =>
      fetchNotificationData<NotificationsView>(`/api/v1/player/notifications?limit=${limit}`),
    enabled,
  })
}

/** Marks the caller's own rows read — ids or all. Invalidates badge + list. */
export function useMarkNotificationsReadMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { ids?: string[]; all?: boolean }) =>
      postNotificationData<MarkReadResult>('/api/v1/player/notifications/read', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}
