'use client'

/**
 * WARLORDS — Clans section for the Mini App console (Phase 34).
 *
 * Renders the LIVE server clan projection: the caller's clan (detail +
 * member roster) or an honest clanless state with the found-clan form, the
 * clan directory (join) and the caller's live invitations (accept = claim
 * the invitation through the server's join route). Every value shown is
 * server-computed — nothing here is mock, hard-coded or optimistic:
 * membership, the role matrix, succession, join policy and invitation
 * validity are decided inside ONE server transaction and arrive read-only.
 * The client merely renders the server's verdicts and lets its typed
 * refusals surface as toasts.
 *
 * Role gating in the UI is a CONVENIENCE MIRROR of the server's matrix —
 * the server re-checks every action (never trust the client):
 *   LEADER  → promote/demote MEMBER↔OFFICER, transfer leadership, remove
 *   OFFICER → invite, remove MEMBER
 *   MEMBER  → leave (the LEADER must transfer first — the server's
 *             CLAN_LEADER_SUCCESSION refusal surfaces as a toast)
 *
 * Visual language matches the console: zinc/dark surfaces, amber accents,
 * text-[11px] uppercase tracking-wider labels, mono body text. Roster and
 * directory scroll inside max-h lists — no horizontal overflow at 390px.
 */

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { usePlayerProfileQuery } from '@/features/player'
import {
  useClanDetail,
  useClanList,
  useCreateClan,
  useInviteMember,
  useJoinClan,
  useLeaveClan,
  useMyInvitations,
  useRemoveMember,
  useSetMemberRole,
  useTransferLeadership,
} from '../api/clans'
import type {
  ClanDetailView,
  ClanInvitationView,
  ClanMemberView,
  ClanRole,
  ClanSummaryView,
} from '../types'
import { CLAN_FORM_LIMITS } from '../types'

// ── Static class lookups (never interpolate Tailwind class names) ────────────

/** Clan role → badge appearance (LEADER outranks OFFICER outranks MEMBER). */
const ROLE_BADGE: Record<ClanRole, string> = {
  LEADER: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  OFFICER: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  MEMBER: 'border-zinc-700 text-zinc-400',
}

const JOIN_POLICY_BADGE: Record<string, string> = {
  OPEN: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  INVITE_ONLY: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
}

/** Typed clan refusal → human text (server error codes win). */
const CLAN_ERROR_TEXT: Record<string, string> = {
  VALIDATION_ERROR: 'Invalid clan details — check the name and tag',
  ALREADY_IN_CLAN: 'Already in a clan',
  NOT_IN_CLAN: 'You are not in this clan',
  CLAN_NAME_TAKEN: 'That clan name is taken',
  CLAN_TAG_TAKEN: 'That clan tag is taken',
  CLAN_FULL: 'That clan is full',
  CLAN_LEADER_SUCCESSION: 'Transfer leadership before leaving your clan',
  CLAN_INVITATION_INVALID: 'That invitation is no longer valid',
  CLAN_JOIN_POLICY_CLOSED: 'This clan is invite-only — ask an officer',
  CLAN_ROLE_REQUIRED: 'Your rank does not allow that action',
  CLAN_NOT_FOUND: 'Clan not found',
  PLAYER_NOT_FOUND: 'No player with that id',
}

function clanErrorText(error: Error & { code?: string }): string {
  if (error.code && CLAN_ERROR_TEXT[error.code]) return CLAN_ERROR_TEXT[error.code]
  return error.message || 'Clan action failed — try again'
}

function roleRank(role: ClanRole): number {
  return role === 'LEADER' ? 3 : role === 'OFFICER' ? 2 : 1
}

// ── Create form (clanless state) ─────────────────────────────────────────────

function CreateClanForm() {
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const createClan = useCreateClan()
  const { toast } = useToast()
  const limits = CLAN_FORM_LIMITS
  // Display hints only — the server re-validates and stays authoritative.
  const nameReady = name.trim().length >= limits.nameMin
  const tagReady = tag.trim().length >= limits.tagMin

  function handleCreate() {
    createClan.mutate(
      { name: name.trim(), tag: tag.trim() },
      {
        onSuccess: (clan) => {
          toast({
            title: `Clan founded — ${clan.name} [${clan.tag}]`,
            description: 'You are the LEADER. Invite warlords or open the gates.',
          })
          setName('')
          setTag('')
        },
        onError: (error) => {
          const typed = error as Error & { code?: string }
          toast({
            title: 'Clan not founded',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  return (
    <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
        Found a clan
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">
          you become its LEADER
        </span>
      </p>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={limits.nameMax}
        placeholder="Clan name"
        aria-label="Clan name"
        className="h-11 border-zinc-700 bg-zinc-950 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
      />
      <Input
        value={tag}
        onChange={(event) => setTag(event.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())}
        maxLength={limits.tagMax}
        placeholder="TAG"
        aria-label="Clan tag (uppercase letters and digits)"
        className="h-11 border-zinc-700 bg-zinc-950 font-mono text-xs uppercase text-zinc-200 placeholder:text-zinc-600"
      />
      <p className="text-[10px] text-zinc-500">
        name {name.trim().length}/{limits.nameMax} · tag {tag.trim().length}/{limits.tagMax} (A–Z
        0–9) — bounds mirror the server config
      </p>
      <Button
        size="sm"
        className="min-h-[44px] w-full bg-amber-500 text-[11px] font-bold text-zinc-950 hover:bg-amber-400"
        disabled={createClan.isPending || !nameReady || !tagReady}
        onClick={handleCreate}
        aria-label="Found a clan with the entered name and tag"
      >
        {createClan.isPending ? '… FOUNDING' : '[ FOUND CLAN ]'}
      </Button>
    </div>
  )
}

// ── Invitations (clanless state) ─────────────────────────────────────────────

function InvitationRow({
  invitation,
  acceptPending,
  onAccept,
}: {
  invitation: ClanInvitationView
  acceptPending: boolean
  onAccept: (invitation: ClanInvitationView) => void
}) {
  const expiresAt = new Date(invitation.expiresAt)
  return (
    <li className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[11px] font-semibold text-zinc-200">
          {invitation.clanName}{' '}
          <span className="font-mono text-[10px] text-zinc-400">[{invitation.clanTag}]</span>
        </span>
        <Button
          size="sm"
          className="min-h-[44px] bg-amber-500 px-3 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
          disabled={acceptPending}
          onClick={() => onAccept(invitation)}
          aria-label={`Accept the invitation to ${invitation.clanName}`}
        >
          {acceptPending ? '… JOINING' : '[ ACCEPT ]'}
        </Button>
      </div>
      <p className="mt-0.5 text-[10px] text-zinc-500">
        invited by {invitation.invitorName} · expires {expiresAt.toLocaleDateString()}{' '}
        {expiresAt.toLocaleTimeString()}
      </p>
    </li>
  )
}

function InvitationsPanel() {
  const { data, error, isPending, refetch } = useMyInvitations()
  const joinClan = useJoinClan()
  const { toast } = useToast()

  function handleAccept(invitation: ClanInvitationView) {
    joinClan.mutate(
      { clanId: invitation.clanId, invitationId: invitation.id },
      {
        onSuccess: (clan) => {
          toast({
            title: `Joined ${clan.name} [${clan.tag}]`,
            description: 'Invitation claimed — you are a MEMBER.',
          })
        },
        onError: (err) => {
          const typed = err as Error & { code?: string }
          toast({
            title: 'Invitation not claimed',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  if (isPending) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-1/3 bg-zinc-800" />
        <Skeleton className="h-12 w-full bg-zinc-800" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="space-y-1.5">
        <p className="text-red-400" role="alert">
          {(error as Error & { code?: string }).code ?? 'ERROR'}: {error.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </div>
    )
  }
  const invitations = data?.invitations ?? []
  return (
    <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
        Invitations
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">
          {invitations.length} live · 24h server TTL
        </span>
      </p>
      {invitations.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-zinc-500">
          No live invitations — an officer must invite you (or join an OPEN clan below).
        </p>
      ) : (
        <ul
          className="max-h-48 space-y-1.5 overflow-y-auto pr-1"
          aria-label="Live clan invitations"
        >
          {invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              acceptPending={joinClan.isPending}
              onAccept={handleAccept}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Directory (clanless state) ───────────────────────────────────────────────

function DirectoryRow({
  clan,
  joinPending,
  onJoin,
}: {
  clan: ClanSummaryView
  joinPending: boolean
  onJoin: (clan: ClanSummaryView) => void
}) {
  const full = clan.memberCount >= clan.maxMembers
  return (
    <li className="rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[11px] font-semibold text-zinc-200">
          {clan.name} <span className="font-mono text-[10px] text-zinc-400">[{clan.tag}]</span>
        </span>
        {full ? (
          <Badge
            variant="outline"
            className="shrink-0 border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-500"
          >
            FULL
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="min-h-[44px] border-zinc-700 px-3 text-[10px] font-bold text-amber-300 hover:bg-zinc-800"
            disabled={joinPending}
            onClick={() => onJoin(clan)}
            aria-label={`Join ${clan.name}`}
          >
            {joinPending ? '… JOINING' : '[ JOIN ]'}
          </Button>
        )}
      </div>
      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
        <span>
          {clan.memberCount}/{clan.maxMembers} members
        </span>
        <span>· leader {clan.leaderName}</span>
        <span>· {clan.trophies} trophies</span>
        <Badge
          variant="outline"
          className={`px-1.5 py-0 text-[9px] ${JOIN_POLICY_BADGE[clan.joinPolicy] ?? 'border-zinc-700 text-zinc-400'}`}
        >
          {clan.joinPolicy === 'OPEN' ? 'OPEN' : 'INVITE ONLY'}
        </Badge>
      </p>
    </li>
  )
}

function ClanDirectory() {
  const [page, setPage] = useState(1)
  const { data, error, isPending, refetch } = useClanList({ page })
  const joinClan = useJoinClan()
  const { toast } = useToast()

  function handleJoin(clan: ClanSummaryView) {
    joinClan.mutate(
      { clanId: clan.id },
      {
        onSuccess: (joined) => {
          toast({
            title: `Joined ${joined.name} [${joined.tag}]`,
            description: 'You are a MEMBER — the roster is live above.',
          })
        },
        onError: (err) => {
          const typed = err as Error & { code?: string }
          toast({
            title: 'Join refused',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  if (isPending) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-1/4 bg-zinc-800" />
        <Skeleton className="h-12 w-full bg-zinc-800" />
        <Skeleton className="h-12 w-full bg-zinc-800" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="space-y-1.5">
        <p className="text-red-400" role="alert">
          {(error as Error & { code?: string }).code ?? 'ERROR'}: {error.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </div>
    )
  }
  const clans = data?.clans ?? []
  const total = data?.total ?? 0
  const pageSize = data?.pageSize ?? 10
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
        Clans
        <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">
          {total} banners · largest first
        </span>
      </p>
      {clans.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-zinc-500">
          No clans exist yet — found the first one above.
        </p>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1" aria-label="Clan directory">
          {clans.map((clan) => (
            <DirectoryRow
              key={clan.id}
              clan={clan}
              joinPending={joinClan.isPending}
              onJoin={handleJoin}
            />
          ))}
        </ul>
      )}
      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
            disabled={page <= 1}
            aria-label="Previous clan directory page"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            ‹ prev
          </Button>
          <span className="text-[10px] text-zinc-500">
            page {page}/{pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
            disabled={page >= pages}
            aria-label="Next clan directory page"
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
          >
            next ›
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ── Member roster (in-clan state) ────────────────────────────────────────────

interface MemberRowProps {
  member: ClanMemberView
  viewerRole: ClanRole
  viewerPlayerId: string
  pending: boolean
  onSetRole: (member: ClanMemberView, role: 'OFFICER' | 'MEMBER') => void
  onRemove: (member: ClanMemberView) => void
  onTransfer: (member: ClanMemberView) => void
}

function MemberRow({
  member,
  viewerRole,
  viewerPlayerId,
  pending,
  onSetRole,
  onRemove,
  onTransfer,
}: MemberRowProps) {
  const isSelf = member.playerId === viewerPlayerId
  const isLeaderViewer = viewerRole === 'LEADER'
  const isOfficerViewer = viewerRole === 'OFFICER'
  const targetRank = roleRank(member.role)
  const viewerRank = roleRank(viewerRole)
  // Convenience mirror of the server matrix — the server re-checks.
  const canSetRole = isLeaderViewer && !isSelf && member.role !== 'LEADER'
  const canRemove =
    !isSelf &&
    targetRank < viewerRank &&
    (isLeaderViewer || (isOfficerViewer && member.role === 'MEMBER'))
  const canTransfer = isLeaderViewer && !isSelf
  const joined = new Date(member.joinedAt)
  return (
    <li
      className={`rounded border px-2.5 py-2 ${
        isSelf ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-800 bg-zinc-950/60'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-[11px] font-semibold text-zinc-200">
          {member.name}
          {isSelf ? <span className="ml-1 text-[10px] text-amber-300">(you)</span> : null}
        </span>
        <Badge
          variant="outline"
          className={`shrink-0 px-1.5 py-0 text-[9px] font-semibold ${ROLE_BADGE[member.role]}`}
        >
          {member.role}
        </Badge>
      </div>
      <p className="mt-0.5 text-[10px] text-zinc-500">
        power {member.power} · level {member.level} · joined {joined.toLocaleDateString()}
      </p>
      {canSetRole || canRemove || canTransfer ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {canSetRole ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] border-zinc-700 px-2.5 text-[10px] font-bold text-zinc-300 hover:bg-zinc-800"
              disabled={pending}
              onClick={() => onSetRole(member, member.role === 'MEMBER' ? 'OFFICER' : 'MEMBER')}
              aria-label={`${member.role === 'MEMBER' ? 'Promote' : 'Demote'} ${member.name}`}
            >
              {member.role === 'MEMBER' ? '[ PROMOTE ]' : '[ DEMOTE ]'}
            </Button>
          ) : null}
          {canTransfer ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] border-amber-500/40 px-2.5 text-[10px] font-bold text-amber-300 hover:bg-zinc-800"
              disabled={pending}
              onClick={() => onTransfer(member)}
              aria-label={`Transfer leadership to ${member.name}`}
            >
              [ TRANSFER ]
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              size="sm"
              variant="outline"
              className="min-h-[44px] border-red-500/30 px-2.5 text-[10px] font-bold text-red-300 hover:bg-zinc-800"
              disabled={pending}
              onClick={() => onRemove(member)}
              aria-label={`Remove ${member.name} from the clan`}
            >
              [ REMOVE ]
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

// ── Invite + leave toolbar (in-clan state) ───────────────────────────────────

function ClanConsole({ clan, viewerPlayerId }: { clan: ClanDetailView; viewerPlayerId: string }) {
  const [inviteId, setInviteId] = useState('')
  const viewerRole = clan.viewerRole ?? 'MEMBER'
  const officerPlus = viewerRole === 'LEADER' || viewerRole === 'OFFICER'
  const setRole = useSetMemberRole()
  const removeMember = useRemoveMember()
  const transfer = useTransferLeadership()
  const invite = useInviteMember()
  const leave = useLeaveClan()
  const { toast } = useToast()
  const pending =
    setRole.isPending ||
    removeMember.isPending ||
    transfer.isPending ||
    invite.isPending ||
    leave.isPending

  function handleSetRole(member: ClanMemberView, role: 'OFFICER' | 'MEMBER') {
    setRole.mutate(
      { clanId: clan.id, playerId: member.playerId, role },
      {
        onSuccess: (result) => {
          toast({
            title: 'Role updated',
            description: `${member.name} is now ${result.role}.`,
          })
        },
        onError: (error) => {
          const typed = error as Error & { code?: string }
          toast({
            title: 'Role change refused',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  function handleRemove(member: ClanMemberView) {
    removeMember.mutate(
      { clanId: clan.id, playerId: member.playerId },
      {
        onSuccess: () => {
          toast({
            title: 'Member removed',
            description: `${member.name} was removed from ${clan.name}.`,
          })
        },
        onError: (error) => {
          const typed = error as Error & { code?: string }
          toast({
            title: 'Removal refused',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  function handleTransfer(member: ClanMemberView) {
    transfer.mutate(
      { clanId: clan.id, playerId: member.playerId },
      {
        onSuccess: () => {
          toast({
            title: 'Leadership transferred',
            description: `${member.name} is the new LEADER — you are now an OFFICER.`,
          })
        },
        onError: (error) => {
          const typed = error as Error & { code?: string }
          toast({
            title: 'Transfer refused',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  function handleInvite() {
    const target = inviteId.trim()
    if (!target) return
    invite.mutate(
      { clanId: clan.id, playerId: target },
      {
        onSuccess: (invitation) => {
          toast({
            title: 'Invitation sent',
            description: `${invitation.clanName} invited a warlord — 24h to claim.`,
          })
          setInviteId('')
        },
        onError: (error) => {
          const typed = error as Error & { code?: string }
          toast({
            title: 'Invite refused',
            description: clanErrorText(typed),
            variant: 'destructive',
          })
        },
      },
    )
  }

  function handleLeave() {
    leave.mutate(clan.id, {
      onSuccess: () => {
        toast({
          title: 'You left the clan',
          description: 'The banner no longer carries your colors.',
        })
      },
      onError: (error) => {
        const typed = error as Error & { code?: string }
        toast({
          title: 'Leave refused',
          description: clanErrorText(typed),
          variant: 'destructive',
        })
      },
    })
  }

  return (
    <div className="space-y-2">
      {/* Clan banner line — server summary fields only */}
      <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-xs font-bold text-zinc-100">
            {clan.name} <span className="font-mono text-[11px] text-amber-300">[{clan.tag}]</span>
          </span>
          <Badge
            variant="outline"
            className={`shrink-0 px-1.5 py-0 text-[9px] font-semibold ${ROLE_BADGE[viewerRole]}`}
          >
            YOU: {viewerRole}
          </Badge>
        </div>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-400">
          <span>
            <span className="text-zinc-200">{clan.memberCount}</span>/{clan.maxMembers} members
          </span>
          <span>· leader {clan.leaderName}</span>
          <span>· {clan.trophies} trophies</span>
          <Badge
            variant="outline"
            className={`px-1.5 py-0 text-[9px] ${JOIN_POLICY_BADGE[clan.joinPolicy] ?? 'border-zinc-700 text-zinc-400'}`}
          >
            {clan.joinPolicy === 'OPEN' ? 'OPEN' : 'INVITE ONLY'}
          </Badge>
        </p>
        {clan.description ? (
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{clan.description}</p>
        ) : null}
      </div>

      {/* Roster — server role matrix mirrored for convenience */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          Roster
          <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">
            {clan.members.length} warlords
          </span>
        </p>
        <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1" aria-label="Clan member roster">
          {clan.members.map((member) => (
            <MemberRow
              key={member.playerId}
              member={member}
              viewerRole={viewerRole}
              viewerPlayerId={viewerPlayerId}
              pending={pending}
              onSetRole={handleSetRole}
              onRemove={handleRemove}
              onTransfer={handleTransfer}
            />
          ))}
        </ul>
      </div>

      {/* Invite — OFFICER+; the server requires the target's player id */}
      {officerPlus ? (
        <div className="space-y-1.5 rounded border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            Invite
            <span className="ml-2 font-normal normal-case tracking-normal text-zinc-500">
              one live invitation per player · 24h TTL
            </span>
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              value={inviteId}
              onChange={(event) => setInviteId(event.target.value)}
              placeholder="player id"
              aria-label="Player id to invite"
              className="h-11 min-w-0 flex-1 border-zinc-700 bg-zinc-950 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600"
            />
            <Button
              size="sm"
              className="min-h-[44px] bg-amber-500 px-3 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
              disabled={invite.isPending || inviteId.trim().length === 0}
              onClick={handleInvite}
              aria-label="Send a clan invitation to the entered player id"
            >
              {invite.isPending ? '… INVITING' : '[ INVITE ]'}
            </Button>
          </div>
          <p className="text-[10px] leading-relaxed text-zinc-600">
            The server requires the player&apos;s exact id — there is no name-lookup endpoint.
          </p>
        </div>
      ) : null}

      {/* Leave — the LEADER's attempt surfaces the server's succession 409 */}
      <Button
        size="sm"
        variant="outline"
        className="min-h-[44px] w-full border-red-500/30 text-[10px] font-bold text-red-300 hover:bg-zinc-800"
        disabled={leave.isPending}
        onClick={handleLeave}
        aria-label={
          viewerRole === 'LEADER'
            ? 'Attempt to leave the clan (the leader must transfer leadership first)'
            : 'Leave the clan'
        }
      >
        {leave.isPending ? '… LEAVING' : '[ LEAVE CLAN ]'}
      </Button>
      {viewerRole === 'LEADER' ? (
        <p className="text-[10px] leading-relaxed text-zinc-600">
          The LEADER cannot leave — transfer the banner first (the server enforces succession).
        </p>
      ) : null}
    </div>
  )
}

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * Full-width console card. Owns its queries (enabled only while a session
 * exists) so page.tsx stays additive; anonymous users get the standard
 * sign-in prompt, exactly like the Marches section.
 */
export function ClansSection({ signedIn }: { signedIn: boolean }) {
  // "My clan" discovery: the profile projection carries the denormalized
  // Player.clanId/clanRole mirror — the clan detail itself is fetched from
  // /api/v1/clans/[id] (the clans API has no /mine route by design).
  const { data: profile } = usePlayerProfileQuery({ enabled: signedIn })
  const myClanId = profile?.clan?.id ?? null
  const {
    data: clan,
    error: clanError,
    isPending: clanPending,
    refetch: refetchClan,
  } = useClanDetail({ enabled: signedIn && myClanId !== null, clanId: myClanId })

  const clanless = signedIn && profile !== undefined && myClanId === null
  const headerStatus = !signedIn
    ? 'SIGN IN TO VIEW'
    : clan
      ? `${clan.tag} · ${(clan.viewerRole ?? 'MEMBER').toUpperCase()}`
      : clanless
        ? 'CLANLESS'
        : 'NO CLAN'

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
          Clans
          <span
            className={`inline-flex items-center gap-2 text-xs font-semibold ${
              clan ? 'text-amber-400' : clanless ? 'text-emerald-400' : 'text-zinc-500'
            }`}
            aria-live="polite"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                clan ? 'bg-amber-400' : clanless ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            {headerStatus}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
        {!signedIn ? (
          <p className="leading-relaxed text-zinc-500">
            Anonymous — sign in to found a clan, rally under a banner and station clan garrisons.
          </p>
        ) : clanless ? (
          <>
            <CreateClanForm />
            <Separator className="bg-zinc-800" />
            <InvitationsPanel />
            <Separator className="bg-zinc-800" />
            <ClanDirectory />
            <Separator className="bg-zinc-800" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Server-authoritative clans: names and tags are unique, one clan per warlord, and the
              role matrix (LEADER &gt; OFFICER &gt; MEMBER) is enforced inside the server&apos;s
              transaction — this panel only renders its verdicts. Clan membership authorizes
              REINFORCE garrisons on clan-held territories.
            </p>
          </>
        ) : clanPending ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-1/3 bg-zinc-800" />
            <Skeleton className="h-14 w-full bg-zinc-800" />
            <Skeleton className="h-14 w-full bg-zinc-800" />
          </div>
        ) : clanError ? (
          <div className="space-y-1.5">
            <p className="text-red-400" role="alert">
              {(clanError as Error & { code?: string }).code ?? 'ERROR'}: {clanError.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-zinc-700 px-2 text-[10px] text-zinc-300"
              onClick={() => refetchClan()}
            >
              Retry
            </Button>
          </div>
        ) : clan && profile ? (
          <>
            <ClanConsole clan={clan} viewerPlayerId={profile.id} />
            <Separator className="bg-zinc-800" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Role powers mirror the server matrix — promote/demote and leadership transfer are
              LEADER-only, invites and MEMBER removal are OFFICER+, and nobody manages an equal or
              higher rank. The server re-checks every action inside one locked transaction.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
