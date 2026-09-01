'use client'

/**
 * WARLORDS — Quests & Achievements section for the Mini App console.
 *
 * Renders the LIVE server quest board (GET /api/v1/quests) grouped into
 * DAILY · WEEKLY · MAIN tabs (SEASONAL quests would join the Weekly tab when
 * they exist — only types present in the data render), plus the permanent
 * achievement board (GET /api/v1/quests/achievements). Claims go through the
 * feature mutation; every reward, status and progress value shown is
 * server-computed — nothing here is mock, hard-coded or optimistic.
 *
 * Visual language matches the console: zinc/dark surfaces, amber accents,
 * text-[11px] uppercase tracking-wider labels, mono body text. Cards stack
 * and chips wrap — no horizontal overflow at 390px.
 */

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { useAchievements, useClaimQuest, useQuests } from '../api/quests'
import type { AchievementView, QuestBoardEntry } from '../types'

type QuestsTab = 'DAILY' | 'WEEKLY' | 'MAIN' | 'ACHIEVEMENTS'

interface QuestGroup {
  tab: Exclude<QuestsTab, 'ACHIEVEMENTS'>
  label: string
  quests: QuestBoardEntry[]
}

/** Group the board into tabs by quest type — only non-empty groups render. */
function groupBoardQuests(quests: QuestBoardEntry[]): QuestGroup[] {
  const groups: QuestGroup[] = []
  const daily = quests.filter((q) => q.type === 'DAILY')
  // SEASONAL quests join the Weekly tab (both are cycle-window quests).
  const weekly = quests.filter((q) => q.type === 'WEEKLY' || q.type === 'SEASONAL')
  const main = quests.filter((q) => q.type === 'MAIN')
  if (daily.length > 0) groups.push({ tab: 'DAILY', label: 'DAILY', quests: daily })
  if (weekly.length > 0) groups.push({ tab: 'WEEKLY', label: 'WEEKLY', quests: weekly })
  if (main.length > 0) groups.push({ tab: 'MAIN', label: 'MAIN', quests: main })
  return groups
}

/** "+200 GOLD · +100 XP" — reward summary for toasts (server amounts only). */
function rewardSummary(reward: Record<string, number>): string {
  return Object.entries(reward)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([key, amount]) => `+${amount} ${key}`)
    .join(' · ')
}

/** Maps typed claim refusals to friendly copy (server error codes win). */
function claimErrorText(error: Error & { code?: string }): string {
  switch (error.code) {
    case 'QUEST_ALREADY_CLAIMED':
      return 'Already claimed'
    case 'QUEST_NOT_COMPLETED':
      return 'Quest is not completed yet'
    case 'QUEST_EXPIRED':
      return 'This quest expired — its reward cycle rolled over'
    case 'QUEST_NOT_FOUND':
      return 'Quest not found'
    default:
      return error.message || 'Claim failed — try again'
  }
}

function lockReasonText(entry: QuestBoardEntry): string {
  if (entry.eligibility.eligible) return ''
  switch (entry.eligibility.reason) {
    case 'MIN_LEVEL':
      return `Reach level ${entry.minLevel}`
    case 'PREREQUISITES':
      return entry.prerequisiteQuestIds.length > 0
        ? 'Complete the previous quest to unlock'
        : 'Locked'
    default:
      return 'Locked' // INACTIVE · NO_ACTIVE_SEASON
  }
}

function progressPct(progress: number, target: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(target) || target <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((progress / target) * 100)))
}

/** Amber reward chips — wraps, never overflows. */
function RewardChips({ reward }: { reward: Record<string, number> }) {
  const entries = Object.entries(reward).filter(([, amount]) => Number(amount) > 0)
  if (entries.length === 0) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {entries.map(([key, amount]) => (
        <Badge
          key={key}
          variant="outline"
          className="border-amber-500/30 bg-amber-500/5 px-1.5 py-0 text-[9px] font-semibold text-amber-300"
        >
          {amount} {key}
        </Badge>
      ))}
    </span>
  )
}

interface QuestCardProps {
  quest: QuestBoardEntry
  claimDisabled: boolean
  onClaim: (quest: QuestBoardEntry) => void
}

/** One quest row — status treatment per instance state, locked style otherwise. */
function QuestCard({ quest, claimDisabled, onClaim }: QuestCardProps) {
  const instance = quest.instance
  const locked = instance === null && !quest.eligibility.eligible
  const expired = instance?.status === 'EXPIRED'
  const completed = instance?.status === 'COMPLETED'
  const claimed = instance?.status === 'CLAIMED'
  const active = instance?.status === 'ACTIVE'
  const dimmed = locked || expired

  return (
    <div
      className={`rounded border px-2.5 py-2 ${
        locked
          ? 'border-zinc-800/70 bg-zinc-950/40'
          : completed
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-zinc-800 bg-zinc-950/60'
      } ${dimmed ? 'opacity-60' : ''}`}
    >
      {/* Title + status/action row — wraps, title truncates */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-semibold text-zinc-200">{quest.title}</span>
          {quest.type === 'SEASONAL' ? (
            <Badge
              variant="outline"
              className="shrink-0 border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-400"
            >
              SEASONAL
            </Badge>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {completed ? (
            <Button
              size="sm"
              className="h-7 bg-amber-500 px-2 text-[10px] font-bold text-zinc-950 hover:bg-amber-400"
              disabled={claimDisabled}
              onClick={() => onClaim(quest)}
              aria-label={`Claim reward for ${quest.title}`}
            >
              [ CLAIM ]
            </Button>
          ) : claimed ? (
            <Badge className="border border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-300">
              CLAIMED ✓
            </Badge>
          ) : expired ? (
            <Badge
              variant="outline"
              className="border-zinc-700 px-1.5 py-0 text-[10px] text-zinc-500"
            >
              EXPIRED
            </Badge>
          ) : active ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-zinc-700 px-2 text-[10px] font-semibold text-zinc-500"
              disabled
              aria-label={`${quest.title} in progress (${instance.progress}/${instance.target})`}
            >
              {instance.progress > 0 ? `${instance.progress}/${instance.target}` : 'IN PROGRESS'}
            </Button>
          ) : (
            // Eligible but not yet instantiated — assignments are created on
            // read, so this is a transient server state, never a fake status.
            <Badge
              variant="outline"
              className="border-zinc-700 px-1.5 py-0 text-[10px] text-zinc-400"
            >
              AVAILABLE
            </Badge>
          )}
        </span>
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-zinc-500 [overflow-wrap:anywhere]">
        {quest.description}
      </p>

      {/* Progress bar — server-computed instance progress only */}
      {instance ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10px] text-zinc-400">
            {instance.progress} / {instance.target}
          </span>
          <Progress
            value={progressPct(instance.progress, instance.target)}
            aria-label={`${quest.title} progress ${instance.progress} of ${instance.target}`}
            className="h-1 bg-zinc-800"
          />
        </div>
      ) : null}

      {/* Lock line — prerequisites chain / level gate / generic lock */}
      {locked ? (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-orange-400">
          <span aria-hidden>🔒</span>
          <span className="min-w-0">{lockReasonText(quest)}</span>
        </p>
      ) : null}

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
        <RewardChips reward={quest.reward} />
        {quest.minLevel > 0 ? (
          <Badge variant="outline" className="border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-500">
            lv{quest.minLevel}+
          </Badge>
        ) : null}
      </div>
    </div>
  )
}

/** One achievement tile — unlocked (amber) or locked with live progress. */
function AchievementCard({ achievement }: { achievement: AchievementView }) {
  return (
    <div
      className={`rounded border px-2.5 py-2 ${
        achievement.unlocked
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-zinc-800 bg-zinc-950/60'
      }`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-semibold text-zinc-200">{achievement.title}</span>
        {achievement.unlocked ? (
          <Badge className="shrink-0 border border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-300">
            UNLOCKED
            {achievement.unlockedAt ? (
              <span className="ml-1 font-normal text-amber-300/80">
                · {achievement.unlockedAt.slice(0, 10)}
              </span>
            ) : null}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="shrink-0 border-zinc-700 px-1.5 py-0 text-[9px] text-zinc-500"
          >
            {achievement.category}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-zinc-500 [overflow-wrap:anywhere]">
        {achievement.description}
      </p>
      {achievement.progress ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10px] text-zinc-400">
            {achievement.progress.current} / {achievement.progress.target}
          </span>
          <Progress
            value={progressPct(achievement.progress.current, achievement.progress.target)}
            aria-label={`${achievement.title} progress ${achievement.progress.current} of ${achievement.progress.target}`}
            className="h-1 bg-zinc-800"
          />
        </div>
      ) : null}
      <div className="mt-1.5">
        <RewardChips reward={achievement.reward} />
      </div>
    </div>
  )
}

/**
 * Full-width console card. Owns its queries (enabled only while a session
 * exists) so page.tsx stays additive; anonymous users get the standard
 * sign-in prompt, exactly like the City/Army/Battle sections.
 */
export function QuestsSection({ signedIn }: { signedIn: boolean }) {
  const {
    data: board,
    error: boardError,
    isPending: boardPending,
  } = useQuests({
    enabled: signedIn,
  })
  const { data: achievementBoard } = useAchievements({ enabled: signedIn })
  const claim = useClaimQuest()
  const { toast } = useToast()

  // Tab request survives data refetches; falls back to the first available
  // tab when the requested group disappears (e.g. cycles roll over).
  const [requestedTab, setRequestedTab] = useState<QuestsTab>('DAILY')

  const questGroups = useMemo(() => groupBoardQuests(board?.quests ?? []), [board])
  const achievements = achievementBoard?.achievements ?? []
  const availableTabs: QuestsTab[] = [
    ...questGroups.map((group) => group.tab),
    ...(achievements.length > 0 ? (['ACHIEVEMENTS'] as const) : []),
  ]
  const activeTab: QuestsTab | null = availableTabs.includes(requestedTab)
    ? requestedTab
    : (availableTabs[0] ?? null)

  function handleClaim(entry: QuestBoardEntry) {
    claim.mutate(entry.id, {
      onSuccess: (result) => {
        toast({
          title: `Quest claimed — ${result.title}`,
          description: `${rewardSummary(result.reward)} · wallet updated`,
        })
      },
      onError: (error) => {
        toast({
          title: 'Claim failed',
          description: claimErrorText(error as Error & { code?: string }),
          variant: 'destructive',
        })
      },
    })
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 md:col-span-2">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base font-bold text-zinc-100">
          Quests &amp; Achievements
          <span
            className={`inline-flex items-center gap-2 text-xs font-semibold ${
              board
                ? board.counts.claimable > 0
                  ? 'text-amber-400'
                  : 'text-emerald-400'
                : 'text-zinc-500'
            }`}
            aria-live="polite"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                board
                  ? board.counts.claimable > 0
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-emerald-400'
                  : 'bg-zinc-600'
              }`}
            />
            {board
              ? board.counts.claimable > 0
                ? `${board.counts.claimable} CLAIMABLE`
                : `${board.counts.active} ACTIVE`
              : signedIn
                ? 'NO QUEST BOARD'
                : 'SIGN IN TO VIEW'}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 font-mono text-xs text-zinc-400">
        {board ? (
          <>
            {/* Counts strip — live from the server board projection */}
            <p className="font-mono text-xs text-zinc-400">
              <span className="text-amber-400">{board.counts.active}</span> active ·{' '}
              <span className="text-amber-400">{board.counts.claimable}</span> claimable ·{' '}
              <span className="text-zinc-200">{board.counts.claimed}</span> claimed
            </p>
            <Separator className="bg-zinc-800" />

            {availableTabs.length === 0 ? (
              <p className="leading-relaxed text-zinc-500">
                Quest board is empty — assignments appear as soon as the server catalog has an
                active quest for your cycle.
              </p>
            ) : (
              <Tabs
                value={activeTab ?? ''}
                onValueChange={(value) => setRequestedTab(value as QuestsTab)}
              >
                <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-1">
                  {questGroups.map((group) => (
                    <TabsTrigger
                      key={group.tab}
                      value={group.tab}
                      className="flex-none border border-transparent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 data-[state=active]:border-amber-500/40 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300"
                    >
                      {group.label}
                    </TabsTrigger>
                  ))}
                  {achievements.length > 0 ? (
                    <TabsTrigger
                      value="ACHIEVEMENTS"
                      className="flex-none border border-transparent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 data-[state=active]:border-amber-500/40 data-[state=active]:bg-amber-500/15 data-[state=active]:text-amber-300"
                    >
                      ACHIEVEMENTS
                    </TabsTrigger>
                  ) : null}
                </TabsList>

                {questGroups.map((group) => (
                  <TabsContent key={group.tab} value={group.tab} className="mt-1 space-y-1.5">
                    {group.quests.map((quest) => (
                      <QuestCard
                        key={quest.id}
                        quest={quest}
                        claimDisabled={claim.isPending}
                        onClaim={handleClaim}
                      />
                    ))}
                  </TabsContent>
                ))}
                {achievements.length > 0 ? (
                  <TabsContent value="ACHIEVEMENTS" className="mt-1">
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {achievements.map((achievement) => (
                        <AchievementCard key={achievement.id} achievement={achievement} />
                      ))}
                    </div>
                  </TabsContent>
                ) : null}
              </Tabs>
            )}

            <Separator className="bg-zinc-800" />
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Server-authoritative quests: progress arrives exclusively via server-side domain
              events (battles won, units trained, upgrades, ledger credits) inside game transactions
              — the client has no write path. Claiming is a guarded exactly-once status transition;
              the reward is paid through the ledger (
              <span className="text-amber-400">QUEST_REWARD</span>) in the same transaction.
              DAILY/WEEKLY instances reset by UTC cycle; unclaimed SEASONAL rewards expire at
              settlement.
            </p>
          </>
        ) : boardPending && signedIn ? (
          <p className="animate-pulse text-zinc-500">probing /api/v1/quests …</p>
        ) : boardError ? (
          <p className="text-red-400" role="alert">
            {(boardError as Error & { code?: string }).code ?? 'ERROR'}: {boardError.message}
          </p>
        ) : (
          <p className="leading-relaxed text-zinc-500">
            {signedIn
              ? 'Signed in but no quest board available — assignments are created on read, reload to retry.'
              : 'Anonymous — sign in to view your quest board, claim completed quests and track achievements.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
