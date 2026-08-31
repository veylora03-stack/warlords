'use client'

/**
 * WARLORDS — Notification bell (Phase 22).
 *
 * Presentation ONLY: the badge polls the server-owned unread counter, the
 * popover renders engine-delivered rows, and the only intent it can issue
 * is mark-read on the caller's own rows. Type badges translate the catalog
 * keys to short labels; unknown types fall back to the raw key (server
 * truth, never invented client-side).
 */

import { useState } from 'react'
import { BellRing, Check, Inbox } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  useMarkNotificationsReadMutation,
  useNotificationsQuery,
  useUnreadCountQuery,
} from '../api/notifications'
import type { NotificationItem } from '../types'

const TYPE_LABELS: Record<string, string> = {
  ATTACK_INCOMING: 'Attack',
  ATTACK_RESULT: 'Battle',
  CONSTRUCTION_COMPLETE: 'Build',
  TRAINING_COMPLETE: 'Train',
  QUEST_COMPLETED: 'Quest',
  REWARD: 'Reward',
  CLAN_INVITE: 'Clan',
  CLAN_WAR: 'War',
  WORLD_BOSS: 'Boss',
  EVENT: 'Event',
  RANK_CHANGE: 'Rank',
  ANNOUNCEMENT: 'News',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  const deltaSec = Math.max(0, Math.floor((now - then) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const deltaMin = Math.floor(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHours = Math.floor(deltaMin / 60)
  if (deltaHours < 24) return `${deltaHours}h ago`
  return `${Math.floor(deltaHours / 24)}d ago`
}

function NotificationRow({
  item,
  now,
  onMarkRead,
  pending,
}: {
  item: NotificationItem
  now: number
  onMarkRead: (id: string) => void
  pending: boolean
}) {
  return (
    <div className={`px-3 py-2 ${item.isRead ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className={`border-zinc-700 text-[10px] ${
            item.isRead ? 'text-zinc-500' : 'border-amber-500/40 text-amber-400'
          }`}
        >
          {typeLabel(item.type)}
        </Badge>
        <span className="font-mono text-[10px] text-zinc-600">
          {relativeTime(item.createdAt, now)}
        </span>
      </div>
      <p
        className={`mt-1 text-xs font-semibold ${item.isRead ? 'text-zinc-400' : 'text-zinc-100'}`}
      >
        {item.title}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{item.body}</p>
      {!item.isRead && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onMarkRead(item.id)}
          className="mt-1 h-6 gap-1 px-2 text-[10px] text-amber-400 hover:text-amber-300"
        >
          <Check className="h-3 w-3" /> mark read
        </Button>
      )}
    </div>
  )
}

export function NotificationBell({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const { data: unread } = useUnreadCountQuery({ enabled })
  const { data: inbox, isPending } = useNotificationsQuery({ enabled: enabled && open, limit: 20 })
  const markRead = useMarkNotificationsReadMutation()

  if (!enabled) return null

  const unreadCount = unread?.unreadCount ?? 0
  const items = inbox?.notifications ?? []
  const pendingIds = markRead.isPending

  const markOne = (id: string) => {
    markRead.mutate({ ids: [id] })
  }

  const markAll = () => {
    markRead.mutate({ all: true })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setNow(Date.now())
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Notifications — ${unreadCount} unread`}
          className="relative h-9 gap-2 border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-amber-300"
        >
          <BellRing className="h-4 w-4" />
          <span className="hidden sm:inline">Notifications</span>
          {unreadCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-zinc-950">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 border-zinc-800 bg-zinc-950 p-0 sm:w-96"
      >
        <div className="flex items-center justify-between px-3 py-2">
          <p className="text-xs font-bold uppercase tracking-widest text-amber-500">Inbox</p>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pendingIds}
              onClick={markAll}
              className="h-6 gap-1 px-2 text-[10px] text-amber-400 hover:text-amber-300"
            >
              <Check className="h-3 w-3" /> mark all read ({unreadCount})
            </Button>
          )}
        </div>
        <Separator className="bg-zinc-800" />
        {isPending ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">loading…</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <Inbox className="h-5 w-5 text-zinc-600" />
            <p className="text-xs text-zinc-500">No notifications yet — war reports land here.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="divide-y divide-zinc-900">
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  now={now}
                  onMarkRead={markOne}
                  pending={pendingIds}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
