#!/usr/bin/env bash
# Deploys what's checked out (#325): the API first, then the runner, each on
# its own. `docker compose up -d` for both at once creates every container
# before starting any, so the new API would wait, down, for the old runner's
# drain. Run it on main:
#   git pull && scripts/deploy.sh          the API and the runner
#   scripts/deploy.sh ronin                only the API (the dashboard, the portal)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

docker compose build ronin
docker compose up -d --no-deps ronin
echo "deploy: la API está arriba"
[ "${1:-}" = ronin ] && exit 0
# Waits while the old runner drains: what it started ends first.
echo "deploy: el runner espera a que termine lo que está corriendo (docker compose logs -f runner)"
docker compose up -d --no-deps runner
echo "deploy: el runner está arriba"
