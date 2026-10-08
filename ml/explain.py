"""Explainable forecasts: exact TreeSHAP attributions for the production XGBoost model.

    python -m ml.explain        (~1-2 min, reads metrics.json, writes ml/artifacts/explain_*)

Rebuilds the production feature context exactly as ml/train.py does for the final fold
(train on weeks 0..T-1, forecast the next 12 weeks), refits the gradient-boosting model
with the production number of rounds and asks XGBoost for its native TreeSHAP values
(`pred_contribs=True`, no `shap` package needed).

The Poisson model predicts log(demand), so SHAP values add up in log space:

    log(forecast) = bias + sum(contribs)        ->   forecast = exp(bias) * prod(exp(contrib))

exp(bias) is the model's baseline weekly rate (an "average row" of the training data) and
exp(contrib) for a feature group is a multiplicative factor ("x1.18 = lifts by 18%").
Only the gradient-boosting member of the ensemble is explained; the ensemble also blends
the deep model and the seasonal baseline, so explanations describe the GBM's reasoning.
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
import xgboost as xgb

from . import config as C
from .data import load_raw, weekly_panel
from .features import FEATURES, build_context, build_rows, training_origins
from .models.gbm import GBMForecaster

# Human feature groups (every model feature belongs to exactly one group).
GROUPS: dict[str, list[str]] = {
    "Long-run demand level": ["hist_mean", "deseason_level", "curve_level"],
    "Recent sales (lags & averages)": ["lag_1", "lag_2", "lag_3", "lag_4", "ma_4", "ma_8", "ma_12", "ema",
                                       "std_8", "nz_8", "weeks_since_sale"],
    "Momentum & trend": ["momentum"],
    "Season effect": ["target_med_season_idx", "target_cat_season_idx", "recent_season_idx", "season_shift",
                      "seasonal_naive", "woy_sin", "woy_cos", "month", "season_code",
                      "recent_curve_mult", "target_curve_mult", "curve_shift", "curve_naive"],
    "Festivals": ["fest_onam", "fest_vishu", "fest_xmas"],
    "Product traits": ["category_code", "form_code", "log_price", "rx_share"],
    "Forecast horizon": ["h"],
    "Store & category activity": ["cat_momentum", "store_momentum"],
}
GROUP_ORDER = list(GROUPS)
FEATURE_GROUP = {f: g for g, fs in GROUPS.items() for f in fs}
assert set(FEATURES) <= set(FEATURE_GROUP), "every model feature must belong to exactly one group"

GLOBAL_SAMPLE = 40_000   # training rows sampled for the season / category importance tables


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def shap_values(gbm: GBMForecaster, rows: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (contribs [n, n_features], bias [n], margin [n]) in log space."""
    dm = gbm._matrix(rows, with_label=False)
    it = (0, gbm.best_rounds)
    contribs = gbm.booster.predict(dm, pred_contribs=True, iteration_range=it)
    margin = gbm.booster.predict(dm, output_margin=True, iteration_range=it)
    return contribs[:, :-1], contribs[:, -1], margin


def group_matrix(contribs: np.ndarray) -> np.ndarray:
    """Sum feature contributions into [n, n_groups] in GROUP_ORDER."""
    out = np.zeros((len(contribs), len(GROUP_ORDER)))
    for j, f in enumerate(FEATURES):
        out[:, GROUP_ORDER.index(FEATURE_GROUP[f])] += contribs[:, j]
    return out


def mean_abs(G: np.ndarray, mask=None) -> dict[str, float]:
    g = G if mask is None else G[mask]
    return {name: float(np.abs(g[:, k]).mean()) for k, name in enumerate(GROUP_ORDER)}


def main():
    t0 = time.time()
    A = C.ARTIFACTS
    metrics = json.loads((A / "metrics.json").read_text())
    rounds = int(metrics["gbm_rounds"])

    log("Loading data")
    sales, master = load_raw()
    panel, weeks = weekly_panel(sales, master)
    cut_f = len(weeks) - 1

    # ---- Production context, identical to ml.train.run_fold(cutoff = last week) ----
    ctx = build_context(panel, master, weeks, cut_f)
    train = build_rows(ctx, training_origins(cut_f))
    train = train[train["target_t"] <= cut_f].reset_index(drop=True)
    test = build_rows(ctx, [cut_f], require_target=False)
    log(f"{len(train):,} training rows, {len(test):,} forecast rows; fitting GBM ({rounds} rounds)")
    gbm = GBMForecaster().fit(train, rounds=rounds)

    # ---- SHAP for the 12 forecast rows of every medicine -----------------------------
    contribs, bias, margin = shap_values(gbm, test)
    pred = gbm.predict(test)
    add_err = float(np.abs(contribs.sum(1) + bias - margin).max())
    exp_err = float(np.abs(np.exp(margin) - pred).max())
    log(f"Additivity: max |sum(contribs)+bias-margin| = {add_err:.2e}; max |exp(margin)-predict| = {exp_err:.2e}")
    assert add_err < 1e-3, "TreeSHAP values do not add up to the model margin"
    assert exp_err < 1e-3 * max(1.0, pred.max()), "exp(margin) does not reproduce GBMForecaster.predict"

    # Agreement with the GBM column that ml.train wrote (refit on identical data/params).
    fc = pd.read_csv(A / "forecast.csv")
    ids = ctx.med_ids
    week_str = lambda t: ctx.week_index[int(t)].strftime("%Y-%m-%d")
    mine = pd.DataFrame({"medicine_id": ids[test["med"]], "h": test["h"].to_numpy(), "pred": pred})
    cmp = fc.merge(mine, on=["medicine_id", "h"])
    agree = {"rows": int(len(cmp)), "max_abs_diff": float(np.abs(cmp["gbm"] - cmp["pred"]).max()),
             "corr": float(np.corrcoef(cmp["gbm"], cmp["pred"])[0, 1]),
             "total_ratio": float(cmp["pred"].sum() / max(cmp["gbm"].sum(), 1e-9))}
    log(f"Agreement with forecast.csv gbm column: {agree}")

    G = group_matrix(contribs)
    long = pd.DataFrame(G, columns=GROUP_ORDER)
    long.insert(0, "h", test["h"].to_numpy())
    long.insert(0, "medicine_id", ids[test["med"]])
    long = long.melt(id_vars=["medicine_id", "h"], var_name="group", value_name="contrib")
    long["contrib"] = long["contrib"].round(6)
    long.sort_values(["medicine_id", "h", "group"]).to_csv(A / "explain_medicine.csv", index=False)

    rows = pd.DataFrame({"medicine_id": ids[test["med"]], "h": test["h"].to_numpy(),
                         "week": test["target_t"].map(week_str).to_numpy(),
                         "season": [C.SEASON_ORDER[s] for s in test["season_code"]],
                         "bias": bias, "margin": margin, "prediction": pred})
    rows.round(6).to_csv(A / "explain_rows.csv", index=False)

    # Individual features (for "top drivers" detail), only meaningful contributions kept.
    feat = pd.DataFrame(contribs, columns=FEATURES)
    feat.insert(0, "_h", test["h"].to_numpy())   # "h" is itself a feature name
    feat.insert(0, "medicine_id", ids[test["med"]])
    feat = feat.melt(id_vars=["medicine_id", "_h"], var_name="feature", value_name="contrib").rename(columns={"_h": "h"})
    feat = feat[feat["contrib"].abs() >= 1e-4]
    feat["contrib"] = feat["contrib"].round(5)
    feat.to_csv(A / "explain_feature.csv", index=False)

    # ---- Global importance --------------------------------------------------------------
    # Forecast rows only cover Sep-Nov; a sample of training rows spans every season.
    samp = train.sample(min(GLOBAL_SAMPLE, len(train)), random_state=C.SEED).reset_index(drop=True)
    c_tr, b_tr, m_tr = shap_values(gbm, samp)
    assert np.abs(c_tr.sum(1) + b_tr - m_tr).max() < 1e-3
    G_tr = group_matrix(c_tr)
    seasons = np.array([C.SEASON_ORDER[s] for s in samp["season_code"]])
    cats = np.array([ctx.categories[c] for c in samp["category_code"]])
    feat_imp = sorted(({"feature": f, "group": FEATURE_GROUP[f], "mean_abs": float(np.abs(c_tr[:, j]).mean())}
                       for j, f in enumerate(FEATURES)), key=lambda d: -d["mean_abs"])

    out = {
        "generated_at": pd.Timestamp.now().isoformat(timespec="seconds"),
        "method": "XGBoost native TreeSHAP (pred_contribs), log/margin space of the Poisson model",
        "gbm_rounds": rounds,
        "bias": float(bias[0]),
        "baseline_rate": float(np.exp(bias[0])),
        "groups": GROUP_ORDER,
        "group_features": GROUPS,
        "checks": {"additivity_max_err": add_err, "predict_max_err": exp_err, "agreement_with_forecast_csv": agree},
        "overall": {"forecast": mean_abs(G), "training": mean_abs(G_tr)},
        "by_season": {s: mean_abs(G_tr, seasons == s) | {"_rows": int((seasons == s).sum())} for s in C.SEASON_ORDER},
        "by_category": {c: mean_abs(G_tr, cats == c) | {"_rows": int((cats == c).sum())} for c in ctx.categories},
        "top_features": feat_imp,
        "sample_rows": int(len(samp)),
        "forecast_rows": int(len(test)),
    }
    (A / "explain_global.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    log(f"Wrote explain_medicine.csv ({len(long):,} rows), explain_rows.csv, explain_feature.csv, explain_global.json "
        f"in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
