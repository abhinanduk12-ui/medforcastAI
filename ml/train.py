"""End-to-end training pipeline.

    python -m ml.train                                   # default: base workbook -> ml/artifacts
    python -m ml.train --data <xlsx|csv|manifest.json> --out <artifact dir> [--extra-sales a.csv ...]

--data / --extra-sales only change WHICH transactions are loaded (see ml/ingest.py); the modelling
below is unchanged. Machine-readable progress lines "PROGRESS <pct> <message>" go to stdout for
the retraining job runner (backend/routers/mlops.py).

Evaluation protocol (rolling origin, no leakage):
  Fold A  train weeks 0-31  -> forecast weeks 32-43 (Mar-May 2026)  : tunes ensemble weights,
                                                                      DL epochs, conformal intervals
  Fold B  train weeks 0-43  -> forecast weeks 44-55 (Jun-Aug 2026)  : untouched holdout - reported
  Final   train weeks 0-55  -> forecast the next 12 weeks (Sep-Nov 2026)

Fold B is a genuine seasonal test: the models must anticipate the 2026 monsoon
surge from data ending in the pre-monsoon summer.
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C
from .data import calendar_frame, load_raw, weekly_panel
from .features import build_context, build_rows, sequences, training_origins
from .metrics import summary, wape
from .models.deep import DeepForecaster
from .models.gbm import GBMForecaster
from .seasonality import (bootstrap_category_ci, category_index, deseasonalised_level, festival_impact,
                          index_lookup, medicine_index)

MODELS = ["gbm", "deep", "snaive", "ma8"]
LABELS = {"gbm": "Gradient Boosting (Poisson)", "deep": "Deep SeasonalGRU", "snaive": "Seasonal Naive",
          "ma8": "Moving Average (8w)", "ensemble": "MedForecast Ensemble"}
H_GROUPS = {"1-4": range(1, 5), "5-8": range(5, 9), "9-12": range(9, 13)}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def progress(pct: int, msg: str):
    """Machine-readable progress line parsed by the retraining job runner."""
    print(f"PROGRESS {int(pct)} {msg}", flush=True)


def run_fold(panel, master, weeks, cutoff, dl_epochs=None, gbm_rounds=None, with_val=True):
    """Train every model on weeks <= cutoff; predict origin=cutoff for horizons 1..12."""
    ctx = build_context(panel, master, weeks, cutoff)
    train = build_rows(ctx, training_origins(cutoff))
    train = train[train["target_t"] <= cutoff].reset_index(drop=True)
    test = build_rows(ctx, [cutoff], require_target=False)
    log(f"cutoff={cutoff}: {len(train):,} training rows, {len(test):,} forecast rows")

    tr_seq, te_seq = sequences(ctx, train), sequences(ctx, test)
    use_val = with_val and test["y"].notna().all()
    gbm = GBMForecaster().fit(train, val=test if use_val else None, rounds=gbm_rounds)
    log(f"  GBM fitted ({gbm.best_rounds} boosting rounds)")

    deep = DeepForecaster(len(ctx.med_ids), len(ctx.categories), len(ctx.forms))
    val = (test, te_seq) if use_val else None
    deep.fit(train, tr_seq, ctx.scale, val=val, fixed_epochs=dl_epochs)
    log(f"  Deep model fitted (best epoch {deep.best_epoch})")

    test = test.copy()
    test["gbm"] = gbm.predict(test)
    test["deep"] = deep.predict(test, te_seq, ctx.scale)
    test["snaive"] = test["curve_naive"].clip(lower=0)   # smooth seasonal baseline (no step at season boundaries)
    test["ma8"] = test["ma_8"]
    return ctx, test, gbm, deep


def fit_weights(df):
    """Grid-search convex ensemble weights minimising WAPE."""
    best = (np.inf, None)
    grid = np.round(np.arange(0, 1.0001, 0.05), 2)
    y = df["y"].to_numpy()
    P = df[["gbm", "deep", "snaive"]].to_numpy()
    for a, b in itertools.product(grid, grid):
        if a + b > 1:
            continue
        w = np.array([a, b, 1 - a - b])
        e = wape(y, P @ w)
        if e < best[0]:
            best = (e, w)
    # Shrink toward equal weights: fitted combination weights are noisy on one short fold
    # (the "forecast combination puzzle"), equal weights are a robust prior.
    w = 0.5 * best[1] + 0.5 * np.full(3, 1 / 3)
    return dict(zip(["gbm", "deep", "snaive"], (w / w.sum()).round(3).tolist()))


def ensemble(df, w):
    return sum(df[k] * v for k, v in w.items())


def norm_resid(y, p):
    return (y - p) / np.sqrt(p + 0.5)


def calibrate(df):
    """Conformal-style quantiles of variance-normalised residuals, per horizon group."""
    out = {}
    for g, hs in H_GROUPS.items():
        r = norm_resid(df.loc[df["h"].isin(hs), "y"], df.loc[df["h"].isin(hs), "ensemble"])
        out[g] = {"q05": float(np.quantile(r, 0.05)), "q95": float(np.quantile(r, 0.95)),
                  "sigma": float(np.std(r))}
    return out


def add_intervals(df, cal):
    df = df.copy()
    lo, hi, sig = np.zeros(len(df)), np.zeros(len(df)), np.zeros(len(df))
    for g, hs in H_GROUPS.items():
        m = df["h"].isin(hs).to_numpy()
        s = np.sqrt(df.loc[m, "ensemble"].to_numpy() + 0.5)
        lo[m] = df.loc[m, "ensemble"].to_numpy() + cal[g]["q05"] * s
        hi[m] = df.loc[m, "ensemble"].to_numpy() + cal[g]["q95"] * s
        sig[m] = cal[g]["sigma"] * s
    df["lo"], df["hi"], df["sigma"] = np.clip(lo, 0, None), np.clip(hi, 0, None), sig
    return df


def evaluate(df, ctx):
    res = {"overall": {}, "by_horizon": [], "by_category": [], "aggregate": {}}
    cols = MODELS + ["ensemble"]
    for k in cols:
        res["overall"][k] = summary(df["y"], df[k]) | {"label": LABELS[k]}
    for h, g in df.groupby("h"):
        res["by_horizon"].append({"h": int(h), **{k: wape(g["y"], g[k]) for k in cols}})
    df = df.assign(category=[ctx.categories[c] for c in df["category_code"]])
    for cat, g in df.groupby("category"):
        res["by_category"].append({"category": cat, "units": float(g["y"].sum()),
                                   "wape_item": wape(g["y"], g["ensemble"]),
                                   "wape_category": wape(g.groupby("target_t")["y"].sum(), g.groupby("target_t")["ensemble"].sum())})
    # Aggregated accuracy: what a buyer planning at category / store level experiences.
    for level, keys in {"category_week": ["category", "target_t"], "store_week": ["target_t"]}.items():
        agg = df.groupby(keys)[["y"] + cols].sum()
        res["aggregate"][level] = {k: wape(agg["y"], agg[k]) for k in cols}
    # Noise floor: an oracle that knows each medicine's true mean demand over the test window.
    oracle = df.groupby("med")["y"].transform("mean")
    floor = wape(df["y"], oracle)
    res["noise_floor_wape"] = floor
    ref = res["overall"]["ma8"]["wape"]
    for k in cols:
        res["overall"][k]["skill_vs_ma8"] = float((ref - res["overall"][k]["wape"]) / max(ref - floor, 1e-9))
    # Season-sensitive categories (identified from training data only).
    swing = np.abs(ctx.cat_season_idx - 1).max(1)
    seasonal = [ctx.categories[i] for i in np.where(swing >= 0.15)[0]]
    sub = df[df["category"].isin(seasonal)]
    agg = sub.groupby(["category", "target_t"])[["y"] + cols].sum()
    res["seasonal_categories"] = {"categories": seasonal, "share_of_units": float(sub["y"].sum() / df["y"].sum()),
                                  "item_week": {k: wape(sub["y"], sub[k]) for k in cols},
                                  "category_week": {k: wape(agg["y"], agg[k]) for k in cols}}
    res["coverage_90"] = float(((df["y"] >= df["lo"]) & (df["y"] <= df["hi"])).mean())
    # Seasonal direction test: did we correctly call which items rise vs fall vs. the last 8 weeks?
    up_true = df.groupby("med").apply(lambda g: g["y"].mean() > g["ma_8"].iloc[0], include_groups=False)
    up_pred = df.groupby("med").apply(lambda g: g["ensemble"].mean() > g["ma_8"].iloc[0], include_groups=False)
    busy = df.groupby("med")["y"].sum() >= 12
    res["direction_accuracy"] = float((up_true[busy] == up_pred[busy]).mean())
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m ml.train", description="Train the MedForecast models.")
    ap.add_argument("--data", help="training workbook (.xlsx with 'Sales Data' + 'Medicine Master'), a sales .csv "
                                   "in the same schema, or a dataset manifest.json / directory built by ml.ingest")
    ap.add_argument("--extra-sales", nargs="*", default=[], help="extra sales .csv files appended to --data "
                                                                 "(de-duplicated by transaction_id)")
    ap.add_argument("--out", help="artifact output directory (default: env MEDFORECAST_ARTIFACTS or ml/artifacts)")
    args = ap.parse_args(argv)

    t0 = time.time()
    # Default behaviour is unchanged: base workbook in, ml/artifacts out.
    C.ARTIFACTS = Path(args.out or os.environ.get("MEDFORECAST_ARTIFACTS") or C.DEFAULT_ARTIFACTS).resolve()
    if args.data or args.extra_sales:
        from .ingest import resolve_training_input
        C.RAW_XLSX = resolve_training_input(args.data, args.extra_sales, workdir=C.ARTIFACTS / "_input")
    C.ARTIFACTS.mkdir(parents=True, exist_ok=True)
    C.PROCESSED.mkdir(parents=True, exist_ok=True)
    progress(1, "Loading data")
    log(f"Loading data from {C.RAW_XLSX}; writing artifacts to {C.ARTIFACTS}")
    sales, master = load_raw()
    panel, weeks = weekly_panel(sales, master)
    T = len(weeks)
    log(f"{len(sales):,} transactions -> {master.shape[0]} medicines x {T} full weeks "
        f"({weeks[0].date()} .. {(weeks[-1] + pd.Timedelta(days=6)).date()})")
    if not (args.data or args.extra_sales):
        panel.to_csv(C.PROCESSED / "weekly_panel.csv", index=False)
    progress(5, f"Weekly panel ready: {master.shape[0]} medicines x {T} weeks")

    cut_a, cut_b, cut_f = T - 1 - 2 * C.HORIZON, T - 1 - C.HORIZON, T - 1

    # ---- Fold A: model selection / calibration ---------------------------------
    progress(8, "Fold A: training models for validation")
    ctx_a, fa, gbm_a, deep_a = run_fold(panel, master, weeks, cut_a)
    weights = fit_weights(fa)
    fa["ensemble"] = ensemble(fa, weights)
    calib = calibrate(fa)
    dl_epochs = max(6, deep_a.best_epoch)
    gbm_rounds = max(100, gbm_a.best_rounds)
    log(f"Ensemble weights {weights}; DL epochs {dl_epochs}; GBM rounds {gbm_rounds}")

    # ---- Fold B: honest holdout -----------------------------------------------
    progress(35, "Fold B: training models for the holdout")
    ctx_b, fb, gbm_b, deep_b = run_fold(panel, master, weeks, cut_b, dl_epochs=dl_epochs, gbm_rounds=gbm_rounds, with_val=False)
    fb["ensemble"] = ensemble(fb, weights)
    fb = add_intervals(fb, calib)
    fa = add_intervals(fa, calib)
    ev_b = evaluate(fb, ctx_b)
    ev_a = evaluate(fa, ctx_a)
    log("Holdout WAPE: " + ", ".join(f"{k}={v['wape']:.3f}" for k, v in ev_b["overall"].items())
        + f" | coverage90={ev_b['coverage_90']:.2f} | floor={ev_b['noise_floor_wape']:.3f}")
    log("Seasonal-category cat-week WAPE: " + str({k: round(v, 3) for k, v in ev_b["seasonal_categories"]["category_week"].items()}))
    imp_rows = build_rows(ctx_b, training_origins(cut_b)[-12:])
    imp_rows = imp_rows[imp_rows["target_t"] <= cut_b]
    importance = gbm_b.importance(imp_rows)

    # Re-calibrate intervals on both folds' out-of-sample residuals for the production forecast.
    calib_final = calibrate(pd.concat([fa, fb]))

    # ---- Final model: all data -> next 12 weeks --------------------------------
    progress(62, "Holdout scored; training the production model on all weeks")
    # Production weights are refit on BOTH folds' out-of-sample predictions.
    prod_weights = fit_weights(pd.concat([fa, fb]))
    log(f"Production ensemble weights {prod_weights}")
    ctx_f, ff, _, deep_f = run_fold(panel, master, weeks, cut_f, dl_epochs=dl_epochs, gbm_rounds=gbm_rounds, with_val=False)
    ff["ensemble"] = ensemble(ff, prod_weights)
    ff = add_intervals(ff, calib_final)

    # ---- Seasonal impact analytics (full history) ------------------------------
    progress(88, "Computing seasonal impact analytics")
    log("Computing seasonal impact analytics")
    cal = calendar_frame(weeks)
    ci = category_index(panel)
    mi = medicine_index(panel, ci)
    med_mat, cat_mat, _, _ = index_lookup(panel)
    boot = bootstrap_category_ci(panel)
    ci = ci.merge(boot, on=["category", "season"], how="left")
    fest = festival_impact(panel, cal)
    level = deseasonalised_level(panel, med_mat)

    # ---- Persist artifacts -------------------------------------------------------
    progress(95, "Writing artifacts")
    log("Writing artifacts")
    A = C.ARTIFACTS
    ids = ctx_f.med_ids
    week_str = lambda t: ctx_f.week_index[int(t)].strftime("%Y-%m-%d")

    stats = panel.groupby("medicine_id").agg(total_units=("units", "sum"), total_revenue=("revenue", "sum"),
                                             total_tx=("tx", "sum"), avg_weekly=("units", "mean"))
    meds = master.set_index("medicine_id").join(stats)
    meds["base_level"] = level.reindex(meds.index).fillna(0)
    for s in C.SEASON_ORDER:
        meds[f"idx_{s}"] = med_mat.reindex(meds.index)[s].fillna(1.0)
    meds.reset_index().to_csv(A / "medicines.csv", index=False)

    panel[["medicine_id", "week", "units", "revenue", "tx"]].assign(week=lambda d: d["week"].dt.strftime("%Y-%m-%d")) \
        .to_csv(A / "weekly_history.csv", index=False)

    def dump_preds(df, path, actual=True):
        out = pd.DataFrame({"medicine_id": ids[df["med"]], "week": df["target_t"].map(week_str), "h": df["h"],
                            "gbm": df["gbm"], "deep": df["deep"], "snaive": df["snaive"], "ma8": df["ma8"],
                            "ensemble": df["ensemble"], "lo": df["lo"], "hi": df["hi"], "sigma": df["sigma"]})
        if actual:
            out["actual"] = df["y"]
        out.round(4).to_csv(path, index=False)

    dump_preds(ff, A / "forecast.csv", actual=False)
    dump_preds(fb, A / "backtest.csv")
    mi.to_csv(A / "med_season_index.csv", index=False)
    ci.to_csv(A / "cat_season_index.csv", index=False)
    fest.to_csv(A / "festival_impact.csv", index=False)
    importance.to_csv(A / "feature_importance.csv", index=False)

    s = sales
    store = {
        "generated_at": pd.Timestamp.now().isoformat(timespec="seconds"),
        "data": {
            "transactions": int(len(s)), "medicines": int(master.shape[0]),
            "medicines_sold": int(s["medicine_id"].nunique()), "categories": int(master["category"].nunique()),
            "suppliers": int(s["supplier_id"].nunique()),
            "start": str(s["sale_date"].min().date()), "end": str(s["sale_date"].max().date()),
            "weeks": T, "units": int(s["quantity_sold"].sum()), "revenue": float(s["total_amount"].sum()),
            "rx_share": float((s["prescription_type"] == "Rx").mean()),
            "forecast_start": week_str(cut_f + 1), "forecast_end": week_str(cut_f + C.HORIZON),
        },
        "monthly": (s.assign(month=s["sale_date"].dt.to_period("M").astype(str))
                    .groupby("month").agg(units=("quantity_sold", "sum"), revenue=("total_amount", "sum"),
                                          tx=("transaction_id", "size")).reset_index().to_dict("records")),
        "dow": (s.groupby(s["sale_date"].dt.dayofweek).size() / s["sale_date"].dt.normalize().drop_duplicates()
                .dt.dayofweek.value_counts().sort_index()).round(2).tolist(),
        "hour": s.groupby("hour").size().reindex(range(24), fill_value=0).tolist(),
        "seasons": {k: {**v, "month_list": C.SEASONS[k]} for k, v in C.SEASON_META.items()},
        "festivals": C.FESTIVALS,
    }
    (A / "store.json").write_text(json.dumps(store, indent=1, default=str))

    metrics = {
        "protocol": {
            "fold_a": {"train_until": week_str(cut_a), "test": [week_str(cut_a + 1), week_str(cut_a + C.HORIZON)]},
            "fold_b": {"train_until": week_str(cut_b), "test": [week_str(cut_b + 1), week_str(cut_b + C.HORIZON)]},
            "final": {"train_until": week_str(cut_f)},
            "horizon_weeks": C.HORIZON, "rows_per_fold": int(len(fb)),
        },
        "labels": LABELS,
        "weights": weights,
        "production_weights": prod_weights,
        "dl_epochs": dl_epochs,
        "gbm_rounds": gbm_rounds,
        "gbm_curve": gbm_a.curve,
        "dl_history": deep_a.history,
        "calibration": calib_final,
        "holdout": ev_b,
        "validation": ev_a,
        "training_seconds": round(time.time() - t0, 1),
    }
    (A / "metrics.json").write_text(json.dumps(metrics, indent=1))
    log(f"Done in {time.time() - t0:.0f}s")
    progress(100, "Training finished")


if __name__ == "__main__":
    main()
