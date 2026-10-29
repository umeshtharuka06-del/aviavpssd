# Deployment Overview

Aviator has three deployment targets. Each is independent — deploy them in the order below.

| Component | Runs On | Directory | Guide |
|-----------|---------|-----------|-------|
| API + DB + Retention Worker | VPS (Docker Compose) | `backend/`, `database/`, `deploy/vps/` | [VPS Deployment](docs/VPS_DEPLOYMENT.md) |
| Admin Site | Vercel | `admin-web/` | [Vercel Deployment](docs/VERCEL_DEPLOYMENT.md) |
| Chrome Extension | Chrome Web Store | `extension/` | [Extension Packaging](docs/EXTENSION_PACKAGING.md) |

## Order of Operations

1. **VPS first** — the API must be running before the admin site or extension can connect.
2. **Admin site second** — needs the VPS API URL and `ADMIN_SERVICE_KEY` as Vercel env vars.
3. **Extension last** — built with the production API URL baked in at compile time.

## Quick Reference

```
# 1. VPS: generate secrets and start the stack
#    (Portainer Git stack: set the variables in Portainer instead — see docs/VPS_DEPLOYMENT.md)
cd deploy/vps
bash ../scripts/generate-secrets.sh api.yourdomain.com you@example.com
docker compose up -d --build
bash ../scripts/create-admin.sh admin@yourdomain.com

# 2. Vercel: set env vars and deploy
#    VPS_API_URL=https://api.yourdomain.com  (server-only)
#    VPS_ADMIN_SERVICE_KEY=<from .env>        (server-only)
#    Then deploy via Vercel CLI or Git push

# 3. Extension: build and package
EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run package -w @aviator/extension
# Upload extension/release/aviator-extension-*.zip to Chrome Web Store
```

## Checklists & Scripts

- [Deployment Checklist](deploy/DEPLOYMENT_CHECKLIST.md) — step-by-step verification for all three targets
- [Validate Environment](deploy/scripts/validate-env.sh) — checks `.env` before first start
- [Generate Secrets](deploy/scripts/generate-secrets.sh) — creates `.env` with random secrets
- [Create Admin](deploy/scripts/create-admin.sh) — sets up the admin account
- [Health Check](deploy/scripts/health-check.sh) — post-deployment smoke test
- [Package VPS](deploy/scripts/package-vps.sh) — builds a minimal deployment tarball
- [Package Extension](deploy/scripts/package-extension.sh) — production extension build + zip
- [Backup](deploy/scripts/backup.sh) — nightly database backup
- [Restore](deploy/scripts/restore.sh) — restore from backup

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system diagram, data flow, and design decisions.
