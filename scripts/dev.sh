#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  printf 'Bun is required in WSL. Install it with: curl -fsSL https://bun.sh/install | bash\n' >&2
  exit 1
fi

if [[ ! -d "$root_dir/frontend/node_modules" ]]; then
  bun --cwd "$root_dir/frontend" install --frozen-lockfile
fi

cleanup() {
  trap - EXIT INT TERM
  kill "$backend_pid" "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" "$frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  cd "$root_dir"
  exec uv run \
    --with-requirements requirements.txt \
    --with-requirements requirements-dev.txt \
    uvicorn backend.app.main:app \
    --host 0.0.0.0 \
    --port "${BACKEND_PORT:-8000}" \
    --loop asyncio \
    --reload
) &
backend_pid=$!

(
  cd "$root_dir/frontend"
  exec bun run dev
) &
frontend_pid=$!

printf 'Backend: http://localhost:%s\n' "${BACKEND_PORT:-8000}"
printf 'Frontend: http://localhost:5173\n'
printf 'Press Ctrl+C to stop both servers.\n'

set +e
wait -n "$backend_pid" "$frontend_pid"
status=$?
set -e
exit "$status"
