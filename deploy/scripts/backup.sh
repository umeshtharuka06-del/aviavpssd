#!/usr/bin/env bash
# Nightly logical backup (run on the VPS, e.g. from cron at 03:15 UTC):
#   15 3 * * * cd /opt/aviator/deploy/vps && bash ../scripts/backup.sh >> /var/log/aviator-backup.log 2>&1
#
# Temporary game history is EXCLUDED: only table definitions of game_observations and
# ingest_batches are dumped, never their rows, so backups never extend the 12-hour retention.
# Old dump files are deleted after BACKUP_RETENTION_DAYS (default 14).
set -euo pipefail
cd "$(dirname "$0")/../vps"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aviator}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/aviator-$STAMP.dump"

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
  --exclude-table-data=game_observations --exclude-table-data=ingest_batches' > "$OUT.partial"
mv "$OUT.partial" "$OUT"
echo "$(date -u +%FT%TZ) backup written: $OUT ($(du -h "$OUT" | cut -f1))"

find "$BACKUP_DIR" -name 'aviator-*.dump' -type f -mtime +"$RETENTION_DAYS" -print -delete
