#!/usr/bin/env bash
# Deploys what's checked out (#325): the API first, then the runner, each on
# its own. `docker compose up -d` for both at once creates every container
# before starting any, so the new API would wait, down, for the old runner's
# drain. Run it on main:
#   git pull && scripts/deploy.sh          the API and then the runner
#   scripts/deploy.sh api                  only the API (the dashboard, the portal, the webhooks)
#   scripts/deploy.sh runner               only the runner (the jobs and the agents)
# The API is compose's `ronin` service.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

what="${1:-all}"
case "$what" in
  all|api|runner) ;;
  *) echo "uso: scripts/deploy.sh [api|runner]" >&2; exit 2 ;;
esac

docker compose build ronin
if [ "$what" != runner ]; then
  docker compose up -d --no-deps ronin
  echo "deploy: la API está arriba"
fi
if [ "$what" != api ]; then
  # Waits while the old runner drains: what it started ends first.
  echo "deploy: el runner espera a que termine lo que está corriendo (docker compose logs -f runner)"
  docker compose up -d --no-deps runner
  echo "deploy: el runner está arriba"
fi
