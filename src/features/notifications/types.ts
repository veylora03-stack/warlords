/**
 * WARLORDS — Notification feature types (mirror of the server DTOs).
 *
 * Inbox rows are engine-delivered: title/body were rendered SERVER-side at
 * drain time from catalog templates. The client renders text and issues one
 * intent — mark read (own rows only).
 */

export interface NotificationItem {
  id: string
  type: string
  title: string
  body: string
  data: Record<string, unknown> | null
  isRead: boolean
  createdAt: string
}

export interface NotificationsView {
  notifications: NotificationItem[]
  unreadCount: number
}

export interface UnreadCountView {
  unreadCount: number
}

export interface MarkReadResult {
  updated: number
}
