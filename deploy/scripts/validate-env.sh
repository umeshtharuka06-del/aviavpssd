#!/usr/bin/env bash
# Validates deploy/vps/.env before first start.
# Checks: all required vars present, no placeholders, secrets are unique and long enough.
#   bash deploy/scripts/validate-env.sh
set -euo pipefail
cd "$(dirname "$0")/../vps"

if [ ! -f .env ]; then
  echo "FAIL: deploy/vps/.env not found."
  echo "  Run: bash deploy/scripts/generate-secrets.sh <domain> <email>"
  exit 1
fi

ERRORS=0
err() { echo "FAIL: $1"; ERRORS=$((ERRORS + 1)); }

# Source the .env file safely (values only, no command execution)
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^# ]] && continue
  value="${value#\"}"
  value="${value%\"}"
  declare "ENV_$key=$value"
done < .env

# Required variables
REQUIRED=(
  API_DOMAIN ACME_EMAIL
  POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL
  CODE_PEPPER DEVICE_PEPPER IP_HASH_PEPPER ADMIN_SERVICE_KEY
)

for var in "${REQUIRED[@]}"; do
  envvar="ENV_$var"
  val="${!envvar:-}"
  if [ -z "$val" ]; then
    err "$var is missing or empty"
  elif [[ "$val" =~ ^(change-me|placeholder|xxxx) ]]; then
    err "$var still has a placeholder value: $val"
  fi
done

# Secrets must be at least 32 characters
SECRETS=(CODE_PEPPER DEVICE_PEPPER IP_HASH_PEPPER ADMIN_SERVICE_KEY)
for var in "${SECRETS[@]}"; do
  envvar="ENV_$var"
  val="${!envvar:-}"
  if [ -n "$val" ] && [ "${#val}" -lt 32 ]; then
    err "$var is only ${#val} characters (minimum 32)"
  fi
done

# All four secrets must be different
seen=()
for var in "${SECRETS[@]}"; do
  envvar="ENV_$var"
  val="${!envvar:-}"
  for prev in "${seen[@]+"${seen[@]}"}"; do
    if [ "$val" = "$prev" ]; then
      err "$var is a duplicate of another secret"
      break
    fi
  done
  seen+=("$val")
done

# POSTGRES_PASSWORD should match what's in DATABASE_URL
pg_pass="${ENV_POSTGRES_PASSWORD:-}"
db_url="${ENV_DATABASE_URL:-}"
if [ -n "$pg_pass" ] && [ -n "$db_url" ]; then
  if [[ "$db_url" != *"$pg_pass"* ]]; then
    err "POSTGRES_PASSWORD does not appear in DATABASE_URL (they must match)"
  fi
fi

# Domain should not be the example placeholder
domain="${ENV_API_DOMAIN:-}"
if [ "$domain" = "api.example.com" ]; then
  err "API_DOMAIN is still set to api.example.com"
fi

email="${ENV_ACME_EMAIL:-}"
if [ "$email" = "you@example.com" ]; then
  err "ACME_EMAIL is still set to you@example.com"
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "$ERRORS problem(s) found. Fix them before starting the stack."
  exit 1
else
  echo "OK: .env looks good. All required variables set, secrets are unique and long enough."
fi
