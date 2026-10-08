"""12-month seasonal planning calendar ("Year Planner").

Projects demand and purchase value month by month for the year ahead, so buyers can see the
season changes and festivals coming and pre-order before demand moves.

Method (per medicine, per day, then summed to months):
  seasonal projection = base_level / 7 * season index of that day's month / festival share already in it
                        * (1 + per-day festival uplift)   significant festival effects only, on festival days
  ML blend            = w(h) * ensemble / 7 + (1 - w(h)) * seasonal projection
                        on days covered by the 12-week ML forecast, with w(h) = W0 * (1 - (h - 1) / 12)
  uncertainty (90 %)  = seasonal part: season-index CI (per category, fully correlated within it)
                        + store level: run-rate error + month-to-month shock (stationary, measured)
                          + drift growing with sqrt(months since the data ended) (floored assumption)
                        + calibrated weekly forecast noise (independent per medicine/week);
                        ML part: calibrated per-medicine sigma + shared store-level error from the holdout.
                        The two are combined as if fully correlated (sd = w * sd_ml + (1 - w) * sd_seasonal),
                        which is conservative.
"""
from __future__ import annotations

import calendar as pycal
import math
from datetime import date
from functools import lru_cache

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from ml import config as C
from backend.core import S, clean, MIN_UPLIFT, MIN_SEASON_BASE

router = APIRouter(prefix="/api/calendar", tags=["calendar"])

Z90 = 1.645
ML_W0 = 0.8              # ML weight on the first forecast week; decays linearly to ~0 by week 13
ML_DECAY_WEEKS = 12
DRIFT_FLOOR = 0.015      # assumed minimum random-walk drift of the store level per month (one year can't rule it out)
MIN_CAT_WEEKLY = 2.0     # category units/week needed before it is suggested for pre-ordering
TOP_MEDS = 5


def _months(start: pd.Timestamp, n: int) -> list[pd.Timestamp]:
    return [start + pd.DateOffset(months=i) for i in range(n)]


def _ml_weight(h: int) -> float:
    return max(0.0, ML_W0 * (1 - (h - 1) / ML_DECAY_WEEKS))


def _week_season(w) -> str:
    # Same convention as training (ml/data.py): a week belongs to the season of its mid-point.
    return C.season_of(pd.Timestamp(w) + pd.Timedelta(days=3))


@lru_cache(maxsize=4)
def _level_model(generated_at: str) -> dict:
    """Store-level uncertainty of the season-adjusted run-rate, from the weekly history (log scale).

    Model: log level of a 4-week block = stationary month-level shock + random-walk drift + weekly noise / 4.
    - weekly noise var  = lag-1 variogram / 2 of the weekly series
    - month shock var   = variance of 4-week block means minus the weekly noise share (noise / 4)
    - drift var / month = slope of the block variogram over lags (a random walk makes it grow linearly
                          with lag; a stationary series keeps it flat). One year can't pin a drift down,
                          so it is floored at DRIFT_FLOOR, a stated assumption.
    - level SE          = noise of the ~12-week mean the run-rate is estimated from.
    """
    m = S.meds
    tot = S.hist_wide.fillna(0).sum(axis=0)
    base = m["base_level"].fillna(0)
    fac = pd.Series({w: float((base * m[f"idx_{_week_season(w)}"]).sum() / max(base.sum(), 1e-9)) for w in S.weeks})
    ds = np.log((tot / fac).clip(lower=1).to_numpy())
    nb = len(ds) // 4
    if nb < 4:
        return {"drift": DRIFT_FLOOR, "drift_est": None, "month_sd": 0.03, "level_se": 0.02}
    noise_w = float(np.mean(np.diff(ds) ** 2) / 2)
    blocks = ds[-nb * 4:].reshape(nb, 4).mean(axis=1)
    month_var = max(float(np.var(blocks, ddof=1)) - noise_w / 4, 0.0)
    lags = np.arange(1, nb // 2 + 1)
    gam = np.array([np.mean((blocks[k:] - blocks[:-k]) ** 2) for k in lags])
    npairs = nb - lags
    X = np.column_stack([np.ones(len(lags)), lags])
    W = np.sqrt(npairs)[:, None]
    slope = float(np.linalg.lstsq(X * W, gam * W[:, 0], rcond=None)[0][1])
    drift_est = math.sqrt(max(slope, 0.0))
    return {"drift": max(DRIFT_FLOOR, drift_est), "drift_est": drift_est,
            "month_sd": math.sqrt(month_var), "level_se": math.sqrt(noise_w / 12)}


@lru_cache(maxsize=4)
def _ml_store_error(generated_at: str) -> float | None:
    """Relative store-level error of the ML ensemble over 4-week blocks of the holdout, beyond what the
    per-medicine sigmas imply when summed as independent (shared level errors and bias show up here)."""
    bt = S.bt
    if bt.empty or "actual" not in bt:
        return None
    g = bt.groupby("week").agg(f=("ensemble", "sum"), a=("actual", "sum"), v=("sigma", lambda x: float((x ** 2).sum())))
    nb = len(g) // 4
    if nb < 1:
        return None
    blk = g.iloc[: nb * 4].to_numpy().reshape(nb, 4, 3).sum(axis=1)   # f, a, v per block
    excess = float(np.mean((blk[:, 1] - blk[:, 0]) ** 2) - np.mean(blk[:, 2]))
    return math.sqrt(max(excess, 0.0) / float(np.mean(blk[:, 0] ** 2)))


@lru_cache(maxsize=4)
def _festival_model(generated_at: str) -> tuple[dict, dict]:
    """Per-day festival uplifts, and how much each (category, season) index already contains them.

    S.fest measures the uplift of festival *weeks* (>= 3 festival days) over normal weeks of the season.
    Spreading it over festival *days* needs it scaled by 7 / mean festival days in those weeks.
    The season indices were measured over weeks that included the festival (the history has two Onams
    inside Monsoon weeks), so that share is divided out before the festival is added back on its own days;
    otherwise the festival would be counted twice.
    """
    sig = S.fest[S.fest["significant"]]
    n_weeks = {s: 0 for s in C.SEASON_ORDER}
    fdays = {}                                     # (festival, season) -> festival days in history
    flagged = {}                                   # festival -> festival days of each flagged week
    for w in S.weeks:
        s = _week_season(w)
        n_weeks[s] += 1
        for f, d in C.festival_days(pd.Timestamp(w)).items():
            fdays[(f, s)] = fdays.get((f, s), 0) + d
            if d >= 3:
                flagged.setdefault(f, []).append(d)
    per_day = {}                                   # (festival, category) -> uplift per festival day
    for f, cat, u in sig[["festival", "category", "uplift"]].itertuples(index=False):
        mean_d = float(np.mean(flagged[f])) if flagged.get(f) else 7.0
        per_day[(f, cat)] = float(u) * 7 / mean_d
    deflate = {}                                   # (category, season) -> factor the index is inflated by
    for (f, cat), v in per_day.items():
        for s in C.SEASON_ORDER:
            if n_weeks[s]:
                deflate[(cat, s)] = deflate.get((cat, s), 1.0) + v * fdays.get((f, s), 0) / (7 * n_weeks[s])
    # The served indices are shrunk toward 1 (index = 1 + w * (raw - 1)), so take the festival share out of
    # the raw index and re-apply the same shrinkage: factor = index / (1 + w * (raw / F - 1)).
    csi = S.csi.set_index(["category", "season"])
    for key, F in list(deflate.items()):
        if key in csi.index and F > 1:
            idx, raw = float(csi.at[key, "index"]), float(csi.at[key, "raw_index"])
            w = min(max((idx - 1) / (raw - 1), 0.0), 1.0) if abs(raw - 1) > 1e-6 else 1.0
            ex = 1 + w * (raw / F - 1)
            deflate[key] = idx / ex if ex > 0.05 else F
    return per_day, deflate


def _index_rel_se() -> dict[tuple[str, str], float]:
    """Relative standard error of each category x season index from its 90 % bootstrap CI."""
    c = S.csi
    se = ((c["ci_hi"] - c["ci_lo"]) / (2 * Z90) / c["index"].clip(lower=0.05)).clip(lower=0, upper=1.0)
    return {(cat, s): float(v) for cat, s, v in zip(c["category"], c["season"], se)}


def _festival_windows(day_from: pd.Timestamp, day_to: pd.Timestamp) -> list[dict]:
    out = []
    for name, wins in C.FESTIVALS.items():
        for a, b in wins:
            a, b = pd.Timestamp(a), pd.Timestamp(b)
            if b >= day_from and a <= day_to:
                out.append({"name": name, "start": a, "end": b})
    return out


@lru_cache(maxsize=32)
def _build(category: str | None, n: int, start: str, generated_at: str) -> dict:
    m = S.meds if not category else S.meds[S.meds["category"] == category]
    ids = m.index
    base = m["base_level"].fillna(0).clip(lower=0).to_numpy()
    price = m["median_price"].fillna(0).to_numpy()
    cats = m["category"].to_numpy()
    fest_day, deflate = _festival_model(generated_at)
    # Season index with the festival share taken out (festivals are added back on their own days below).
    idx = {s: m[f"idx_{s}"].fillna(1.0).to_numpy() / np.array([deflate.get((c, s), 1.0) for c in cats])
           for s in C.SEASON_ORDER}

    # Calendar: n months to show, plus one more so the last month gets a "next month" for purchase rhythm.
    month_starts = _months(pd.Timestamp(start + "-01"), n + 1)
    first_day, last_day = month_starts[0], month_starts[-1] + pd.offsets.MonthEnd(0)
    fests = _festival_windows(first_day, last_day)
    sig = S.fest[S.fest["significant"]]
    fest_vec = {}  # festival -> per-medicine uplift per festival day (0 where the category has no significant effect)
    for name in C.FESTIVALS:
        fest_vec[name] = np.array([fest_day.get((name, c), 0.0) for c in cats])

    # ML forecast (weekly) -> daily rates over the forecast span
    fweeks = [pd.Timestamp(w) for w in S.fweeks]
    fc = S.fc_wide.reindex(ids).fillna(0).to_numpy()            # meds x weeks
    sg = S.sig_wide.reindex(ids).fillna(0).to_numpy()
    sig_noise = S.sig_wide.reindex(ids).iloc[:, -1].fillna(0).to_numpy()  # weekly noise at the longest horizon
    fc_end = fweeks[-1] + pd.Timedelta(days=6)
    data_end = pd.Timestamp(S.weeks[-1]) + pd.Timedelta(days=6)

    lv = _level_model(generated_at)
    drift = lv["drift"]
    # Shared (cross-medicine) ML error: measured on the holdout, never below the store's own month-to-month swing.
    ml_bt = _ml_store_error(generated_at)
    ml_corr = max(ml_bt or 0.0, math.sqrt(lv["month_sd"] ** 2 + lv["level_se"] ** 2))
    rel_se = _index_rel_se()
    med_se = float(np.median(list(rel_se.values()))) if rel_se else 0.1
    ucats = sorted(set(cats))
    cat_masks = {c: cats == c for c in ucats}

    months = []
    for ms in month_starts:
        days = pycal.monthrange(ms.year, ms.month)[1]
        season = C.MONTH_TO_SEASON[ms.month]
        si = idx[season]
        seas = np.zeros(len(ids))      # seasonal(+festival) projection, units in month
        final = np.zeros(len(ids))
        ml_var = np.zeros(len(ids))    # ML variance on covered days (independent per medicine)
        ml_sum = np.zeros(len(ids))    # ML expected units on covered days
        wsum, cov_days, hs = 0.0, 0, []
        fest_days = {}
        for d in range(days):
            day = ms + pd.Timedelta(days=d)
            mult = np.ones(len(ids))
            for f in fests:
                if f["start"] <= day <= f["end"]:
                    mult = mult + fest_vec[f["name"]]
                    fest_days[f["name"]] = fest_days.get(f["name"], 0) + 1
            s_rate = base * si / 7 * mult
            seas += s_rate
            if fweeks and fweeks[0] <= day <= fc_end:
                k = (day - fweeks[0]).days // 7
                h = k + 1
                w = _ml_weight(h)
                final += w * fc[:, k] / 7 + (1 - w) * s_rate
                ml_var += sg[:, k] ** 2 / 7
                ml_sum += fc[:, k] / 7
                wsum += w
                cov_days += 1
                hs.append(h)
            else:
                final += s_rate
        w_bar = wsum / days

        # ---- uncertainty (units and value), at the level of this (filtered) store
        typical = base * days / 7
        mid = ms + pd.Timedelta(days=days / 2)
        k_months = max((mid - data_end).days / 30.44, 0.5)

        def band(weights: np.ndarray) -> tuple[float, float]:
            tot_seas = float((seas * weights).sum())
            var_idx = sum((float((seas * weights)[mk].sum()) * rel_se.get((c, season), med_se)) ** 2
                          for c, mk in cat_masks.items())
            # store level: estimated run-rate error + this month's shock (both stationary) + drift since data end
            var_level = (lv["level_se"] ** 2 + lv["month_sd"] ** 2 + drift ** 2 * k_months) * tot_seas ** 2
            var_noise = float(((sig_noise * weights) ** 2).sum() * days / 7)
            sd_seas = math.sqrt(var_idx + var_level + var_noise)
            # ML error scaled to a whole month: independent per-medicine part + shared part (holdout-measured)
            sd_ml = math.sqrt(float((ml_var * weights ** 2).sum()) * days / cov_days
                              + (ml_corr * float((ml_sum * weights).sum()) * days / cov_days) ** 2) if cov_days else 0.0
            sd = w_bar * sd_ml + (1 - w_bar) * sd_seas
            return float((final * weights).sum()), sd

        units, sd_u = band(np.ones(len(ids)))
        value, sd_v = band(price)

        # ---- rising medicines: month expectation vs the medicine's typical month
        with np.errstate(divide="ignore", invalid="ignore"):
            upl = np.where(typical > 0, final / typical - 1, np.nan)
        ok = (base >= MIN_SEASON_BASE) & (upl >= MIN_UPLIFT)
        extra = final - typical
        order = np.argsort(-np.where(ok, extra, -np.inf))[: TOP_MEDS]
        rising = [{"medicine_id": ids[i], "medicine_name": m["medicine_name"].iat[i], "category": cats[i],
                   "abc": m["abc"].iat[i], "expected_units": final[i], "typical_units": typical[i],
                   "uplift": upl[i], "extra_units": extra[i]} for i in order if ok[i]]

        # ---- categories: expected vs typical month
        cat_rows = []
        for c, mk in cat_masks.items():
            t, e, sp = float(typical[mk].sum()), float(final[mk].sum()), float(seas[mk].sum())
            cat_rows.append({"category": c, "typical": t, "expected": e, "seasonal": sp,
                             "value": float((final * price)[mk].sum()),
                             "uplift": e / t - 1 if t > 0 else None, "base_weekly": float(base[mk].sum())})

        months.append({
            "month": ms.strftime("%Y-%m"), "label": ms.strftime("%b %Y"), "short": ms.strftime("%b"),
            "season": season, "days": days,
            "festivals": [{"name": f["name"], "days_in_month": fest_days.get(f["name"], 0),
                           "start": f["start"].strftime("%Y-%m-%d"), "end": f["end"].strftime("%Y-%m-%d"),
                           "effects": [{"category": c, "uplift": float(u), "per_day_uplift": fest_day.get((f["name"], c))}
                                       for c, u in sig[sig["festival"] == f["name"]][["category", "uplift"]].itertuples(index=False)
                                       if (not category or c == category)]}
                          for f in fests if fest_days.get(f["name"], 0) > 0],
            "units": units, "units_lo": max(0.0, units - Z90 * sd_u), "units_hi": units + Z90 * sd_u,
            "value": value, "value_lo": max(0.0, value - Z90 * sd_v), "value_hi": value + Z90 * sd_v,
            "typical_units": float(typical.sum()), "seasonal_units": float(seas.sum()),
            "ml_weight": w_bar, "ml_days": cov_days, "ml_horizon": [min(hs), max(hs)] if hs else None,
            "source": "ML blend" if cov_days else "Seasonal projection",
            "months_ahead": k_months, "rising": rising,
            "_cats": cat_rows,
        })

    shown = months[:n]
    mean_rate = np.mean([mo["units"] / mo["days"] for mo in shown]) if shown else 0
    for mo in shown:
        mo["index"] = (mo["units"] / mo["days"]) / mean_rate if mean_rate > 0 else None

    # ---- heatmap: category x month, relative to that category's average month (per-day rates)
    rows = []
    for c in ucats:
        rates = [next(r for r in mo["_cats"] if r["category"] == c) for mo in shown]
        per_day = np.array([r["expected"] / mo["days"] for r, mo in zip(rates, shown)])
        avg = per_day.mean() if len(per_day) else 0
        bw = rates[0]["base_weekly"] if rates else 0
        if bw <= 0 or avg <= 0:
            continue
        rows.append({"category": c, "base_weekly": bw, "units": float(sum(r["expected"] for r in rates)),
                     "low_volume": bw < MIN_CAT_WEEKLY,
                     "cells": [{"month": mo["month"], "index": float(p / avg), "units": r["expected"], "uplift": r["uplift"]}
                               for p, r, mo in zip(per_day, rates, shown)]})
    rows.sort(key=lambda r: -r["units"])

    # ---- purchase rhythm: categories whose seasonal per-day rate rises >= 8 % into next month.
    # Uses the seasonal(+festival) projection only, so the ML blend edge can't fake a season change.
    for i, mo in enumerate(shown):
        nxt = months[i + 1]
        pre = []
        for a, b in zip(mo["_cats"], nxt["_cats"]):
            if a["base_weekly"] < MIN_CAT_WEEKLY or a["seasonal"] <= 0:
                continue
            ra, rb = a["seasonal"] / mo["days"], b["seasonal"] / nxt["days"]
            ch = rb / ra - 1
            if ch >= MIN_UPLIFT:
                pre.append({"category": a["category"], "change": ch, "extra_units": (rb - ra) * nxt["days"],
                            "for_month": nxt["month"], "for_label": nxt["label"]})
        mo["pre_order"] = sorted(pre, key=lambda r: -r["extra_units"])
        mo["rising_categories"] = sorted(
            [{"category": r["category"], "uplift": r["uplift"], "extra_units": r["expected"] - r["typical"]}
             for r in mo["_cats"] if r["base_weekly"] >= MIN_CAT_WEEKLY and (r["uplift"] or 0) >= MIN_UPLIFT],
            key=lambda r: -r["extra_units"])[:4]
        mo["top_categories"] = [{"category": r["category"], "expected": r["expected"], "value": r["value"]}
                                for r in sorted(mo["_cats"], key=lambda r: -r["value"])[:3]]
    for mo in months:
        mo.pop("_cats", None)

    tot_u = sum(mo["units"] for mo in shown)
    tot_v = sum(mo["value"] for mo in shown)
    peak = max(shown, key=lambda mo: mo["index"] or 0) if shown else None
    low = min(shown, key=lambda mo: mo["index"] or 0) if shown else None
    return {
        "category": category, "start": shown[0]["month"] if shown else None, "months": shown,
        "summary": {"units": tot_u, "value": tot_v,
                    # Annual band: month errors are positively correlated (shared drift / index), so sum the sds.
                    "units_lo": sum(mo["units_lo"] for mo in shown), "units_hi": sum(mo["units_hi"] for mo in shown),
                    "value_lo": sum(mo["value_lo"] for mo in shown), "value_hi": sum(mo["value_hi"] for mo in shown),
                    "peak_month": peak and peak["month"], "peak_label": peak and peak["label"], "peak_index": peak and peak["index"],
                    "low_month": low and low["month"], "low_label": low and low["label"], "low_index": low and low["index"],
                    "ml_months": [mo["month"] for mo in shown if mo["ml_days"]],
                    "pre_order_months": sum(1 for mo in shown if mo["pre_order"]),
                    "medicines": int(len(ids))},
        "heatmap": {"months": [mo["month"] for mo in shown], "rows": rows},
        "method": {
            "data_end": data_end.strftime("%Y-%m-%d"),
            "festival_dates_until": max(b for w in C.FESTIVALS.values() for _, b in w),
            "forecast_span": [S.fweeks[0], fc_end.strftime("%Y-%m-%d")] if S.fweeks else None,
            "ml_w0": ML_W0, "ml_decay_weeks": ML_DECAY_WEEKS, "z": Z90,
            "drift_per_month": drift, "drift_estimated": lv["drift_est"], "drift_floor": DRIFT_FLOOR,
            "month_shock_sd": lv["month_sd"], "level_se": lv["level_se"], "ml_shared_error": ml_corr,
            "min_uplift": MIN_UPLIFT, "min_cat_weekly": MIN_CAT_WEEKLY,
            "significant_festivals": [{"festival": f, "category": c, "uplift": float(u), "per_day_uplift": fest_day.get((f, c)),
                                       "index_share_removed": {s: deflate[(c, s)] - 1 for s in C.SEASON_ORDER
                                                               if deflate.get((c, s), 1.0) > 1.0}}
                                      for f, c, u in sig[["festival", "category", "uplift"]].itertuples(index=False)],
            "notes": [
                "Seasonal projection: each medicine's season-adjusted weekly run-rate × the shrunk season index of the month × days/7. "
                "Season indices are per season, so months inside one season differ only by length and festivals.",
                "Festivals: only festival × category effects that clear the significance test (z ≥ 3) are used. The measured festival-week lift "
                "is spread over festival days (× 7 / average festival days in those weeks) and added on the days that fall in the month. "
                "The history saw these festivals inside its season averages, so their share is first taken out of the season index, "
                "otherwise the festival would be counted twice.",
                f"ML blend: on days covered by the 12-week ensemble forecast, the projection is blended toward it with weight "
                f"{ML_W0:.0%} × (1 − (h − 1)/{ML_DECAY_WEEKS}) for forecast week h. The forecast was issued from data ending "
                f"{data_end:%d %b %Y}, so what it knows about the current level ages with every week. The weight schedule is a design choice, "
                "not fitted: the holdout showed the ensemble at least as accurate as the baselines at every horizon, but it can't tell us the seasonal projection's own error.",
                "90% band: season-index uncertainty from the bootstrap CI (correlated within a category); store-level uncertainty from the "
                f"season-adjusted weekly history: a month-to-month swing of {lv['month_sd']:.1%} and run-rate estimate error of {lv['level_se']:.1%} "
                f"(both measured), plus drift growing with √(months since data end) at {drift:.1%} per month; and calibrated weekly forecast noise. "
                + ("The history shows no measurable drift (the season-adjusted level does not wander further apart over longer gaps), "
                   "so the drift rate is an assumed floor. " if (lv["drift_est"] or 0) < DRIFT_FLOOR else "The drift rate is estimated from how far apart the level wanders over longer gaps. ")
                + f"The ML part uses its calibrated per-medicine sigma plus a shared store-level error of {ml_corr:.1%} "
                "(measured on 4-week totals of the Jun–Aug 2026 holdout, where medicine errors moved together). "
                "ML and seasonal errors are combined as if fully correlated, which errs wide.",
                "Purchase rhythm: categories whose seasonal per-day demand rises ≥ 8% into next month (min 2 units/week), so they can be ordered a month ahead.",
                "Data is one year of history, so each season has been seen once. Treat months beyond the ML horizon as a structured planning baseline, not a prediction.",
            ],
        },
    }


@router.get("")
def calendar_view(
    category: str | None = Query(None, max_length=80, description="Limit to one medicine category"),
    months: int = Query(12, ge=1, le=24, description="Number of months to plan"),
    start: str | None = Query(None, pattern=r"^\d{4}-\d{2}$", description="First month, YYYY-MM (default: current month)"),
):
    category = category or None
    if category and category not in set(S.meds["category"]):
        raise HTTPException(404, f"Unknown category: {category}")
    if start:
        y, mth = int(start[:4]), int(start[5:])
        if not 1 <= mth <= 12:
            raise HTTPException(422, "start month must be 01-12")
        # First whole month after the history ends: earlier months already have actual sales.
        after = pd.Timestamp(S.weeks[-1]) + pd.Timedelta(days=7)
        lo = after.to_period("M") + (0 if after.day == 1 else 1)
        if pd.Period(start, "M") < lo:
            raise HTTPException(422, f"start must be {lo} or later (the plan is forward-looking)")
        if y > 2035:
            raise HTTPException(422, "start must be 2035-12 or earlier")
    else:
        start = date.today().strftime("%Y-%m")
    out = _build(category, months, start, S.meta.get("generated_at", ""))
    cats = S.meds.groupby("category")["base_level"].sum().sort_values(ascending=False)
    return clean({**out, "categories": [{"category": c, "base_weekly": float(v)} for c, v in cats.items()],
                  "today": date.today().isoformat()})
