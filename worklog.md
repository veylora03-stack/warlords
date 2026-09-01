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

---
Task ID: 1
Agent: Z.ai Code (main)
Task: PHASE 32 — World Map + Territory Engine: INSPECT + DESIGN (Path C approved)

Work Log:
- Provenance audit confirmed: Phase 29/30 never existed here; baseline 702/702 at 553f071 (user approved Path C — implement World/Territory from this repository)
- Inspected: prisma/schema.prisma (Territory contract model w/ @@unique(x,y), cityId @unique, Battle.territoryId, TERRITORY_ASSAULT type literal), battle.service.ts one-tx pipeline (idempotency claim, energy CAS, cooldown, BATTLE_ENGINE_LOCK→db:write lock order), simulator.ts (PURE, context.terrain→terrainAttackBps), config/battle.ts (terrainAttackBps ext point, version snapshot), economy.service (grantResources/spendResources/runEconomyTransaction, CAS credits, cap-clamped ledger), quest-events.service (applyQuestEventInTx, lastEventKey dedupe, EARNED_LEDGER_REASONS), engine/quest/progress.ts (event union, reserved CAPTURE_/CONTROL_/DEFEND_TERRITORIES objectives currently inert), config/quests+achievements (deferred territory entries documented), notification.service (enqueue + fan-out + dedupe), season-settlement.service (TERRITORY_OWNERSHIP wipe EXISTS — must become capital-aware), player-registration/bootstrap (findFreeCityCoordinate spiral; bootstrap creates city at coords), stats.service (catalog-validated append-only counters), admin RBAC scopes+audit, route-handler defineRoute conventions, integration test conventions (real initData auth, route handlers invoked directly)
- Key integration findings: season settlement already strips ALL territory ownership (must exclude capitals + write history rows); city coords and territory coords share the unique (x,y) plane — capital claims the cell; battle cooldown checks PVP_ATTACK only (extend to shared regroup incl. TERRITORY_ASSAULT)

Stage Summary:
- DESIGN (server-authoritative, deterministic, reuses every existing engine):
  - WORLD 41×41 (x,y ∈ 0..40), seed 20260901, REGION_SIZE 7 → 6×6=36 persistent regions (name pools data-driven); each cell = one Territory (1681) with terrain/status/owner/resource/production
  - TERRAIN: PLAINS/FOREST/MOUNTAINS/DESERT/SWAMP/HILLS/RIVER/COAST/CITY — config/world.ts: attackBps (attacker, via existing terrainAttackBps + version bump 2), defenseBps (defender via BattleSide.modifiers), productionMultiplierBps, weight, color; simulator untouched
  - Schema additive: Territory += regionId/name/terrain/status/ownerType/isCapital/resourceType/productionRate/productionCollectedAt/captureCount; NEW Region (world_regions) + TerritoryHistory (append-only, CAPTURE|SEASON_RESET|ADMIN|SPAWN|WORLD_INIT); indexes: territory(regionId),(status),(x,y via existing unique); history(territoryId,createdAt),(seasonNumber)
  - States: UNCLAIMED|CONTROLLED|LOCKED only; capitals protected by SERVER RULES (isCapital), not a persisted PROTECTED state
  - Spawn: registration finds free cell avoiding LOCKED/capital cells; bootstrapPlayer claims capital (conditional update of the generated cell or create); capital: type PLAYER_CITY, terrain CITY, cityId anchor, cannot be attacked/captured, survives seasons
  - Attack pipeline (world.service attackTerritory): idempotency claim (TERRITORY_ASSAULT action) → season gate → territory validation (exists/not LOCKED/not capital/not own) → 4-dir adjacency to ANY owned territory (derived from coords, never stored) → shared attack cooldown (PVP_ATTACK+TERRITORY_ASSAULT) → energy CAS → attacker real army; defender = real owner army+terrain-defense OR deterministic virtual garrison from (worldSeed,x,y)+unit catalog (NOT persisted, documented); existing simulateBattle {type TERRITORY_ASSAULT, terrain} → one tx: battle+rounds+casualties(CAS)+spoils via ledger TERRITORY_CAPTURE+honor/XP/season points+stats+power+quest events+achievements+logs+notifications+idempotency; capture ONLY on ATTACKER_WIN via conditional updateMany + TerritoryHistory(CAPTURE)
  - Quest events: TERRITORY_CAPTURED {territoryId, regionId, ownedCount, battleId} (feeds CAPTURE_TERRITORIES INCREMENT + CONTROL_TERRITORIES SET ownedCount), TERRITORY_DEFENDED, TERRITORY_LOST; BATTLE_FINISHED also fires (territory assault is a battle); seeds: main-06-first-territory, seasonal conqueror(3)/land-lord(hold 5 SET)/defender(5); achievements: ach-first-territory(1), ach-conqueror(10), ach-defender(5) via STAT metrics territoriesCaptured/territoriesDefended (+territoriesLost stat)
  - Economy: LEDGER_REASONS += TERRITORY_CAPTURE, TERRITORY_PRODUCTION; both in EARNED_LEDGER_REASONS; lazy production on collect: min interval, cap hours, terrain multiplier, owner-only, Σledger==balance
  - Season: settlement strips non-capital ownership (+history SEASON_RESET rows), capitals survive; achievements permanent
  - APIs: GET /world/map (viewport bounds, area cap, server-picked default around capital), GET /world/territories/[id] (+server-computed attackability reasons), POST /world/territories/[id]/attack, GET /world/territories/[id]/history (public world record — no private data), GET /world/player-territories, POST /world/territories/[id]/collect; admin inspect/lock/ownership (world.view/world.manage scopes + audit)
  - Notifications: reuse ATTACK_RESULT (no second system); quests/achievements reuse QUEST_COMPLETED/ACHIEVEMENT_UNLOCKED
  - New error codes: TERRITORY_CAPITAL_PROTECTED 403, TERRITORY_NOT_ADJACENT 400, TERRITORY_LOCKED 409, TERRITORY_OWNED 400, TERRITORY_NOT_COLLECTIBLE 409, REGION_NOT_FOUND 404

---
Task ID: 8
Agent: frontend-styling-expert
Task: PHASE 32 — World Map + Territory Mini App UI

Work Log:
- Read worklog + studied the Phase 31 reference implementation (quests feature: query keys, 401→null fetch wrapper, typed mutation errors via Object.assign(code/details), invalidate-surfaces helper, useMeQuery auth gate `{ enabled: signedIn }`) and page.tsx conventions (stacked md:col-span-2 Cards, sticky footer preserved, anonymous prompt text pattern)
- Verified REAL API contracts against src/lib/game/services/world.service.ts read models (TerritoryMapCell, WorldMapView, TerritoryDetailView, PlayerTerritoriesView, TerritoryHistoryView, TerritoryAttackResult, TerritoryCollectResult), config/world.ts TERRAIN color vocabulary (lime/emerald/zinc/amber/teal/yellow/sky/cyan/orange), route schemas (map query minX/maxX/minY/maxY, attack body idempotencyKey) — UI types mirror them exactly (TERRITORY_TYPES incl. MINE/FOREST/MOUNTAIN/BOSS_ZONE included per common.ts)
- Created src/features/world/types.ts — DTO mirrors, zero `any`; amounts cross as strings (BigInt policy), counters as numbers
- Created src/features/world/api/world.ts — `worldKeys` (map(bounds|null), detail(id), history(id,page), playerTerritories); `useWorldMap({enabled,bounds|null})` (null → server picks capital-centered viewport); lazy `useTerritoryDetail` / `useTerritoryHistory` (enabled only when a cell is selected / history expanded); `usePlayerTerritories`; `useAttackTerritory` (POST + client-generated idempotencyKey via crypto.randomUUID(); per-call key so retries replay the stored response; onSuccess invalidates ['world'] prefix (map+detail+history+holdings), ['quests'] (CAPTURE/CONTROL objectives), economyKeys.resources, ['player'] prefix); `useCollectProduction` (invalidates ['world'] + wallet)
- Created src/features/world/components/world-map-section.tsx — console Card (md:col-span-2, zinc/amber, text-[11px] uppercase tracking-wider labels): holdings line ('Capital at (x,y) · N territories · P pending production'); pan controls ←↑↓→ (44×44px, half-viewport strides, edge-clamped disabled states) + ⊙ recenter (returns to bounds=null → server-picked); viewport readout; region strip badges (regions intersecting viewport); MAP GRID: CSS grid `repeat(cols, minmax(0,1fr))` + aspect-square cells in a max-w-[320px] container (fits by sizing, NO overflow-x at any viewport — server default 8×9→15×15 and client-panned 13×13 both verified); STATIC terrain lookup record (9 families → bg-*/border-*/text-* + zinc fallback, zero dynamic class interpolation); ★ capitals, ✕ LOCKED (dimmed), amber border+ring for OWN cells (derived from player-territories ids — ownerType PLAYER alone is not "yours"), selected cell ring-2 amber; cells are buttons with aria-label 'territory x,y name' + aria-pressed; DETAIL PANEL (lazy useTerritoryDetail): name/type, coords, region, terrainLabel chip, status badge, owner ('Held by X' / 'Unclaimed — garrison strength N'), production rate, strategicValue, captureCount; ASSAULT: attackable → amber [ ASSAULT ] min-h-[44px], else disabled button + all server reasons mapped to human text (NOT_ADJACENT/CAPITAL_PROTECTED/OWNED_BY_YOU/LOCKED/ACTION_ON_COOLDOWN/INSUFFICIENT_ENERGY/ARMY_EMPTY/SEASON_NOT_ACTIVE); own producing cells: pendingAmount + [ COLLECT ] when production.collectible else 'Next collection' timestamp; ATTACK RESULT strip: outcome · CAPTURED/DEFENSE HELD · spoils · honor · season pts · casualty line-counts; success toast 'Victory — +100 GOLD · territory captured' (+casualties, +replay flag), typed failure toasts (11 attack error codes mapped); HISTORY: collapsible (useTerritoryHistory, pageSize 10) with reason/new-owner/date/season rows + prev/next pager; loading Skeletons, error+retry, real empty states — NO mock data; anonymous = standard sign-in prompt
- Created src/features/world/index.ts barrel
- Integrated into src/app/page.tsx ADDITIVELY: one import + `<WorldMapSection signedIn={signedIn} />` between QuestsSection and Architecture cards; no existing section restructured; footer untouched
- Gates: bun run lint ✓ (also removed 2 pre-existing unused-import lint errors left in tests/integration/world/world-system.test.ts — dead imports only, zero behavior change), npx tsc --noEmit ✓, prettier --write on new files ✓
- Runtime verification (browser + curl): GET / 200; SSR HTML contains 'World Map' + anonymous prompt, no error boundary; dev-impersonate session → live map (72 cells, 5 region badges), cell select → detail with server verdicts, REAL ASSAULT executed: toast 'Victory — +100 GOLD · territory captured · casualties attacker 1 / defender 2 · 5 rounds', panel refetched to CONTROLLED/Held-by-me/captured 4× with reasons OWNED_BY_YOU+ACTION_ON_COOLDOWN, result strip rendered, holdings line updated to 2 territories (invalidations confirmed), history shows new CAPTURE row + pager (12 records, 2 pages); pan east/south/recenter verified (0–7→4–11→recenter); NO browser console errors; NO horizontal overflow (scrollWidth==clientWidth) at 390/430/768/1280px; dev.log last 400 lines: all world routes 200, zero runtime errors from the UI

Stage Summary:
- Artifacts: src/features/world/{types.ts, api/world.ts, components/world-map-section.tsx, index.ts}; src/app/page.tsx (+2 lines: import + section render); world-system.test.ts (lint dead-import removal only)
- Hooks surface: worldKeys.map(bounds|null)/detail(id)/history(id,page)/playerTerritories · useWorldMap · useTerritoryDetail · useTerritoryHistory · usePlayerTerritories · useAttackTerritory (idempotencyKey per submission; invalidates world+quests+wallet+profile) · useCollectProduction (invalidates world+wallet)
- All spec branches type-exact vs server DTOs; collect-success and ARMY_EMPTY/SEASON_NOT_ACTIVE/INSUFFICIENT_ENERGY toasts are code-complete but not live-fireable with this dev player (no producing holdings; army present so only OWNED/cooldown/adjacency reasons observable) — verified via the disabled-button + reason-list rendering instead
- lint ✓ · tsc ✓ · prettier ✓ · page 200 · browser-verified end-to-end at 390/430/768/1280 with a real captured territory; dev server NOT restarted (untouched, as required)

---
Task ID: 2
Agent: Z.ai Code (main)
Task: PHASE 32 — World Map + Territory Engine: IMPLEMENT → TEST → EXPLOIT → CONCURRENCY → LOAD → E2E → REGRESSION → DOCUMENT

Work Log:
- Schema additive (both twins + committed migrations 20260902000000_world_engine): Territory += regionId/name/terrain/status/ownerType/isCapital/resourceType/productionRate/productionCollectedAt/captureCount; NEW world_regions + territory_history; indexes (regionId/status/history territoryId+createdAt/seasonNumber)
- Config: config/world.ts (grid 41×41 seed 20260901, terrain catalog 9 types w/ attackBps+defenseBps+production, garrison policy, production policy, name pools, map policy, invariants); BATTLE.terrainAttackBps extended, version 1→2; LEDGER_REASONS += TERRITORY_CAPTURE/PRODUCTION; STAT_DEFINITIONS += territoriesCaptured/Defended/Lost; admin scopes world.view/manage (moderator view-only); error codes (TERRITORY_CAPITAL_PROTECTED/NOT_ADJACENT/LOCKED/OWNED/NOT_COLLECTIBLE/REGION_NOT_FOUND)
- Engine: engine/world/generator.ts PURE (generateWorld/adjacentCoords/areAdjacent/garrisonFor/accruedProduction; mulberry32 shared w/ battle sim; per-cell deterministic garrison jitter)
- Services: world.service.ts (ensureWorldGenerated idempotent w/ pre-read + region backfill + legacy-capital backfill; map viewport w/ area cap + capital-centered default; detail w/ server attackability; player-territories; paged history; attackTerritory full pipeline; collectTerritoryProduction lazy+ledger; admin inspect/lock/ownership); world-capital.service.ts (leaf — capital claim + SPAWN history); battle.service exports (toBattleStack/loadArmySide/casualtyRows reused, no second army builder); city-site spiral constrained to world grid; player-bootstrap claims capital in-tx; season-settlement capital-aware wipe + SEASON_RESET history rows; awardSeasonPointsInTx source union += TERRITORY_CAPTURE/DEFENSE; admin audit targets += territory
- Quest engine: typed events TERRITORY_CAPTURED{ownedCount}/DEFENDED/LOST; CAPTURE_TERRITORIES INCREMENT, CONTROL_TERRITORIES SET(ownedCount), DEFEND_TERRITORIES INCREMENT; event keys = battle id; seeds main-06 + seasonal conqueror/land-lord/defender; achievements ach-first-territory/conqueror/defender
- APIs: 6 player routes (/world/map, territories/[id]{,/attack,/history,/collect}, player-territories) + 3 admin routes (RBAC world.view/manage); APP_VERSION 0.21.0-phase32
- Mini App: features/world (types/api/components barrel) by frontend subagent — browser-verified live assault, pan/recenter, no overflow 390-1280, zero console errors
- Bugs found & fixed during testing: Prisma not: excludes NULL rows in capture guard (OR-null arm); capital check before owned check; ensureWorldGenerated pre-read excludes pre-grid cells; city spiral constrained to grid (out-of-bounds capital strays); season settlement capital-awareness; mid-file import + seed scoping in service draft; default map viewport all-undefined-bounds bug; battle rounds rows are per-side (E2E assertion)
- Test infra: tests/helpers/cleanup.ts per-row user purge + territory hygiene (bulk deleteMany FK artifact under SQLite emulation w/ capital cascade surface); patched 23 suites; deterministic telegramConfig:{token:null} in all drains (real token went Unauthorized mid-session); NEW ops flag NOTIFICATION_WORKER_DISABLED (env.ts + worker kill-switch + .env.example) so the dev server's 15s worker cannot race direct-drain tests; one-time sandbox repairs (stray out-of-grid cells, abandoned capitals → inert unclaimed)
- Tests: unit world-config 16 + world-generator 21; integration world-system 14 + world-security 10 + world-concurrency 5 + world-load 5; e2e world-journey 12; deploy-artifacts contract updated to baseline+committed-migrations semantics (+1)

Stage Summary:
- FINAL: 786/786 green (unit 381 · integration 344 · e2e 61) — baseline 702 preserved + 84 new; typecheck ✓ eslint ✓ prettier ✓ db:verify invariants ✓; production build NOT run (sandbox policy forbids bun run build — documented in docs/WORLD-MAP.md §Known limitations)
- Real measurements: generator 10k cells ≈7ms; map 441 cells ≈16ms; full-grid scan 1,681 rows in 2 SQL statements; 20 real assaults avg ≈75ms (max ≈200ms)
- Artifact: docs/WORLD-MAP.md (architecture, generation, terrain, capture, economy, season, API, security, concurrency, performance, testing, limitations)
