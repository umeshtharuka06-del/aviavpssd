"""Load each public file into one normalised frame, with provenance kept on every record.

Normalised columns (one row per round, chronological within a series):
  source_id   registry file id (sources.py)
  series_id   source_id, or source_id:operator when one file holds several operators
  row_in_file 0-based row of the record in the original file (provenance)
  seq         0-based chronological position within the series after cleaning
  multiplier  float, two decimals (the games publish whole cents)
  timestamp   UTC datetime, or NaT when the file has none
  run_id      consecutive rounds whose continuity is not contradicted share a run id; a new run starts
              wherever rounds may be missing or their order is unverified (see `split_runs`)

Nothing is imputed: invalid values are dropped and counted; exact duplicate records are dropped and counted.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

MIN_MULTIPLIER = 1.0
MAX_MULTIPLIER = 1_000_000.0

#: Rows written closer than this are catch-up bursts (no real round is that short): order unverified.
BURST_SECONDS = 2.0
#: A gap longer than max(GAP_FLOOR_SECONDS, GAP_MEDIAN_FACTOR x median interval) may hide missed rounds.
GAP_FLOOR_SECONDS = 180.0
GAP_MEDIAN_FACTOR = 5.0


@dataclass
class LoadResult:
    frame: pd.DataFrame
    raw_rows: int
    invalid: int
    exact_duplicates: int
    timestamp_disorder: int = 0
    notes: list[str] = field(default_factory=list)


def to_cents(x: np.ndarray | pd.Series) -> np.ndarray:
    return np.round(np.asarray(x, dtype=float) * 100).astype(np.int64)


def _valid(m: pd.Series) -> pd.Series:
    v = pd.to_numeric(m, errors="coerce")
    return v.notna() & np.isfinite(v) & (v >= MIN_MULTIPLIER) & (v <= MAX_MULTIPLIER)


def split_runs(timestamps: pd.Series | None, n: int) -> tuple[np.ndarray, dict[str, int]]:
    """Run ids from timestamps: a new run after a burst (< BURST_SECONDS), a disorder (<= 0 s) or a long gap."""
    if timestamps is None or timestamps.isna().all():
        return np.zeros(n, dtype=np.int64), {"bursts": 0, "gaps": 0, "non_increasing": 0}
    dt = timestamps.diff().dt.total_seconds().to_numpy()
    positive = dt[np.isfinite(dt) & (dt > 0)]
    median = float(np.median(positive)) if positive.size else 0.0
    gap = max(GAP_FLOOR_SECONDS, GAP_MEDIAN_FACTOR * median)
    non_inc = np.isfinite(dt) & (dt <= 0)
    burst = np.isfinite(dt) & (dt > 0) & (dt < BURST_SECONDS)
    long_gap = np.isfinite(dt) & (dt > gap)
    brk = non_inc | burst | long_gap
    brk[0] = False
    return np.cumsum(brk).astype(np.int64), {"bursts": int(burst.sum()), "gaps": int(long_gap.sum()), "non_increasing": int(non_inc.sum()), "gap_threshold_s": gap}


def _finish(df: pd.DataFrame, source_id: str, series_id: str, has_time: bool) -> tuple[pd.DataFrame, dict[str, int]]:
    df = df.reset_index(drop=True)
    df["multiplier"] = to_cents(df["multiplier"]) / 100.0
    runs, run_stats = split_runs(df["timestamp"] if has_time else None, len(df))
    out = pd.DataFrame(
        {
            "source_id": source_id,
            "series_id": series_id,
            "row_in_file": df["row_in_file"].to_numpy(),
            "seq": np.arange(len(df)),
            "multiplier": df["multiplier"].to_numpy(),
            "timestamp": df["timestamp"] if has_time else pd.NaT,
            "run_id": runs,
        }
    )
    return out, run_stats


def load_multipliers(path: Path, source_id: str, newest_first: bool = True) -> LoadResult:
    """One column of values, no timestamps. Hash-chain exports list the newest game first; reversed here."""
    raw = pd.read_csv(path)
    col = raw.columns[0]
    raw = raw.rename(columns={col: "multiplier"})
    raw["row_in_file"] = np.arange(len(raw))
    ok = _valid(raw["multiplier"])
    df = raw[ok].copy()
    df["multiplier"] = df["multiplier"].astype(float)
    if newest_first:
        df = df.iloc[::-1]
    df["timestamp"] = pd.NaT
    out, _ = _finish(df, source_id, source_id, has_time=False)
    notes = ["no timestamps or round ids: order is file order" + (" reversed (assumed newest first)" if newest_first else ""),
             "exact duplicates cannot be told apart from repeated values without ids; none removed"]
    return LoadResult(out, len(raw), int((~ok).sum()), 0, 0, notes)


def load_timestamped(path: Path, source_id: str) -> LoadResult:
    """timestamp, crash_multiplier, num_bets, total_bet_amount (C1). Only the multiplier and time are used."""
    raw = pd.read_csv(path, dtype={"num_bets": str})
    raw["row_in_file"] = np.arange(len(raw))
    raw["timestamp"] = pd.to_datetime(raw["timestamp"], errors="coerce", utc=True, format="mixed")
    disorder = int((raw["timestamp"].diff().dt.total_seconds() < 0).sum())
    ok = _valid(raw["crash_multiplier"]) & raw["timestamp"].notna()
    df = raw[ok].copy()
    dup = df.duplicated(subset=["timestamp", "crash_multiplier", "num_bets", "total_bet_amount"], keep="first")
    df = df[~dup].rename(columns={"crash_multiplier": "multiplier"})
    df = df.sort_values(["timestamp", "row_in_file"], kind="stable")
    out, rs = _finish(df, source_id, source_id, has_time=True)
    notes = [f"{disorder} rows earlier than the row before them in file order (re-sorted by time)",
             f"runs split at {rs['bursts']} bursts, {rs['gaps']} gaps > {rs.get('gap_threshold_s', 0):.0f} s, {rs['non_increasing']} equal times",
             "num_bets / total_bet_amount not used (undocumented, mixed formats, amount 0 in most rows)"]
    return LoadResult(out, len(raw), int((~ok).sum()), int(dup.sum()), disorder, notes)


def load_payouts(path: Path, source_id: str) -> dict[str, LoadResult]:
    """created_at, app, payout (P1). One series per operator, sorted by the full microsecond timestamp."""
    raw = pd.read_csv(path)
    raw["row_in_file"] = np.arange(len(raw))
    raw["timestamp"] = pd.to_datetime(raw["created_at"], errors="coerce", utc=True, format="mixed")
    out: dict[str, LoadResult] = {}
    for app, g in raw.groupby("app", sort=True):
        ok = _valid(g["payout"]) & g["timestamp"].notna()
        df = g[ok].copy()
        dup = df.duplicated(subset=["created_at", "payout"], keep="first")
        df = df[~dup].rename(columns={"payout": "multiplier"})
        disorder = int((g["timestamp"].diff().dt.total_seconds() > 0).sum())  # file is newest first
        df = df.sort_values(["timestamp", "row_in_file"], kind="stable")
        sid = f"{source_id}:{app}"
        frame, rs = _finish(df, source_id, sid, has_time=True)
        notes = [f"runs split at {rs['bursts']} catch-up bursts (< {BURST_SECONDS:.0f} s), {rs['gaps']} gaps > {rs.get('gap_threshold_s', 0):.0f} s"]
        out[sid] = LoadResult(frame, len(g), int((~ok).sum()), int(dup.sum()), disorder, notes)
    return out


def load_synthetic(path: Path, source_id: str, limit: int | None = None) -> LoadResult:
    raw = pd.read_csv(path, usecols=["round_id", "timestamp", "crash_point"], nrows=limit)
    raw["row_in_file"] = np.arange(len(raw))
    ok = _valid(raw["crash_point"])
    df = raw[ok].sort_values("round_id", kind="stable").rename(columns={"crash_point": "multiplier"})
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    out, _ = _finish(df, source_id, source_id, has_time=False)
    return LoadResult(out, len(raw), int((~ok).sum()), 0, 0, ["SYNTHETIC: generated by a piecewise-uniform simulator, not game data"])


def load_rounds_csv(path: Path, series_id: str = "user") -> LoadResult:
    """Your own export: a `multiplier` column, optional `received_at` (or `timestamp`) and `break_before`."""
    raw = pd.read_csv(path)
    raw["row_in_file"] = np.arange(len(raw))
    tcol = next((c for c in ("received_at", "timestamp", "created_at") if c in raw.columns), None)
    raw["timestamp"] = pd.to_datetime(raw[tcol], errors="coerce", utc=True, format="mixed") if tcol else pd.NaT
    ok = _valid(raw["multiplier"])
    df = raw[ok].copy()
    if tcol:
        df = df.sort_values(["timestamp", "row_in_file"], kind="stable")
    frame, _ = _finish(df, "user", series_id, has_time=bool(tcol))
    if "break_before" in df.columns:
        frame["run_id"] = np.cumsum(df["break_before"].fillna(False).astype(bool).to_numpy() & (np.arange(len(df)) > 0))
    return LoadResult(frame, len(raw), int((~ok).sum()), 0, 0, [])


# ----------------------------------------------------------------------------------------------- live export (schema v1)

LIVE_EXPORT_COLUMNS = ["schema_version", "site_id", "stream", "obs_id", "received_at", "multiplier", "source", "chain",
                       "chain_index", "break_before", "verified_successor", "run_id"]
#: Fields that never change between exports of the same stored round (continuity fields can: see load_live_exports).
_IMMUTABLE = ["site_id", "received_at", "multiplier", "source", "chain", "chain_index", "break_before"]


def read_live_export(path: Path) -> pd.DataFrame:
    """One `export-rounds` CSV (backend/src/export/rounds-export.ts). Refuses any other column set or schema version."""
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    if list(df.columns) != LIVE_EXPORT_COLUMNS:
        raise ValueError(f"{path}: not a schema-1 live export (columns {list(df.columns)})")
    if len(df) and set(df["schema_version"]) != {"1"}:
        raise ValueError(f"{path}: unsupported schema_version {sorted(set(df['schema_version']))}")
    # undo the exporter's spreadsheet-formula guard: "'-x" was written for a cell that started with = + - @
    guarded = re.compile(r"^'[=+\-@\t\r]")
    for col in df.columns:
        df[col] = df[col].map(lambda v: v[1:] if guarded.match(v) else v)
    return df


def load_live_exports(paths: list[Path], site: str | None = None, min_rounds: int = 0) -> dict[str, LoadResult]:
    """Union of one or more (overlapping) exports -> one LoadResult per (site, stream), chronological by obs_id.

    * The same stored round in several files (same stream and obs_id) is kept once. Its immutable fields must agree
      (a conflict is an error); its continuity is taken as verified if ANY file verified it, because a later export
      may have lost the predecessor to retention.
    * A row continues its run only if it is verified AND its predecessor in the merged stream appears in a file that
      also contains it (within one file every retained row of the stream is present, so adjacency is proven). A round
      purged between two exports therefore never joins two runs.
    * Streams are never merged with each other here (see `merge_streams`).
    """
    frames = []
    for i, p in enumerate(paths):
        df = read_live_export(Path(p))
        df["_file"] = i
        frames.append(df)
    if not frames:
        raise ValueError("no export files given")
    allrows = pd.concat(frames, ignore_index=True)
    if site:
        allrows = allrows[allrows["site_id"] == site]
    allrows["obs_id"] = allrows["obs_id"].astype(np.int64)
    out: dict[str, LoadResult] = {}
    for (site_id, stream), g in allrows.groupby(["site_id", "stream"], sort=True):
        key = g.groupby("obs_id")
        conflicts = key[_IMMUTABLE].nunique().gt(1).any(axis=1)
        if conflicts.any():
            raise ValueError(f"{site_id}/{stream}: obs_id {conflicts[conflicts].index[:5].tolist()} differ between files")
        files = key["_file"].agg(frozenset)
        first = key.first()
        verified = key["verified_successor"].agg(lambda s: (s == "true").any())
        df = first.sort_index()
        files = files.loc[df.index]
        verified = verified.loc[df.index]
        same_file_as_prev = [False] + [bool(files.iloc[i] & files.iloc[i - 1]) for i in range(1, len(df))]
        brk = ~(verified.to_numpy() & np.array(same_file_as_prev))
        brk[0] = True
        m = pd.to_numeric(df["multiplier"], errors="coerce")
        ok = _valid(m)
        frame = pd.DataFrame({
            "source_id": "live",
            "series_id": f"{site_id}/{stream}",
            "row_in_file": df.index.to_numpy(),  # obs_id: provenance in the server record
            "seq": np.arange(len(df)),
            "multiplier": m.to_numpy(dtype=float),
            "timestamp": pd.to_datetime(df["received_at"], utc=True, format="ISO8601"),
            "run_id": np.cumsum(brk) - 1,
        })[ok.to_numpy()].reset_index(drop=True)
        frame["seq"] = np.arange(len(frame))
        if len(frame) < min_rounds:
            continue
        dup = int(len(g) - len(df))
        notes = [f"{len(paths)} export file(s); {dup} repeated row(s) across files kept once",
                 "received_at is server arrival time; obs_id is a server record id, not a game round id",
                 f"{int(brk.sum())} run(s): a run continues only on a verified successor present in the same file"]
        out[f"{site_id}/{stream}"] = LoadResult(frame, len(g), int((~ok).sum()), dup, 0, notes)
    return out


def merge_streams(streams: dict[str, LoadResult], k: int = 8, tolerance_s: float = 60.0) -> LoadResult:
    """One site-level series from several streams (devices watching the same game), by value alignment.

    The longest stream is the base. A run of another stream is dropped where a window of `k` consecutive multipliers
    matches the base exactly at ONE base position within +/- `tolerance_s` (the same rounds seen twice); an ambiguous
    or absent match keeps the rows. Kept runs are appended whole, ordered by their first timestamp; runs are never
    joined, so alignment can only remove duplicates, never create continuity.
    """
    if not streams:
        raise ValueError("no streams")
    keys = sorted(streams, key=lambda s: -len(streams[s].frame))
    base = streams[keys[0]].frame.copy()
    base["_rid"] = "0:" + base["run_id"].astype(str)
    cents = np.round(base["multiplier"].to_numpy() * 100).astype(np.int64)
    btime = base["timestamp"].astype("int64").to_numpy() / 1e9
    index: dict[bytes, list[int]] = {}
    for i in range(len(cents) - k + 1):
        index.setdefault(cents[i:i + k].tobytes(), []).append(i)
    pieces = [base]
    removed = 0
    for j, key in enumerate(keys[1:], start=1):
        f = streams[key].frame
        c = np.round(f["multiplier"].to_numpy() * 100).astype(np.int64)
        t = f["timestamp"].astype("int64").to_numpy() / 1e9
        drop = np.zeros(len(f), dtype=bool)
        run = f["run_id"].to_numpy()
        for i in range(len(c) - k + 1):
            if run[i] != run[i + k - 1]:
                continue
            hits = [b for b in index.get(c[i:i + k].tobytes(), []) if abs(btime[b] - t[i]) <= tolerance_s]
            if len(hits) == 1:
                drop[i:i + k] = True
        removed += int(drop.sum())
        rest = f[~drop].copy()
        # a removed stretch splits the run: rows on either side of it are not adjacent any more
        rest["run_id"] = np.cumsum(np.r_[True, (np.diff(rest.index.to_numpy()) != 1) | (np.diff(rest["run_id"].to_numpy()) != 0)])
        rest["_rid"] = f"{j}:" + rest["run_id"].astype(str)
        pieces.append(rest)
    allr = pd.concat(pieces, ignore_index=True)
    starts = allr.groupby("_rid")["timestamp"].min().sort_values(kind="stable")
    order = {rid: n for n, rid in enumerate(starts.index)}
    allr["_ord"] = allr["_rid"].map(order)
    allr = allr.sort_values(["_ord", "seq"], kind="stable").reset_index(drop=True)
    frame = pd.DataFrame({"source_id": "live", "series_id": keys[0].split("/")[0] + "/merged", "row_in_file": allr["row_in_file"].to_numpy(),
                          "seq": np.arange(len(allr)), "multiplier": allr["multiplier"].to_numpy(), "timestamp": allr["timestamp"].to_numpy(),
                          "run_id": allr["_ord"].to_numpy()})
    notes = [f"merged {len(streams)} stream(s); {removed} row(s) removed as the same rounds seen by another device (unique {k}-round alignment within {tolerance_s:.0f} s)",
             "runs from different devices are never joined; they are ordered by start time"]
    return LoadResult(frame, sum(len(s.frame) for s in streams.values()), 0, removed, 0, notes)
