#!/usr/bin/env bash
# One-time (idempotent, safe to re-run) setup step: registers a GitHub
# webhook in every repo listed in repos.json, pointing at webhook-server.ts's
# public URL (see scripts/setup-webhook-service.sh for running that server,
# and the wiki (https://github.com/Oskr814/ronin/wiki/Webhooks) for exposing it via a reverse proxy/tunnel). Run manually,
# using your own `gh auth` session — same convention as init-labels.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a

: "${WEBHOOK_SECRET:?WEBHOOK_SECRET no está seteado en .env}"
WEBHOOK_URL="${1:?Uso: $0 <url-publica>/webhook — ej. https://ronin-webhooks.tudominio.com/webhook}"
REPOS_CONFIG_PATH="${REPOS_CONFIG_PATH:-$REPO_DIR/repos.json}"

if [[ ! -f "$REPOS_CONFIG_PATH" ]]; then
  echo "No se encontró $REPOS_CONFIG_PATH — ver repos.json.example" >&2
  exit 1
fi

EVENTS=(issues pull_request issue_comment pull_request_review_comment pull_request_review check_suite release)

for repo in $(jq -r '.[].productRepo' "$REPOS_CONFIG_PATH"); do
  echo "Configurando webhook en $repo..."

  # Reusa un hook existente apuntando a la misma URL en vez de duplicarlo —
  # gh api no tiene upsert nativo para esto.
  EXISTING_ID="$(gh api "repos/$repo/hooks" --jq ".[] | select(.config.url == \"$WEBHOOK_URL\") | .id" | head -n1)"

  EVENT_ARGS=()
  for event in "${EVENTS[@]}"; do
    EVENT_ARGS+=(-f "events[]=$event")
  done

  if [[ -n "$EXISTING_ID" ]]; then
    gh api "repos/$repo/hooks/$EXISTING_ID" -X PATCH \
      -F active=true \
      -f config[url]="$WEBHOOK_URL" -f config[content_type]=json -f config[secret]="$WEBHOOK_SECRET" \
      "${EVENT_ARGS[@]}" >/dev/null
    echo "  ✓ actualizado (hook #$EXISTING_ID)"
  else
    gh api "repos/$repo/hooks" -X POST \
      -f name=web -F active=true \
      -f config[url]="$WEBHOOK_URL" -f config[content_type]=json -f config[secret]="$WEBHOOK_SECRET" \
      "${EVENT_ARGS[@]}" >/dev/null
    echo "  ✓ creado"
  fi
done
