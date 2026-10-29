# Extension packaging & distribution

## Build

```bash
npm run build:contracts
cd extension
EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run package
# → extension/build/                      (unpacked)
# → extension/release/aviator-extension-<version>.zip
```

The manifest is generated from `extension/manifest.template.json`; its `version` comes from `extension/package.json` (must be a Chrome version such as `1.0.0`). Every build is validated by `extension/scripts/validate-extension.mjs` (MV3, valid version, no leftover placeholders, every referenced file present) and fails if anything is wrong. The production build refuses a non-HTTPS API URL or one with credentials, excludes the dev test-page adapter entirely, and injects only the public API origin and version. Verify it with `npm run test:secrets` from the repo root before every release.

## What is in the package

`manifest.json`, `background.js`, `content.js`, `popup.html/js/css`, `icons/`. Nothing else: no `.env`, no API credentials, no backend or engine code, no source maps. Permissions are `storage`, `scripting`, `alarms` and `activeTab`; host access covers only the API origin; websites are **optional** permissions the user grants one site at a time.

## Distribution options

| Option | How | Updates |
|---|---|---|
| **Chrome Web Store (recommended)** — public or unlisted | Upload the zip in the Developer Dashboard. Provide the privacy disclosure (below) | Bump `version` in `extension/package.json`, rebuild, upload. Chrome auto-updates users |
| Unpacked (testing only) | `chrome://extensions` → Developer mode → Load unpacked → `extension/build` (never `extension/` — that is source code) | Manual; Chrome warns about developer-mode extensions |
| Enterprise policy (managed devices) | `ExtensionInstallForcelist` with a self-hosted `update.xml` + `.crx` | Via the update manifest |

Self-hosted `.crx` files cannot be installed by ordinary users outside the Web Store on Windows/macOS. Plan on the Web Store for customers.

**Store policies:** extensions related to gambling, and extensions that read data from third-party sites, receive extra review. Check the current Chrome Web Store program policies (and the terms of each site you support) before submitting. The listing must describe exactly what is collected.

## Privacy disclosure (draft for the store listing)

* Collected: completed-round multipliers shown on game pages of websites you explicitly allow, the website's domain (to group results per site), and a random installation identifier.
* Not collected: account details, balances, bets, passwords, payment data, cookies, browsing history.
* Use: sent to our server over HTTPS to provide analysis. Round data is deleted 12 hours after receipt.
* Activation: your activation code is sent once to verify your subscription.

## Site support

The extension detects Aviator games on any site the user allows, using a generic, structure-based reader. Which cases are verified and which still need testing on real sites is in [SITE_SUPPORT.md](SITE_SUPPORT.md). Do not advertise support for a specific site until it is marked verified there.

## Permissions users will see

* **At install:** none for websites (only storage/scripting/alarms/activeTab and the API).
* **"Allow access"** in the popup → Chrome asks: *"Read and change your data on <site>"* for that one site (plus the game frame's site when needed). The extension only reads the visible results list; the wording is Chrome's standard text.
* Store review: broad *optional* host permissions are allowed but must be justified in the listing ("asks per site, only when the user enables a game page").
