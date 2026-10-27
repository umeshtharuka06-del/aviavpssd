#!/usr/bin/env bash
# Creates a minimal tarball for deploying the VPS stack.
# Includes only what Docker Compose needs — no admin-web, extension, docs, tests, or dev tooling.
# The images compile from source (backend/Dockerfile runs tsc, and .dockerignore excludes dist), so
# the tarball carries sources and tsconfigs, not dist. The local build below is only a pre-check.
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
  backend/tsconfig.json \
  backend/tsconfig.build.json \
  backend/src/ \
  backend/Dockerfile \
  shared/contracts/package.json \
  shared/contracts/tsconfig.json \
  shared/contracts/src/ \
  database/migrations/ \
  deploy/vps/docker-compose.yml \
  deploy/vps/.env.example \
  deploy/reverse-proxy/Caddyfile \
  deploy/reverse-proxy/Dockerfile \
  deploy/scripts/ \
  deploy/DEPLOYMENT_CHECKLIST.md \
  package.json \
  package-lock.json \
  .dockerignore

echo "Created: $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"
echo ""
echo "To deploy:"
echo "  1. Copy $OUTFILE to the VPS"
echo "  2. Extract in the deploy root. When updating, first remove the old sources so deleted files"
echo "     do not linger and get compiled (deploy/vps/.env is not touched):"
echo "       rm -rf backend/src shared/contracts/src database/migrations && tar xzf $(basename "$OUTFILE")"
echo "  3. Follow deploy/DEPLOYMENT_CHECKLIST.md"
