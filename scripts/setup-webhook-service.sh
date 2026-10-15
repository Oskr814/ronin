#!/usr/bin/env bash
# Installs (or removes) webhooks/server.ts as a systemd --user service — unlike
# tick (a one-shot cron job, see setup-cron.sh), this has to stay up
# permanently to accept incoming webhook deliveries. Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="ronin-webhook"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

if [[ "${1:-}" == "--remove" ]]; then
  systemctl --user disable --now "$SERVICE_NAME.service" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Servicio $SERVICE_NAME removido"
  exit 0
fi

if [ ! -f "$REPO_DIR/dist/webhooks/server.js" ]; then
  echo "$REPO_DIR/dist/webhooks/server.js no existe — correr 'pnpm build' primero" >&2
  exit 1
fi

# Cron runs with a minimal environment (no .bashrc/.profile sourced), so
# node/pnpm managers like nvm often aren't on PATH there even though they
# work fine interactively — same issue as setup-cron.sh's wrapper, same fix.
FULL_PATH="$("$SHELL" -lc 'echo $PATH')"
NODE_BIN="$(command -v node)"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ronin webhook server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=PATH=$FULL_PATH
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/dist/webhooks/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME.service"
# restart, not `enable --now`: --now doesn't touch a service that's already
# running, so a re-run after a deploy would leave the old code in memory —
# and once `pnpm build` has removed the old dist/ files, it would fail on its
# next restart.
systemctl --user restart "$SERVICE_NAME.service"

echo "Servicio $SERVICE_NAME instalado y corriendo"
echo "Logs: journalctl --user -u $SERVICE_NAME -f"
echo "Desinstalar: $0 --remove"
