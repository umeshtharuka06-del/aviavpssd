#!/usr/bin/env bash
# Restore a dump produced by backup.sh into the running postgres container.
#   bash restore.sh /var/backups/aviator/aviator-20260101T031500Z.dump
# DESTRUCTIVE: replaces current data. Stop api and retention-worker first:
#   docker compose stop api retention-worker
set -euo pipefail
DUMP="${1:?usage: restore.sh <dump-file>}"
cd "$(dirname "$0")/../vps"
read -r -p "This REPLACES the current database with $DUMP. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "aborted"; exit 1; }
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$DUMP"
echo "Restored. Start services again: docker compose up -d api retention-worker"
