# Game-page support: what is verified and what is not

The extension is **not** hard-wired to any betting domain. On any website the user allows, it
(1) detects an Aviator game by page structure, (2) picks a result reader by structure, and
(3) reads only the visible list of completed multipliers. **No real betting site has been
verified yet.** Everything below marked "unverified" still needs testing against the real pages.

## Status matrix

| Case | How it is handled | Status |
|---|---|---|
| Unknown domain with a visible results list (`1.23x` items) | Generic detector + generic DOM reader | ✅ Verified on simulated fixtures (unit tests) and simulated local pages in a real Chromium browser (headless Edge 155) |
| Newest-first and newest-last lists, lists that grow or scroll | Order learned from how the list changes; ambiguous changes are skipped | ✅ Verified (unit + real browser) |
| Stakes, balances, cash-out buttons, the player's own bet list, the live multiplier | Rejected (no `x` suffix, labelled as bets, inside controls, or a single element) | ✅ Verified on simulated markup |
| Duplicate/repeated values, re-renders of the list | Baseline + shift alignment; re-finds a replaced list | ✅ Verified (unit) |
| Single-page navigation (lobby → game without reload) | URL change resets state; detection re-runs | ✅ Verified (unit + real browser) |
| Game loaded later (dynamic content) | Throttled re-detection | ✅ Verified (unit) |
| Lobby page that only lists "Aviator" | Not treated as a game | ✅ Verified (unit + real browser) |
| Unrelated pages with numbers | Not treated as a game | ✅ Verified (unit) |
| Game drawn on a canvas only | Detected, shown as **limited**; nothing collected | ✅ Verified (unit + real browser) |
| Two different plausible lists | **Refused** as ambiguous; nothing collected | ✅ Verified (unit) |
| Game in a cross-origin iframe, frame origin NOT allowed | Detected, shown as **limited**, popup offers "Allow game frame"; no access is taken silently | ✅ Verified (unit + real browser: frame got no script, permission not granted) |
| Game in a cross-origin iframe AFTER the user allows that origin | Reader runs inside the frame (flagged as the game frame by its parent); site key = top page | ✅ Verified in a real browser on simulated pages: reader ran in the allowed cross-origin frame, ignored the live multiplier and bet panel, and the server stored exactly the frame's newest completed results in order (the Chrome approval prompt itself still needs a human click) |
| Allowed frame that loaded before access was granted | Popup injects the reader into it; if that fails, asks for a page reload | ✅ Unit-tested |
| Nested frames (frame inside a frame) | Discovered one level at a time; each origin is offered separately | ✅ Unit-tested |
| Frames without a web origin (data:, sandboxed) | Reported as "cannot be granted"; never requested | ✅ Unit-tested |
| One-off detection before any access (activeTab probe) | Popup injects `probe.js` once into the top frame | ⚠️ Unit-tested logic; needs a manual click in Chrome (activeTab requires a real user gesture) |
| **1xBet** | Generic path; label "1xBet" for `1xbet.com` only | ❌ Unverified on the real site |
| **MelBet** | Generic path; label "MelBet" for `melbet.com` only | ❌ Unverified on the real site |
| **888starz** | Generic path; label "888starz" for `888starz.bet` only | ❌ Unverified on the real site |
| Any other operator / mirror domain | Generic path; key = its own domain | ❌ Unverified until tested |

Known risks on real sites (to check during verification):

* The game is often served from a **provider's iframe** on another origin; the user must allow that origin too.
* Some builds render the history on a **canvas**, so it cannot be read; the extension will then say "limited" rather than guess.
* Class names may be obfuscated; the generic reader does not depend on them, but labels like "bets" help it reject non-result lists. A real page could still contain an unlabelled `x`-suffixed list that is not the round history. Verify before trusting data from a new site.
* Operators may prohibit automated reading in their terms. Check before supporting a site.

## Getting verified frame information from a real site

The extension shows what it actually sees — no guessing. On the game page: open the popup → **Technical details** → **Copy diagnostics**. The report lists the page origin, every iframe's origin (same/cross-origin, likely game, extension access, reader running), the detection signals and the exact limitation. It contains **origins and states only** — no page text, no frame URLs or query strings (game launch URLs can carry session tokens), no account data.

## How to verify a real site

1. Load the dev build, open the game logged in, click the extension, allow the site, then **Allow game frame** for the frame origin it lists (Chrome asks once per website).
2. Compare **Last result** in the popup with the game's own history for 10+ rounds, including two equal values in a row.
3. Confirm stakes, balances and your own bets never appear as results.
4. If the generic reader is wrong or ambiguous on that site, add a **verified adapter** (`extension/src/adapters/sites.ts`) with the observed frame origin, item selector and order, plus a synthetic fixture test. Mark only then as verified in this table.

## Server side

Results are stored per **site key** (the top page's registrable domain, e.g. `example-casino-com`; `onexbet`/`melbet`/`starz888` for the three main domains). The API only accepts keys its own configuration lists: `ACCEPTED_SITE_IDS` (keys) and `ACCEPTED_SITE_DOMAINS` (plain hostnames such as `1xlite-2781.pro`, turned into keys with the same canonical function the extension uses — `@aviator/contracts` `canonicalSite`). Prefer listing each domain explicitly over `*`. Otherwise the popup shows "This website is not enabled on the server yet" and names the domain to add.

Game frames whose launch address redirects to another origin are resolved through a small verified table (`extension/src/detection/frame-redirects.ts`); currently `demo.spribe.io` → `aviator-demo.spribegaming.com` (Spribe demo, verified 2026-10-14). Chrome runs the reader only in the frame's final origin, so that is the origin the popup asks to allow.
