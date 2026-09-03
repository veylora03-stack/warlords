#!/usr/bin/env bash
# WARLORDS — production process supervisor (Phase 34.6).
#
# Purpose: keep the REAL production deployment alive on a single-host runtime:
#   1. ensure PostgreSQL is accepting connections (start it if it manages a
#      local datadir via WARLORDS_PG_DATA);
#   2. run the standalone production build (`.next/standalone/server.js`)
#      forever, restarting automatically if the process exits.
#
# Promotion rule (this script is what `bun run dev` executes):
#   - production mode requires BOTH a built artifact AND a deployment env file
#     (WARLORDS_PROD_ENV, kept OUTSIDE the repository, chmod 600 — the build
#     strips .env* from the artifact, so runtime env comes only from here);
#   - otherwise it falls back to the classic dev server unchanged, so normal
#     development environments are completely unaffected.
#
# Logs go to stdout (the platform launcher tees them into dev.log).
set -u

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STANDALONE="$PROJECT_DIR/.next/standalone/server.js"
ENV_FILE="${WARLORDS_PROD_ENV:-/home/z/warlords-ops/warlords-prod.env}"

# ── 0. Single-instance guard (flock) ────────────────────────────────────────
# Running `bun run dev` twice used to produce a crash-looping duplicate
# (EADDRINUSE every 2s, log noise, wasted CPU). The second starter now exits
# cleanly instead of fighting over port 3000.
mkdir -p /home/z/prod-logs
exec 8>/home/z/prod-logs/supervisor.lock
if ! flock -n 8; then
  echo "[supervisor] another production supervisor already holds the lock — exiting"
  exit 0
fi

# ── 0. Fallback: no production artifact or no deployment env → dev server ──
if [ ! -f "$STANDALONE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "[supervisor] production artifact/env not present — running dev server"
  cd "$PROJECT_DIR"
  exec node node_modules/next/dist/bin/next dev -p 3000
fi

# ── 1. Ensure PostgreSQL is up (single-host topology) ────────────────────────
PGBIN="${WARLORDS_PG_BIN:-/home/z/pgbin/bin}"
PGDATA_DIR="${WARLORDS_PG_DATA:-/home/z/pgdata-prod}"
if [ -d "$PGDATA_DIR" ] && [ -x "$PGBIN/pg_ctl" ]; then
  if ! "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    echo "[supervisor] PostgreSQL down — starting..."
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -l /home/z/prod-logs/pg-startup.log start || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1 && break
      sleep 1
    done
    echo "[supervisor] PostgreSQL start issued"
  else
    echo "[supervisor] PostgreSQL already running"
  fi
fi

# ── 2. Run the production server forever (restart on exit) ───────────────────
cd "$(dirname "$STANDALONE")"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

WRAPPER="${WARLORDS_PROD_WRAPPER:-/home/z/warlords-ops/start-prod.js}"
RUNNER="$WRAPPER"
[ -f "$WRAPPER" ] || RUNNER="$STANDALONE"

echo "[supervisor] production mode: $RUNNER (env: $ENV_FILE)"
while true; do
  echo "[supervisor] starting production server at $(date -Is)"
  bun "$RUNNER"
  CODE=$?
  echo "[supervisor] server exited (code=$CODE) — restarting in 2s at $(date -Is)"
  sleep 2
done
