# Deployment files

| Path | Purpose |
|---|---|
| `vps/docker-compose.yml` | postgres (internal network, no port), migrate, api, retention-worker, caddy |
| `vps/.env.example` | placeholders; the real `.env` is created on the VPS only |
| `reverse-proxy/Caddyfile` | HTTPS, body limit, security headers, header-free access logs |
| `scripts/generate-secrets.sh` | creates `vps/.env` with random secrets (never overwrites) |
| `scripts/create-admin.sh` | creates or resets an admin (password via prompt) |
| `scripts/backup.sh` / `restore.sh` | `pg_dump` without history rows and 14-day rotation / guarded restore |

Guides: [VPS](../docs/VPS_DEPLOYMENT.md) · [Vercel](../docs/VERCEL_DEPLOYMENT.md) · [Extension](../docs/EXTENSION_PACKAGING.md). Nothing here runs automatically.
