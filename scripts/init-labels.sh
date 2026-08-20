#!/usr/bin/env bash
# One-time setup step (idempotent, safe to re-run): creates every ronin:*
# label used by the pipeline in every repo listed in repos.json, including
# this runner's own assignment label (ronin:runner-<RUNNER_ID>). Run
# manually, using your own `gh auth` session — this is a human setup step,
# not something the supervisor does on its own. Without this, a fresh
# RUNNER_ID has no label to pick from the GitHub UI when you go to assign
# yourself a spec PR.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a

: "${RUNNER_ID:?RUNNER_ID no está seteado en .env}"
REPOS_CONFIG_PATH="${REPOS_CONFIG_PATH:-$REPO_DIR/repos.json}"

if [[ ! -f "$REPOS_CONFIG_PATH" ]]; then
  echo "No se encontró $REPOS_CONFIG_PATH — ver repos.json.example" >&2
  exit 1
fi

LABELS=(
  "ronin|Gestionado por el supervisor ronin"
  "ronin:ready|Spec listo para que un runner lo tome"
  "ronin:in-progress|En curso"
  "ronin:blocked|Esperando una decisión humana"
  "ronin:done|Completado"
  "ronin:runner-$RUNNER_ID|Asignado a este runner (ver docs/DESIGN.md §1 y §9)"
)

for repo in $(jq -r '.[].productRepo' "$REPOS_CONFIG_PATH"); do
  echo "Creando labels en $repo..."
  for entry in "${LABELS[@]}"; do
    name="${entry%%|*}"
    desc="${entry#*|}"
    gh label create "$name" --repo "$repo" --force --color ededed --description "$desc"
    echo "  ✓ $name"
  done
done
