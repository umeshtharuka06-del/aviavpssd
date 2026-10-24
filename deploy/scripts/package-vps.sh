#!/usr/bin/env bash
# Creates a minimal tarball for deploying the VPS stack.
# Includes only what Docker Compose needs — no admin-web, extension, docs, tests, or dev tooling.
#   bash deploy/scripts/package-vps.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
OUTDIR="dist"
OUTFILE="$OUTDIR/aviator-vps-$VERSION.tar.gz"

mkdir -p "$OUTDIR"

echo "Building contracts..."
npm run build:contracts --if-present

echo "Building backend..."
npm run build -w @aviator/backend --if-present

echo "Packaging VPS deployment tarball..."
tar czf "$OUTFILE" \
  --exclude='node_modules' \
  --exclude='*.test.ts' \
  --exclude='*.test.js' \
  --exclude='tests/' \
  --exclude='.env' \
  --exclude='.local-pg' \
  backend/package.json \
  backend/dist/ \
  backend/Dockerfile \
  shared/contracts/package.json \
  shared/contracts/dist/ \
  database/migrations/ \
  deploy/vps/docker-compose.yml \
  deploy/vps/.env.example \
  deploy/reverse-proxy/Caddyfile \
  deploy/scripts/ \
  deploy/DEPLOYMENT_CHECKLIST.md \
  package.json \
  package-lock.json \
  .dockerignore

echo "Created: $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"
echo ""
echo "To deploy:"
echo "  1. Copy $OUTFILE to the VPS"
echo "  2. Extract: tar xzf $(basename "$OUTFILE")"
echo "  3. Follow deploy/DEPLOYMENT_CHECKLIST.md"
