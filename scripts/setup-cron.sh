#!/usr/bin/env bash
# Installs (or removes) a crontab entry that runs `pnpm start` on a fixed
# interval. Safe to re-run: replaces this repo's previous entry instead of
# duplicating it, identified by a marker comment scoped to this repo's path
# (so multiple ronin checkouts on the same host don't collide).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
WRAPPER="$REPO_DIR/scripts/run-tick.sh"
MARKER="# ronin-tick:$REPO_DIR"

if [[ "${1:-}" == "--remove" ]]; then
  EXISTING="$(crontab -l 2>/dev/null || true)"
  FILTERED="$(printf '%s\n' "$EXISTING" | grep -v -F "$MARKER" || true)"
  printf '%s\n' "$FILTERED" | crontab -
  echo "Cron removido para $REPO_DIR"
  exit 0
fi

INTERVAL_MINUTES="${1:-5}"
RETENTION_DAYS="${2:-14}"
if ! [[ "$INTERVAL_MINUTES" =~ ^[0-9]+$ && "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "Uso: $0 [minutos] [dias_retencion_logs] | --remove" >&2
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

LOG_DIR="$REPO_DIR/logs"
mkdir -p "\$LOG_DIR"
# One file per day instead of a single ever-growing one — "rotation" is
# just writing to a new path once the date changes. Everything from here
# on (including pnpm tick's own stdout/stderr) goes to it.
exec >> "\$LOG_DIR/tick-\$(date +%F).log" 2>&1

# Time-based retention: prune files older than $RETENTION_DAYS days on
# every run, so this never needs a separate cron entry or logrotate.
find "\$LOG_DIR" -name 'tick-*.log' -mtime +$RETENTION_DAYS -delete
# Per-run records (#65), one folder per day: same retention.
find "\$LOG_DIR/runs" -mindepth 1 -maxdepth 1 -type d -mtime +$RETENTION_DAYS -exec rm -rf {} + 2>/dev/null || true

# Single-flight: a tick can run for a while (a claude -p invocation can take
# up to AGENT_TASK_TIMEOUT_MINUTES). If a previous run is still going, don't
# run a second tick concurrently against the same local state
# (.ronin-state.json) — see docs/DESIGN.md §9. The trigger is not dropped
# either: it leaves a pending mark that the running tick picks up when it
# ends. (Webhook events don't come through here anymore: each one gets its
# own handler process — see docs/DESIGN.md §14.)
PENDING="$REPO_DIR/.tick.pending"
exec 200>"$REPO_DIR/.tick.lock"
if ! flock -n 200; then
  touch "\$PENDING"
  echo "\$(date -Is) [cron] tick ya en curso, queda pendiente para cuando termine"
  exit 0
fi

set -a
source "$REPO_DIR/.env"
set +a

# With DATABASE_URL, the server's scheduler queues the tick (#235, stage 3):
# a tick from here too would run alongside it. This cron entry is left over.
if [ -n "\${DATABASE_URL:-}" ]; then
  echo "\$(date -Is) [cron] con DATABASE_URL los ticks los pone en cola el servidor: este cron sobra (pnpm cron:remove)"
  exit 0
fi

if [ ! -f dist/index.js ]; then
  echo "\$(date -Is) [cron] dist/index.js no existe — correr pnpm build" >&2
  exit 1
fi
if [ -n "\$(find src -newer dist/index.js)" ]; then
  echo "\$(date -Is) [cron] WARN: src/ tiene cambios más nuevos que dist/ — considerar pnpm build"
fi
status=0
while :; do
  rm -f "\$PENDING"
  # 200>&-: the lock stays with this shell only. Whatever the tick launches
  # and outlives it (a /preview's vite, a worker) would otherwise inherit fd
  # 200 and keep the flock held after the tick ends — every later tick then
  # sees "ya en curso" and skips, until that process dies.
  pnpm start 200>&- || status=\$?
  [ -e "\$PENDING" ] || break
  echo "\$(date -Is) [cron] hubo disparos durante el tick, corriendo otro"
done

# A trigger can still land between the last check and the lock release;
# re-check once the lock is free. Re-running this script either takes the
# lock or, if some other trigger got it first, leaves the mark for that one.
exec 200>&-
if [ -e "\$PENDING" ]; then
  exec "\$0"
fi
exit "\$status"
EOF
chmod +x "$WRAPPER"

# No redirection here on purpose — the wrapper redirects its own output to
# the dated log file (see above). A crontab-line redirect would also hit
# cron's "%" means newline" gotcha the moment a date format is involved.
CRON_LINE="*/$INTERVAL_MINUTES * * * * $WRAPPER $MARKER"

# `crontab -l` exits non-zero when there's no crontab installed yet (the
# common first-run case), and `grep -v` exits non-zero when nothing matched
# the marker (also common) — both are expected, not errors, so each needs
# its own `|| true` rather than relying on one at the end of the pipeline
# (which `set -o pipefail` would otherwise still trip on).
EXISTING="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "$EXISTING" | grep -v -F "$MARKER" || true)"
printf '%s\n%s\n' "$FILTERED" "$CRON_LINE" | crontab -

echo "Cron instalado: cada $INTERVAL_MINUTES min -> $WRAPPER"
echo "Logs: $LOG_DIR/tick-YYYY-MM-DD.log (se conservan $RETENTION_DAYS días)"
echo "Ver: crontab -l"
echo "Desinstalar: $0 --remove"
