# WARLORDS — production image (Phase 26)
# Multi-stage build for Render / Koyeb / Railway / any Docker host.
#
#   deps      → full install (dev deps needed for the build) + prisma client
#   prod-deps → production-only node_modules with the POSTGRES prisma client
#               generated (runtime engines for the container's engine target)
#   build     → `next build` (standalone output) — type errors FAIL the build
#   runner    → standalone server + static assets + prod node_modules + the
#               PostgreSQL migration set; non-root; HEALTHCHECK on /health
#
# Migrations: docker/docker-entrypoint.sh runs `prisma migrate deploy` before
# boot when RUN_MIGRATIONS=true (or use the platform's pre-deploy command —
# see DEPLOYMENT.md §Migrations).

# ── deps: build-time toolchain ───────────────────────────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile \
  && bunx prisma generate

# ── prod-deps: runtime node_modules (postgres client + engines) ─────────────
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma/postgres ./prisma/postgres
RUN bun install --frozen-lockfile --production \
  && bunx prisma generate --schema prisma/postgres/schema.prisma

# ── build: compile the standalone server ─────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile \
  && bunx prisma generate
COPY . .
# `bun run build` = next build + standalone asset copy (see package.json).
# The build is executed with sandbox-safe env; no secrets are needed because
# no server component touches the DB at build time.
RUN DATABASE_URL="file:./build-placeholder.db" bun run build

# ── runner: minimal production runtime ───────────────────────────────────────
FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Production node_modules FIRST (prisma engines + CLI for migrate deploy),
# then the standalone server overlays its traced subset.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY prisma/postgres ./prisma/postgres
COPY docker/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

# Drop privileges — the app never writes to the filesystem at runtime.
USER bun

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "server.js"]
