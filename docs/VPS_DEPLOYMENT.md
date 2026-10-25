# VPS deployment

> Nothing in this repository deploys automatically. These steps are run by you, on the VPS.
> **Not yet verified:** the Docker images and compose stack were written but could not be built or run here (no Docker on the development machine). Do a trial run on a staging VPS first.

## What goes to the VPS

`backend/`, `shared/contracts/`, `database/migrations/`, `deploy/`, plus the root `package.json` and `package-lock.json`. **Not** `admin-web/` or `extension/` (deployed separately; the backend image narrows the npm workspaces to `shared/contracts` and `backend`, so their folders need not exist), `docs/`, any `.env` other than `deploy/vps/.env`, or local database folders. The repo-root `.dockerignore` enforces this for the image build.

There are two ways to run the same `deploy/vps/docker-compose.yml`:

* **Portainer CE, Git repository stack** → see [Portainer deployment](#portainer-git-repository-stack) below. Secrets live only in Portainer's stack environment variables; no `.env` file exists anywhere.
* **Plain `docker compose` on the server** → sections 1–4. Secrets live in `deploy/vps/.env` on the server only.

The compose file reads every setting through `${VAR}` interpolation, so both work without code changes. The Caddyfile is built into a small image (`deploy/reverse-proxy/Dockerfile`) rather than bind-mounted, because a Portainer Git stack is cloned inside the Portainer container and relative bind-mount paths do not exist on the host.

## Portainer (Git repository stack)

### Variables to set in Portainer

Stack → **Environment variables**. Names only are shown here; generate each secret yourself on a trusted machine with `openssl rand -hex 32` (a separate value for each one). Never put the values in Git, chat, screenshots or tickets.

| Name | Required | Notes |
|---|---|---|
| `API_DOMAIN` | yes | e.g. `api.yourdomain.com` (no `https://`, no path). Caddy requests the certificate for it. |
| `ACME_EMAIL` | yes | Your email for Let's Encrypt notices. |
| `POSTGRES_PASSWORD` | yes | Used only when the `aviator_pgdata` volume is created for the first time. |
| `POSTGRES_USER` | recommended | Default `aviator_app`. |
| `POSTGRES_DB` | recommended | Default `aviator`. |
| `DATABASE_URL` | yes | Exactly `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>`. Host is the service name `postgres`, port `5432`. |
| `CODE_PEPPER` | yes | ≥ 32 chars, all four secrets must differ. Losing it invalidates every unredeemed code. |
| `DEVICE_PEPPER` | yes | ≥ 32 chars. Losing it forces every customer to re-enter their code. |
| `IP_HASH_PEPPER` | yes | ≥ 32 chars. |
| `ADMIN_SERVICE_KEY` | yes | ≥ 32 chars. The same value goes into Vercel as `VPS_ADMIN_SERVICE_KEY`. |
| `ACCEPTED_SITE_IDS`, `ACCEPTED_SITE_DOMAINS`, `LOG_LEVEL`, `DATABASE_POOL_MAX`, `DEFAULT_DEVICE_LIMIT`, `CUSTOMER_SESSION_TTL_HOURS`, `ADMIN_SESSION_TTL_HOURS`, `ANALYSIS_PROVIDER`, `RETENTION_INTERVAL_SECONDS`, `SECURITY_EVENT_RETENTION_DAYS`, `IMAGE_TAG` | optional | Defaults are in `deploy/vps/.env.example`. |

Keep an offline copy of these values (password manager). A missing required variable stops the deploy with `required variable X is missing a value: set X` — the message names the variable, never a value.

### Checks before the first deploy (on the VPS, read-only)

```bash
# 1. Ports 80 and 443 must be free (Caddy needs both). If anything is listed, do NOT stop it:
#    another stack already owns the port and the API must then go behind that proxy instead.
sudo ss -ltnp '( sport = :80 or sport = :443 )'

# 2. The stack's "edge" network uses 172.30.10.0/24. No existing network may overlap it
#    (e.g. 172.30.0.0/16). If one does, pick a free /24 and change BOTH `subnet` and
#    `TRUST_PROXY` in docker-compose.yml to it.
docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'

# 3. Nothing named "aviator" yet. If aviator_pgdata already exists it keeps the database password
#    it was created with (see "Changing the database password" below). Never delete it.
docker volume ls --filter name=aviator_
docker ps -a --filter label=com.docker.compose.project=aviator

# 4. DNS: must print this VPS's public IP. With Cloudflare, use "DNS only" until the certificate is issued.
dig +short "api.yourdomain.com"
```

Also allow inbound TCP 80 and 443 in the VPS provider's firewall/security group, not only in ufw. HTTPS works only once the domain resolves to this VPS **and** ports 80/443 are reachable from the internet.

### Deploy

1. Portainer → **Stacks** → `aviator` (or **Add stack**, name `aviator`) → build method **Repository**.
2. Repository URL `https://github.com/<owner>/<repo>`, reference `refs/heads/main`, Compose path `deploy/vps/docker-compose.yml`. No authentication is needed for a public repository.
3. Add the variables from the table above, then **Deploy the stack** (or **Pull and redeploy** for an existing stack).
4. Portainer builds `aviator-backend` and `aviator-caddy` from the repository. Expected containers: `postgres` healthy → `migrate` exited (0) → `api` healthy and `retention-worker` healthy (after up to ~2 min) → `caddy` running.
5. Check: `docker logs aviator-caddy-1 2>&1 | grep -i certificate` (look for "certificate obtained successfully"), then `curl -s https://api.yourdomain.com/v1/health`.

Updating later: push the new code to GitHub, back up the database, then **Pull and redeploy** in Portainer. Images are rebuilt on every deploy (`pull_policy: build`) and `migrate` applies new migrations before the API restarts.

### Operations without a compose directory

The `deploy/scripts/*.sh` helpers call `docker compose` and need a local `.env`, so with Portainer use these instead (container names come from the stack name `aviator`; confirm with `docker ps --filter label=com.docker.compose.project=aviator`):

| Task | Command |
|---|---|
| Logs | `docker logs --tail 100 aviator-api-1` / `aviator-retention-worker-1` / `aviator-caddy-1` |
| Create or reset admin | `read -rs PW && printf '%s\n' "$PW" \| docker exec -i aviator-api-1 node dist/src/database/cli.js create-admin --email owner@yourdomain.com; unset PW` |
| Retention health | `docker exec aviator-retention-worker-1 node dist/src/database/cli.js retention-status` |
| Backup | `sudo install -d -m 700 /var/backups/aviator && docker exec aviator-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=game_observations --exclude-table-data=ingest_batches' \| sudo tee /var/backups/aviator/aviator-$(date -u +%Y%m%dT%H%M%SZ).dump >/dev/null` |

### Changing the database password

PostgreSQL applies `POSTGRES_PASSWORD` only when the `aviator_pgdata` volume is first created. To change it on an existing database, without deleting anything:

1. `docker exec -it aviator-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\password $POSTGRES_USER"'` and type the new password twice (not echoed, not stored in shell history).
2. Update `POSTGRES_PASSWORD` **and** `DATABASE_URL` in Portainer to the same new value, then **Update the stack**.

### Rotating exposed secrets

If any value was ever shown in a screenshot, chat or commit, treat it as compromised and replace it:

* `POSTGRES_PASSWORD` / `DATABASE_URL`: see above.
* `ADMIN_SERVICE_KEY`: new value in Portainer **and** Vercel `VPS_ADMIN_SERVICE_KEY`, then redeploy both.
* `IP_HASH_PEPPER`: safe to replace any time (only affects hashed IPs in new security events).
* `CODE_PEPPER` / `DEVICE_PEPPER`: replace freely **before** any codes are sold. Afterwards, replacing `CODE_PEPPER` makes unredeemed codes unusable and `DEVICE_PEPPER` forces customers to re-activate — plan it.

## 1. Server preparation (Ubuntu 24.04 example)

```bash
# Docker Engine + compose plugin: https://docs.docker.com/engine/install/ubuntu/
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-admin-ip> to any port 22 proto tcp   # SSH only from you (or use a VPN)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp                                        # HTTP/3 (optional)
sudo ufw enable
```

Only Caddy publishes ports (80/443). PostgreSQL and the API have **no published ports**, so Docker's iptables rules cannot open them past ufw. Verify after starting: `sudo ss -tlnp` must show nothing on 5432 or 8080 on public interfaces.

Use SSH keys only (`PasswordAuthentication no`) and enable unattended security updates.

## 2. Code and secrets

```bash
sudo mkdir -p /opt/aviator && sudo chown $USER /opt/aviator
# copy the files listed above to /opt/aviator (rsync/scp from your machine; no git remote needed)
cd /opt/aviator/deploy/scripts
bash generate-secrets.sh api.yourdomain.com you@yourdomain.com     # writes ../vps/.env (mode 600)
```

Store an **offline copy** of `deploy/vps/.env`. Losing `CODE_PEPPER` makes every unredeemed code unusable. Losing `DEVICE_PEPPER` forces every customer to re-enter their code.

DNS: point an A/AAAA record for `api.yourdomain.com` at the VPS **before** starting Caddy, so it can obtain the certificate.

## 3. Start

```bash
cd /opt/aviator/deploy/vps
docker compose build
docker compose up -d
docker compose ps                     # postgres healthy, migrate exited 0, api up, retention-worker healthy
curl -s https://api.yourdomain.com/v1/health
bash ../scripts/create-admin.sh owner@yourdomain.com
```

## 4. Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f api retention-worker` (JSON; no codes, tokens or history values) |
| Retention health | `docker compose exec retention-worker node dist/src/database/cli.js retention-status` (exit 1 = unhealthy) |
| Backup (cron) | `15 3 * * * cd /opt/aviator/deploy/vps && bash ../scripts/backup.sh >> /var/log/aviator-backup.log 2>&1` |
| Copy backups off-site | e.g. `rclone copy /var/backups/aviator remote:aviator-backups --max-age 15d` (encrypt the remote) |
| Restore | `docker compose stop api retention-worker && bash ../scripts/restore.sh <file> && docker compose up -d` |
| Update | **back up first** (`bash ../scripts/backup.sh`), copy new code → `docker compose build && docker compose up -d` (the `migrate` container applies pending migrations before the API starts) |
| Give existing codes 5 devices (optional, explicit) | `docker compose run --rm migrate node dist/src/database/cli.js raise-device-limits --to 5` (dry run), then add `--apply` |
| Rotate service key | change `ADMIN_SERVICE_KEY` in `.env` and Vercel's `VPS_ADMIN_SERVICE_KEY`, then `docker compose up -d api` and redeploy Vercel |

## Recovery

1. Fresh VPS → steps 1–2 using the **saved** `.env` (same peppers).
2. `docker compose up -d postgres migrate`, then `restore.sh <latest dump>`.
3. `docker compose up -d`. Subscriptions, codes and devices are restored. Temporary history is intentionally absent (it was never backed up).

## Monitoring checklist

* External uptime check on `https://api.yourdomain.com/v1/health/ready`.
* Alert when `retention-worker` is `unhealthy` (see DATA_RETENTION.md).
* Watch disk usage of the `pgdata` volume and `/var/backups/aviator`.
* Review `security_events` periodically (failed admin logins, lockouts, device resets).
