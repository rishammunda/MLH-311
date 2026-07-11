#!/usr/bin/env bash
# One-command local demo: backend (demo mode, snapshot data) + frontend (Vite).
# Dashboard: http://localhost:5173   Worker phone: http://localhost:5173/worker.html
set -euo pipefail
cd "$(dirname "$0")"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "▶ backend  → http://localhost:8000 (DEMO_MODE, in-memory snapshot)"
(
  cd backend
  DEMO_MODE=1 DISABLE_POLLER=1 DATABASE_URL="sqlite:///:memory:" \
    python3 -m uvicorn main:app --port 8000
) &

echo "▶ frontend → http://localhost:5173"
(
  cd frontend
  [ -d node_modules ] || npm install
  npm run dev
) &

wait
