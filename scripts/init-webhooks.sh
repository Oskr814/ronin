#!/usr/bin/env bash
# One-time (idempotent, safe to re-run) setup step: registers a GitHub
# webhook in every repo listed in repos.json, pointing at the ronin server's
# public URL (see scripts/setup-server-service.sh for running that server,
# and the docs (https://oskr814.github.io/ronin/operar/servidor/) for exposing it via a reverse proxy/tunnel). Run manually,
# using your own `gh auth` session — same convention as init-labels.sh.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a

: "${WEBHOOK_SECRET:?WEBHOOK_SECRET no está seteado en .env}"
WEBHOOK_URL="${1:?Uso: $0 <url-publica>/api/webhooks/github — ej. https://ronin.tudominio.com/api/webhooks/github}"
# The hooks created before the server's API had their own path: the same
# domain's /webhook. One found there is moved to the new URL instead of
# leaving it and adding a second hook, which would deliver every event twice.
ORIGIN="$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$WEBHOOK_URL")"
OLD_WEBHOOK_URL="$ORIGIN/webhook"
REPOS_CONFIG_PATH="${REPOS_CONFIG_PATH:-$REPO_DIR/repos.json}"

if [[ ! -f "$REPOS_CONFIG_PATH" ]]; then
  echo "No se encontró $REPOS_CONFIG_PATH — ver repos.json.example" >&2
  exit 1
fi

EVENTS=(issues pull_request issue_comment pull_request_review_comment pull_request_review check_suite release workflow_run)

for repo in $(jq -r '.[].productRepo' "$REPOS_CONFIG_PATH"); do
  echo "Configurando webhook en $repo..."

  # Reusa un hook existente apuntando a la misma URL (o a la vieja, ver
  # OLD_WEBHOOK_URL) en vez de duplicarlo — gh api no tiene upsert nativo
  # para esto.
  EXISTING_ID="$(gh api "repos/$repo/hooks" --jq ".[] | select(.config.url == \"$WEBHOOK_URL\" or .config.url == \"$OLD_WEBHOOK_URL\") | .id" | head -n1)"

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
