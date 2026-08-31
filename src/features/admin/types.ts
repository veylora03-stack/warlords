/**
 * WARLORDS — Admin feature types (DTO mirrors of the /api/v1/admin surface).
 */

export interface AdminContext {
  isStaff: boolean
  adminRole?: string
  scopes?: string[]
}

export interface PagedMeta {
  page: number
  pageSize: number
  total: number
  pages: number
}

export interface AdminPlayerSummary {
  id: string
  name: string
  level: number
  power: string
  seasonPoints: number
  clanId: string | null
  clanName: string | null
  createdAt: string
  user: { userId: string; telegramId: string; username: string | null; isBanned: boolean }
}

export interface AdminPlayerSearch {
  query: string | null
  rows: AdminPlayerSummary[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export interface AdminPlayerDetails {
  id: string
  name: string
  level: number
  xp: string
  power: string
  honor: string
  reputation: string
  gems: string
  energy: number
  seasonPoints: number
  clan: { id: string; name: string; role: string | null } | null
  title: { id: string; name: string } | null
  createdAt: string
  user: {
    userId: string
    telegramId: string
    username: string | null
    role: string
    isBanned: boolean
    banReason: string | null
    bannedAt: string | null
    banExpiresAt: string | null
    lastLoginAt: string | null
  }
  wallet: Record<string, string>
  city: {
    id: string
    name: string
    x: number
    y: number
    buildings: number
    townHallLevel: number | null
  } | null
  army: { unitCount: number; topTier: number | null }
  ledgerTail: Array<{
    id: string
    resource: string
    delta: string
    balanceAfter: string
    reason: string
    createdAt: string
  }>
  battlesTail: Array<{
    id: string
    type: string
    result: string
    attackerPlayerId: string
    defenderPlayerId: string | null
    startedAt: string
  }>
}

export interface AdminBanResult {
  playerId: string
  userId: string
  isBanned: true
  banReason: string
  bannedAt: string
  banExpiresAt: string | null
}

export interface AdminUnbanResult {
  playerId: string
  userId: string
  isBanned: false
}

export interface AdminAdjustResult {
  applied: Array<{ resource: string; delta: string; balanceAfter: string }>
  balances: Record<string, string>
}

export interface AdminBattleRow {
  id: string
  type: string
  result: string
  attacker: { playerId: string; name: string | null }
  defender: { playerId: string; name: string | null } | null
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: unknown
  honorDelta: number
  seed: number
  configVersion: number
  startedAt: string
  endedAt: string | null
}

export interface AdminBattleList extends PagedMeta {
  rows: AdminBattleRow[]
}

export interface AdminBattleDetail extends AdminBattleRow {
  rounds: Array<{
    roundNumber: number
    side: string
    unitsCommitted: unknown
    unitsLost: unknown
    damageDealt: string
    events: unknown
  }>
  logs: Array<{ id: string; playerId: string; role: string; content: unknown }>
}

export interface AdminEconomyOverview {
  generatedAt: string
  flowWindowDays: number
  supply: Record<string, string>
  playerCount: number
  walletsCount: number
  ledger: { totalRows: number; rowsInWindow: number }
  flowByReason: Array<{
    reason: string
    resource: string
    count: number
    net: string
    minted: string
    burned: string
  }>
  recentAdjustments: Array<{
    id: string
    actorUserId: string
    targetId: string | null
    reason: string | null
    after: unknown
    createdAt: string
  }>
}

export interface AdminEventRow {
  id: string
  type: string
  title: string | null
  body: string | null
  scope: string
  targetPlayerId: string | null
  targetPlayerName: string | null
  startsAt: string
  endsAt: string
  status: string
  createdById: string | null
  config: unknown
  createdAt: string
}

export interface AdminEventList extends PagedMeta {
  rows: AdminEventRow[]
}

export interface AdminClanRow {
  id: string
  name: string
  tag: string
  leaderPlayerId: string
  leaderName: string | null
  level: number
  memberCount: number
  trophies: number
  createdAt: string
}

export interface AdminClanList extends PagedMeta {
  rows: AdminClanRow[]
}

export interface AdminClanDetail extends AdminClanRow {
  description: string | null
  settings: unknown
  treasury: unknown
  members: Array<{
    playerId: string
    name: string
    role: string
    contribution: number
    joinedAt: string
  }>
}

export interface AdminDisbandResult {
  clanId: string
  name: string
  membersRemoved: number
}

export interface AdminAnnouncementRow {
  id: string
  title: string
  body: string
  audience: string
  clanId: string | null
  isActive: boolean
  createdById: string
  createdByName: string | null
  publishedAt: string
}

export interface AdminAnnouncementList extends PagedMeta {
  rows: AdminAnnouncementRow[]
}

export interface AdminBroadcastResult {
  announcementId: string
  notifiedPlayers: number
}

export interface AdminAuditRow {
  id: string
  action: string
  targetType: string
  targetId: string | null
  reason: string | null
  before: unknown
  after: unknown
  createdAt: string
  actor: { userId: string; name: string | null; telegramId: string }
}

export interface AdminAuditList extends PagedMeta {
  rows: AdminAuditRow[]
}

export interface AdminStaffRow {
  adminUserId: string
  userId: string
  telegramId: string
  username: string | null
  userRole: string
  role: string
  isActive: boolean
  lastActionAt: string | null
  createdAt: string
}

export interface AdminGrantResult {
  adminUserId: string
  userId: string
  telegramId: string
  role: string
  isActive: true
}

export interface AdminDeactivateResult {
  adminUserId: string
  userId: string
  isActive: false
}
