#!/usr/bin/env bash
# Post-deployment smoke test: checks API health and readiness.
#   bash deploy/scripts/health-check.sh [https://api.yourdomain.com]
#
# If no URL is given, reads API_DOMAIN from deploy/vps/.env.
set -euo pipefail

if [ -n "${1:-}" ]; then
  BASE_URL="$1"
else
  ENV_FILE="$(dirname "$0")/../vps/.env"
  if [ -f "$ENV_FILE" ]; then
    DOMAIN=$(grep -E '^API_DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    BASE_URL="https://$DOMAIN"
  else
    echo "Usage: health-check.sh [https://api.yourdomain.com]"
    echo "  Or create deploy/vps/.env with API_DOMAIN set."
    exit 1
  fi
fi

ERRORS=0

check() {
  local name="$1" url="$2"
  printf "%-30s" "$name..."
  HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "OK (200)"
  else
    echo "FAIL (HTTP $HTTP_CODE)"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "Checking $BASE_URL"
echo "---"
check "Health (liveness)"      "$BASE_URL/v1/health"
check "Ready (DB connected)"   "$BASE_URL/v1/health/ready"
echo "---"

if [ "$ERRORS" -gt 0 ]; then
  echo "$ERRORS check(s) failed."
  exit 1
else
  echo "All checks passed."
fi
