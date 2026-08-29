# WARLORDS — Engineering Worklog (append-only)

---

Task ID: 0
Agent: Z.ai Code (orchestrator — senior team role)
Task: PHASE 0 — Architecture + Repository Structure + Database Design + API Design + Development Plan

Work Log:
- Inspected repo: Next.js 16 + React 19 + TS 5 + Tailwind 4 + shadcn/ui scaffold, Prisma 6 (SQLite sandbox driver), Zod 4 / Zustand 5 / TanStack Query 5 present; git repo with only an empty initial commit.
- Committed untouched scaffold as baseline (`chore: baseline scaffold`).
- Wrote full architecture document set under `docs/`:
  - ARCHITECTURE.md — stack decisions (incl. justified deviations: Route Handlers instead of separate NestJS/Fastify service; SQLite only as dev driver, PostgreSQL-first schema), layering rules (adapters→services→engines→config), lazy-tick game state model, BigInt/basis-point numeric policy, notification outbox, observability, deployment topology (sandbox gateway + Vercel/Supabase production), module maturity matrix.
  - DATABASE_DESIGN.md — ERD (mermaid), 45-entity catalog, ledger-first economy, catalog/instance split, hot-path indexes, transaction boundary examples, PG migration notes.
  - API_DESIGN.md — envelope contract, error code taxonomy, auth headers, idempotency, rate-limit groups, full endpoint catalog for phases 1–9, attack + idempotent-claim sequences.
  - BATTLE_MODEL.md — deterministic seeded simulation, bps modifier aggregation, data-driven counter matrix, round loop, loot/hospital/protection rules, replay contract, anti-exploit notes.
  - SECURITY.md — Telegram initData HMAC verification, JWT session, anti-cheat matrix, RBAC, anti-replay, secrets register, honest limitations register.
  - ROADMAP.md — phase contracts 0–13 with exit criteria + per-phase quality gate (lint/typecheck/runtime/commit/worklog).
- Designed complete Prisma schema (`prisma/schema.prisma`): 45 models incl. users, players, resource_wallets, resource_transactions (ledger), cities, buildings, unit_types, player_units, marches, commanders, items, technologies, territories, battles/battle_rounds/battle_logs, quests, clans & wars, market, seasons, world_bosses, events, notifications, admin_audit_logs, idempotency_keys, post-MVP-ready diplomacy_relations & spy_missions. All tables @@map'd to snake_case; BigInt for money/power/HP; Json for data-driven config blobs.
  - Fixed 4 validation errors (missing back-relations User.notifications→removed, Player.transactions & Player.ledClans added, March.battleId made unique).
  - `prisma validate` ✅ and `prisma db push` ✅ on SQLite (schema proven valid; Prisma Client regenerated). Post-MVP tables exist from day one so later phases are additive.
- Implemented Phase 0 code:
  - `src/lib/game/types/` — common.ts (all enum-like unions + bps policy), game-state.ts (projections, command intents, reconciliation contract), battle.ts (BattleConfig/BattleSide/BattleInput/simulation/replay types + mergeBps helper), index.ts barrel.
  - `src/lib/api/errors.ts` — AppError taxonomy (stable machine-readable codes) + helpers.
  - `src/lib/api/response.ts` — standard envelope, BigInt-safe JSON serialization, request-id propagation, `handle()` catch-all wrapper.
  - `src/app/api/health/route.ts` — real liveness probe (SELECT 1 via Prisma, latency, uptime, version).
  - `src/app/page.tsx` — WARLORDS dev console (dark fantasy/military theme, amber accents, no indigo/blue): live system status from /api/health, architecture summary, 14-phase roadmap, Phase 0 deliverables; sticky footer via min-h-screen flex + mt-auto; responsive.
  - layout.tsx metadata → WARLORDS; README.md; .env.example (no secrets); package.json `typecheck` script; tsconfig excludes sandbox-only dirs (examples/skills/tests).
- Quality gate: `tsc --noEmit` ✅ clean · `eslint .` ✅ clean · dev server 200s ✅ · Agent Browser verification ✅ (page renders, DATABASE UP with real SELECT 1 latency, zero console errors, zero page errors, desktop 1108px + mobile 390px screenshots verified, footer sticks/pushes correctly) · dev.log free of errors.
- Commit: `feat(phase-0): architecture, database design, api design, battle model, security model, roadmap + schema + api infra + status console`.

Stage Summary:
- Phase 0 exit criteria met: schema validates & pushes; typecheck/lint clean; `/` renders verified console; `/api/health` returns real DB probe.
- Key decisions recorded: Next.js Route Handlers as REST layer with framework-agnostic game core; PostgreSQL-first Prisma schema (SQLite sandbox only); JWT session via `jose` over next-auth for Telegram initData; lazy-tick world without cron; ledger-first economy; deterministic replayable battles with configVersion snapshots; post-MVP tables schema-ready from day one.
- Awaiting user approval to begin PHASE 1 (Database & Authentication: migrations, Telegram initData verification, session JWT, middleware, logger, rate limiter, player bootstrap).
