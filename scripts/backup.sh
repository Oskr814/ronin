#!/usr/bin/env bash
# Backs up a Docker Compose installation of ronin (#235, stage 5) into
# <dest>/<YYYY-MM-DD>/:
#   ronin.dump      the database (pg_dump, custom format)
#   files.tar.gz    the data volume (ronin-files): repos.json, the portal's
#                   images, the meetings' notes, the runs' transcripts, logs…
#   env             the .env: its secrets too, so the backup is as sensitive
#                   as the .env itself
#   manifest        when, and which version of ronin
# Not backed up: the repos volume and Docker's (they rebuild themselves), nor
# the Claude accounts (each installation does its own `claude login`).
#
#   scripts/backup.sh [dest]        dest: BACKUP_DIR in .env, or ./backups
#   scripts/backup.sh --prune dir   only the retention
# Keeps the last 7 daily backups and, before them, the newest of each of 4
# weeks. One per day: a second run the same day replaces it. Daily, from the
# host's cron:
#   15 3 * * * cd /ruta/a/ronin && scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEEP_DAILY=7
KEEP_WEEKLY=4

# The backups of `dir`, newest first: the first KEEP_DAILY stay, and after
# them the newest of each ISO week not seen yet, up to KEEP_WEEKLY. The rest go.
prune() {
  local dir="$1" daily=0 weekly=0 seen=" " name week
  for name in $(ls -1 "$dir" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r); do
    week="$(date -d "$name" +%G-%V)"
    if [ "$daily" -lt "$KEEP_DAILY" ]; then
      daily=$((daily + 1))
      seen="$seen$week "
    elif [[ "$seen" != *" $week "* && "$weekly" -lt "$KEEP_WEEKLY" ]]; then
      weekly=$((weekly + 1))
      seen="$seen$week "
    else
      rm -rf "${dir:?}/$name"
      echo "respaldo: borrado $name"
    fi
  done
}

if [ "${1:-}" = "--prune" ]; then
  prune "${2:?Uso: $0 --prune <carpeta>}"
  exit 0
fi

dest="${1:-${BACKUP_DIR:-$(grep -s '^BACKUP_DIR=' .env | cut -d= -f2- || true)}}"
dest="${dest:-backups}"
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
stamp="$(date +%F)"
partial="$dest/.$stamp.partial"
rm -rf "$partial"
mkdir -m 700 "$partial"

if [ -z "$(docker compose ps -q postgres)" ]; then
  echo "respaldo: Postgres no está corriendo (docker compose up -d postgres)" >&2
  exit 1
fi

docker compose exec -T postgres pg_dump -U ronin -Fc ronin > "$partial/ronin.dump"
docker compose run --rm --no-deps -T -v "$partial:/backup" --entrypoint tar init -czf /backup/files.tar.gz -C /data .
if [ -f .env ]; then
  cp .env "$partial/env"
  chmod 600 "$partial/env"
fi
{
  echo "fecha: $(date -Iseconds)"
  echo "ronin: $(git rev-parse --short HEAD 2>/dev/null || echo desconocido)"
  echo "imagen: $(docker compose images -q ronin 2>/dev/null | head -1)"
} > "$partial/manifest"

rm -rf "${dest:?}/$stamp"
mv "$partial" "$dest/$stamp"
echo "respaldo: $dest/$stamp ($(du -sh "$dest/$stamp" | cut -f1))"
prune "$dest"
