#!/usr/bin/env bash
# The ronin image's entrypoint (#235, stage 5).
#   server (the default)  gets the container ready and starts ronin, all in one process
#   api                   the same, but only the listeners: the jobs go to the runner (#325)
#   runner                the scheduler and the job queue's runner, without listeners
#   init [flags]          `ronin init` (src/apps/cli/init.ts)
#   migrate               brings DATABASE_URL's database up to date
#   anything else         runs as is (bash, claude, gh…)
set -euo pipefail
cd /app

DATA_DIR="${RONIN_DATA_DIR:-/data}"

# git and gh act as ronin's GitHub account, with its token: gh reads GH_TOKEN,
# and git asks gh for the credentials of github.com. The identity of its
# commits is that account's, as on a runner installed by hand.
setup_git() {
  export GH_TOKEN="${GH_TOKEN:-${RONIN_GITHUB_TOKEN:-}}"
  git config --global credential.https://github.com.helper '!gh auth git-credential'
  # The volumes' checkouts were made by other containers; git refuses to
  # work in a repo owned by someone else unless told to.
  git config --global --replace-all safe.directory '*'
  if [ -n "${RONIN_GITHUB_LOGIN:-}" ]; then
    git config --global user.name >/dev/null || git config --global user.name "$RONIN_GITHUB_LOGIN"
    git config --global user.email >/dev/null || git config --global user.email "$RONIN_GITHUB_LOGIN@users.noreply.github.com"
  fi
}

# Every repo of repos.json (and its changelog repo) cloned where its entry
# says, if it isn't there yet: the repos volume isn't backed up, so a
# recovered installation clones them again on its first start.
clone_missing() {
  local repos="${REPOS_CONFIG_PATH:-$DATA_DIR/repos.json}"
  [ -f "$repos" ] || { echo "ronin: no hay $repos todavía (ronin init lo crea)"; return 0; }
  node -e '
    for (const e of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) {
      if (e.productRepo && e.productRepoPath) console.log(`${e.productRepo}\t${e.productRepoPath}`);
      if (e.changelogRepo && e.changelogRepoPath) console.log(`${e.changelogRepo}\t${e.changelogRepoPath}`);
    }' "$repos" | while IFS=$'\t' read -r repo path; do
    [ -e "$path/.git" ] && continue
    echo "ronin: clonando $repo en $path"
    mkdir -p "$(dirname "$path")"
    git clone --quiet "https://github.com/$repo.git" "$path" || echo "ronin: no se pudo clonar $repo" >&2
  done
}

# The dashboard listens on 127.0.0.1 (apps/api/main.ts). This container
# shares its network with the Tailscale sidecar, so `tailscale serve`, through
# the sidecar's socket, publishes it on the tailnet as
# scripts/setup-server-service.sh does on a runner installed by hand. In the
# background: the sidecar may still be starting.
publish_dashboard() {
  [ -n "${DASHBOARD_GITHUB_CLIENT_ID:-}" ] || return 0
  local https="${DASHBOARD_TAILNET_HTTPS_PORT:-8443}" local_port="${SERVER_TAILNET_PORT:-3940}"
  for _ in $(seq 1 60); do
    if tailscale serve --bg --https="$https" "http://127.0.0.1:$local_port" >/dev/null 2>&1; then
      echo "ronin: tablero publicado en la tailnet, puerto $https"
      return 0
    fi
    sleep 2
  done
  echo "ronin: no se pudo publicar el tablero con tailscale serve (¿está el sidecar de Tailscale?)" >&2
}

case "${1:-server}" in
  server)
    mkdir -p "$DATA_DIR/logs" "$DATA_DIR/.ronin-slots" "${CLAUDE_CONFIG_DIR:-/claude/default}"
    setup_git
    clone_missing
    publish_dashboard &
    exec node dist/apps/api/main.js
    ;;
  # The repos are cloned by the runner, the one that works on them: two
  # containers cloning the same one at once would step on each other.
  api)
    mkdir -p "$DATA_DIR/logs" "$DATA_DIR/.ronin-slots" "${CLAUDE_CONFIG_DIR:-/claude/default}"
    setup_git
    publish_dashboard &
    RONIN_ROLE=api exec node dist/apps/api/main.js
    ;;
  runner)
    mkdir -p "$DATA_DIR/logs" "$DATA_DIR/.ronin-slots" "${CLAUDE_CONFIG_DIR:-/claude/default}"
    setup_git
    clone_missing
    export RONIN_ROLE=runner
    exec node dist/apps/api/jobs/main.js
    ;;
  init)
    shift
    exec node dist/apps/cli/init.js "$@"
    ;;
  migrate)
    exec node dist/apps/cli/init.js --steps migrate
    ;;
  *)
    setup_git
    exec "$@"
    ;;
esac
