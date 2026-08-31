/**
 * WARLORDS — API index. Lists the live endpoint surface so clients and
 * operators can discover what exists without reading source code.
 */

import { defineRoute } from '@/lib/api/route-handler'
import { ok } from '@/lib/api/response'
import { APP_NAME, APP_VERSION } from '@/config/app'

export const GET = defineRoute({}, async ({ request }) => {
  return ok(request, {
    service: APP_NAME.toLowerCase(),
    version: APP_VERSION,
    endpoints: {
      health: '/api/health',
      'auth:telegram-login': 'POST /api/v1/auth/telegram',
      'auth:me': 'GET /api/v1/auth/me',
      'auth:logout': 'POST /api/v1/auth/logout',
      'auth:dev-impersonate': 'POST /api/v1/auth/dev-impersonate (non-production only)',
      'player:profile': 'GET /api/v1/player/profile',
      'player:statistics': 'GET /api/v1/player/statistics',
      'player:state': 'GET /api/v1/player/state',
      'player:resources': 'GET /api/v1/player/resources',
      'player:transactions': 'GET /api/v1/player/transactions?limit&cursor&reason (ledger history)',
      'city:state': 'GET /api/v1/city (buildings · production · storage · construction queue)',
      'city:building-catalog':
        'GET /api/v1/city/buildings (per-level costs · durations · requirements · effects)',
      'city:upgrade':
        'POST /api/v1/city/buildings/:type/upgrade (server-side cost + construction timer)',
      'city:finish': 'POST /api/v1/city/buildings/:type/finish (claim completed construction)',
      'army:state': 'GET /api/v1/army (roster · stacks · upkeep totals · live training queue)',
      'army:unit-catalog':
        'GET /api/v1/army/catalog (per-unit stats · costs · timers · counters · building gates)',
      'army:train': 'POST /api/v1/army/train {unitId, count} (server-side cost + FIFO queue)',
      'army:train-complete': 'POST /api/v1/army/train/:id/complete (claim finished batch)',
      'army:train-cancel': 'POST /api/v1/army/train/:id/cancel (policy refund + queue re-walk)',
      'player:notifications':
        'GET /api/v1/player/notifications?limit&unreadOnly (engine-delivered inbox)',
      'player:notifications-unread': 'GET /api/v1/player/notifications/unread-count',
      'player:notifications-read':
        'POST /api/v1/player/notifications/read {ids?|all} (own rows only)',
      'season:status': 'GET /api/v1/season (season lifecycle · rules · my standing)',
      'season:ranking':
        'GET /api/v1/season/ranking?limit&seasonId (live server-computed ranking · settled history)',
      'season:rewards': 'GET /api/v1/season/rewards (pending + claimed season payouts)',
      'season:rewards-claim': 'POST /api/v1/season/rewards/claim {seasonId} (idempotent payout)',
      'season:progression':
        'GET /api/v1/season/progression (permanent titles · cosmetics · achievements · commanders)',
      'season:title-equip':
        'POST /api/v1/season/progression/title {titleId|null} (owned titles only)',
      'admin:me': 'GET /api/v1/admin/me (staff introspection — role + scopes)',
      'admin:players':
        'GET /api/v1/admin/players?q&page&pageSize (search — staff scope players.search)',
      'admin:player-details': 'GET /api/v1/admin/players/:id (full inspection — players.view)',
      'admin:ban': 'POST /api/v1/admin/players/:id/ban {reason, expiresAt?} (players.ban)',
      'admin:unban': 'POST /api/v1/admin/players/:id/unban {note?} (players.unban)',
      'admin:adjust-resources':
        'POST /api/v1/admin/players/:id/resources {resource, delta, note} (ADMIN — ledger path, audited)',
      'admin:battles':
        'GET /api/v1/admin/battles?playerId&type&page (battle inspection — battles.view)',
      'admin:battle-detail':
        'GET /api/v1/admin/battles/:id (rounds trace + reports — battles.view)',
      'admin:economy':
        'GET /api/v1/admin/economy (supply · ledger flow · adjustments — economy.view)',
      'admin:events':
        'GET /api/v1/admin/events?status&page · POST {type,…,endsAt} (ADMIN for POST — events.manage)',
      'admin:event-finish': 'POST /api/v1/admin/events/:id/finish (ADMIN — events.manage)',
      'admin:event-cancel': 'POST /api/v1/admin/events/:id/cancel (ADMIN — events.manage)',
      'admin:clans': 'GET /api/v1/admin/clans?q&page (clan inspection — clans.view)',
      'admin:clan-detail': 'GET /api/v1/admin/clans/:id (roster — clans.view)',
      'admin:clan-disband':
        'POST /api/v1/admin/clans/:id/disband {confirm:"DISBAND", reason} (ADMIN — clans.manage)',
      'admin:announcements':
        'GET /api/v1/admin/announcements?page · POST {title, body, audience?, clanId?} (announcements.create)',
      'admin:announcement-active':
        'POST /api/v1/admin/announcements/:id/active {isActive} (ADMIN — announcements.manage)',
      'admin:announcement-broadcast':
        'POST /api/v1/admin/announcements/:id/broadcast (ADMIN — notification fan-out, audited)',
      'admin:audit-logs':
        'GET /api/v1/admin/audit-logs?action&targetType&actorUserId&page (audit viewer — audit.view)',
      'admin:staff': 'GET /api/v1/admin/staff · POST {telegramId, role} (ADMIN — staff.manage)',
      'admin:staff-deactivate': 'POST /api/v1/admin/staff/:id/deactivate (ADMIN — staff.manage)',
      'admin:season-settle-simulate':
        'POST /api/v1/admin/season/settle/simulate (DRY-RUN reset report — admin only)',
      'admin:season-settle-execute':
        'POST /api/v1/admin/season/settle/execute {seasonNumber} (transactional reset — admin only)',
      'admin:notifications-queue':
        'GET /api/v1/admin/notifications/queue?status&type (outbox ops view — notifications.drain)',
      'admin:notifications-tick':
        'POST /api/v1/admin/notifications/worker/tick (synchronous drain — notifications.drain)',
    },
    envelope: {
      success: '{ ok: true, data, meta: { requestId, serverTime } }',
      failure: '{ ok: false, error: { code, message, details? }, meta }',
    },
  })
})
