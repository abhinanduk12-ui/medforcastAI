"""Seasonal intelligence API — curves, timing & order-by dates, archetypes, forecast impact, readiness.

Built on backend/seasonal.py (quasi-Poisson Fourier curves with empirical-Bayes shrinkage and
FDR-controlled significance). The four-season index endpoints in app.py (/api/seasons) are unchanged.
"""
from __future__ import annotations

import math
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from backend import db
from backend import core
from backend.auth import current_user, store_scope
from backend.core import S, clean, next_season, season_today
from backend.seasonal import (DAY_DOY, FDR_Q, GRID_DOY, MONTH_NAMES, RAIN_CLIMATOLOGY_MM, SEASON_THRESHOLD,
                              Curve, doy_to_date, engine, in_window, monthly_profile, multiplier, next_occurrence)
from ml import config as C

router = APIRouter(prefix="/api/seasonal", tags=["seasonal"])

DEFAULT_LEAD_DAYS = 7
READINESS_TARGET_WEEKS = 4      # pre-season stock target = expected demand in the season's first 4 weeks
SEASONAL_CLASSES = ("Strongly seasonal", "Seasonal", "Seasonal (category evidence)")

METHOD = [
    "Each curve is a quasi-Poisson regression of weekly units on yearly Fourier terms (3 harmonics for "
    "categories, 2 for medicines), so it follows the shape of the year week by week rather than four flat season averages.",
    "Medicines borrow strength from their category (empirical Bayes): items with few sales follow their category's shape, "
    "well-sold items keep their own. Small categories are shrunk toward 'no seasonal effect' the same way.",
    "Significance: an F test of the seasonal curve against a flat line, using the overdispersed (quasi-Poisson) deviance, "
    f"then Benjamini-Hochberg false-discovery control across all tested medicines (q < {FDR_Q:.2f}).",
    f"Season window = the stretch of the year where demand is at least {round((SEASON_THRESHOLD - 1) * 100)}% above an average week. "
    "Order-by date = window start minus the supplier's learned lead time (7-day default until deliveries are recorded).",
    "90% bands come from 300 draws of the curve coefficients from their estimated (overdispersion-scaled) distribution.",
]
LIMITS = [
    "About 56 weeks of history: each part of the year has been seen once (August twice), so curves describe last "
    "year's pattern and will sharpen as more years of sales are loaded on the Data & models page.",
    "No trend term: store-level demand is flat year over year in this data, and with one year a trend cannot be "
    "separated from the yearly cycle.",
    "The sales data is synthetic (per its Read Me); branch demand is scaled from the main store.",
]


# ───────────────────────── helpers ─────────────────────────

def _fmt_day(d: date) -> str:
    return f"{d.day} {MONTH_NAMES[d.month - 1]} {d.year}"


def _doy_label(doy: float) -> str:
    d = doy_to_date(int(doy), 2025)
    return f"{d.day} {MONTH_NAMES[d.month - 1]}"


_lead_cache: dict = {"at": 0.0, "store": None, "value": {}}


def _lead_days(store_id: str | None) -> dict[str, tuple[float, str]]:
    """Learned lead time per medicine (days, source); cached for a minute."""
    if time.monotonic() - _lead_cache["at"] < 60 and _lead_cache["store"] == store_id:
        return _lead_cache["value"]
    out: dict[str, tuple[float, str]] = {}
    try:
        from backend.suppliers import lead_time_info
        for m in S.meds.index:
            try:
                info = lead_time_info(m, store_id)
                status = info.get("status") or "default"
                out[m] = (float(info.get("mean_days") or DEFAULT_LEAD_DAYS), "learned" if status == "learned" else status)
            except Exception:
                out[m] = (DEFAULT_LEAD_DAYS, "default")
    except Exception:
        out = {m: (DEFAULT_LEAD_DAYS, "default") for m in S.meds.index}
    _lead_cache.update(at=time.monotonic(), store=store_id, value=out)
    return out


def _store_scale(store_id: str | None) -> float:
    if not store_id:
        return 1.0
    try:
        from backend import inventory as inv
        return float(inv.store_scale(store_id))
    except Exception:
        return 1.0


def _cv_summary(cv: Curve) -> dict:
    t = cv.timing
    return {
        "id": cv.key, "level": cv.level, "label": cv.label, "category": cv.category, "class": cv.seasonal_class,
        "strength": cv.strength, "p": cv.p, "q": cv.q, "tested": cv.tested, "shrink_weight": cv.shrink_weight,
        "amplitude": t["amplitude"], "peak_mult": t["peak_mult"], "trough_mult": t["trough_mult"],
        "peak": _doy_label(t["peak_doy"]), "trough": _doy_label(t["trough_doy"]),
        "onset": _doy_label(t["onset_doy"]) if t["onset_doy"] else None,
        "end": _doy_label(t["end_doy"]) if t["end_doy"] else None,
        "duration_days": t["duration_days"], "rain_corr": cv.rain_corr, "small_sample": cv.small_sample,
        "units": cv.units, "transactions": cv.tx,
    }


def _timing_row(cv: Curve, today: date, lead_days: float, lead_source: str) -> dict:
    t = cv.timing
    row = _cv_summary(cv)
    row.update(lead_days=lead_days, lead_source=lead_source, today_mult=float(cv.day[today.timetuple().tm_yday - 1]),
               next_onset=None, next_peak=None, order_by=None, days_to_order=None, in_season=False)
    if not t["onset_doy"]:
        row["status"] = "No distinct season"
        return row
    peak = next_occurrence(t["peak_doy"], today)
    if in_window(today, t["onset_doy"], t["end_doy"]):
        row.update(in_season=True, status="In season now: keep stocked", next_peak=_fmt_day(peak))
        onset = next_occurrence(t["onset_doy"], today + timedelta(days=t["duration_days"]))
    else:
        onset = next_occurrence(t["onset_doy"], today)
        row["next_peak"] = _fmt_day(peak)
    order_by = onset - timedelta(days=math.ceil(lead_days))
    days = (order_by - today).days
    row.update(next_onset=_fmt_day(onset), order_by=_fmt_day(order_by), days_to_order=days,
               next_onset_iso=onset.isoformat(), order_by_iso=order_by.isoformat())
    if not row["in_season"]:
        row["status"] = "Order now" if days <= 7 else ("Order within a month" if days <= 30 else "Upcoming")
    return row


def _get(level: str, key: str) -> Curve:
    E = engine()
    src = E.cat if level == "category" else E.med
    if key not in src:
        raise HTTPException(404, f"Unknown {level}: {key}")
    return src[key]


def _observed(cv: Curve) -> list[dict]:
    """Observed weekly demand relative to that series' average week (the dots behind the curve)."""
    E = engine()
    if cv.level == "medicine":
        y = E.Y.loc[cv.key].to_numpy()
    else:
        y = E.Y.loc[S.meds.index[S.meds["category"] == cv.key]].sum(0).to_numpy()
    mean = y.mean()
    if mean <= 0:
        return []
    return [{"week": w, "doy": float(d), "ratio": float(v / mean), "year": int(w[:4])}
            for w, d, v in zip(E.weeks, E.week_doy, y)]


def _curve_payload(cv: Curve, with_observed: bool = True) -> dict:
    grid = [{"doy": float(d), "label": _doy_label(d), "m": float(m), "lo": float(lo), "hi": float(hi)}
            for d, m, lo, hi in zip(GRID_DOY, cv.grid, cv.lo, cv.hi)]
    out = {**_cv_summary(cv), "grid": grid,
           "monthly": [{"month": MONTH_NAMES[i], "m": float(v)} for i, v in enumerate(monthly_profile(cv.day))]}
    if with_observed:
        out["observed"] = _observed(cv)
    return out


_explain_cache: dict = {"path": None, "mtime": None, "df": None}


def _season_shap() -> pd.DataFrame | None:
    """Model-based season factor per (medicine, horizon) from the SHAP explain artifact, if present."""
    try:
        p = Path(str(core.A)) / "explain_medicine.csv"
        if not p.exists():
            return None
        mt = p.stat().st_mtime
        if _explain_cache["path"] != str(p) or _explain_cache["mtime"] != mt:
            e = pd.read_csv(p)
            e = e[e["group"] == "Season effect"][["medicine_id", "h", "contrib"]]
            _explain_cache.update(path=str(p), mtime=mt, df=e)
        return _explain_cache["df"]
    except Exception:
        return None


def _forecast_frame(scale: float) -> pd.DataFrame:
    """12-week ensemble forecast with curve-based and SHAP-based seasonal contributions per row."""
    E = engine()
    f = S.fc[["medicine_id", "week", "h", "ensemble"]].copy()
    f["ensemble"] = f["ensemble"] * scale
    doy = (pd.to_datetime(f["week"]) + pd.Timedelta(days=3)).dt.dayofyear.to_numpy() - 1
    mult = np.array([E.med[m].day[d] if m in E.med else 1.0 for m, d in zip(f["medicine_id"], doy)])
    f["curve_mult"] = mult
    f["season_curve"] = f["ensemble"] * (1 - 1 / np.maximum(mult, 1e-6))
    shap = _season_shap()
    if shap is not None:
        f = f.merge(shap, on=["medicine_id", "h"], how="left")
        fac = np.exp(f["contrib"].fillna(0.0).to_numpy())
        f["shap_mult"] = fac
        f["season_shap"] = f["ensemble"] * (1 - 1 / fac)
    else:
        f["shap_mult"] = np.nan
        f["season_shap"] = np.nan
    return f.merge(S.meds[["category", "median_price", "medicine_name"]], left_on="medicine_id", right_index=True)


# ───────────────────────── endpoints ─────────────────────────

@router.get("/overview")
def overview(store_id: str = Depends(store_scope), user: dict = Depends(current_user)):
    E = engine()
    today = date.today()
    lead = _lead_days(store_id)
    cats = [cv for cv in E.cat.values() if not cv.small_sample]
    rows = []
    for cv in cats:
        members = S.meds.index[S.meds["category"] == cv.key]
        ld = float(np.median([lead[m][0] for m in members])) if len(members) else DEFAULT_LEAD_DAYS
        rows.append(_timing_row(cv, today, ld, "median of members"))
    seasonal_rows = [r for r in rows if r["class"] in ("Strongly seasonal", "Seasonal")]
    upcoming = sorted([r for r in seasonal_rows if not r["in_season"] and r.get("order_by_iso")], key=lambda r: r["order_by_iso"])[:5]
    in_season = sorted([r for r in seasonal_rows if r["in_season"]], key=lambda r: -r["today_mult"])
    classes = pd.Series([cv.seasonal_class for cv in E.med.values()]).value_counts().to_dict()
    f = _forecast_frame(_store_scale(store_id))
    seasonal_units = float(f["season_curve"].sum())
    seasonal_value = float((f["season_curve"] * f["median_price"]).sum())
    today_cat = sorted(((cv.key, float(cv.day[today.timetuple().tm_yday - 1])) for cv in cats), key=lambda x: -x[1])
    return clean({
        "today": today.isoformat(), "current_season": season_today(today), "next_season": next_season(season_today(today)),
        "summary": E.summary, "classes": classes,
        "kpi": {
            "seasonal_medicines": int(sum(classes.get(c, 0) for c in SEASONAL_CLASSES)),
            "significant_medicines": E.summary["medicines_significant"],
            "significant_categories": E.summary["categories_significant"], "categories": len(cats),
            "forecast_seasonal_units": seasonal_units, "forecast_seasonal_value": seasonal_value,
            "forecast_units": float(f["ensemble"].sum()),
            "archetypes": E.archetypes.get("k", 0),
        },
        "upcoming": upcoming, "in_season": in_season,
        "today_by_category": [{"category": c, "m": m} for c, m in today_cat],
        "method": METHOD, "limits": LIMITS,
    })


@router.get("/curves")
def curves(ids: str = Query(..., max_length=600, description="comma list of cat:<category> or med:<medicine_id> (max 4)"),
           user: dict = Depends(current_user)):
    out = []
    for raw in [x.strip() for x in ids.split(",") if x.strip()][:4]:
        if raw.startswith("cat:"):
            out.append(_curve_payload(_get("category", raw[4:])))
        elif raw.startswith("med:"):
            out.append(_curve_payload(_get("medicine", raw[4:])))
        else:
            raise HTTPException(422, "Each id must start with cat: or med:")
    return clean({"today_doy": date.today().timetuple().tm_yday, "series": out, "threshold": SEASON_THRESHOLD})


@router.get("/calendar")
def calendar(include_small: bool = False, user: dict = Depends(current_user)):
    """Category x week-of-year multipliers (52 weekly columns through a generic year)."""
    E = engine()
    cats = [cv for cv in E.cat.values() if include_small or not cv.small_sample]
    cats.sort(key=lambda cv: (-(cv.q is not None and cv.q < FDR_Q), -cv.timing["amplitude"]))
    month_ticks = [{"col": int(i), "month": MONTH_NAMES[doy_to_date(int(d), 2025).month - 1]}
                   for i, d in enumerate(GRID_DOY) if doy_to_date(int(d), 2025).day <= 7]
    return clean({
        "columns": [_doy_label(d) for d in GRID_DOY], "month_ticks": month_ticks,
        "today_col": int(np.argmin(np.abs(GRID_DOY - date.today().timetuple().tm_yday))),
        "rows": [{**_cv_summary(cv), "values": [float(v) for v in cv.grid]} for cv in cats],
        "seasons": {s: ms for s, ms in C.SEASONS.items()},
    })


@router.get("/timing")
def timing(level: str = Query("category", pattern="^(category|medicine)$"), store_id: str = Depends(store_scope),
           cls: str | None = Query(None, max_length=60), category: str | None = Query(None, max_length=80),
           limit: int = Query(200, ge=1, le=500), user: dict = Depends(current_user)):
    E = engine()
    today = date.today()
    lead = _lead_days(store_id)
    rows = []
    if level == "category":
        for cv in E.cat.values():
            if cv.small_sample:
                continue
            members = S.meds.index[S.meds["category"] == cv.key]
            ld = float(np.median([lead[m][0] for m in members])) if len(members) else DEFAULT_LEAD_DAYS
            rows.append(_timing_row(cv, today, ld, "median of members"))
    else:
        for m, cv in E.med.items():
            if cls and cv.seasonal_class != cls:
                continue
            if category and cv.category != category:
                continue
            if not cls and cv.seasonal_class not in SEASONAL_CLASSES:
                continue
            ld, src = lead.get(m, (DEFAULT_LEAD_DAYS, "default"))
            r = _timing_row(cv, today, ld, src)
            r["base_weekly"] = float(S.meds.at[m, "base_level"]) * _store_scale(store_id)
            r["abc"] = S.meds.at[m, "abc"]
            rows.append(r)
    rows.sort(key=lambda r: (r["order_by_iso"] if r.get("order_by_iso") else "9999", -r["amplitude"]))
    return clean({"today": today.isoformat(), "level": level, "count": len(rows), "rows": rows[:limit]})


@router.get("/archetypes")
def archetypes(user: dict = Depends(current_user)):
    E = engine()
    return clean({**E.archetypes, "rain": RAIN_CLIMATOLOGY_MM, "months": MONTH_NAMES})


@router.get("/forecast-impact")
def forecast_impact(store_id: str = Depends(store_scope), user: dict = Depends(current_user)):
    """How much of the next 12 weeks' forecast is seasonal: by the seasonal curve and by the model's own SHAP season effect."""
    f = _forecast_frame(_store_scale(store_id))
    has_shap = bool(f["season_shap"].notna().any())
    f["value_curve"] = f["season_curve"] * f["median_price"]
    f["value_shap"] = f["season_shap"] * f["median_price"]
    by_cat = (f.groupby("category").agg(forecast=("ensemble", "sum"), season_curve=("season_curve", "sum"),
                                        season_shap=("season_shap", "sum"), value_curve=("value_curve", "sum"),
                                        value_shap=("value_shap", "sum")).reset_index())
    by_cat["share_curve"] = by_cat["season_curve"] / by_cat["forecast"].replace(0, np.nan)
    by_cat = by_cat.sort_values("value_curve", key=lambda s: -s.abs())
    weekly = (f.groupby("week").agg(forecast=("ensemble", "sum"), season_curve=("season_curve", "sum"),
                                    season_shap=("season_shap", "sum")).reset_index())
    weekly["without_curve"] = weekly["forecast"] - weekly["season_curve"]
    weekly["without_shap"] = weekly["forecast"] - weekly["season_shap"] if has_shap else np.nan
    med = (f.groupby(["medicine_id", "medicine_name", "category"]).agg(
        forecast=("ensemble", "sum"), season_curve=("season_curve", "sum"), season_shap=("season_shap", "sum"),
        value_curve=("value_curve", "sum")).reset_index())
    agree = None
    if has_shap:
        ok = med[(med["forecast"] > 1)]
        if len(ok) > 5:
            agree = float(np.corrcoef(ok["season_curve"], ok["season_shap"].fillna(0))[0, 1])
    return clean({
        "has_shap": has_shap, "weeks": sorted(f["week"].unique().tolist()),
        "totals": {"forecast": float(f["ensemble"].sum()), "season_curve": float(f["season_curve"].sum()),
                   "season_shap": float(f["season_shap"].sum()) if has_shap else None,
                   "value_curve": float(f["value_curve"].sum()),
                   "value_shap": float(f["value_shap"].sum()) if has_shap else None,
                   "agreement_corr": agree},
        "weekly": weekly.to_dict("records"),
        "categories": by_cat.to_dict("records"),
        "top_up": med.sort_values("season_curve", ascending=False).head(12).to_dict("records"),
        "top_down": med.sort_values("season_curve").head(8).to_dict("records"),
        "note": ("Seasonal contribution = forecast - forecast / seasonal multiplier. 'Curve' uses this page's seasonal "
                 "curves; 'Model' uses the forecasting model's own SHAP season effect. They are two independent views of "
                 "the same question and should broadly agree."),
    })


def _season_window(season: str, today: date) -> tuple[date, date]:
    """The first occurrence of the season (incl. one in progress) that has not ended yet. Handles Winter
    crossing New Year: on 15 Jan the current Dec-Feb window is returned, not next year's."""
    months = C.SEASONS[season]
    first, last = months[0], months[-1]
    for y in (today.year - 1, today.year, today.year + 1):
        start = date(y, first, 1)
        end_year = y + 1 if last < first else y
        nxt = date(end_year + 1, 1, 1) if last == 12 else date(end_year, last + 1, 1)
        end = nxt - timedelta(days=1)
        if end >= today:
            return start, end
    raise HTTPException(500, "Could not resolve the season window")


@router.get("/readiness")
def readiness(season: str | None = Query(None, max_length=20), store_id: str = Depends(store_scope),
              user: dict = Depends(current_user)):
    """Is the shelf ready for the coming season? Stock that will still be sellable at the season start,
    plus open purchase orders, against expected demand in the season's first weeks."""
    E = engine()
    today = date.today()
    season = season or next_season(season_today(today))
    if season not in C.SEASONS:
        raise HTTPException(404, "Unknown season")
    start, end = _season_window(season, today)
    in_progress = start <= today
    eff_start = max(start, today)
    weeks = pd.date_range(eff_start, end, freq="7D")
    scale = _store_scale(store_id)
    base = S.meds["base_level"].fillna(0.0) * scale
    doy = (weeks + pd.Timedelta(days=3)).dayofyear.to_numpy() - 1
    target_doy = doy[:READINESS_TARGET_WEEKS]
    mult = {m: E.med[m].day for m in E.med}
    exp_total = pd.Series({m: float(base[m] * mult[m][doy].sum()) if m in mult else float(base[m] * len(doy))
                           for m in S.meds.index})
    exp_target = pd.Series({m: float(base[m] * mult[m][target_doy].sum()) if m in mult else float(base[m] * len(target_doy))
                            for m in S.meds.index})
    on_hand = pd.Series(dtype=float)
    on_order = pd.Series(dtype=float)
    try:
        rows = db.query("SELECT medicine_id, SUM(qty_on_hand) AS q FROM batches WHERE store_id = ? AND expiry_date > ? "
                        "GROUP BY medicine_id", (store_id, eff_start.isoformat()))
        on_hand = pd.Series({r["medicine_id"]: float(r["q"] or 0) for r in rows})
    except Exception:
        pass
    try:
        rows = db.query("SELECT l.medicine_id, SUM(l.qty_ordered - l.qty_received) AS q FROM suppliers_po_lines l "
                        "JOIN suppliers_po p ON p.id = l.po_id WHERE p.store_id = ? AND p.status IN ('sent', 'partially_received') "
                        "GROUP BY l.medicine_id", (store_id,))
        on_order = pd.Series({r["medicine_id"]: float(r["q"] or 0) for r in rows})
    except Exception:
        pass
    d = S.meds[["medicine_name", "category", "abc", "median_price"]].copy()
    d["expected_season"] = exp_total
    d["target"] = np.ceil(exp_target)
    d["on_hand"] = on_hand.reindex(d.index).fillna(0.0)
    d["on_order"] = on_order.reindex(d.index).fillna(0.0)
    d["available"] = d["on_hand"] + d["on_order"]
    d["gap"] = (d["target"] - d["available"]).clip(lower=0)
    d["gap_value"] = d["gap"] * d["median_price"] * 0.8
    d["class"] = [E.med[m].seasonal_class if m in E.med else "Steady" for m in d.index]
    d["season_mult"] = [float(np.mean(mult[m][doy])) if m in mult and len(doy) else 1.0 for m in d.index]
    d = d[d["target"] > 0]
    cat = d.groupby("category").agg(target=("target", "sum"), available=("available", "sum"), gap=("gap", "sum"),
                                    gap_value=("gap_value", "sum"), items=("target", "size"),
                                    short_items=("gap", lambda s: int((s > 0).sum()))).reset_index()
    cat["coverage"] = (cat["available"] / cat["target"]).clip(upper=9.99)
    cat["season_mult"] = cat["category"].map(lambda c: float(np.mean(E.cat[c].day[doy])) if c in E.cat and len(doy) else 1.0)
    cat = cat.sort_values("gap_value", ascending=False)
    top = d[d["gap"] > 0].sort_values("gap_value", ascending=False).head(25).reset_index()
    covered = float(np.minimum(d["available"], d["target"]).sum() / max(d["target"].sum(), 1e-9))
    return clean({
        "season": season, "start": start.isoformat(), "end": end.isoformat(), "in_progress": in_progress,
        "starts_in_days": (start - today).days, "store_id": store_id, "demand_scale": scale,
        "target_weeks": READINESS_TARGET_WEEKS,
        "summary": {"items": int(len(d)), "short_items": int((d["gap"] > 0).sum()), "coverage": covered,
                    "gap_units": float(d["gap"].sum()), "gap_value": float(d["gap_value"].sum()),
                    "expected_season_units": float(d["expected_season"].sum())},
        "categories": cat.to_dict("records"), "top_gaps": top.to_dict("records"),
        "note": (f"Target = expected demand in the first {READINESS_TARGET_WEEKS} weeks of {season} (season-adjusted run-rate "
                 "x this medicine's seasonal curve x branch scale). Available = sellable stock that will not have expired by "
                 "the season start, plus open purchase orders. Gap value is at cost (80% of selling price)."),
    })


@router.get("/medicine/{medicine_id}")
def medicine(medicine_id: str, store_id: str = Depends(store_scope), user: dict = Depends(current_user)):
    E = engine()
    cv = _get("medicine", medicine_id)
    cat = E.cat.get(cv.category)
    ld, src = _lead_days(store_id).get(medicine_id, (DEFAULT_LEAD_DAYS, "default"))
    arche = next((c["name"] for c in E.archetypes.get("clusters", [])
                  if any(m["id"] == medicine_id for m in c["members"])), None)
    f = _forecast_frame(_store_scale(store_id))
    f = f[f["medicine_id"] == medicine_id]
    return clean({
        "curve": _curve_payload(cv), "category_curve": _curve_payload(cat, with_observed=False) if cat else None,
        "timing": _timing_row(cv, date.today(), ld, src), "archetype": arche,
        "forecast": [{"week": r.week, "forecast": r.ensemble, "curve_mult": r.curve_mult,
                      "shap_mult": None if pd.isna(r.shap_mult) else r.shap_mult} for r in f.itertuples()],
        "method": METHOD, "limits": LIMITS,
    })


@router.get("/evidence")
def evidence(user: dict = Depends(current_user)):
    E = engine()
    tested = [cv for cv in E.med.values() if cv.tested and cv.p is not None]
    pv = np.array([cv.p for cv in tested]) if tested else np.array([])
    hist = np.histogram(pv, bins=10, range=(0, 1))[0].tolist() if len(pv) else []
    cats = sorted((cv for cv in E.cat.values() if not cv.small_sample), key=lambda cv: -(cv.rain_corr or 0))
    return clean({
        "summary": E.summary, "fdr_q": FDR_Q, "p_histogram": hist,
        "expected_null_per_bin": len(pv) / 10 if len(pv) else 0,
        "yoy_august": E.yoy, "yoy_store_ratio": getattr(E, "summary_yoy_store", None),
        "rain": {"months": MONTH_NAMES, "mm": RAIN_CLIMATOLOGY_MM,
                 "source": "Kochi monthly rainfall climatology, ERA5 1991-2020 (Open-Meteo archive)",
                 "categories": [{"category": cv.key, "rain_corr": cv.rain_corr, "class": cv.seasonal_class,
                                 "monthly": [float(x) for x in monthly_profile(cv.day)]} for cv in cats]},
        "categories": [_cv_summary(cv) for cv in sorted(E.cat.values(), key=lambda cv: (cv.q if cv.q is not None else 1))],
        "method": METHOD, "limits": LIMITS,
    })


@router.on_event("startup")
def _warm():
    """Build the curves and the per-medicine lead times in the background so the first page view is fast."""
    import threading
    from backend.seasonal import warm

    def run():
        warm()
        try:
            from backend import inventory as inv
            _lead_days(inv.main_store_id())
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()
