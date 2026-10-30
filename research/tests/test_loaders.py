"""Data validation, normalisation and de-duplication."""

import pandas as pd

from aviator_engine.loaders import load_payouts, load_rounds_csv, load_timestamped, split_runs


def test_timestamped_drops_invalid_and_exact_duplicates_and_sorts(tmp_path):
    p = tmp_path / "c.csv"
    p.write_text(
        "timestamp,crash_multiplier,num_bets,total_bet_amount\n"
        "2026-01-01 00:00:30,2.50,10,0\n"
        "2026-01-01 00:00:00,1.20,10,0\n"  # earlier than the row before: re-sorted
        "2026-01-01 00:01:00,abc,10,0\n"  # invalid
        "2026-01-01 00:01:30,0.50,10,0\n"  # below 1.00: invalid
        "2026-01-01 00:02:00,3.10,7/9,0\n"
        "2026-01-01 00:02:00,3.10,7/9,0\n"  # exact duplicate
        "2026-01-01 00:02:30,1.25,1,0\n",
        encoding="utf-8",
    )
    r = load_timestamped(p, "C1")
    f = r.frame
    assert r.raw_rows == 7 and r.invalid == 2 and r.exact_duplicates == 1 and r.timestamp_disorder == 1
    assert f["multiplier"].tolist() == [1.2, 2.5, 3.1, 1.25]
    assert f["seq"].tolist() == [0, 1, 2, 3]
    assert f["row_in_file"].tolist() == [1, 0, 4, 6]  # provenance kept
    assert (f["source_id"] == "C1").all()


def test_payouts_one_series_per_operator_chronological(tmp_path):
    p = tmp_path / "p.csv"
    p.write_text(
        '"created_at","app","payout"\n'
        '"2024-02-03 10:01:00.5+00","A","2.07"\n'
        '"2024-02-03 10:01:00.4+00","B","1.00"\n'
        '"2024-02-03 10:00:30.000001+00","A","1.50"\n'
        '"2024-02-03 10:00:30.000001+00","A","1.50"\n'
        '"2024-02-03 10:00:00+00","A","9.99"\n',
        encoding="utf-8",
    )
    s = load_payouts(p, "P1")
    assert set(s) == {"P1:A", "P1:B"}
    a = s["P1:A"]
    assert a.frame["multiplier"].tolist() == [9.99, 1.5, 2.07] and a.exact_duplicates == 1


def test_runs_split_at_bursts_gaps_and_disorder():
    ts = pd.Series(pd.to_datetime([
        "2026-01-01 00:00:00", "2026-01-01 00:00:30", "2026-01-01 00:00:30.5",  # burst
        "2026-01-01 00:01:00", "2026-01-01 01:00:00",  # long gap
        "2026-01-01 01:00:30", "2026-01-01 01:00:30",  # equal time
    ], utc=True, format="mixed"))
    runs, st = split_runs(ts, len(ts))
    assert runs.tolist() == [0, 0, 1, 1, 2, 2, 3]
    assert st["bursts"] == 1 and st["gaps"] == 1 and st["non_increasing"] == 1


def test_user_export_with_break_column(tmp_path):
    p = tmp_path / "u.csv"
    p.write_text("multiplier,received_at,break_before\n1.5,2026-01-01T00:00:00Z,false\n2.5,2026-01-01T00:00:30Z,false\n1.1,2026-01-01T00:01:00Z,true\n", encoding="utf-8")
    f = load_rounds_csv(p).frame
    assert f["run_id"].tolist() == [0, 0, 1]
