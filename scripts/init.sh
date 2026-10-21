#!/usr/bin/env bash
# `ronin init` with Docker (#235, stage 5): builds the image, writes .env and
# repos.json asking for what's missing (src/apps/cli/init.ts) and brings the
# database up to date. Then `docker compose up -d`. Safe to re-run: only
# what's missing is asked. Its flags go to init, e.g.
#   scripts/init.sh --repo owner/nombre --set RUNNER_ID=persona
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  touch .env
  chmod 600 .env
fi

docker compose build ronin
docker compose run --rm init --steps env,repos "$@"
docker compose up -d --wait postgres
docker compose run --rm init --steps migrate

cat <<'EOF'

Listo. Para levantar ronin:
  docker compose up -d
Después, un login de Claude por cuenta (la de por defecto, /claude/default):
  docker compose exec ronin claude
La guía: https://oskr814.github.io/ronin/operar/docker/
EOF
