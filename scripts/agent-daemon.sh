#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-}"
shift || true

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${AGENT_STATE_DIR:-$HOME/.agentd/state}"
LOG_DIR="${AGENT_LOG_DIR:-$HOME/.agentd/logs}"
REPO="${REPO:-hntrl/steering-rl}"
MAX_PARALLEL="${MAX_PARALLEL:-2}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-60}"
DRY_RUN="${DRY_RUN:-0}"

SUPERVISOR_PID_FILE="$STATE_DIR/supervisor.pid"
RECONCILER_PID_FILE="$STATE_DIR/reconciler.pid"

mkdir -p "$STATE_DIR" "$LOG_DIR"

start_processes() {
  if [[ -f "$SUPERVISOR_PID_FILE" ]] && kill -0 "$(cat "$SUPERVISOR_PID_FILE")" 2>/dev/null; then
    echo "Supervisor is already running (pid $(cat "$SUPERVISOR_PID_FILE"))"
    return
  fi

  echo "Starting supervisor..."
  supervisor_cmd=(
    node "$ROOT_DIR/scripts/agent-supervisor.mjs"
    --repo "$REPO"
    --max-parallel "$MAX_PARALLEL"
    --poll-interval-seconds "$POLL_INTERVAL_SECONDS"
  )
  if [[ "$DRY_RUN" == "1" ]]; then
    supervisor_cmd+=(--dry-run)
  fi
  nohup "${supervisor_cmd[@]}" >> "$LOG_DIR/supervisor.log" 2>&1 &
  echo $! > "$SUPERVISOR_PID_FILE"

  echo "Starting reconciler..."
  reconciler_cmd=(
    node "$ROOT_DIR/scripts/agent-reconciler.mjs"
    --repo "$REPO"
    --poll-interval-seconds "$POLL_INTERVAL_SECONDS"
  )
  if [[ "$DRY_RUN" == "1" ]]; then
    reconciler_cmd+=(--dry-run)
  fi
  nohup "${reconciler_cmd[@]}" >> "$LOG_DIR/reconciler.log" 2>&1 &
  echo $! > "$RECONCILER_PID_FILE"

  echo "Agent daemon started."
}

stop_processes() {
  if [[ -f "$SUPERVISOR_PID_FILE" ]]; then
    pid="$(cat "$SUPERVISOR_PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Stopped supervisor ($pid)"
    fi
    rm -f "$SUPERVISOR_PID_FILE"
  fi

  if [[ -f "$RECONCILER_PID_FILE" ]]; then
    pid="$(cat "$RECONCILER_PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Stopped reconciler ($pid)"
    fi
    rm -f "$RECONCILER_PID_FILE"
  fi
}

status_processes() {
  if [[ -f "$SUPERVISOR_PID_FILE" ]] && kill -0 "$(cat "$SUPERVISOR_PID_FILE")" 2>/dev/null; then
    echo "Supervisor: running (pid $(cat "$SUPERVISOR_PID_FILE"))"
  else
    echo "Supervisor: stopped"
  fi

  if [[ -f "$RECONCILER_PID_FILE" ]] && kill -0 "$(cat "$RECONCILER_PID_FILE")" 2>/dev/null; then
    echo "Reconciler: running (pid $(cat "$RECONCILER_PID_FILE"))"
  else
    echo "Reconciler: stopped"
  fi
}

run_once() {
  echo "Running one supervisor/reconciler cycle..."
  supervisor_args=(
    "$ROOT_DIR/scripts/agent-supervisor.mjs"
    --repo "$REPO"
    --max-parallel "$MAX_PARALLEL"
    --once
  )
  reconciler_args=(
    "$ROOT_DIR/scripts/agent-reconciler.mjs"
    --repo "$REPO"
    --once
  )

  if [[ "$DRY_RUN" == "1" ]]; then
    supervisor_args+=(--dry-run)
    reconciler_args+=(--dry-run)
  fi

  node "${supervisor_args[@]}"
  node "${reconciler_args[@]}"

  echo "One cycle completed."
}

reset_state() {
  rm -rf "$STATE_DIR/locks"
  mkdir -p "$STATE_DIR/locks"
  echo "Cleared stale task locks at $STATE_DIR/locks"
}

follow_logs() {
  runs_file="$STATE_DIR/runs.json"
  if [[ ! -f "$runs_file" ]]; then
    echo "Run state file not found: $runs_file"
    exit 1
  fi

  log_path="$(python3 - "$runs_file" <<'PY'
import json
import sys
from pathlib import Path

runs_path = Path(sys.argv[1])
runs = json.loads(runs_path.read_text()) if runs_path.exists() else []

if not runs:
    print("")
    raise SystemExit(0)

running = [r for r in runs if r.get("status") == "running"]
target = running[-1] if running else runs[-1]
print(target.get("log_path", ""))
PY
)"

if [[ -z "$log_path" ]]; then
  echo "No run log path found in $runs_file"
  exit 1
fi

if [[ ! -f "$log_path" ]]; then
  echo "Log file does not exist yet: $log_path"
  exit 1
fi

echo "Tailing $log_path"
tail -f "$log_path"
}

case "$CMD" in
  start)
    start_processes
    ;;
  stop)
    stop_processes
    ;;
  restart)
    stop_processes
    start_processes
    ;;
  status)
    status_processes
    ;;
  once)
    run_once
    ;;
  reset)
    reset_state
    ;;
  follow)
    follow_logs
    ;;
  *)
    echo "Usage: scripts/agent-daemon.sh <start|stop|restart|status|once|reset|follow>"
    exit 1
    ;;
esac
