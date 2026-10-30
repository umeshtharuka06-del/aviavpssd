# Data-quality report (engine stat-5.1, extension 0.2.1)

Audited 2026-10-28. This covers how rounds are collected, uploaded, ordered and de-duplicated; where rounds can be missed; and what data I actually had.

## 1. Which data exists, and which I had

| Data | Kind | Rounds | Used for |
|---|---|---|---|
| **Your 1xBet rounds** | real, actual game | **unknown to me**: they are only on your VPS (12 h retention). I have no credentials and no authorisation to read them | nothing. **No actual 1xBet data was available for any analysis in this work** |
| Local dev database | **simulated** test page (`devfixture`) | 32 | nothing |
| `PHIMAS/aviator` `aviator_payouts.csv` | **third-party**, real Aviator rounds from four Kenyan operators, provenance undocumented | 300,000 (BETIKA 107,449 · BETGR8 97,407 · ODIBETS 66,823 · WINPESA 28,315 after removing 5 exact duplicates and 1 invalid row) | evaluation and backtests only, per operator |
| `MindingTheData/Crash-Analysis` `multipliers.csv` | **third-party**, a computed bustabit-style hash chain, **not Aviator** | 732,367 | negative control only |
| Simulated histories | **simulated** (independent rounds, or a planted pattern) | 300–6,000 per history | negative and positive controls only |

The three kinds are never mixed: each file is evaluated on its own, each operator is a separate series, and simulated results are labelled SIMULATED wherever they appear.

**Verified consecutive 1xBet rounds available to me: 0.** The engine now reports this number for your device (`currentRun` / `longestRun`, see section 4). After deployment you will see it in the panel ("N consecutive verified").

## 2. Live server check (read-only, no credentials)

Probed `https://api.shoptrack.site` on 2026-10-28 without a token. Every handler checks the session inside the route, so an unknown route answers 404 and a known one 401:

| Request | Answer | Meaning |
|---|---|---|
| `GET /v1/health` | 200 `{"status":"ok","version":"0.1.0"}` | API up; the engine version is not exposed |
| `POST /v1/history/backfill` | **401** SESSION_INVALID | **The route exists**: the VPS runs code with the stat-5 backfill route, newer than the only VPS package in the repo (`dist/aviator-vps-0.1.0.tar.gz`, stat-2) |
| `POST /v1/nonexistent-route-probe` | 404 | control: unknown routes give 404 |

So the server is most likely **stat-5** (deployed outside this repository's history, which still has no commits). I could not confirm the engine version, whether migration 0004 ran, or what your installed extension version is: that needs a device session or VPS access I don't have. Nothing was written to the server.

## 3. Collection path and its weak points

| Step | What happens | Risk found | Status |
|---|---|---|---|
| Read the results strip | Content script reads the visible list (25–60 values, no round ids, no times) | — | unchanged |
| Diff | A new read must equal the previous one shifted by k ≤ 10 new values, with ≥ 3 overlapping (smallest k wins, so it under-counts rather than invents) | **When the diff fails (re-sync), or the list disappears and reappears, the rounds in between are lost silently.** The next upload looked continuous to the server if it arrived within 120 s | **fixed** (continuity chain, below) |
| Order | Learned from the first unambiguous change; ambiguous changes emit nothing | an ambiguous change also hides rounds | **fixed** (starts a new chain) |
| Upload queue | FIFO, same batch id on retry; batches older than 10 min, or rejected as invalid, are dropped | **a dropped batch left an unmarked hole** | **fixed** (index jump = break) |
| Server time | `received_at` = arrival time; one upload of several rounds shares one time | a delayed upload (> 120 s) voided a forecast whose next round was in fact verified | **fixed** (verified successors are scored even when late) |
| Duplicates | `batchId` idempotency; the diff never re-emits overlap; backfill stores only rounds after a unique value alignment of ≥ 4 | low | unchanged; the evaluation also measures excess adjacent repeats |
| Backfill alignment | value-based, ambiguity → nothing stored | a single stored round can align by coincidence when it is older than the strip; worst case some strip rounds are **not** stored (never duplicated) | documented, unchanged |

### The fix: collector continuity (`continuity: { chain, index }`)

- The content script starts a new **chain id** whenever it may have lost rounds: a new baseline (page load, adapter change, collection paused or unavailable), a re-sync, or an ambiguous change. Each round gets its position in the chain. The backfill opens the chain at position 0 and the first live round follows it.
- The queue keeps the positions correct when it splits a batch (≤ 50 per upload) or trims a backfill (≤ 100).
- The server stores `chain_id`, `chain_index` and `break_before` per round (migration `0005_round_continuity.sql`, three nullable columns, nothing rewritten). A round is a **verified successor** only if the latest stored round has the same chain and the previous index. A value-aligned backfill also counts as verified. Anything else is a break.
- The engine uses that evidence first: a forecast whose next stored round is not a verified successor is **void**, even without a time gap. A verified successor is **scored** even when its upload was delayed. Rounds from older clients (NULL) keep the 120 s time rule exactly as before.
- Compatibility: a server without the field (the current stat-5 VPS) rejects it with VALIDATION_FAILED. The extension then resends the same batch without it, and stops sending it for that browser session. Nothing is lost, and collection works exactly as in 0.2.0.

Tests: `extension/tests/controller.test.ts` (chain numbering, new chain after a re-sync), `extension/tests/background.test.ts` (offsets after split/trim, fallback without loss), `backend/tests/forecast-ledger.test.ts` "collector continuity" (missing batch → break, new chain → break, delayed verified round → scored, backfill continues the chain, NULL for old clients), `backend/tests/evaluate.test.ts` (break precedence).

## 4. Warm-up on verified consecutive rounds

The first estimate now requires **20 consecutive verified rounds** (`longestRun ≥ 20`), not just 20 stored rounds. After that, every round gets a forecast, as before. The response carries `currentRun` (the verified run ending at the latest round) and `longestRun`. The panel shows "N of 20 consecutive verified rounds" while warming up, and "N consecutive verified (longest M)" afterwards. Both fields are optional in the contract, so a stat-5 server without them still validates; the panel then falls back to the round count.

## 5. What the third-party data taught about collection quality

`npm run evaluate:signal` measures runs, intervals, timestamps and adjacent repeats for every series (full tables: [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md)).

| Operator | Rows written < 2 s apart (catch-up bursts) | Intervals > 3× median (likely missed rounds) | Adjacent equal values inside bursts vs normal spacing |
|---|---|---|---|
| BETGR8 | 16,694 pairs (17.1%) | 518 | 108 of 16,694 pairs (0.65%) vs 356 of ~80,000 (0.44%) |
| BETIKA | 16,887 (15.7%) | 627 | 195 (1.15%) vs 448 (0.50%) |
| ODIBETS | 18,858 (28.2%) | 419 | 212 (1.12%) vs 187 (0.39%) |
| WINPESA | 3,487 (12.3%) | 180 | 27 (0.77%) vs 117 (0.47%) |

The file's collector wrote many rounds in bursts microseconds apart. Their order inside a burst is insertion order, and the burst rows hold about twice the normal share of repeated values (likely duplicates). **This produced spurious "dependence"**: lag-1 correlation of "≥ 2×" was −0.033 to +0.034 inside bursts and −0.002 to +0.008 between normally spaced rounds.

My first evaluation pass also had a loader bug: `Date.parse` keeps only milliseconds, so rows a few microseconds apart got equal times and kept the file's newest-first order, which reversed them. **Fixed**: the loader now sorts by the full microsecond timestamp and starts a new run at every burst (< 2 s, shorter than any real round). All figures in this work come from the corrected loader. The earlier backtest figures in BACKTEST_RESULTS.md were regenerated.

With bursts treated as unverified, **every serial-dependence test is non-significant on all four operators** (dependence tables in EVALUATION_RESULTS.md). The lesson for your own data: dependence found in a history with gaps, bursts or duplicates is more likely a collection artifact than a property of the game. That is why continuity is recorded per round instead of being guessed from times.

## 6. Remaining limits

- Rounds have no ids, so value alignment (backfill) and the diff are the only de-duplication. Both refuse ambiguous cases instead of guessing.
- Times are server arrival times. They are used for retention and the fallback break rule, not as round times.
- 12 h retention caps the evidence any device accumulates: about 1,500–2,000 rounds if collecting all day.
- A chain covers one page view. A page reload starts a new chain, which a backfill aligned by value reconnects when the strip still overlaps the stored rounds.
