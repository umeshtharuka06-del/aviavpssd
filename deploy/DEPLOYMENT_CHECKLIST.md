# Deployment Checklist

Pre-deployment verification for all three components. Complete each section in order.

---

## 1. VPS (API + Database + Retention Worker)

Docs: [VPS Deployment Guide](../docs/VPS_DEPLOYMENT.md)

### Prerequisites

- [ ] VPS provisioned (Ubuntu 22.04+, 2 GB RAM minimum)
- [ ] Docker Engine and Docker Compose v2 installed
- [ ] DNS A/AAAA record for `api.yourdomain.com` pointing to VPS IP
- [ ] Firewall allows inbound 80/tcp and 443/tcp only (SSH on a non-standard port)
- [ ] Project files transferred to VPS (e.g. `/opt/aviator/`)

### Secrets & Configuration

- [ ] Run `bash deploy/scripts/generate-secrets.sh api.yourdomain.com you@example.com`
- [ ] Verify `.env` exists at `deploy/vps/.env` with mode 600
- [ ] Confirm all four peppers/keys are unique and >= 32 characters:
  - `CODE_PEPPER`
  - `DEVICE_PEPPER`
  - `IP_HASH_PEPPER`
  - `ADMIN_SERVICE_KEY`
- [ ] Confirm `POSTGRES_PASSWORD` is not a placeholder
- [ ] Set `API_DOMAIN` to the real public hostname
- [ ] Set `ACME_EMAIL` to a real email for Let's Encrypt notices
- [ ] Optionally run `bash deploy/scripts/validate-env.sh` to verify automatically
- [ ] Back up `.env` offline (losing `CODE_PEPPER` invalidates all unredeemed codes)

### Caddyfile

- [ ] No edit needed: the Caddyfile reads `API_DOMAIN` and `ACME_EMAIL` from the environment and is built into the `aviator-caddy` image (`deploy/reverse-proxy/Dockerfile`)
- [ ] Ports 80/443 are free on the VPS and reachable from the internet; DNS for `API_DOMAIN` resolves to the VPS
- [ ] Portainer users: follow the "Portainer (Git repository stack)" section of the VPS guide instead of creating `.env`

### First Start

- [ ] `cd deploy/vps && docker compose up -d`
- [ ] Check migration container exited successfully: `docker compose logs migrate`
- [ ] Check API is healthy: `curl -s https://api.yourdomain.com/v1/health`
- [ ] Check readiness (DB connected): `curl -s https://api.yourdomain.com/v1/health/ready`
- [ ] Check retention worker is running: `docker compose ps retention-worker`

### Admin Account

- [ ] Create admin: `bash deploy/scripts/create-admin.sh admin@yourdomain.com`
- [ ] Note the `ADMIN_SERVICE_KEY` value — needed for the Vercel admin site

### Backups

- [ ] Test backup: `bash deploy/scripts/backup.sh`
- [ ] Schedule nightly backup in cron:
  ```
  15 3 * * * cd /opt/aviator/deploy/vps && bash ../scripts/backup.sh >> /var/log/aviator-backup.log 2>&1
  ```
- [ ] Test restore procedure with `deploy/scripts/restore.sh` on a separate database

---

## 2. Admin Site (Vercel)

Docs: [Vercel Deployment Guide](../docs/VERCEL_DEPLOYMENT.md)

### Prerequisites

- [ ] Vercel account with the project linked to your Git repository
- [ ] VPS API is running and reachable over HTTPS

### Environment Variables (Vercel Dashboard)

Set these as **server-side only** (no `NEXT_PUBLIC_` prefix):

- [ ] `VPS_API_URL` = `https://api.yourdomain.com` (must be HTTPS in production)
- [ ] `VPS_ADMIN_SERVICE_KEY` = the same `ADMIN_SERVICE_KEY` from VPS `.env`

### Build Settings

- [ ] Framework preset: Next.js
- [ ] Root directory: `admin-web`
- [ ] Install command: `npm install` (from repo root — Vercel handles workspaces)
- [ ] Build command: `npm run build -w @aviator/admin-web`

### Deploy & Verify

- [ ] Deploy via Vercel CLI or Git push
- [ ] Access the admin URL and confirm the login page loads
- [ ] Log in with the admin credentials created in VPS step
- [ ] Verify the Overview page shows code stats and retention health
- [ ] Confirm the site returns `X-Robots-Tag: noindex, nofollow` headers
- [ ] Confirm the site has no `NEXT_PUBLIC_` variables leaking secrets

### Domain (Optional)

- [ ] Add custom domain in Vercel dashboard
- [ ] Verify DNS and SSL certificate

---

## 3. Chrome Extension

Docs: [Extension Packaging Guide](../docs/EXTENSION_PACKAGING.md)

### Build

- [ ] Set the production API URL:
  ```bash
  EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run build:prod -w @aviator/extension
  ```
- [ ] Verify `extension/build/manifest.json` has:
  - Correct API origin in `host_permissions`
  - Correct API origin in `content_security_policy`
  - No `localhost` or `127.0.0.1` references

### Package

- [ ] Build the zip:
  ```bash
  EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run package -w @aviator/extension
  ```
- [ ] Verify zip exists at `extension/release/aviator-extension-<version>.zip`
- [ ] Unzip into a temp folder and inspect: manifest, background.js, content-script.js, popup.html, icons

### Secret Scan

- [ ] Run the secret separation test:
  ```bash
  npm run test:secrets
  ```
- [ ] Confirm no peppers, service keys, or database URLs appear in the extension bundle

### Chrome Web Store (when ready)

- [ ] Create developer account at https://chrome.google.com/webstore/devconsole
- [ ] Upload the `.zip` as a new extension
- [ ] Fill in listing: description, screenshots, privacy policy
- [ ] Privacy disclosure: declare `storage`, `scripting`, `alarms`, `activeTab` permissions
- [ ] Submit for review

---

## 4. Post-Deployment Smoke Tests

- [ ] API health: `curl -sf https://api.yourdomain.com/v1/health | jq .`
- [ ] API readiness: `curl -sf https://api.yourdomain.com/v1/health/ready | jq .`
- [ ] Admin login works through the Vercel-hosted site
- [ ] Generate a test activation code via admin site
- [ ] Install extension (dev mode or from store), redeem the test code
- [ ] Extension shows "Active" state after redemption
- [ ] Visit a supported site, confirm detection popup appears
- [ ] Request analysis (expect mock/test data response)
- [ ] Retention worker is purging: check `docker compose logs retention-worker`

---

## 5. Operational Notes

| Task | Command | Schedule |
|------|---------|----------|
| View API logs | `docker compose logs -f api` | On demand |
| View retention logs | `docker compose logs -f retention-worker` | On demand |
| Restart stack | `docker compose restart` | On demand |
| Update images | `docker compose pull && docker compose up -d` | After code changes |
| Run backup | `bash deploy/scripts/backup.sh` | Nightly via cron |
| Restore backup | `bash deploy/scripts/restore.sh <dump-file>` | Emergency only |
| Check retention health | Admin site Overview page or API logs | Daily |
| Rotate secrets | Generate new values, update `.env`, restart stack | As needed |
