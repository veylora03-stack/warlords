#!/bin/sh
# WARLORDS — container entrypoint (Phase 26).
# Optional migration gate, then exec the server (PID 1 handoff so signals
# (SIGTERM) reach the Node/Bun server for graceful drains).
set -eu

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[warlords-entrypoint] applying database migrations (prisma migrate deploy)"
  bun x prisma migrate deploy --schema prisma/postgres/schema.prisma
  echo "[warlords-entrypoint] migrations applied"
else
  echo "[warlords-entrypoint] RUN_MIGRATIONS!=true — skipping in-container migration (platform pre-deploy step expected)"
fi

exec "$@"
