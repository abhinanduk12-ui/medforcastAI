"""Explainable forecasts: TreeSHAP drivers of the gradient-boosting forecast.

Artifacts come from `python -m ml.explain` and are loaded lazily (reloaded when the
files change). SHAP values live in the Poisson model's log space, so each feature group
acts as a multiplicative factor on the model's baseline weekly rate:

    forecast = baseline_rate x factor_1 x factor_2 x ...
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Path, Query

from backend.core import A, S, clean
from ml import config as C

router = APIRouter(prefix="/api/explain", tags=["explain"])

FILES = ["explain_medicine.csv", "explain_rows.csv", "explain_feature.csv", "explain_global.json"]
MISSING = "Forecast explanations have not been generated yet. Run `python -m ml.explain` from the project root (about 30 seconds)."
STALE = ("These explanations were generated for an earlier model run and no longer match the current forecast. "
         "Run `python -m ml.explain` to refresh them.")
NEUTRAL = 0.01         # |factor - 1| below this is reported as "no real effect"
SENTENCE_MIN = 0.03     # smallest effect worth a sentence

FEATURE_NAMES = {
    "hist_mean": "Long-run average demand", "deseason_level": "Season-adjusted run-rate", "lag_1": "Sales last week",
    "lag_2": "Sales 2 weeks ago", "lag_3": "Sales 3 weeks ago", "lag_4": "Sales 4 weeks ago", "ma_4": "4-week average",
    "ma_8": "8-week average", "ma_12": "12-week average", "ema": "Exponential average", "std_8": "Volatility (8 wk)",
    "nz_8": "Sales frequency (8 wk)", "weeks_since_sale": "Weeks since last sale", "momentum": "Item momentum",
    "target_med_season_idx": "Target-season index (medicine)", "target_cat_season_idx": "Target-season index (category)",
    "recent_season_idx": "Recent season index", "season_shift": "Season shift ratio", "seasonal_naive": "Seasonal baseline",
    "woy_sin": "Week of year (sin)", "woy_cos": "Week of year (cos)", "month": "Target month", "season_code": "Target season",
    "fest_onam": "Onam festival", "fest_vishu": "Vishu festival", "fest_xmas": "Christmas / New Year",
    "category_code": "Therapeutic category", "form_code": "Dosage form", "log_price": "Unit price", "rx_share": "Prescription share",
    "h": "Forecast horizon", "cat_momentum": "Category momentum", "store_momentum": "Store momentum",
}

_cache: dict = {"key": None, "data": None}


def _load():
    """Load explain artifacts, cached on file modification times. None if any file is missing."""
    paths = [A / f for f in FILES]
    if not all(p.exists() for p in paths):
        return None
    try:
        key = tuple(p.stat().st_mtime_ns for p in paths)
    except OSError:
        return None
    if _cache["key"] != key:
        try:
            med = pd.read_csv(paths[0])
            rows = pd.read_csv(paths[1])
            feat = pd.read_csv(paths[2])
            glob = json.loads(paths[3].read_text(encoding="utf-8"))
            data = {
                "contrib": med.pivot_table(index=["medicine_id", "h"], columns="group", values="contrib").reindex(columns=glob["groups"]),
                "rows": rows.set_index(["medicine_id", "h"]).sort_index(),
                "feat": feat.set_index("medicine_id").sort_index(),
                "global": glob,
            }
        except Exception:
            # Half-written files (ml.explain running right now) or a corrupt artifact: keep serving the
            # previous good copy if there is one, otherwise report "not available" instead of a 500.
            return _cache["data"]
        _cache["data"], _cache["key"] = data, key
    return _cache["data"]


def _finite(o):
    """JSON-safe without clean()'s 4-decimal rounding (the additivity checks are ~1e-5 and would read as 0)."""
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, (int, np.integer)) and not isinstance(o, bool):
        return int(o)
    if isinstance(o, (float, np.floating)):
        v = float(o)
        return v if math.isfinite(v) else None
    return o


def _gbm_now(mid: str | None = None, weeks: int = C.HORIZON) -> pd.DataFrame:
    """Live GBM forecast rows (forecast.csv) to compare against the explained model."""
    f = S.fc[S.fc["h"] <= weeks]
    return f[f["medicine_id"] == mid] if mid is not None else f


def _stale(explained: np.ndarray, live: np.ndarray) -> bool:
    """True when the explained GBM no longer reproduces the live GBM forecast (e.g. after a retrain)."""
    if len(explained) != len(live) or not len(live):
        return True
    return bool(np.abs(explained - live).max() > 0.01 * max(1.0, float(np.abs(live).max())))


def _effect(factor: float) -> str:
    """'lifts this forecast by 18%' for modest effects, 'multiplies this forecast by 3.2×' for large ones."""
    if factor >= 2:
        return f"multiplies this forecast by {factor:.1f}×"
    if factor <= 0.5:
        return f"scales this forecast down to {factor:.2f}× ({(factor - 1) * 100:+.0f}%)".replace("-", "−")
    pct = f"{abs(factor - 1) * 100:.0f}%"
    return f"lifts this forecast by {pct}" if factor > 1 else f"lowers this forecast by {pct}"


def _season_sentence(factor: float, by_season: list[dict]) -> str:
    if len(by_season) == 1:
        return f"The {by_season[0]['season']}-season effect {_effect(factor)}."
    # Several seasons in the window: an average would hide opposite effects, so name each one.
    parts = [f"{'+' if b['factor'] >= 1 else '−'}{abs(b['factor'] - 1) * 100:.0f}% in the {b['season']} weeks"
             for b in by_season]
    return f"The season effect is {' and '.join(parts)} (net {(factor - 1) * 100:+.0f}% over the whole window).".replace("net -", "net −")


def _sentence(group: str, factor: float, festivals: list[str], avg_weekly: float | None = None) -> str:
    v = _effect(factor)
    # SHAP signs are relative to the model's baseline row, not to this medicine's own history, so the
    # sentences state what the model did with an input rather than asserting a comparison it never made.
    if group == "Long-run demand level":
        lvl = ""
        if avg_weekly is not None and math.isfinite(avg_weekly):
            lvl = (" (almost no sales over the past year)" if avg_weekly < 0.005 else
                   f" (about {avg_weekly:.1f} units a week on average)" if avg_weekly >= 1 else
                   f" (about {avg_weekly:.2f} units a week on average)")
        return f"Its long-run sales level{lvl} {v} relative to the store baseline."
    if group == "Recent sales (lags & averages)":
        return f"What it sold over the last 1–12 weeks {v}."
    if group == "Momentum & trend":
        return f"Its recent 4-week trend versus its long-run average {v}."
    if group == "Festivals":
        if festivals:
            return f"{' and '.join(festivals)} in the forecast window {v}."
        return f"No festival falls in these weeks, which {v}."
    if group == "Product traits":
        return f"The mix of its category, dosage form, price and prescription share {v} compared with a typical item."
    if group == "Forecast horizon":
        return f"How far ahead these weeks are {v}."
    if group == "Store & category activity":
        return f"Recent store-wide and category sales momentum {v}."
    return f"{group} {v}."


def _signed_pct(x: float) -> str:
    """'+3%' / '−3%' / '0%': the sign follows the rounded value, so it never prints '−0%'."""
    r = round(x * 100)
    return f"{'+' if r > 0 else '−' if r < 0 else ''}{abs(r)}%"


@router.get("/medicine/{mid}")
def explain_medicine(mid: str = Path(..., min_length=1, max_length=32),
                     weeks: int = Query(4, ge=1, le=C.HORIZON, description="Average the explanation over the first N forecast weeks")):
    if mid not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine {mid}")
    d = _load()
    if d is None:
        return {"available": False, "message": MISSING}
    if mid not in d["rows"].index.get_level_values(0):
        raise HTTPException(404, f"No explanation stored for {mid}; rerun `python -m ml.explain`.")

    rows = d["rows"].loc[mid]
    contrib = d["contrib"].loc[mid]
    groups = d["global"]["groups"]
    first = rows.index[rows.index <= weeks]
    bias = float(rows["bias"].iloc[0])
    baseline = math.exp(bias)
    mean_c = contrib.loc[first].mean()
    # Waterfall reaches exp(mean margin) = geometric mean of weekly forecasts; the arithmetic
    # mean is slightly higher (Jensen). Report that gap explicitly rather than hide it.
    geo = math.exp(bias + float(mean_c.sum()))
    prediction = float(rows.loc[first, "prediction"].mean())
    averaging = prediction / geo if geo > 0 else 1.0

    factors = []
    for g in groups:
        c = float(mean_c[g])
        f = math.exp(c)
        factors.append({"group": g, "contrib": c, "factor": f, "pct": f - 1,
                        "direction": "neutral" if abs(f - 1) < NEUTRAL else ("up" if f > 1 else "down"),
                        "features": d["global"]["group_features"][g]})
    factors.sort(key=lambda x: -abs(x["contrib"]))

    wk = rows.loc[first, "week"].tolist()
    seasons = list(dict.fromkeys(rows.loc[first, "season"].tolist()))
    sc = contrib.loc[first, "Season effect"]
    by_season = [{"season": s_, "weeks": int((rows.loc[first, "season"] == s_).sum()),
                  "factor": math.exp(float(sc[rows.loc[first, "season"] == s_].mean()))} for s_ in seasons]
    fest_days = {n: sum(C.festival_days(pd.Timestamp(w))[n] for w in wk) for n in C.FESTIVALS}
    festivals = [n for n, v in fest_days.items() if v > 0]

    ens = _gbm_now(mid, weeks).sort_values("h")
    stale = _stale(rows.loc[first, "prediction"].to_numpy(dtype=float), ens["gbm"].to_numpy(dtype=float))
    n = len(first)
    m = S.meds.loc[mid]
    sentences = [f"Starting from the model’s store-wide baseline of {baseline:.1f} units a week, the gradient-boosting model "
                 f"expects {prediction:.1f} units a week over the next {n} week{'s' if n > 1 else ''}."]
    # The season sentence is always included (it is the question a seasonal planner asks);
    # the other drivers are named only when they move the forecast by >= 3%.
    for fac in factors:
        if fac["group"] == "Season effect":
            sf = fac["factor"]
            strong = abs(sf - 1) >= SENTENCE_MIN or any(abs(b["factor"] - 1) >= SENTENCE_MIN for b in by_season)
            sentences.append(_season_sentence(sf, by_season) if strong else
                             f"The season has little effect on this medicine in these weeks ({_signed_pct(sf - 1)}).")
        elif abs(fac["factor"] - 1) >= SENTENCE_MIN and len(sentences) < 5:
            sentences.append(_sentence(fac["group"], fac["factor"], festivals, float(m["avg_weekly"])))

    # Individual features behind the drivers (averaged over the same weeks).
    ft = d["feat"].loc[[mid]] if mid in d["feat"].index else pd.DataFrame(columns=["h", "feature", "contrib"])
    ft = ft[ft["h"] <= weeks].groupby("feature")["contrib"].sum() / n
    top = ft.reindex(ft.abs().sort_values(ascending=False).index).head(6)
    group_of = {f: g for g, fs in d["global"]["group_features"].items() for f in fs}

    per_h = []
    for h, r in rows.iterrows():
        c = contrib.loc[h]
        per_h.append({"h": int(h), "week": r["week"], "season": r["season"], "prediction": float(r["prediction"]),
                      "season_factor": math.exp(float(c["Season effect"])),
                      "factors": {g: math.exp(float(c[g])) for g in groups}})

    return clean({
        "available": True, "id": mid, "name": m["medicine_name"], "weeks": n, "week_range": [wk[0], wk[-1]], "seasons": seasons,
        "stale": stale, "stale_message": STALE if stale else None,
        "baseline_rate": baseline, "geometric_prediction": geo, "averaging_factor": averaging, "prediction": prediction,
        "ensemble_prediction": float(ens["ensemble"].mean()) if len(ens) else None,
        "gbm_weight": S.metrics.get("production_weights", {}).get("gbm"),
        "factors": factors, "sentences": sentences, "season_breakdown": by_season,
        "top_features": [{"feature": f, "label": FEATURE_NAMES.get(f, f), "group": group_of.get(f), "contrib": float(v),
                          "factor": math.exp(float(v))} for f, v in top.items()],
        "per_horizon": per_h,
    })


@router.get("/global")
def explain_global():
    d = _load()
    if d is None:
        return {"available": False, "message": MISSING}
    g = d["global"]
    groups = g["groups"]

    def rows(table: dict) -> list[dict]:
        out = []
        for name, vals in table.items():
            imp = {k: vals[k] for k in groups}
            tot = sum(imp.values()) or 1.0
            out.append({"name": name, "rows": vals.get("_rows"), "importance": imp, "share": {k: v / tot for k, v in imp.items()},
                        "typical_factor": {k: math.exp(v) for k, v in imp.items()}})
        return out

    overall = [{"group": k, "mean_abs": g["overall"]["forecast"][k], "typical_factor": math.exp(g["overall"]["forecast"][k]),
                "training_mean_abs": g["overall"]["training"][k], "features": g["group_features"][k]} for k in groups]
    overall.sort(key=lambda x: -x["mean_abs"])
    live = _gbm_now().set_index(["medicine_id", "h"])["gbm"]
    both = d["rows"]["prediction"].to_frame().join(live, how="outer")
    stale = bool(both.isna().any().any()) or _stale(both["prediction"].to_numpy(dtype=float), both["gbm"].to_numpy(dtype=float))
    out = clean({
        "available": True, "generated_at": g["generated_at"], "method": g["method"], "baseline_rate": g["baseline_rate"],
        "stale": stale, "stale_message": STALE if stale else None,
        "groups": groups, "overall": overall,
        "by_season": [r for s in C.SEASON_ORDER for r in rows({s: g["by_season"][s]})],
        "by_category": sorted(rows(g["by_category"]), key=lambda r: -(r["rows"] or 0)),
        "top_features": [{**f, "label": FEATURE_NAMES.get(f["feature"], f["feature"])} for f in g["top_features"][:12]],
        "checks": g["checks"], "sample_rows": g["sample_rows"], "forecast_rows": g["forecast_rows"],
        "gbm_weight": S.metrics.get("production_weights", {}).get("gbm"),
    })
    out["checks"] = _finite(g["checks"])
    return out
