# Deploying the live rounds export to the Contabo VPS — runbook

**Status: prepared, not executed.** Run the steps in order, one at a time. Where a step says **STOP**, do not continue; send me the output instead.

Design (why it is safe):
- The export ships as a **separate image tag** (`aviator-backend:export-20261031`), built from an uploaded source tree in its own folder.
- The running stack keeps its image: `aviator-backend:latest` is **not** rebuilt or re-tagged.
- Compose is not used, so no service is recreated.
- `aviator-api-1`, `aviator-retention-worker-1`, `aviator-postgres-1` and `aviator-caddy-1` are **never restarted**.
- **No migration** runs.
- The export itself runs in a **one-off container** (`docker run --rm`). It has the same network, environment and hardening as the API container. It writes only to a mounted host folder.

Placeholders (replace them everywhere):
- `<VPS_USER>`: your SSH user (needs `sudo`).
- `<VPS_HOST>`: the VPS IP or hostname.

Windows commands are **PowerShell** on your PC. VPS commands are **bash** over SSH.

---

## Part A — on your Windows PC: package the code

### A1. Build the final code locally (needed for the compiled comparison in B5)
```powershell
cd C:\Users\user\Downloads\project\aviator\aviator
Remove-Item -Recurse -Force backend\dist, shared\contracts\dist -ErrorAction SilentlyContinue   # no stale files from older builds
npm run build:contracts
npm run build -w @aviator/backend
```

### A2. Package the source the image is built from (no secrets, no local data)
```powershell
tar -czf $env:USERPROFILE\aviator-export-src.tgz --exclude=node_modules --exclude=dist --exclude=.env --exclude=.local-pg --exclude=coverage --exclude=.next package.json package-lock.json .dockerignore backend shared/contracts database/migrations
```

### A3. Prove the package holds no secret or local database file
```powershell
tar -tzf $env:USERPROFILE\aviator-export-src.tgz | Select-String -Pattern '(^|/)\.env$|\.local-pg|credentials|\.pem$|\.key$'
```
**Expected: no output.** If anything is listed, **STOP**.

### A4. Package the locally compiled output (for comparison only; never deployed)
```powershell
tar -czf $env:USERPROFILE\aviator-local-dist.tgz backend/dist/src shared/contracts/dist
```

### A5. Upload both files
```powershell
scp $env:USERPROFILE\aviator-export-src.tgz $env:USERPROFILE\aviator-local-dist.tgz <VPS_USER>@<VPS_HOST>:~/
```

---

## Part B — on the VPS: compare production with the local checkout (nothing changes)

```bash
ssh <VPS_USER>@<VPS_HOST>
```

### B1. Record the state of the running stack (used to prove nothing changed)
```bash
docker inspect -f '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}}' \
  aviator-api-1 aviator-retention-worker-1 aviator-postgres-1 aviator-caddy-1 | tee ~/containers-before.txt
docker image inspect aviator-backend:latest --format '{{.Id}}' | tee ~/image-latest-before.txt
docker exec aviator-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT name, checksum FROM schema_migrations ORDER BY name"' | tee ~/migrations-before.txt
curl -fsS https://api.shoptrack.site/v1/health; echo
df -h / /var/lib/docker
```
Expected:
- four containers `running`;
- seven migrations `0001_…` to `0007_…`;
- the health check returns `{"status":"ok",...}`;
- at least 3 GB free.

Keep this SSH session open through Part F: later steps reuse the shell variables (`PROD_SRC`, `CSV`, `MAN`).

### B2. Find the production source folder
```bash
WD=$(docker inspect aviator-api-1 --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
echo "compose working dir: $WD"
PROD_SRC=$(realpath "$WD/../..")
echo "production source: $PROD_SRC"
ls "$PROD_SRC/backend/src" >/dev/null && echo "source present" || echo "NO SOURCE ON HOST (Portainer?) - skip B4, B5 is decisive"
```

### B3. Unpack the uploaded code into its own folder
```bash
sudo rm -rf /opt/aviator-export-src /tmp/aviator-local-dist
sudo install -d -m 755 /opt/aviator-export-src /tmp/aviator-local-dist
sudo tar -xzf ~/aviator-export-src.tgz -C /opt/aviator-export-src
sudo tar -xzf ~/aviator-local-dist.tgz -C /tmp/aviator-local-dist
```

### B4. Compare the source (only when B2 found a source folder)
```bash
sudo diff -rq "$PROD_SRC/backend/src"          /opt/aviator-export-src/backend/src
sudo diff -rq "$PROD_SRC/shared/contracts/src" /opt/aviator-export-src/shared/contracts/src
sudo diff -rq "$PROD_SRC/database/migrations"  /opt/aviator-export-src/database/migrations
for f in package.json package-lock.json backend/package.json backend/Dockerfile shared/contracts/package.json; do
  sudo cmp -s "$PROD_SRC/$f" "/opt/aviator-export-src/$f" && echo "same     $f" || echo "DIFFERS  $f"
done
sudo diff -rq "$PROD_SRC/backend/tests" /opt/aviator-export-src/backend/tests
```
**Expected, and nothing else:**
```
Only in /opt/aviator-export-src/backend/src: export
Files .../backend/src/database/cli.ts and .../backend/src/database/cli.ts differ
Files .../backend/src/security/events.ts and .../backend/src/security/events.ts differ
same     package.json  (and the other four files: same)
Only in /opt/aviator-export-src/backend/tests: export.test.ts         (tests are not in the image)
Only in /opt/aviator-export-src/backend/tests: strategy-parity.test.ts
```
Review the two edited files (only additions should appear):
```bash
sudo diff -u "$PROD_SRC/backend/src/database/cli.ts"     /opt/aviator-export-src/backend/src/database/cli.ts
sudo diff -u "$PROD_SRC/backend/src/security/events.ts"  /opt/aviator-export-src/backend/src/security/events.ts
```
In both files, the lines marked `-` must be only the single help line (`console.error('Commands: …')`), which is replaced by a longer version. **Any other difference: STOP.**

### B5. Compare what is actually running (decisive; works with Portainer too)
This copies the compiled code out of the running API container. It is a read; the container is not affected.
```bash
sudo rm -rf /tmp/aviator-prod-dist && sudo install -d -m 755 /tmp/aviator-prod-dist/backend /tmp/aviator-prod-dist/shared/contracts
sudo docker cp aviator-api-1:/app/backend/dist/src         /tmp/aviator-prod-dist/backend/
sudo docker cp aviator-api-1:/app/shared/contracts/dist    /tmp/aviator-prod-dist/shared/contracts/
sudo diff -rq /tmp/aviator-prod-dist/backend/src          /tmp/aviator-local-dist/backend/dist/src
sudo diff -rq /tmp/aviator-prod-dist/shared/contracts/dist /tmp/aviator-local-dist/shared/contracts/dist
```
**Expected, and nothing else:**
```
Only in /tmp/aviator-local-dist/backend/dist/src: export
Files /tmp/aviator-prod-dist/backend/src/database/cli.js and /tmp/aviator-local-dist/backend/dist/src/database/cli.js differ
Files /tmp/aviator-prod-dist/backend/src/security/events.js and /tmp/aviator-local-dist/backend/dist/src/security/events.js differ
```
The contracts comparison must print nothing.

If B5 shows **any other** file, the running production code is not this checkout plus the export. **STOP** and send me the output. Do not build.

---

## Part C — on the VPS: build the export image (running services untouched)

### C1. Optional safety backup (the export never writes game data, but this is cheap)
Same command as VPS_DEPLOYMENT.md (no history rows):
```bash
sudo install -d -m 700 /var/backups/aviator
docker exec aviator-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=game_observations --exclude-table-data=ingest_batches' \
  | sudo tee /var/backups/aviator/aviator-$(date -u +%Y%m%dT%H%M%SZ).dump >/dev/null
sudo ls -l /var/backups/aviator | tail -2
```

### C2. Build under a new tag only (a few minutes of CPU; prefer a quiet hour)
```bash
cd /opt/aviator-export-src
sudo docker build -f backend/Dockerfile -t aviator-backend:export-20261031 .
```

### C3. Confirm the new image has the command, and `latest` is unchanged
```bash
docker run --rm --entrypoint sh aviator-backend:export-20261031 -c 'ls dist/src/export && grep -c "export-rounds" dist/src/database/cli.js && id'
docker image inspect aviator-backend:latest --format '{{.Id}}' | diff - ~/image-latest-before.txt && echo "latest unchanged"
```
Expected: `rounds-export.js`, a count of at least `1`, a line `uid=…(app) gid=…(app)` (**note both numbers**), and `latest unchanged`.

---

## Part D — on the VPS: prepare and run the export

### D1. Host export folder, owned by the container user, owner-only
Use the uid and gid from C3, for example `100` and `101`:
```bash
APP_UID=<uid from C3>; APP_GID=<gid from C3>
sudo install -d -m 700 -o "$APP_UID" -g "$APP_GID" /var/lib/aviator-exports
sudo stat -c '%A %u:%g %n' /var/lib/aviator-exports
```
Expected: `drwx------ <uid>:<gid> /var/lib/aviator-exports`.

### D2. Network and environment of the running API (environment goes to a root-only temporary file)
```bash
docker inspect aviator-postgres-1 --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}'
```
Expected: `aviator_db` (if the name differs, use it below).
```bash
sudo sh -c 'umask 077; docker inspect aviator-api-1 --format "{{range .Config.Env}}{{println .}}{{end}}" > /root/aviator-export.env'
sudo stat -c '%A %U %n' /root/aviator-export.env
sudo grep -c '^DATABASE_URL=' /root/aviator-export.env
```
Expected: `-rw------- root /root/aviator-export.env` and `1`. Do **not** print the file: it holds the secrets.

### D3. Run the export (one-off container: same network and hardening as the services)
```bash
sudo docker run --rm \
  --name aviator-export-once \
  --network aviator_db \
  --env-file /root/aviator-export.env \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v /var/lib/aviator-exports:/exports \
  aviator-backend:export-20261031 \
  node dist/src/database/cli.js export-rounds --out /exports --site onexbet
```
Expected output:
```
Exported <N> rounds in <S> stream(s), <R> run(s) → /exports/rounds-onexbet-<UTC>.csv
Manifest /exports/rounds-onexbet-<UTC>.manifest.json (sha256 <64 hex>)
```
To export all sites, leave out `--site onexbet`. For a window, add `--since 2026-10-31T00:00:00Z --until 2026-10-31T06:00:00Z`.

### D4. Remove the temporary secrets file immediately
```bash
sudo shred -u /root/aviator-export.env; sudo ls /root/aviator-export.env 2>/dev/null || echo "env file removed"
```

---

## Part E — on the VPS: verify

### E1. Files, permissions, checksum
```bash
cd /var/lib/aviator-exports
sudo ls -l
sudo stat -c '%A %u:%g %n' rounds-onexbet-*
CSV=$(sudo sh -c 'ls rounds-onexbet-*.csv | tail -1'); MAN="${CSV%.csv}.manifest.json"; echo "$CSV $MAN"
sudo sha256sum "$CSV"
sudo grep -o '"csvSha256": "[0-9a-f]*"' "$MAN"
```
Expected:
- both files are `-rw------- <uid>:<gid>`;
- the two SHA-256 values are **identical**.

### E2. Content checks (no identifiers)
```bash
sudo head -1 "$CSV"
sudo sed -n '2,4p' "$CSV"
sudo grep -Eic '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$CSV"
sudo grep -Ec '(^|,)dv_|(^|,)ac_' "$CSV"
sudo grep -o '"counts": {[^}]*}' "$MAN"
```
Expected:
- the header is exactly `schema_version,site_id,stream,obs_id,received_at,multiplier,source,chain,chain_index,break_before,verified_successor,run_id`;
- streams look like `s_` followed by 16 hex characters;
- both counts print `0`;
- `rows` matches the D3 output.

### E3. Audit event (counts only)
```bash
docker exec aviator-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT occurred_at, actor, detail FROM security_events WHERE event_type = '\''admin.rounds_exported'\'' ORDER BY id DESC LIMIT 3;"'
```
Expected: one new row with `actor = cli` and `detail` holding only `site`, `since`, `until`, `rows` and `streams`.

### E4. Prove the running stack was not touched
```bash
docker inspect -f '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}} {{.State.Status}}' \
  aviator-api-1 aviator-retention-worker-1 aviator-postgres-1 aviator-caddy-1 | diff - ~/containers-before.txt && echo "containers unchanged"
docker image inspect aviator-backend:latest --format '{{.Id}}' | diff - ~/image-latest-before.txt && echo "latest image unchanged"
docker exec aviator-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT name, checksum FROM schema_migrations ORDER BY name"' | diff - ~/migrations-before.txt && echo "no migration ran"
curl -fsS https://api.shoptrack.site/v1/health; echo
```
Expected: `containers unchanged`, `latest image unchanged`, `no migration ran`, and `{"status":"ok",...}`.

---

## Part F — copy to your Windows PC, then delete from the VPS

### F1. On the VPS: stage a copy your SSH user can read
```bash
install -d -m 700 ~/aviator-export-out
sudo install -m 600 -o "$USER" -g "$(id -gn)" "/var/lib/aviator-exports/$CSV" "/var/lib/aviator-exports/$MAN" ~/aviator-export-out/
ls -l ~/aviator-export-out
```

### F2. On Windows: an encrypted folder, then copy
`cipher /e` turns on Windows EFS for the folder (Windows 10 Enterprise), so the files are encrypted at rest as they arrive. BitLocker on the drive is an alternative.
```powershell
New-Item -ItemType Directory -Force C:\Users\user\aviator-exports | Out-Null
cipher /e C:\Users\user\aviator-exports
scp "<VPS_USER>@<VPS_HOST>:~/aviator-export-out/*" C:\Users\user\aviator-exports\
```

### F3. On Windows: verify the checksum after transfer
```powershell
cd C:\Users\user\aviator-exports
$csv = Get-ChildItem rounds-*.csv | Sort-Object Name | Select-Object -Last 1
$man = Get-Content ($csv.FullName -replace '\.csv$', '.manifest.json') -Raw | ConvertFrom-Json
$hash = (Get-FileHash $csv.FullName -Algorithm SHA256).Hash.ToLower()
if ($hash -eq $man.csvSha256) { "checksum OK $hash" } else { "CHECKSUM MISMATCH - do not use" }
```

### F4. On the VPS: delete every server copy (only after F3 says OK)
```bash
shred -u ~/aviator-export-out/* && rmdir ~/aviator-export-out
sudo shred -u "/var/lib/aviator-exports/$CSV" "/var/lib/aviator-exports/$MAN"
sudo ls -A /var/lib/aviator-exports
```
Expected: an empty listing. On SSD or journaling filesystems `shred` cannot guarantee physical erasure, but it removes the files and overwrites what it can.

### F5. On the VPS: clean the comparison material (nothing secret, but no longer needed)
```bash
sudo rm -rf /tmp/aviator-prod-dist /tmp/aviator-local-dist
rm -f ~/aviator-export-src.tgz ~/aviator-local-dist.tgz
```
Keep `/opt/aviator-export-src` and the `export-20261031` image if you plan more exports. Remove them otherwise (Part H).

### F6. On Windows: analyse
```powershell
cd C:\Users\user\Downloads\project\aviator\aviator\research
python -m aviator_engine.cli analyze-export C:\Users\user\aviator-exports\rounds-onexbet-*.csv
```

---

## Part G — later exports

Repeat **D2 → D3 → D4 → E1–E3 → F1–F4**. Nothing has to be rebuilt.

If you keep exporting every ≤ 6 h to build a longer history, remember that keeping the files is still a pending retention decision. Never leave them on the VPS.

---

## Part H — rollback

Nothing in the running stack was changed, so rollback only removes what this procedure added.

```bash
sudo docker image rm aviator-backend:export-20261031
sudo rm -rf /opt/aviator-export-src /tmp/aviator-prod-dist /tmp/aviator-local-dist
sudo shred -u /root/aviator-export.env 2>/dev/null; true
sudo find /var/lib/aviator-exports -type f -exec shred -u {} \; ; sudo rmdir /var/lib/aviator-exports
rm -rf ~/aviator-export-out ~/aviator-export-src.tgz ~/aviator-local-dist.tgz ~/containers-before.txt ~/image-latest-before.txt ~/migrations-before.txt
docker inspect -f '{{.Name}} {{.State.Status}}' aviator-api-1 aviator-retention-worker-1 aviator-postgres-1 aviator-caddy-1
curl -fsS https://api.shoptrack.site/v1/health; echo
```

- **Database:** nothing to undo. No schema or data changed. The `admin.rounds_exported` audit rows hold counts only and are purged after `SECURITY_EVENT_RETENTION_DAYS` (90). Leave them as the record that exports happened.
- **The C1 backup** stays in `/var/backups/aviator`, where it is rotated by your existing backup policy.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| D3: `EACCES … mkdir '/exports'` or `open … EACCES` | folder owner is not the container user | redo D1 with the uid and gid from C3 |
| D3: `Invalid backend configuration` | the environment file is incomplete | redo D2 (it must come from `aviator-api-1`) |
| D3: `getaddrinfo ENOTFOUND postgres` | wrong network | use the network name printed in D2 |
| D3: `EEXIST` | an export with the same second-resolution name exists | wait one second and rerun; nothing was overwritten |
| C2: npm or network errors | the build needs internet access to download packages | retry; the running stack is not affected |
