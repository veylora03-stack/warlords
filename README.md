# ⚔️ WARLORDS — Telegram MMO Strategy Game

A persistent, **server-authoritative** MMO strategy game delivered as a **Telegram Bot + Mini App + REST API**.
Build a city, raise armies, collect commanders, fight deterministic battles, conquer territories, climb leaderboards.

> Status: **Phase 0 — Architecture & Repository Setup: COMPLETE**
> Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)

---

## Documentation (architecture-as-code)

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System overview, stack decisions, folder structure, game state model, engines, deployment |
| [`docs/DATABASE_DESIGN.md`](docs/DATABASE_DESIGN.md) | ERD, 45-entity catalog, indexing strategy, transaction boundaries, PG migration notes |
| [`docs/API_DESIGN.md`](docs/API_DESIGN.md) | REST conventions, error taxonomy, endpoint catalog, sequences |
| [`docs/BATTLE_MODEL.md`](docs/BATTLE_MODEL.md) | Deterministic seeded battle simulation, counters, loot, protection rules |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Telegram auth, anti-cheat matrix, RBAC, idempotency, secrets |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phase contracts 0–13 with exit criteria |

## Tech Stack

- **Next.js 16 (App Router)** + React 19 + TypeScript 5 (strict)
- **Tailwind CSS 4 + shadcn/ui** — dark-fantasy game UI
- **Prisma ORM** — PostgreSQL-first schema (SQLite as sandbox dev driver)
- **Zod v4** — validation on every request
- **Zustand + TanStack Query** — client state / server state
- **Telegram Bot API + Mini Apps SDK** — client surface

## Getting Started

```bash
bun install
cp .env.example .env         # fill in real values
bun run db:push              # apply Prisma schema
bun run dev                  # http://localhost:3000
```

### Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Dev server on :3000 (logs → `dev.log`) |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run db:push` / `db:generate` / `db:migrate` | Prisma schema operations |

## Principles

1. **Never trust the client** — every resource, battle result, reward and cooldown is computed server-side.
2. **Ledger economy** — every resource delta is appended to `resource_transactions` with `balanceAfter`; negative balances are structurally impossible.
3. **Deterministic battles** — `(seed, configVersion, inputs)` fully replays any engagement.
4. **Data-driven balance** — unit/building/tech/quest numbers live in typed config, never hard-coded in logic.
5. **Working software over claims** — every phase exits through lint + typecheck + runtime verification.

## Repository Map

```
docs/            architecture documents
prisma/          schema (single source of truth for persistence)
src/app/         Mini App entry + /api (REST adapters)
src/lib/api/     response envelope, error taxonomy
src/lib/game/    types · config · engine · services (game core)
src/components/  ui (shadcn) · game (Phase 8+)
mini-services/   optional realtime services (socket.io) — later phases
worklog.md       append-only engineering journal
```
