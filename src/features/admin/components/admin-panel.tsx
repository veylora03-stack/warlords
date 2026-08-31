'use client'

/**
 * WARLORDS — Admin Panel (Phase 21) client surface.
 *
 * This panel is a VIEW over server-enforced scopes: every button here only
 * works if the server's RBAC matrix allows the caller's DB-backed role.
 * Hiding UI for missing scopes is pure UX — never the security boundary.
 */

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  useAdminAdjustMutation,
  useAdminAnnouncementActiveMutation,
  useAdminAnnouncementCreateMutation,
  useAdminAnnouncementsQuery,
  useAdminAuditQuery,
  useAdminBanMutation,
  useAdminBattleDetailQuery,
  useAdminBattlesQuery,
  useAdminBroadcastMutation,
  useAdminClanDetailQuery,
  useAdminClansQuery,
  useAdminDeactivateMutation,
  useAdminDisbandMutation,
  useAdminEconomyQuery,
  useAdminEventCreateMutation,
  useAdminEventTransitionMutation,
  useAdminEventsQuery,
  useAdminGrantMutation,
  useAdminMeQuery,
  useAdminPlayerDetailsQuery,
  useAdminPlayersQuery,
  useAdminStaffQuery,
  useAdminUnbanMutation,
} from '../api/admin'
import type { AdminPlayerSummary } from '../types'

function formatAmount(raw: string): string {
  const value = Number(raw)
  if (!Number.isFinite(value)) return raw
  return value.toLocaleString('en-US')
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

function Err({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <p className="text-[11px] font-semibold text-red-400">{message}</p>
}

// ── Players tab ──────────────────────────────────────────────────────────────

function PlayerDetailsDialog({
  playerId,
  onClose,
  canBan,
  canUnban,
  canAdjust,
}: {
  playerId: string | null
  onClose: () => void
  canBan: boolean
  canUnban: boolean
  canAdjust: boolean
}) {
  const { data: player, error } = useAdminPlayerDetailsQuery(playerId)
  const ban = useAdminBanMutation()
  const unban = useAdminUnbanMutation()
  const adjust = useAdminAdjustMutation()

  const [banReason, setBanReason] = useState('')
  const [adjustResource, setAdjustResource] = useState('GOLD')
  const [adjustDelta, setAdjustDelta] = useState('1000')
  const [adjustNote, setAdjustNote] = useState('')
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const deltaNum = Number.parseInt(adjustDelta, 10)
  const adjustValid = Number.isInteger(deltaNum) && deltaNum !== 0 && adjustNote.trim().length >= 4

  return (
    <Dialog open={playerId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300">
        <DialogHeader>
          <DialogTitle className="text-amber-400">
            {player ? `${player.name} — level ${player.level}` : 'Player details'}
          </DialogTitle>
          <DialogDescription className="text-zinc-500">
            {player ? `id ${player.id} · telegram ${player.user.telegramId}` : 'loading…'}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Err error={error} />
        ) : player ? (
          <div className="space-y-3">
            <div className="grid gap-1 rounded border border-zinc-800 bg-zinc-900/60 p-3 sm:grid-cols-2">
              <p>
                power <span className="text-amber-400">{formatAmount(player.power)}</span>
              </p>
              <p>
                honor <span className="text-amber-400">{formatAmount(player.honor)}</span>
              </p>
              <p>
                season points <span className="text-amber-400">{player.seasonPoints}</span>
              </p>
              <p>
                gems <span className="text-amber-400">{formatAmount(player.gems)}</span>
              </p>
              <p>
                clan{' '}
                <span className="text-zinc-100">
                  {player.clan ? `${player.clan.name} (${player.clan.role ?? '—'})` : '—'}
                </span>
              </p>
              <p>
                title <span className="text-zinc-100">{player.title?.name ?? '—'}</span>
              </p>
              <p>
                city{' '}
                <span className="text-zinc-100">
                  {player.city
                    ? `${player.city.name} (${player.city.x},${player.city.y}) TH${player.city.townHallLevel ?? '?'} · ${player.city.buildings} buildings`
                    : '—'}
                </span>
              </p>
              <p>
                army{' '}
                <span className="text-zinc-100">
                  {player.army.unitCount} units · top T{player.army.topTier ?? '—'}
                </span>
              </p>
              <p className="sm:col-span-2">
                ban state{' '}
                {player.user.isBanned ? (
                  <span className="font-bold text-red-400">
                    BANNED — {player.user.banReason ?? 'no reason recorded'}
                    {player.user.banExpiresAt
                      ? ` (until ${formatTime(player.user.banExpiresAt)})`
                      : ''}
                  </span>
                ) : (
                  <span className="text-emerald-400">ACTIVE</span>
                )}
              </p>
              <p className="sm:col-span-2">
                wallet{' '}
                <span className="text-zinc-100">
                  {Object.entries(player.wallet)
                    .map(([resource, amount]) => `${resource} ${formatAmount(amount)}`)
                    .join(' · ')}
                </span>
              </p>
            </div>

            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">ledger tail</p>
              <div className="space-y-1">
                {player.ledgerTail.map((row) => (
                  <div
                    key={row.id}
                    className="flex justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5"
                  >
                    <span>{row.reason}</span>
                    <span>
                      <span
                        className={row.delta.startsWith('-') ? 'text-red-400' : 'text-emerald-400'}
                      >
                        {row.delta.startsWith('-') ? '' : '+'}
                        {formatAmount(row.delta)} {row.resource}
                      </span>{' '}
                      <span className="text-zinc-600">→ {formatAmount(row.balanceAfter)}</span>
                    </span>
                  </div>
                ))}
                {player.ledgerTail.length === 0 && <p className="text-zinc-600">no ledger rows</p>}
              </div>
            </div>

            {(canBan || canUnban) && (
              <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">moderation</p>
                {player.user.isBanned ? (
                  canUnban ? (
                    <Button
                      size="sm"
                      className="bg-emerald-700 text-zinc-50 hover:bg-emerald-600"
                      disabled={unban.isPending}
                      onClick={async () => {
                        setActionMessage(null)
                        try {
                          await unban.mutateAsync({ playerId: player.id })
                          setActionMessage('Player unbanned.')
                        } catch (err) {
                          setActionMessage(err instanceof Error ? err.message : String(err))
                        }
                      }}
                    >
                      UNBAN
                    </Button>
                  ) : (
                    <p className="text-zinc-600">unban requires players.unban scope</p>
                  )
                ) : canBan ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      className="border-zinc-700 bg-zinc-950 font-mono text-xs"
                      placeholder="reason (min 4 chars)"
                      value={banReason}
                      onChange={(e) => setBanReason(e.target.value)}
                    />
                    <Button
                      size="sm"
                      className="bg-red-800 text-zinc-50 hover:bg-red-700"
                      disabled={ban.isPending || banReason.trim().length < 4}
                      onClick={async () => {
                        setActionMessage(null)
                        try {
                          await ban.mutateAsync({ playerId: player.id, reason: banReason })
                          setBanReason('')
                          setActionMessage('Player banned — effective immediately.')
                        } catch (err) {
                          setActionMessage(err instanceof Error ? err.message : String(err))
                        }
                      }}
                    >
                      BAN
                    </Button>
                  </div>
                ) : (
                  <p className="text-zinc-600">ban requires players.ban scope</p>
                )}
              </div>
            )}

            {canAdjust && (
              <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                  resource adjustment (ledger path — audited)
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    aria-label="resource"
                    className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
                    value={adjustResource}
                    onChange={(e) => setAdjustResource(e.target.value)}
                  >
                    {['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL', 'GEMS'].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label="delta"
                    className="w-28 border-zinc-700 bg-zinc-950 font-mono text-xs"
                    placeholder="±delta"
                    value={adjustDelta}
                    onChange={(e) => setAdjustDelta(e.target.value)}
                  />
                  <Input
                    aria-label="note"
                    className="flex-1 border-zinc-700 bg-zinc-950 font-mono text-xs"
                    placeholder="note (min 4 chars)"
                    value={adjustNote}
                    onChange={(e) => setAdjustNote(e.target.value)}
                  />
                  <Button
                    size="sm"
                    className="bg-amber-700 text-zinc-950 hover:bg-amber-600"
                    disabled={adjust.isPending || !adjustValid}
                    onClick={async () => {
                      setActionMessage(null)
                      try {
                        await adjust.mutateAsync({
                          playerId: player.id,
                          resource: adjustResource,
                          delta: deltaNum,
                          note: adjustNote,
                        })
                        setAdjustNote('')
                        setActionMessage(
                          `Adjusted ${adjustResource} ${deltaNum > 0 ? '+' : ''}${deltaNum}.`,
                        )
                      } catch (err) {
                        setActionMessage(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    ADJUST
                  </Button>
                </div>
              </div>
            )}

            {actionMessage && (
              <p className="text-[11px] font-semibold text-amber-400">{actionMessage}</p>
            )}
          </div>
        ) : (
          <p className="animate-pulse text-zinc-500">loading player…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PlayersTab({ scopes }: { scopes: Set<string> }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data, error, isPending } = useAdminPlayersQuery(search, page)

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setSearch(query.trim())
        }}
      >
        <Input
          className="border-zinc-700 bg-zinc-950 font-mono text-xs"
          placeholder="name · id · telegramId · username"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="player search"
        />
        <Button size="sm" className="bg-amber-700 text-zinc-950 hover:bg-amber-600" type="submit">
          SEARCH
        </Button>
      </form>
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">searching…</p>
      ) : data ? (
        <>
          <p className="text-[11px] text-zinc-500">
            {data.total} player(s){data.query ? ` matching “${data.query}”` : ''} — page {data.page}
            /{data.pages}
          </p>
          <div className="space-y-1">
            {data.rows.map((row) => (
              <PlayerRow key={row.id} row={row} onOpen={() => setSelectedId(row.id)} />
            ))}
            {data.rows.length === 0 && <p className="text-zinc-600">no players found</p>}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← PREV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page >= data.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              NEXT →
            </Button>
          </div>
        </>
      ) : null}
      <PlayerDetailsDialog
        playerId={selectedId}
        onClose={() => setSelectedId(null)}
        canBan={scopes.has('players.ban')}
        canUnban={scopes.has('players.unban')}
        canAdjust={scopes.has('players.adjust_resources')}
      />
    </div>
  )
}

function PlayerRow({ row, onOpen }: { row: AdminPlayerSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-left font-mono text-xs hover:border-amber-700/60"
    >
      <span className="flex items-center gap-2">
        <span className="font-bold text-zinc-100">{row.name}</span>
        <span className="text-zinc-600">lv{row.level}</span>
        {row.user.isBanned && <Badge className="bg-red-900 text-red-200">BANNED</Badge>}
        {row.clanName && <Badge className="bg-zinc-800 text-zinc-300">[{row.clanName}]</Badge>}
      </span>
      <span className="text-zinc-500">
        power {formatAmount(row.power)} · sp {row.seasonPoints} · {row.user.telegramId}
      </span>
    </button>
  )
}

// ── Battles tab ──────────────────────────────────────────────────────────────

function BattlesTab() {
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data, error, isPending } = useAdminBattlesQuery(page)
  const { data: detail } = useAdminBattleDetailQuery(selectedId)

  return (
    <div className="space-y-3">
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading battles…</p>
      ) : data ? (
        <>
          <p className="text-[11px] text-zinc-500">
            {data.total} battle(s) — page {data.page}/{data.pages}
          </p>
          <div className="space-y-1">
            {data.rows.map((battle) => (
              <button
                key={battle.id}
                type="button"
                onClick={() => setSelectedId(battle.id)}
                className="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-left font-mono text-xs hover:border-amber-700/60"
              >
                <span>
                  <span className="text-zinc-300">{battle.type}</span>{' '}
                  <span className="text-zinc-600">
                    seed {battle.seed} · v{battle.configVersion}
                  </span>
                </span>
                <span>
                  <span className="text-zinc-400">
                    {battle.attacker.name ?? battle.attacker.playerId}
                  </span>
                  {' vs '}
                  <span className="text-zinc-400">
                    {battle.defender?.name ?? battle.defender?.playerId ?? 'PVE'}
                  </span>{' '}
                  <span
                    className={
                      battle.result === 'ATTACKER_WIN' ? 'text-emerald-400' : 'text-amber-400'
                    }
                  >
                    {battle.result}
                  </span>
                </span>
              </button>
            ))}
            {data.rows.length === 0 && (
              <p className="text-zinc-600">
                no battles yet — inspection goes live with the Battle Engine
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← PREV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page >= data.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              NEXT →
            </Button>
          </div>
        </>
      ) : null}

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300">
          <DialogHeader>
            <DialogTitle className="text-amber-400">Battle trace</DialogTitle>
            <DialogDescription className="text-zinc-500">
              {detail
                ? `${detail.type} · ${detail.result} · rounds ${detail.roundsCount}`
                : 'loading…'}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-2">
              <div className="grid gap-1 rounded border border-zinc-800 bg-zinc-900/60 p-3 sm:grid-cols-2">
                <p>
                  attacker power{' '}
                  <span className="text-amber-400">{formatAmount(detail.attackerPower)}</span>
                </p>
                <p>
                  defender power{' '}
                  <span className="text-amber-400">{formatAmount(detail.defenderPower)}</span>
                </p>
                <p>
                  loot{' '}
                  <span className="text-zinc-100">
                    {detail.loot ? JSON.stringify(detail.loot) : '—'}
                  </span>
                </p>
                <p>
                  started <span className="text-zinc-100">{formatTime(detail.startedAt)}</span>
                </p>
              </div>
              {detail.rounds.map((round) => (
                <div
                  key={`${round.roundNumber}-${round.side}`}
                  className="rounded border border-zinc-800 bg-zinc-950/60 p-2.5"
                >
                  <p className="text-zinc-400">
                    round {round.roundNumber} · {round.side} · dmg {formatAmount(round.damageDealt)}
                  </p>
                  {round.events ? (
                    <pre className="mt-1 overflow-x-auto text-[10px] text-zinc-600">
                      {JSON.stringify(round.events)}
                    </pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Economy tab ──────────────────────────────────────────────────────────────

function EconomyTab() {
  const { data, error, isPending } = useAdminEconomyQuery()

  if (error) return <Err error={error} />
  if (isPending) return <p className="animate-pulse text-zinc-500">aggregating ledger…</p>
  if (!data) return <p className="text-zinc-600">no data</p>

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Object.entries(data.supply).map(([resource, amount]) => (
          <div key={resource} className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
            <p className="text-[10px] uppercase text-zinc-500">{resource}</p>
            <p className="font-mono text-xs font-bold text-amber-400">{formatAmount(amount)}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-zinc-500">
        {data.playerCount} players · {data.walletsCount} wallets · ledger {data.ledger.totalRows}{' '}
        rows ({data.ledger.rowsInWindow} in {data.flowWindowDays}d window)
      </p>
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
          ledger flow by reason ({data.flowWindowDays}d)
        </p>
        <div className="space-y-1">
          {data.flowByReason.map((flow) => (
            <div
              key={`${flow.reason}-${flow.resource}`}
              className="flex justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 font-mono text-xs"
            >
              <span className="text-zinc-300">
                {flow.reason} <span className="text-zinc-600">· {flow.resource}</span>
              </span>
              <span>
                <span className="text-zinc-500">×{flow.count}</span>{' '}
                <span className={flow.net.startsWith('-') ? 'text-red-400' : 'text-emerald-400'}>
                  {flow.net.startsWith('-') ? '' : '+'}
                  {formatAmount(flow.net)}
                </span>
              </span>
            </div>
          ))}
          {data.flowByReason.length === 0 && <p className="text-zinc-600">no flow in window</p>}
        </div>
      </div>
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
          recent admin adjustments
        </p>
        <div className="space-y-1">
          {data.recentAdjustments.map((row) => (
            <div
              key={row.id}
              className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 font-mono text-xs"
            >
              <span className="text-zinc-300">{formatTime(row.createdAt)}</span>{' '}
              <span className="text-zinc-500">target {row.targetId ?? '—'}</span>{' '}
              <span className="text-amber-400">{row.reason ?? ''}</span>
            </div>
          ))}
          {data.recentAdjustments.length === 0 && (
            <p className="text-zinc-600">no adjustments yet</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Events tab ───────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  'GOLD_RUSH',
  'BANDIT_ATTACK',
  'PLAGUE',
  'FIRE',
  'MERCHANT_FLEET',
  'RARE_METEOR',
  'NPC_INVASION',
]

function EventsTab({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, error, isPending } = useAdminEventsQuery(status, page)
  const create = useAdminEventCreateMutation()
  const transition = useAdminEventTransitionMutation()

  const [type, setType] = useState('GOLD_RUSH')
  const [title, setTitle] = useState('')
  const [hours, setHours] = useState('24')
  const [message, setMessage] = useState<string | null>(null)

  const hoursNum = Number.parseInt(hours, 10)
  const createValid = hoursNum >= 1

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="event status filter"
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
          value={status}
          onChange={(e) => {
            setPage(1)
            setStatus(e.target.value)
          }}
        >
          <option value="">ALL</option>
          {['SCHEDULED', 'ACTIVE', 'FINISHED', 'CANCELLED'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-zinc-500">
          {data ? `${data.total} event(s) — page ${data.page}/${data.pages}` : ''}
        </p>
      </div>
      {canManage && (
        <form
          className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            setMessage(null)
            create
              .mutateAsync({
                type,
                ...(title.trim() ? { title: title.trim() } : {}),
                endsAt: new Date(Date.now() + hoursNum * 3600_000).toISOString(),
              })
              .then((row) => setMessage(`Spawned ${row.id} (${row.status}).`))
              .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)))
          }}
        >
          <select
            aria-label="event type"
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Input
            className="flex-1 border-zinc-700 bg-zinc-950 font-mono text-xs"
            placeholder="title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Input
            className="w-20 border-zinc-700 bg-zinc-950 font-mono text-xs"
            placeholder="hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            aria-label="duration hours"
          />
          <Button
            size="sm"
            type="submit"
            className="bg-amber-700 text-zinc-950 hover:bg-amber-600"
            disabled={create.isPending || !createValid}
          >
            SPAWN
          </Button>
        </form>
      )}
      {message && <p className="text-[11px] font-semibold text-amber-400">{message}</p>}
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading events…</p>
      ) : data ? (
        <div className="space-y-1">
          {data.rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 font-mono text-xs"
            >
              <span>
                <span className="font-bold text-zinc-100">{row.type}</span>{' '}
                <Badge
                  className={
                    row.status === 'ACTIVE'
                      ? 'bg-emerald-900 text-emerald-200'
                      : row.status === 'CANCELLED'
                        ? 'bg-red-900 text-red-200'
                        : 'bg-zinc-800 text-zinc-300'
                  }
                >
                  {row.status}
                </Badge>{' '}
                {row.title && <span className="text-zinc-500">{row.title}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-zinc-600">ends {formatTime(row.endsAt)}</span>
                {canManage && (row.status === 'ACTIVE' || row.status === 'SCHEDULED') ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-zinc-700 px-2 py-0.5 font-mono text-[10px]"
                      disabled={transition.isPending}
                      onClick={async () => {
                        setMessage(null)
                        try {
                          await transition.mutateAsync({ eventId: row.id, action: 'finish' })
                        } catch (err) {
                          setMessage(err instanceof Error ? err.message : String(err))
                        }
                      }}
                    >
                      FINISH
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-900 px-2 py-0.5 font-mono text-[10px] text-red-300"
                      disabled={transition.isPending}
                      onClick={async () => {
                        setMessage(null)
                        try {
                          await transition.mutateAsync({ eventId: row.id, action: 'cancel' })
                        } catch (err) {
                          setMessage(err instanceof Error ? err.message : String(err))
                        }
                      }}
                    >
                      CANCEL
                    </Button>
                  </>
                ) : null}
              </span>
            </div>
          ))}
          {data.rows.length === 0 && <p className="text-zinc-600">no events</p>}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-zinc-700 font-mono text-xs"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← PREV
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-zinc-700 font-mono text-xs"
          disabled={!data || page >= data.pages}
          onClick={() => setPage((p) => p + 1)}
        >
          NEXT →
        </Button>
      </div>
    </div>
  )
}

// ── Clans tab ────────────────────────────────────────────────────────────────

function ClansTab({ canManage }: { canManage: boolean }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data, error, isPending } = useAdminClansQuery(search, page)
  const { data: detail } = useAdminClanDetailQuery(selectedId)
  const disband = useAdminDisbandMutation()
  const [confirm, setConfirm] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setSearch(query.trim())
        }}
      >
        <Input
          className="border-zinc-700 bg-zinc-950 font-mono text-xs"
          placeholder="clan name or tag"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="clan search"
        />
        <Button size="sm" className="bg-amber-700 text-zinc-950 hover:bg-amber-600" type="submit">
          SEARCH
        </Button>
      </form>
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading clans…</p>
      ) : data ? (
        <div className="space-y-1">
          {data.rows.map((clan) => (
            <button
              key={clan.id}
              type="button"
              onClick={() => setSelectedId(clan.id)}
              className="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-left font-mono text-xs hover:border-amber-700/60"
            >
              <span>
                <span className="font-bold text-zinc-100">[{clan.tag}]</span>{' '}
                <span className="text-zinc-200">{clan.name}</span>{' '}
                <span className="text-zinc-600">lv{clan.level}</span>
              </span>
              <span className="text-zinc-500">
                {clan.memberCount} members · {clan.trophies} 🏆 · leader {clan.leaderName ?? '—'}
              </span>
            </button>
          ))}
          {data.rows.length === 0 && (
            <p className="text-zinc-600">no clans yet — Clan System ships in a later phase</p>
          )}
        </div>
      ) : null}

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-h-[80vh] max-w-xl overflow-y-auto border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-300">
          <DialogHeader>
            <DialogTitle className="text-amber-400">
              {detail ? `[${detail.tag}] ${detail.name}` : 'Clan'}
            </DialogTitle>
            <DialogDescription className="text-zinc-500">
              {detail ? `${detail.memberCount} members · trophies ${detail.trophies}` : 'loading…'}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="space-y-1">
                {detail.members.map((member) => (
                  <div
                    key={member.playerId}
                    className="flex justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5"
                  >
                    <span className="text-zinc-200">
                      {member.name} <span className="text-zinc-600">{member.role}</span>
                    </span>
                    <span className="text-zinc-500">joined {formatTime(member.joinedAt)}</span>
                  </div>
                ))}
              </div>
              {canManage && (
                <div className="space-y-2 rounded border border-red-900/60 bg-red-950/30 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-red-300">
                    disband (destructive — audited)
                  </p>
                  <Input
                    className="border-zinc-700 bg-zinc-950 font-mono text-xs"
                    placeholder='type "DISBAND"'
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    aria-label="disband confirmation"
                  />
                  <Input
                    className="border-zinc-700 bg-zinc-950 font-mono text-xs"
                    placeholder="reason (min 4 chars)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    aria-label="disband reason"
                  />
                  <Button
                    size="sm"
                    className="bg-red-800 text-zinc-50 hover:bg-red-700"
                    disabled={
                      disband.isPending || confirm !== 'DISBAND' || reason.trim().length < 4
                    }
                    onClick={async () => {
                      setMessage(null)
                      try {
                        const result = await disband.mutateAsync({
                          clanId: detail.id,
                          confirm,
                          reason,
                        })
                        setSelectedId(null)
                        setMessage(
                          `Disbanded ${result.name} — ${result.membersRemoved} member(s) removed.`,
                        )
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    DISBAND
                  </Button>
                </div>
              )}
              {message && <p className="text-[11px] font-semibold text-amber-400">{message}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Announcements tab ────────────────────────────────────────────────────────

function AnnouncementsTab({ canCreate, canManage }: { canCreate: boolean; canManage: boolean }) {
  const [page, setPage] = useState(1)
  const { data, error, isPending } = useAdminAnnouncementsQuery(page)
  const create = useAdminAnnouncementCreateMutation()
  const toggle = useAdminAnnouncementActiveMutation()
  const broadcast = useAdminBroadcastMutation()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const createValid = title.trim().length >= 4 && body.trim().length >= 4

  return (
    <div className="space-y-3">
      {canCreate && (
        <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">new announcement</p>
          <Input
            className="border-zinc-700 bg-zinc-950 font-mono text-xs"
            placeholder="title (4…120 chars)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="announcement title"
          />
          <Input
            className="border-zinc-700 bg-zinc-950 font-mono text-xs"
            placeholder="body (4…2000 chars)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="announcement body"
          />
          <Button
            size="sm"
            className="bg-amber-700 text-zinc-950 hover:bg-amber-600"
            disabled={create.isPending || !createValid}
            onClick={async () => {
              setMessage(null)
              try {
                await create.mutateAsync({ title, body })
                setTitle('')
                setBody('')
                setMessage('Announcement created (inactive until broadcast-ready).')
              } catch (err) {
                setMessage(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            CREATE
          </Button>
        </div>
      )}
      {message && <p className="text-[11px] font-semibold text-amber-400">{message}</p>}
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading announcements…</p>
      ) : data ? (
        <div className="space-y-1">
          {data.rows.map((row) => (
            <div
              key={row.id}
              className="space-y-2 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 font-mono text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-zinc-100">{row.title}</span>
                <span className="flex items-center gap-2">
                  <Badge
                    className={
                      row.isActive ? 'bg-emerald-900 text-emerald-200' : 'bg-zinc-800 text-zinc-400'
                    }
                  >
                    {row.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </Badge>
                  <span className="text-zinc-600">{formatTime(row.publishedAt)}</span>
                </span>
              </div>
              <p className="text-zinc-400">{row.body}</p>
              <p className="text-zinc-600">
                audience {row.audience} · by {row.createdByName ?? row.createdById}
              </p>
              {canManage && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-zinc-700 px-2 py-0.5 font-mono text-[10px]"
                    disabled={toggle.isPending}
                    onClick={async () => {
                      setMessage(null)
                      try {
                        await toggle.mutateAsync({
                          announcementId: row.id,
                          isActive: !row.isActive,
                        })
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    {row.isActive ? 'DEACTIVATE' : 'ACTIVATE'}
                  </Button>
                  <Button
                    size="sm"
                    className="bg-amber-700 px-2 py-0.5 font-mono text-[10px] text-zinc-950 hover:bg-amber-600"
                    disabled={broadcast.isPending || !row.isActive}
                    onClick={async () => {
                      setMessage(null)
                      try {
                        const result = await broadcast.mutateAsync(row.id)
                        setMessage(`Broadcast — ${result.notifiedPlayers} player(s) notified.`)
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    BROADCAST
                  </Button>
                </div>
              )}
            </div>
          ))}
          {data.rows.length === 0 && <p className="text-zinc-600">no announcements yet</p>}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          className="border-zinc-700 font-mono text-xs"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← PREV
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-zinc-700 font-mono text-xs"
          disabled={!data || page >= data.pages}
          onClick={() => setPage((p) => p + 1)}
        >
          NEXT →
        </Button>
      </div>
    </div>
  )
}

// ── Audit tab ────────────────────────────────────────────────────────────────

function AuditTab() {
  const [actionFilter, setActionFilter] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const { data, error, isPending } = useAdminAuditQuery(action, page)

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setAction(actionFilter.trim().toUpperCase())
        }}
      >
        <Input
          className="border-zinc-700 bg-zinc-950 font-mono text-xs"
          placeholder="filter by action (e.g. BAN, ADJUST_RESOURCES)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          aria-label="audit action filter"
        />
        <Button size="sm" className="bg-amber-700 text-zinc-950 hover:bg-amber-600" type="submit">
          FILTER
        </Button>
      </form>
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading audit trail…</p>
      ) : data ? (
        <>
          <p className="text-[11px] text-zinc-500">
            {data.total} row(s) — page {data.page}/{data.pages}
          </p>
          <div className="space-y-1">
            {data.rows.map((row) => (
              <div
                key={row.id}
                className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 font-mono text-xs"
              >
                <div className="flex justify-between">
                  <span>
                    <span className="font-bold text-amber-400">{row.action}</span>{' '}
                    <span className="text-zinc-500">
                      {row.targetType}
                      {row.targetId ? ` · ${row.targetId.slice(0, 12)}…` : ''}
                    </span>
                  </span>
                  <span className="text-zinc-600">{formatTime(row.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-zinc-500">
                  actor {row.actor.name ?? row.actor.telegramId}
                  {row.reason ? ` — ${row.reason}` : ''}
                </p>
              </div>
            ))}
            {data.rows.length === 0 && <p className="text-zinc-600">no audit rows</p>}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← PREV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-zinc-700 font-mono text-xs"
              disabled={page >= data.pages}
              onClick={() => setPage((p) => p + 1)}
            >
              NEXT →
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ── Staff tab ────────────────────────────────────────────────────────────────

function StaffTab() {
  const { data, error, isPending } = useAdminStaffQuery()
  const grant = useAdminGrantMutation()
  const deactivate = useAdminDeactivateMutation()
  const [telegramId, setTelegramId] = useState('')
  const [role, setRole] = useState<'ADMIN' | 'MODERATOR'>('MODERATOR')
  const [message, setMessage] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <form
        className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          setMessage(null)
          grant
            .mutateAsync({ telegramId: telegramId.trim(), role })
            .then((result) => setMessage(`Granted ${result.role} to ${result.telegramId}.`))
            .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)))
        }}
      >
        <Input
          className="flex-1 border-zinc-700 bg-zinc-950 font-mono text-xs"
          placeholder="telegram id (registered user)"
          value={telegramId}
          onChange={(e) => setTelegramId(e.target.value)}
          aria-label="staff telegram id"
        />
        <select
          aria-label="staff role"
          className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs"
          value={role}
          onChange={(e) => setRole(e.target.value as 'ADMIN' | 'MODERATOR')}
        >
          <option value="MODERATOR">MODERATOR</option>
          <option value="ADMIN">ADMIN</option>
        </select>
        <Button
          size="sm"
          type="submit"
          className="bg-amber-700 text-zinc-950 hover:bg-amber-600"
          disabled={grant.isPending || telegramId.trim().length === 0}
        >
          GRANT
        </Button>
      </form>
      {message && <p className="text-[11px] font-semibold text-amber-400">{message}</p>}
      {error ? (
        <Err error={error} />
      ) : isPending ? (
        <p className="animate-pulse text-zinc-500">loading staff…</p>
      ) : data ? (
        <div className="space-y-1">
          {data.rows.map((row) => (
            <div
              key={row.adminUserId}
              className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 font-mono text-xs"
            >
              <span>
                <span className="font-bold text-zinc-100">{row.username ?? row.telegramId}</span>{' '}
                <Badge
                  className={
                    row.role === 'MODERATOR'
                      ? 'bg-zinc-800 text-zinc-300'
                      : 'bg-amber-900/60 text-amber-200'
                  }
                >
                  {row.role}
                </Badge>
                {!row.isActive && <Badge className="bg-red-900 text-red-200">INACTIVE</Badge>}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-zinc-600">{row.telegramId}</span>
                {row.isActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-900 px-2 py-0.5 font-mono text-[10px] text-red-300"
                    disabled={deactivate.isPending}
                    onClick={async () => {
                      setMessage(null)
                      try {
                        await deactivate.mutateAsync(row.adminUserId)
                        setMessage(`Deactivated ${row.telegramId}.`)
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    REVOKE
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── Panel shell ──────────────────────────────────────────────────────────────

export function AdminPanel() {
  const { data: admin, error, isPending } = useAdminMeQuery()

  if (isPending) return null
  if (error) return null // non-staff or anonymous — the panel simply doesn't render
  if (!admin?.isStaff) return null

  const scopes = new Set(admin.scopes ?? [])
  const role = admin.adminRole ?? 'ADMIN'

  return (
    <Card className="border-amber-900/60 bg-zinc-900/60 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base font-bold text-zinc-100">
          Admin Panel
          <span className="flex items-center gap-2 text-xs font-semibold">
            <Badge className="bg-amber-900/60 text-amber-200">{role}</Badge>
            <span className="text-zinc-500">
              {scopes.size} scope(s) — enforced server-side on every route
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Every action lands in the audit trail (transactional for mutations). RBAC: the moderator
          role cannot adjust resources, manage events/clans/staff or settle seasons — those routes
          answer to the server-side scope matrix, not to this UI.
        </p>
        <Separator className="bg-zinc-800" />
        <Tabs defaultValue={scopes.has('players.search') ? 'players' : 'economy'}>
          <TabsList className="flex flex-wrap gap-1 bg-zinc-950">
            {scopes.has('players.search') && (
              <TabsTrigger value="players" className="text-xs">
                Players
              </TabsTrigger>
            )}
            {scopes.has('battles.view') && (
              <TabsTrigger value="battles" className="text-xs">
                Battles
              </TabsTrigger>
            )}
            {scopes.has('economy.view') && (
              <TabsTrigger value="economy" className="text-xs">
                Economy
              </TabsTrigger>
            )}
            {scopes.has('events.view') && (
              <TabsTrigger value="events" className="text-xs">
                Events
              </TabsTrigger>
            )}
            {scopes.has('clans.view') && (
              <TabsTrigger value="clans" className="text-xs">
                Clans
              </TabsTrigger>
            )}
            {scopes.has('announcements.view') && (
              <TabsTrigger value="announcements" className="text-xs">
                Announcements
              </TabsTrigger>
            )}
            {scopes.has('audit.view') && (
              <TabsTrigger value="audit" className="text-xs">
                Audit
              </TabsTrigger>
            )}
            {scopes.has('staff.manage') && (
              <TabsTrigger value="staff" className="text-xs">
                Staff
              </TabsTrigger>
            )}
          </TabsList>
          {scopes.has('players.search') && (
            <TabsContent value="players">
              <PlayersTab scopes={scopes} />
            </TabsContent>
          )}
          {scopes.has('battles.view') && (
            <TabsContent value="battles">
              <BattlesTab />
            </TabsContent>
          )}
          {scopes.has('economy.view') && (
            <TabsContent value="economy">
              <EconomyTab />
            </TabsContent>
          )}
          {scopes.has('events.view') && (
            <TabsContent value="events">
              <EventsTab canManage={scopes.has('events.manage')} />
            </TabsContent>
          )}
          {scopes.has('clans.view') && (
            <TabsContent value="clans">
              <ClansTab canManage={scopes.has('clans.manage')} />
            </TabsContent>
          )}
          {scopes.has('announcements.view') && (
            <TabsContent value="announcements">
              <AnnouncementsTab
                canCreate={scopes.has('announcements.create')}
                canManage={scopes.has('announcements.manage')}
              />
            </TabsContent>
          )}
          {scopes.has('audit.view') && (
            <TabsContent value="audit">
              <AuditTab />
            </TabsContent>
          )}
          {scopes.has('staff.manage') && (
            <TabsContent value="staff">
              <StaffTab />
            </TabsContent>
          )}
        </Tabs>
      </CardContent>
    </Card>
  )
}
