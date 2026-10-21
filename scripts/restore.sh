#!/usr/bin/env bash
# Restores a backup of scripts/backup.sh into this Docker Compose
# installation (#235, stage 5): the database, the data volume and, if this
# checkout doesn't have one, the .env. Replaces what's there.
#   scripts/restore.sh <backups/YYYY-MM-DD> [--yes] [--env]
#     --yes   doesn't ask for confirmation
#     --env   takes the backup's .env even if there's one already
# Then `docker compose up -d` and a `claude login` per account.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

src="" yes=false take_env=false
for arg in "$@"; do
  case "$arg" in
    --yes) yes=true ;;
    --env) take_env=true ;;
    *) src="$arg" ;;
  esac
done
if [ -z "$src" ] || [ ! -f "$src/ronin.dump" ] || [ ! -f "$src/files.tar.gz" ]; then
  echo "Uso: $0 <carpeta del respaldo, con ronin.dump y files.tar.gz> [--yes] [--env]" >&2
  exit 1
fi
src="$(cd "$src" && pwd)"

if [ "$yes" != true ]; then
  read -r -p "Esto reemplaza la base y los archivos de esta instalación con $src. ¿Seguir? [s/N] " answer
  [[ "$answer" =~ ^[sS]$ ]] || exit 1
fi

# The .env first: Postgres starts with its password.
if [ -f "$src/env" ] && { [ ! -s .env ] || [ "$take_env" = true ]; }; then
  cp "$src/env" .env
  chmod 600 .env
  echo "restaurar: .env del respaldo"
elif [ -f "$src/env" ] && ! cmp -s "$src/env" .env; then
  echo "restaurar: .env es distinto del respaldo y se queda como está (--env para tomar el del respaldo)"
fi

docker compose build ronin
docker compose stop ronin 2>/dev/null || true
docker compose up -d --wait postgres

echo "restaurar: la base"
docker compose exec -T postgres pg_restore -U ronin -d ronin --clean --if-exists --no-owner --single-transaction < "$src/ronin.dump"

echo "restaurar: los archivos"
docker compose run --rm --no-deps -T -v "$src:/backup:ro" --entrypoint sh init -c 'find /data -mindepth 1 -delete && tar -xzf /backup/files.tar.gz -C /data'

cat <<'EOF'
Listo. Para levantar ronin:
  docker compose up -d
Al arrancar clona los repos de repos.json y pone la base al día. Después, un
login de Claude por cuenta:
  docker compose exec ronin claude
EOF
