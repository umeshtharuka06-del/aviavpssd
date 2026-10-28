#!/usr/bin/env bash
# Creates deploy/vps/.env from .env.example with fresh random secrets (only if .env is absent).
#   bash generate-secrets.sh api.yourdomain.com you@yourdomain.com
set -euo pipefail
cd "$(dirname "$0")/../vps"
[ -e .env ] && { echo ".env already exists; not overwriting."; exit 1; }
DOMAIN="${1:?usage: generate-secrets.sh <api-domain> <acme-email>}"
EMAIL="${2:?usage: generate-secrets.sh <api-domain> <acme-email>}"
rand() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }
PG="$(rand)"
umask 077
sed -e "s|^API_DOMAIN=.*|API_DOMAIN=$DOMAIN|" \
    -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$EMAIL|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG|" \
    -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://aviator_app:$PG@postgres:5432/aviator|" \
    -e "s|^CODE_PEPPER=.*|CODE_PEPPER=$(rand)|" \
    -e "s|^DEVICE_PEPPER=.*|DEVICE_PEPPER=$(rand)|" \
    -e "s|^IP_HASH_PEPPER=.*|IP_HASH_PEPPER=$(rand)|" \
    -e "s|^ADMIN_SERVICE_KEY=.*|ADMIN_SERVICE_KEY=$(rand)|" \
    .env.example > .env
chmod 600 .env
echo "Wrote deploy/vps/.env (mode 600). Copy ADMIN_SERVICE_KEY into Vercel as VPS_ADMIN_SERVICE_KEY."
echo "Back up .env somewhere safe and offline: losing CODE_PEPPER invalidates every unredeemed code."
