# WARLORDS — Frontend Architecture (Mini App)

> Phase 0 baseline · The client is a renderer + command sender. It computes nothing that matters.

---

## 1. Routing & Navigation Model

- **One user-visible route: `/`** (project constraint + Mini App best practice). No page routing — tab navigation is state, not URL.
- Tab switch = Zustand `useNavStore.activeTab` (instant, preserves scroll positions and TanStack Query caches).
- Telegram `BackButton`: bound to panel-internal drill-downs (e.g. building detail); hidden at root tab level.
- Deep links (`?startapp=battle:123`, `?startapp=clanInvite:456`) parsed once at boot → set initial tab + open target dialog.

```
AppShell (app/page.tsx)
├── HUD Header        — resources strip · energy · power · settings gear
├── <ActivePanel />   — dynamic-imported per tab (code splitting)
│    HOME · CITY · ARMY · WORLD · CLAN · QUESTS · RANKING · PROFILE
└── StickyFooter / BottomNav — 8 tabs, safe-area aware, mt-auto pattern
```

## 2. Component Layering

| Layer | Path | Rules |
|---|---|---|
| Shell & layout | `components/layout/*` | No game logic; composes HUD, nav, footer; owns safe-area/viewport handling |
| Feature panels | `components/game/{home,city,army,world,clan,quests,ranking,profile}/*` | Consume hooks (`useCityQuery`, `useTrainMutation`…); render projections; emit command intents |
| Shared game UI | `components/game/common/*` | ResourceBadge, CountdownTimer (serverTime-anchored), StatBar, RarityChip, UnitCard, BattleReportCard… |
| Primitives | `components/ui/*` (shadcn) | Never modified in-place — extensions go to shared game UI |

Panel-level drill-downs use local state + Radix Dialog/Sheet — no nested routing.

## 3. State Management Split

| Kind | Owner | Examples |
|---|---|---|
| Server state | **TanStack Query** | player/city/army/battles/quests/clan/rankings; `staleTime` tuned per entity; mutations invalidate via matrix below |
| Session | Zustand | `{userId, role, telegramUser}` set at auth handshake |
| Navigation/UI | Zustand | activeTab, open dialogs, HUD collapsed, sfx/haptics prefs |
| Never | — | resource balances, battle outcomes, cooldowns — client only renders what server says |

**Query-key taxonomy** (typed factory in `src/lib/api/query-keys.ts`):
`['player','me'] · ['city'] · ['army'] · ['battle','marches'] · ['battle','report',id] · ['quests','active'] · ['rank',category,period,page] · ['clan',id] · ['notifications','unread']`

**Invalidation matrix (mutation → keys):**

| Mutation | Invalidate |
|---|---|
| collect / upgrade / train / research | `['player','me']`, `['city']`, `['army']`, `['quests','active']` |
| attack / scout | `['army']`, `['battle','marches']`, `['player','me']` (energy) |
| claim quest | `['quests','active']`, `['player','me']` |
| clan ops | `['clan',id]`, `['player','me']` |

## 4. Data Flow & Timers

```
POST /api/v1/... (command intent)
   → 200 { ok, data, meta.serverTime }   → invalidate affected keys
GET  polls: battles/marches + notifications every 30s while app visible
            (also serves as server-side sweep trigger for arrived marches)
CountdownTimer renders from (data.completesAt − meta.serverTime offset captured at fetch),
re-rendered by a 1s ticker store — device clock drift irrelevant.
```

Optimistic UI is allowed ONLY for cosmetic reads (unread badge, tab prefs). **Any** resource/power/energy number is never optimistic.

## 5. Telegram Integration (client)

`src/lib/telegram/client.ts` — the ONLY module importing `@telegram-apps/sdk`:

| Capability | Usage |
|---|---|
| `initData` | captured once → `POST /auth/telegram` |
| themeParams | mapped onto CSS custom properties (game theme stays dark-fantasy regardless) |
| hapticFeedback | light impact on button taps, success/error on results (respect user pref) |
| BackButton | panel drill-down binding |
| viewport / expand | request fullscreen on boot; handle height changes |
| popup/alert | avoided — custom in-app dialogs (consistent UX) |

**Browser fallback**: when `window.Telegram?.WebApp` is absent (dev in plain browser), the wrapper no-ops gracefully and `dev-impersonate` auth is offered (non-production only).

## 6. UX System

- Theme: zinc-950 base, amber/orange accents, crimson for combat — **no blue/indigo**. Tokens via Tailwind classes on a dark wrapper; game imagery via SVG + generated assets.
- Mobile-first 360–440px primary; desktop = centered max-w-5xl with side padding.
- Touch targets ≥44px; bottom nav 56–64px; safe-area insets on nav/footer (`env(safe-area-inset-*)`).
- Every async surface has: skeleton (initial), spinner-in-place (refetch), error card with retry, empty state with call-to-action.
- Toasts (sonner) for results; destructive actions get AlertDialog confirm; subtle framer-motion for tab transitions and reward moments (reduced-motion respected).
- Long lists (rankings, ledger, reports) virtualized (`@tanstack/react-virtual` budget: render ≤ 20 nodes).

## 7. Performance Budget

| Metric | Budget | Technique |
|---|---|---|
| First paint (shell) | < 1.5s on mid-range Android | Shell + HOME panel only; rest `next/dynamic`; no blocking fonts beyond Geist |
| Bundle per panel | < 60KB gzip | Lazy boundaries; recharts only on RANKING/PROFILE demand |
| API chatter | ≤ 2 idle req/min | 30s sweep poll; conditional GET via query staleTime |
| List scroll | 60fps | Virtualization; memoized rows; no layout-thrash animations (transform/opacity only) |

## 8. i18n

`next-intl` (already installed). Locale files `src/messages/{en,fa}.json`; language = Telegram `language_code` fallback `en`. All game copy through `useTranslations` from day one — no hard-coded strings in panels (numbers/dates via `Intl` with server-anchored UTC).

## 9. Error & Boundary Contract

- Root `ErrorBoundary` → full-screen "realm crashed" card + reload (logs to console only — no telemetry service in MVP).
- Per-panel React Query `onError` → inline error card + toast; auth failures (`UNAUTHORIZED/SESSION_EXPIRED`) → global handler re-runs initData handshake once, then hard reload.
- 429 (`RATE_LIMITED`) → disable action buttons for `retryAfterSec` with countdown.

## 10. Accessibility

Semantic landmarks (`header/nav/main/footer`), ARIA labels on all icon buttons, focus-visible rings, keyboard-operable dialogs/tabs (Radix default), alt text on imagery, `aria-live` for battle-result announcements.
