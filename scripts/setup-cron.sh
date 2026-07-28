#!/usr/bin/env bash
# Installs (or removes) a crontab entry that runs `pnpm tick` on a fixed
# interval. Safe to re-run: replaces this repo's previous entry instead of
# duplicating it, identified by a marker comment scoped to this repo's path
# (so multiple ValerIA checkouts on the same host don't collide).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
WRAPPER="$REPO_DIR/scripts/run-tick.sh"
MARKER="# valeria-tick:$REPO_DIR"

if [[ "${1:-}" == "--remove" ]]; then
  crontab -l 2>/dev/null | grep -v -F "$MARKER" | crontab - || true
  echo "Cron removido para $REPO_DIR"
  exit 0
fi

INTERVAL_MINUTES="${1:-5}"
if ! [[ "$INTERVAL_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Uso: $0 [minutos|--remove]" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

# Cron runs with a minimal environment (no .bashrc/.profile sourced), so
# node/pnpm managers like nvm often aren't on PATH there even though they
# work fine interactively. Capturing a real login shell's PATH once here and
# baking it into the wrapper avoids guessing individual install locations.
FULL_PATH="$("$SHELL" -lc 'echo $PATH')"

cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$FULL_PATH"
cd "$REPO_DIR"

# Single-flight: a tick can run for a while (a claude -p invocation can take
# up to AGENT_TASK_TIMEOUT_MINUTES). If a previous run is still going, skip
# this trigger instead of running a second tick concurrently against the
# same local state (.valeria-state.json) — see docs/DESIGN.md §9.
exec 200>"$REPO_DIR/.tick.lock"
flock -n 200 || { echo "\$(date -Is) tick ya en curso, salteando" >> "$LOG_DIR/tick.log"; exit 0; }

set -a
source "$REPO_DIR/.env"
set +a
pnpm tick
EOF
chmod +x "$WRAPPER"

CRON_LINE="*/$INTERVAL_MINUTES * * * * $WRAPPER >> $LOG_DIR/tick.log 2>&1 $MARKER"
( crontab -l 2>/dev/null | grep -v -F "$MARKER" ; echo "$CRON_LINE" ) | crontab -

echo "Cron instalado: cada $INTERVAL_MINUTES min -> $WRAPPER"
echo "Log: $LOG_DIR/tick.log"
echo "Ver: crontab -l"
echo "Desinstalar: $0 --remove"
