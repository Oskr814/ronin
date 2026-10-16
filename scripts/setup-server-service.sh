#!/usr/bin/env bash
# Installs (or removes) the ronin server (src/server/index.ts) as a systemd
# --user service — unlike tick (a one-shot cron job, see setup-cron.sh), this
# has to stay up permanently to accept incoming webhook deliveries. Safe to
# re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="ronin-server"
# The same server's old name: installing the new one removes it, since both
# listen on the same port.
OLD_SERVICE_NAME="ronin-webhook"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE_NAME.service"

# The dashboard (#65), when configured: its listener is on 127.0.0.1 and only
# the tailnet reaches it, through `tailscale serve` — never `funnel`, and never
# on a port of PREVIEW_PORT_RANGE, the only range the Tailscale policy opens
# to people outside (docs/DESIGN.md §12).
set -a
# shellcheck disable=SC1091
[ -f "$REPO_DIR/.env" ] && source "$REPO_DIR/.env"
set +a
TAILNET_PORT="${SERVER_TAILNET_PORT:-3940}"
TAILNET_HTTPS_PORT="${DASHBOARD_TAILNET_HTTPS_PORT:-8443}"

remove_service() {
  systemctl --user disable --now "$1.service" 2>/dev/null || true
  rm -f "$UNIT_DIR/$1.service"
}

if [[ "${1:-}" == "--remove" ]]; then
  remove_service "$SERVICE_NAME"
  tailscale serve --https="$TAILNET_HTTPS_PORT" off 2>/dev/null || true
  systemctl --user daemon-reload
  echo "Servicio $SERVICE_NAME removido"
  exit 0
fi

if [ ! -f "$REPO_DIR/dist/server/index.js" ]; then
  echo "$REPO_DIR/dist/server/index.js no existe — correr 'pnpm build' primero" >&2
  exit 1
fi

if [ -f "$UNIT_DIR/$OLD_SERVICE_NAME.service" ]; then
  remove_service "$OLD_SERVICE_NAME"
  echo "Servicio viejo $OLD_SERVICE_NAME removido"
fi

# Cron runs with a minimal environment (no .bashrc/.profile sourced), so
# node/pnpm managers like nvm often aren't on PATH there even though they
# work fine interactively — same issue as setup-cron.sh's wrapper, same fix.
FULL_PATH="$("$SHELL" -lc 'echo $PATH')"
NODE_BIN="$(command -v node)"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ronin server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
Environment=PATH=$FULL_PATH
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/dist/server/index.js
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

if [ -n "${DASHBOARD_GITHUB_CLIENT_ID:-}" ]; then
  tailscale serve --bg --https="$TAILNET_HTTPS_PORT" "http://127.0.0.1:$TAILNET_PORT" >/dev/null
  echo "Tablero publicado en la tailnet: ${DASHBOARD_URL:-https://<host>.ts.net:$TAILNET_HTTPS_PORT}"
else
  echo "Tablero desactivado (falta DASHBOARD_GITHUB_CLIENT_ID en .env)"
fi
echo "Logs: journalctl --user -u $SERVICE_NAME -f"
echo "Desinstalar: $0 --remove"
