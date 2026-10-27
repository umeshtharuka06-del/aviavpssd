#!/usr/bin/env bash
# Creates (or resets the password of) an admin account. Prompts for the password on stdin.
#   bash create-admin.sh owner@yourdomain.com
set -euo pipefail
cd "$(dirname "$0")/../vps"
EMAIL="${1:?usage: create-admin.sh <email>}"
read -r -s -p "New admin password (min 12 chars): " PW; echo
printf '%s\n' "$PW" | docker compose run --rm -T migrate node dist/src/database/cli.js create-admin --email "$EMAIL"
