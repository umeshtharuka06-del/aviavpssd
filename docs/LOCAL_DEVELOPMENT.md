# Local development

Requirements: Node.js 22.12+ (developed on 24.19), npm 11. No Docker and no system PostgreSQL needed: `embedded-postgres` runs PostgreSQL 18 from `node_modules`, bound to 127.0.0.1.

```bash
npm install                                   # all workspaces
npm run build:contracts                       # shared/contracts → dist
```

## 1. Database (terminal 1, keep running)

```bash
npm run local-db -w @aviator/backend          # 127.0.0.1:55433, data in backend/.local-pg (gitignored)
```

## 2. Local secrets (once)

```bash
node scripts/dev-setup.mjs
```

This creates `backend/.env`, `admin-web/.env.local` and `backend/.local-pg/dev-admin.json` with random local values. All are gitignored, and existing files are never overwritten.

```bash
npm run db -w @aviator/backend -- migrate
# create the local admin from the generated file (or use your own email/password):
npm run db -w @aviator/backend -- create-admin --email admin@localhost.test    # prompts for the password
```

## 3. Run

| Terminal | Command | URL |
|---|---|---|
| 2 | `npm run dev -w @aviator/backend` | http://127.0.0.1:8080/v1/health |
| 3 | `npm run dev:worker -w @aviator/backend` | retention worker (60 s interval locally) |
| 4 | `npm run dev -w @aviator/admin-web` | http://localhost:3000 |
| 5 | `node extension/dev/serve.mjs` | http://localhost:5173 (simulated pages: `/`, `/generic`, `/canvas`, `/lobby`, `/frame`, `/spa`) |

## 4. Extension

```bash
npm run build:dev -w @aviator/extension       # → extension/build, API http://127.0.0.1:8080 (validated automatically)
npm run validate -w @aviator/extension        # re-check extension/build at any time
```

In Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select **`extension/build`** (the folder that contains `manifest.json`, `background.js`, `popup.html` and `icons/`). Do **not** select `extension/` itself: it is source code, and its manifest is only a template (`manifest.template.json`). Open http://localhost:5173, click the extension icon, enter a code generated on the admin site, then click **Allow on Local test page** and reload the page.

## Tests

```bash
npm test                                      # all workspaces
npm run test:backend                          # starts a throwaway PostgreSQL automatically
npm run test:admin
npm run test:extension
npm run test:secrets                          # production builds + secret scan
# Live extension ↔ backend check (backend running, code from the admin site):
E2E_API_BASE_URL=http://127.0.0.1:8080 E2E_CODE=AVX-… npx vitest run tests/e2e-live.test.ts   # in extension/
```

Backend tests use `TEST_DATABASE_URL` if set (database name must end in `_test`; its schema is dropped). Otherwise they start a temporary PostgreSQL in the OS temp dir and remove it afterwards.

## Troubleshooting

* `npm install` prints `allow-scripts` warnings for `esbuild` and `@embedded-postgres/windows-x64`. Neither postinstall script is needed on Windows. On Linux/macOS, run `npm approve-scripts @embedded-postgres/<platform>` if PostgreSQL fails to start (its script restores symlinks).
* In the admin site's dev mode the CSP allows `eval` (React dev tooling). Production builds do not.
