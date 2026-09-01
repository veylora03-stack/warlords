# WARLORDS Worklog

---
Task ID: 1-2
Agent: Z.ai Code (main)
Task: PHASE 31 — Quest + Achievement Engine: INSPECT + DESIGN

Work Log:
- Git verified: latest commit d21b557 (Phase 28 Battle Engine, 643 tests), main branch, no tags, no stash, clean tree except .zscripts/dev.pid
- CLAIMED Phase 29/30 baseline (740/740, commit a2202c9, v0.19.0-phase30) DOES NOT EXIST in this repository
  - health endpoint reports version 0.17.0-phase28, phase:28
  - package.json version 0.2.0
  - No territory engine, no world service, no /api/v1/world routes, db.territory never referenced
- Environment rebuild: prisma client regenerated, SQLite pushed+seeded, dev .env written (integration tests need TELEGRAM_BOT_TOKEN/JWT_SECRET/ADMIN_TELEGRAM_IDS)
- Baseline verified by execution: unit 321 pass, integration 283 pass, E2E 39 pass = 643/643 GREEN (matches Phase 28 commit message exactly)
- Inspected: prisma/schema.prisma (53 models), battle.service.ts attack() one-tx pipeline, economy.service.ts grant/spend + idempotency claim pattern, notification.service.ts enqueue/dedupe, season.service.ts resolveSeasonStateInTx, city/army services, progression.service grantXp CAS, stats.service recordPlayerStats (append-only JSON counters), admin RBAC+audit, route-handler conventions, test conventions
- Quest/Achievement STATUS: schema models + seed catalogs exist since Phase 2 contract (Quest/PlayerQuest/Achievement/PlayerAchievement), engine + APIs absent; notification QUEST_COMPLETED + REWARD types + dedupe keys pre-designed; LEDGER_REASONS has QUEST_REWARD; stats catalog has questsCompleted

Stage Summary:
- BASELINE TRUTH: 643/643 (Phase 28), NOT 740/740. Phase 31 proceeds on the REAL baseline.
- TERRITORY EVENTS (TERRITORY_CAPTURED/DEFENDED/LOST, BATTLE_ON_TERRITORY) DO NOT EXIST — no fake events; territory quests (CONQUEROR/LAND LORD/DEFENDER) deferred, documented
- DESIGN (event-driven, server-authoritative):
  - Typed quest events applied INSIDE owning service tx: BATTLE_FINISHED, BUILDING_UPGRADED, UNITS_TRAINED, RESOURCES_EARNED (ledger credit path; ADMIN_ADJUSTMENT excluded), RESOURCES_SPENT, POWER_REACHED (SET), LEVEL_REACHED (SET)
  - Pure engine: src/lib/game/engine/quest/progress.ts (objective match + delta/SET modes + completion); orchestrator: quest.service.ts (assignment w/ eligibility+prereqs, applyQuestEventInTx, claim); achievement.service.ts (evaluate vs stats/level/power, DB-unique exactly-once unlock, auto reward)
  - Claim model: objective reached → COMPLETED (notification) → player claims → guarded status transition (updateMany where status=COMPLETED = DB exactly-once backstop) → grantResources(QUEST_REWARD) + grantXp + honor — one tx, rollback-safe
  - Reset: DAILY cycle=UTC date, WEEKLY cycle=ISO week, SEASONAL cycle=season number + expiresAt=season.endsAt, MAIN permanent. Lazy expiry + assign-on-read (createMany skipDuplicates, unique-guarded)
  - Schema additions (additive only): Quest.minLevel Int @default(0), Quest @@index([isActive]); PlayerQuest.cycle String @default("0"), PlayerQuest.lastEventKey String?, @@unique([playerId, questId, cycle]); Achievement.metric String + Achievement.meta Json?
  - REWARD_KEYS += HONOR; LEDGER_REASONS += ACHIEVEMENT_REWARD; NOTIFICATION_TYPES += ACHIEVEMENT_UNLOCKED
  - Stats backfilled at hook points: unitsTrained, buildingsConstructed, resourcesCollected, resourcesSpent, questsCompleted
  - APIs: GET /api/v1/quests (?filter=), GET /api/v1/quests/[id], POST /api/v1/quests/[id]/claim; admin: toggle/reset (RBAC ADMIN + audit)
  - New catalog quests: q-first-battle→q-warlord chain appended to MAIN; WEEKLY builder/recruiter/resource-tycoon; DAILY recruitment+win2; achievements: centurion (100 battles), grand-marshal (1000 units)

---
Task ID: 8
Agent: frontend-styling-expert
Task: Quest + Achievements Mini App UI

Work Log:
- Read worklog + studied page.tsx structure (stacked full-width `md:col-span-2` Cards, auth gate via useMeQuery → `signedIn`, queries `{ enabled: signedIn }`, anonymous prompt text pattern, sticky footer via min-h-screen flex flex-col + mt-auto — preserved)
- Studied feature conventions (city.ts/battle.ts/economy.ts): queryKeys consts, 401→null fetch wrapper, typed mutation errors via Object.assign(code/details), invalidate-surfaces helper; economy wallet key is `economyKeys.resources` (no `wallet` key exists)
- Verified REAL API contracts against src/app/api/v1/quests/* routes + quest.service/achievement.service read models (QuestBoardEntry, QuestInstanceView, counts, QuestClaimResult{reward:Record<string,number>, wallet:Record<string,string>}, AchievementView) — UI types mirror them exactly
- Created src/features/quests/types.ts — DTO mirrors (QuestType/QuestStatus/QuestFilter/QuestBoardEntry/QuestBoardView/QuestClaimResult/AchievementView/AchievementBoardView), zero `any`
- Created src/features/quests/api/quests.ts — `questsKeys` (board(filter) + achievements), `useQuests({enabled,filter='all'})`, `useAchievements({enabled})`, `useClaimQuest()` → POST /api/v1/quests/[id]/claim, onSuccess invalidates ['quests'] prefix (board+achievements, all filters), economyKeys.resources (wallet), economyKeys.transactions(8), ['player'] prefix
- Created src/features/quests/components/quests-section.tsx — self-contained console Card (md:col-span-2, zinc/amber language, `text-[11px] uppercase tracking-wider` labels): counts strip `X active · Y claimable · Z claimed`; shadcn Tabs DAILY·WEEKLY·MAIN·ACHIEVEMENTS rendered ONLY for types present (SEASONAL joins Weekly, tagged SEASONAL); per-status card treatment — ACTIVE: server progress `X / Y` + Progress bar + disabled claim (IN PROGRESS / `p/t`), COMPLETED: amber `[ CLAIM ]` → mutation + success toast (`+200 GOLD · +100 XP …`) + typed failure toasts (ALREADY_CLAIMED→"Already claimed", NOT_COMPLETED, EXPIRED, NOT_FOUND), CLAIMED: `CLAIMED ✓` badge, EXPIRED: dimmed + badge, no-instance+ineligible: dimmed lock card (PREREQUISITES→"Complete the previous quest to unlock" w/ chain hint, MIN_LEVEL→"Reach level N", else "Locked"); reward chips wrap; achievements grid (sm:2-col) with UNLOCKED badge + unlock date or live progress bar; empty states real (no mocks anywhere); anonymous = standard sign-in prompt; 390px-safe (flex-wrap, min-w-0 truncate, [overflow-wrap:anywhere])
- Created src/features/quests/index.ts barrel (types + api + component, notifications-style)
- Integrated into src/app/page.tsx ADDITIVELY: one import + `<QuestsSection signedIn={signedIn} />` between Battle Engine and Architecture cards; no existing section restructured; footer untouched
- Gates: bun run lint ✓ (also removed 2 unused-decl lint errors left in backend quest.service.ts: unused `Tx` import + unused `QuestCatalogRow` interface — dead code only, zero behavior change), tsc --noEmit ✓, prettier --write on new files ✓
- Runtime verification: GET / 200, SSR HTML contains the section + anonymous prompt; GET /api/v1/quests anon → 401 handled as null → prompt; dev.log last 100 lines show NO runtime errors from the quests UI
- ENV FINDING (pre-existing, backend-side, NOT a UI bug): the RUNNING dev server predates the 13:23 Prisma client regeneration → its in-memory client lacks PlayerQuest.cycle → dev-impersonate/bootstrap and signed-in quest flows 500 with `Unknown field 'cycle'` until the dev server is restarted. Verified disk state is already correct: prisma/schema.prisma has cycle, node_modules/.prisma regenerated, db/custom.db pushed (player_quests.cycle present, 11 quests seeded). Did NOT restart the server per task constraints.

Stage Summary:
- Artifacts: src/features/quests/{types.ts, api/quests.ts, components/quests-section.tsx, index.ts}; src/app/page.tsx (+2 lines: import + section render); quest.service.ts (lint dead-code removal only)
- Hooks surface: questsKeys.board(filter)/questsKeys.achievements · useQuests · useAchievements · useClaimQuest (invalidates quests+achievements+wallet+ledger+profile on success)
- lint ✓ · tsc ✓ · prettier ✓ · page compiles + renders (200), anonymous path verified live; signed-in board/claim path is code-complete and type-exact vs the service DTOs but blocked end-to-end by the stale dev-server Prisma client — NEXT ACTION for owner: restart dev server (`bun run dev`), then GET /api/v1/quests with a dev-impersonate session will succeed and the section renders live counts/tabs/claim flow immediately

---
Task ID: 3-12
Agent: Z.ai Code (main)
Task: PHASE 31 — Quest + Achievement Engine: IMPLEMENT → TEST → EXPLOIT → LOAD → E2E → REGRESSION → DOCUMENT

Work Log:
- Schema (additive, both dev + postgres twins, migrations committed): Quest.minLevel + @@index([isActive]); PlayerQuest.cycle + lastEventKey + @@unique([playerId, questId, cycle]); Achievement.metric + meta
- Types/configs: QUEST_TYPES += SEASONAL; NOTIFICATION_TYPES += ACHIEVEMENT_UNLOCKED (payload/template/channel/dedupe); REWARD_KEYS += HONOR; LEDGER_REASONS += ACHIEVEMENT_REWARD; admin scopes quests.view/manage + audit targets quest/player_quest; error codes QUEST_NOT_COMPLETED/ALREADY_CLAIMED/EXPIRED/REWARD_INVALID
- Engine: pure layer engine/quest/progress.ts (matching, INCREMENT/SET contributions, clamps, UTC cycles incl. ISO weeks, splitReward fail-closed); quest-events.service (assignment sweep, applyQuestEventInTx, lastEventKey dedupe, ledger hook); quest.service (board/detail/claim guarded transition/admin ops audited); achievement.service (metric evaluation, DB-unique unlock, auto ledger reward)
- Extraction: season-state.service leaf (season state machine) to avoid import cycles; season.service re-exports unchanged
- Wiring (all in-tx): battle (BATTLE_FINISHED ×2 + achievement eval), city (BUILDING_UPGRADED + buildingsConstructed + eval), army (UNITS_TRAINED + unitsTrained + eval), power (POWER_REACHED), progression (LEVEL_REACHED), economy applyResourceDeltas = THE single ledger-activity choke point (stats + EARN/SPEND events; BOOTSTRAP + ADMIN_ADJUSTMENT excluded by documented policy)
- APIs: GET /quests (+filter), GET /quests/[id], POST /quests/[id]/claim, GET /quests/achievements; admin toggle/reset/grant/revoke (RBAC + audit)
- Mini App (subagent Task 8): features/quests feature module + page.tsx section; dev server restart required for regenerated Prisma client (done); browser-verified end-to-end
- Fix during load testing: splitReward flags unknown keys REGARDLESS of value (fail-closed gap caught by unit test); ledger hook centralized in economy after initial caller-side hooks proved testable-wrong
- Tests: 22 unit + 22 integration (assignment/battle/economy/building/army/claim/exactly-once 10-way concurrency/replay/security matrix/reset boundaries incl. seasonal + admin RBAC/audit) + 10 E2E journey (LOGIN→QUESTS→REAL BATTLE→PROGRESS→COMPLETE→CLAIM→LEDGER→NOTIFICATION→HISTORY→ACHIEVEMENT) + 5 load (100/1k/10k events flat ~3.5ms/event, redelivery no-op, board 29ms)
- REGRESSION FINAL: unit 343 ✓ · integration 310 ✓ · E2E 49 ✓ = 702/702 GREEN (baseline 643 preserved + 59 new; 3 contract tests updated to the Phase 31 invariants, none removed/weakened)
- typecheck ✓ · lint ✓ · prettier ✓ · all routes compile in dev server; production build NOT run (sandbox forbids bun run build — documented, compensating controls listed)
- Browser verification (agent-browser): board renders real data → server-driven completion → CLAIM click → toast "+8 GEMS · +60 XP" → CLAIMED ✓ + counts update; Achievements tab real unlock + progress; NO console errors; NO horizontal overflow at 390/768/1280px

Stage Summary:
- 702/702 tests green; quest engine is event-driven, server-authoritative, claim-based, exactly-once under concurrency, ledger-integrated, season-aware, admin-audited
- HONEST SCOPE: territory quests (CONQUEROR/LAND LORD/DEFENDER) NOT seeded — the claimed "Phase 30" World/Territory engine does not exist in this repository (verified via git + health endpoint phase:28 + db.territory unused); extension points ready (reserved objective types + typed event union)
