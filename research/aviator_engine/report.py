"""Markdown rendering of report.json. Every table states its sample size; percentages carry 95% intervals."""

from __future__ import annotations


def _pct(x, d=1):
    return "—" if x is None else f"{100 * x:.{d}f}%"


def _ci(lo, hi, d=1):
    return "—" if lo is None else f"[{100 * lo:.{d}f}, {100 * hi:.{d}f}]"


def _p(x):
    return "—" if x is None else (f"{x:.2e}" if x < 1e-3 else f"{x:.3f}")


def _f(x, d=4):
    return "—" if x is None else f"{x:+.{d}f}"


def render_markdown(r: dict) -> str:
    L: list[str] = [f"# Analysis engine report\n\nGenerated {r.get('generated')}. SIMULATED and SYNTHETIC results are controls, never observations.\n"]
    if "fetch" in r:
        L.append("## Files\n\n| File | SHA-256 matches registry |\n|---|---|")
        L += [f"| {x['file_id']} `{x['path']}` | {'yes' if x['matches'] else 'NO: ' + x['sha256'][:12]} |" for x in r["fetch"]]
        L.append("")
    L.append("## Data quality (before any model)\n")
    L.append("| Series | Role | Valid rounds | Invalid | Exact dups removed | Date range | Runs / longest | Adjacent repeats obs / exp | P(<1.5 \\| <2) (1/m law 0.686, uniform 0.5) | Fit to 0.97/m χ² p |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    for sid, q in r["quality"].items():
        dr = f"{q['first'][:10]} → {q['last'][:10]}" if q.get("first") else "no timestamps"
        sf = q["synthetic_fingerprint"]
        L.append(f"| {sid} | {q['role']} | {q['valid_rounds']:,} | {q['invalid_removed']} | {q['exact_duplicates_removed']} | {dr} | {q['runs']:,} / {q['longest_run']:,} | "
                 f"{q['adjacent_repeats']['observed']} / {q['adjacent_repeats']['expected']:.0f} | {sf.get('share_below_1_5_given_below_2', 0):.3f} | {_p(q['fit_to_rtp_reference']['p'])} |")
    if "overlap" in r:
        L.append("\n**Overlap between series** (shared 8-round sequences of whole-cent values):\n")
        hits = [o for o in r["overlap"] if o["shared_kgrams"] > 0]
        L += [f"- {o['a']} ↔ {o['b']}: {o['shared_kgrams']:,} shared ({_pct(o['share_of_a'])} of {o['a']})" for o in hits] or ["- none"]
    if "mirrors" in r:
        L.append(f"\nMirrors: A1 byte-identical to B1: **{r['mirrors']['A1_identical_to_B1']}**; A2 same rows as C1: **{r['mirrors']['A2_same_rows_as_C1']}**.")
    if "derived_leakage_B2" in r:
        L.append(f"\nB2 (derived features): {r['derived_leakage_B2']['conclusion']}\n")
    for sid, a in r.get("analysis", {}).items():
        L.append(f"\n## {sid} ({a['role']})\n")
        pl = a.get("plausibility")
        if pl:
            L.append(f"Plausibility gate: **{'pass' if pl['passes'] else 'FAIL'}**" + ("" if pl["passes"] else " — " + "; ".join(pl["reasons"])) + "\n")
        d = a["distribution"]
        L.append(f"n = {d['n']:,} · median {d['median']:.2f}× · mean {d['mean']:.2f}×\n")
        L.append("| Range | Count | Share | 95% CI |\n|---|---|---|---|")
        L += [f"| {x['range']} | {x['count']:,} | {_pct(x['share'], 2)} | {_ci(x['ci_low'], x['ci_high'], 2)} |" for x in d["analysis_ranges"]]
        L.append("\nPanel ranges: " + " · ".join(f"{x['range']} {_pct(x['share'])} {_ci(x['ci_low'], x['ci_high'])}" for x in d["display_ranges"]))
        s = a["sequential"]
        ds = s["dependence_summary"]
        L.append("\n| Dependence test (within verified runs) | p | BH p |\n|---|---|---|")
        L += [f"| {k} | {_p(v)} | {_p(ds['p_bh'][k])} |" for k, v in ds["p"].items()]
        L.append(f"\nAny dependence after BH: **{'YES' if ds['any_significant_bh'] else 'no'}**. "
                 f"Lag-1 r(≥2×) = {s['acf_ge2']['r'][0]:+.4f} (null SE {s['acf_ge2']['se_null']:.4f}). "
                 f"Longest complete low streak {s['streak_distribution']['longest']} (descriptive; streak χ² p {_p(s['streak_distribution']['p'])}, length-biased with run breaks); mean {s['streak_distribution']['mean_length']:.2f} vs geometric {s['streak_distribution']['expected_mean_length']:.2f}.")
        c = s["conditional_on_lows"]
        L.append("\nP(next ≥ 2× | k lows before): " + " · ".join(f"{row['lows_before']}: {_pct(row['rate'])} (n {row['n']:,})" for row in c["rows"]))
        bh = s["block_homogeneity"]
        cps = s["change_points"]["significant"]
        L.append(f"\nDistribution change over 10 blocks: χ² p {_p(bh['p'])}, P(≥2×) by block {min(bh['p_ge2_by_block']):.1%}–{max(bh['p_ge2_by_block']):.1%}. "
                 f"Change points (BH-significant): {', '.join(f'round {x['index']:,} ({x['before']:.1%} → {x['after']:.1%})' for x in cps) if cps else 'none'}.")
        st = a["strategy"]
        w, t = st["watch"], st["tracking"]
        L.append(f"\n**WATCH rule (walk-forward):** {w['forecasts']:,} watch forecasts ({_pct(st['share_of_forecasts_in_watch'])}). "
                 f"Target ≥2× hit rate in WATCH {_pct(w['target_hit_rate'])} {_ci(*w['target_ci'])} vs tracking {_pct(t['target_hit_rate'])} {_ci(*t['target_ci'])}; "
                 f"Fisher p {_p(st.get('watch_vs_tracking_target', {}).get('fisher_p'))}. Range 2.00×–4.99× hit rate in WATCH {_pct(w['range_hit_rate'])}.")
        e = a["evaluation"]
        L.append(f"\n**Walk-forward evaluation** ({e['scored']:,} scored of the first {e['evaluated_rounds']:,} rounds). Δ = log loss minus baseline (negative = better), block-bootstrap 95% CI.\n")
        L.append("| Model | Role | Log loss | Brier | Top-range hit | Δ vs empirical [CI] | Δ vs recent [CI] | Folds ahead | Holm p | Calib. Z (≥2×) | Validated |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for k, m in e["models"].items():
            ve, vr = m.get("vs_empirical"), m.get("vs_recent_empirical")
            fe = f"{_f(ve['mean_diff'], 5)} [{_f(ve['ci_low'], 5)}, {_f(ve['ci_high'], 5)}]" if ve else "—"
            fr = f"{_f(vr['mean_diff'], 5)} [{_f(vr['ci_low'], 5)}, {_f(vr['ci_high'], 5)}]" if vr else "—"
            L.append(f"| {k} | {m['role']} | {m['log_loss']:.5f} | {m['brier']:.5f} | {_pct(m['top_range_hit'])} | {fe} | {fr} | {m.get('folds_ahead', '—')} | "
                     f"{_p(m.get('holm_p'))} | {m['calibration_ge2']['spiegelhalter_z']:+.2f} | {'YES' if m.get('validated') else 'no'} |")
        L.append(f"\nVerdict: **{e['verdict']}**")
    if r.get("stat6"):
        L.append("\n## stat-6 pre-registered rules (exact estimate and range probabilities)\n")
        L.append("| Series | Scored | Plausibility | Exact | Range |\n|---|---|---|---|---|")
        for sid, s6 in r["stat6"].items():
            L.append(f"| {sid} | {s6['scored']:,} | {'pass' if s6['plausibility']['passes'] else 'FAIL'} | {s6['exact_status']} | {s6['range_status']} |")
    if r.get("skipped"):
        L.append("\nSkipped (too few rounds): " + "; ".join(f"{k}: {v}" for k, v in r["skipped"].items()))
    if "controls" in r:
        c = r["controls"]
        L.append(f"\n## SIMULATED controls ({c['reps']} × {c['n']:,} rounds each)\n")
        L.append(f"- Independent rounds: dependence flagged in {c['fair_summary']['dependence_detected']} of {c['fair_summary']['of']}; a model validated in {c['fair_summary']['any_model_validated']} of {c['fair_summary']['of']} (false alarms).")
        L.append(f"- Planted ±5 pp previous-round effect: dependence detected in {c['planted_summary']['dependence_detected']} of {c['planted_summary']['of']}; a model validated in {c['planted_summary']['any_model_validated']} of {c['planted_summary']['of']} (power).")
    return "\n".join(L) + "\n"
