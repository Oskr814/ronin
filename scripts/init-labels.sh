#!/usr/bin/env bash
# One-time setup step (idempotent, safe to re-run): creates every valeria:*
# label used by the pipeline in PRODUCT_REPO, including this runner's own
# assignment label (valeria:runner-<RUNNER_ID>). Run manually, using your
# own `gh auth` session — this is a human setup step, not something the
# supervisor does on its own. Without this, a fresh RUNNER_ID has no label
# to pick from the GitHub UI when you go to assign yourself a spec PR.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a

: "${PRODUCT_REPO:?PRODUCT_REPO no está seteado en .env}"
: "${RUNNER_ID:?RUNNER_ID no está seteado en .env}"

LABELS=(
  "valeria|Gestionado por el supervisor ValerIA"
  "valeria:ready|Spec listo para que un runner lo tome"
  "valeria:in-progress|En curso"
  "valeria:blocked|Esperando una decisión humana"
  "valeria:done|Completado"
  "valeria:runner-$RUNNER_ID|Asignado a este runner (ver docs/DESIGN.md §1 y §9)"
)

echo "Creando labels en $PRODUCT_REPO..."
for entry in "${LABELS[@]}"; do
  name="${entry%%|*}"
  desc="${entry#*|}"
  gh label create "$name" --repo "$PRODUCT_REPO" --force --color ededed --description "$desc"
  echo "  ✓ $name"
done
