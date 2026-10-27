# Vercel deployment (admin site)

> Not deployed. These are the steps for you to run. A production build (`next build`) was verified locally. The Vercel monorepo settings below follow Vercel's documented npm-workspaces support but have not been exercised against a real Vercel project.

## What goes to Vercel

`admin-web/` plus `shared/contracts/` (built during the build) and the root `package.json` / `package-lock.json`. Vercel never receives the backend, database, extension or any `.env` file.

## Project settings

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Root Directory | `admin-web` |
| Include files outside the Root Directory | Enabled (needed for `shared/contracts`) |
| Install Command | default (npm detects the workspace root lockfile) |
| Build Command | default → `npm run build` (builds contracts, then `next build`) |
| Node.js version | 22.x or 24.x |

## Environment variables (Project → Settings → Environment Variables)

| Name | Value | Environments |
|---|---|---|
| `VPS_API_URL` | `https://api.yourdomain.com` | Production (and Preview only if you want previews to reach production) |
| `VPS_ADMIN_SERVICE_KEY` | same value as `ADMIN_SERVICE_KEY` on the VPS. Mark as **Sensitive** | Production |

Neither name starts with `NEXT_PUBLIC_`, so Next.js never inlines them into browser code. The site refuses non-HTTPS `VPS_API_URL` values in production.

**Preview deployments:** leave `VPS_ADMIN_SERVICE_KEY` unset for Preview (preview builds then cannot reach the admin API), or point previews at a separate staging VPS with its own key. Also enable Vercel **Deployment Protection** so preview URLs are not public.

## Domain

Use a dedicated hostname such as `admin.yourdomain.com`. The site sends `X-Robots-Tag: noindex` and strict security headers (CSP, HSTS, frame-ancestors none). Obscurity is not protection: every page and Server Action authenticates server-side against the VPS.

## Deploy

Without a git remote, use the CLI from your machine:

```bash
npm i -g vercel
cd admin-web
vercel link          # choose/create the project, Root Directory = admin-web
vercel --prod
```

## After deploying

1. Open `https://admin.yourdomain.com` → you should be redirected to `/login`.
2. Sign in with the admin created on the VPS (`deploy/scripts/create-admin.sh`).
3. The overview should show code counts and **"Healthy"** retention status.
