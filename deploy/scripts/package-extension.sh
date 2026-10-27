#!/usr/bin/env bash
# Builds the production Chrome extension and creates the versioned .zip for Chrome Web Store.
#   bash deploy/scripts/package-extension.sh https://api.yourdomain.com
set -euo pipefail
cd "$(dirname "$0")/../.."

API_URL="${1:?Usage: package-extension.sh <https://api.yourdomain.com>}"

if [[ ! "$API_URL" =~ ^https:// ]]; then
  echo "ERROR: API URL must start with https:// for production builds."
  exit 1
fi

echo "Building contracts..."
npm run build:contracts --if-present

echo "Building production extension with API: $API_URL"
EXTENSION_API_BASE_URL="$API_URL" npm run package -w @aviator/extension

VERSION=$(node -p "require('./extension/package.json').version" 2>/dev/null || echo "0.0.0")
ZIP="extension/release/aviator-extension-$VERSION.zip"

if [ -f "$ZIP" ]; then
  echo ""
  echo "Package ready: $ZIP ($(du -h "$ZIP" | cut -f1))"
  echo ""
  echo "Verify before uploading:"
  echo "  1. Unzip and check manifest.json for correct API origin"
  echo "  2. Run: npm run test:secrets"
  echo "  3. Upload to Chrome Web Store developer console"
else
  echo "ERROR: Expected zip not found at $ZIP"
  exit 1
fi
