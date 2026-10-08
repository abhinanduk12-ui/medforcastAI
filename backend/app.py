"""MedForecast API - serves the trained forecasting system to the web app.

    uvicorn backend.app:app --port 8000

Feature modules in backend/routers/*.py that expose `router` (a FastAPI APIRouter)
are mounted automatically.
"""
from __future__ import annotations

import importlib
import math
import pkgutil

import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from ml import config as C
from backend.core import *  # noqa: F401,F403  (S, clean, season helpers, plan_rows, ...)
from backend.core import (S, clean, season_today, next_season, season_movers, strongest_season,
                          plan_rows, z_for, MIN_SEASON_BASE)

app = FastAPI(title="MedForecast AI", version="2.0")


@app.exception_handler(RequestValidationError)
async def _validation_error(request, exc: RequestValidationError):
    def safe(o):
        if isinstance(o, float) and not math.isfinite(o):
            return str(o)
        if isinstance(o, dict):
            return {k: safe(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [safe(v) for v in o]
        return o
    return JSONResponse(status_code=422, content={"detail": safe(jsonable_encoder(exc.errors()))})
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
# Session gate for /api/* (env MEDFORECAST_AUTH, read per request; "0" disables). Added last = outermost.
from backend.auth import AuthMiddleware, current_user, require_perm, resolve_store  # noqa: E402
app.add_middleware(AuthMiddleware)


@app.get("/api/health")
def health():
    try:
        from backend.seasonal import ENGINE
        seasonal_ready = ENGINE._key is not None
    except Exception:
        seasonal_ready = False
    return {"ok": not ROUTER_ERRORS, "generated_at": S.meta["generated_at"], "router_errors": ROUTER_ERRORS,
            "seasonal_ready": seasonal_ready}


@app.post("/api/reload")
def reload(_: dict = Depends(require_perm("settings.edit"))):
    """Reload model artifacts from disk (owner only: heavy, and briefly swaps shared state)."""
    S.load()
    return {"ok": True}


@app.get("/api/overview")
def overview():
    h = S.hist.groupby("week")[["units", "revenue", "tx"]].sum().reindex(S.weeks)
    f = S.fc.groupby("week").agg(ensemble=("ensemble", "sum"), sig2=("sigma", lambda s: float((s ** 2).sum())))
    z = 1.645
    bt = S.bt.groupby("week")[["actual", "ensemble"]].sum()
    series = [{"week": w, "actual": float(h.at[w, "units"]),
               "backtest": float(bt.at[w, "ensemble"]) if w in bt.index else None} for w in S.weeks]
    for w in S.fweeks:
        mu, sd = f.at[w, "ensemble"], math.sqrt(f.at[w, "sig2"])
        series.append({"week": w, "forecast": mu, "lo": max(0, mu - z * sd), "hi": mu + z * sd})
    # Bridge the line so the forecast starts at the last actual point.
    last = len(S.weeks) - 1
    series[last]["forecast"] = series[last]["actual"]

    # Same 12 calendar weeks last year (52 weeks earlier) for a seasonal comparison.
    fw0 = pd.Timestamp(S.fweeks[0]) - pd.Timedelta(weeks=52)
    ly_weeks = [(fw0 + pd.Timedelta(weeks=i)).strftime("%Y-%m-%d") for i in range(len(S.fweeks))]
    ly = h["units"].reindex(ly_weeks)
    next12 = float(f["ensemble"].sum())

    cur = season_today()
    nxt = next_season(cur)
    cat_units = S.hist.merge(S.meds[["category"]], left_on="medicine_id", right_index=True) \
        .groupby("category")["units"].sum().sort_values(ascending=False)
    top = cat_units.head(7)
    mix = [{"category": k, "units": float(v)} for k, v in top.items()] + \
          [{"category": "Other", "units": float(cat_units.iloc[7:].sum())}]
    hold = S.metrics["holdout"]
    return clean({
        "data": S.meta["data"],
        "kpi": {
            "revenue": S.meta["data"]["revenue"], "units": S.meta["data"]["units"],
            "transactions": S.meta["data"]["transactions"],
            "avg_basket": S.meta["data"]["revenue"] / S.meta["data"]["transactions"],
            "next4_units": float(f["ensemble"].iloc[:4].sum()), "next12_units": next12,
            "last12_units": float(h["units"].iloc[-12:].sum()),
            "ly_same_period_units": float(ly.sum()) if ly.notna().all() else None,
            "holdout_category_accuracy": 1 - hold["aggregate"]["category_week"]["ensemble"],
            "holdout_store_accuracy": 1 - hold["aggregate"]["store_week"]["ensemble"],
            "coverage_90": hold["coverage_90"],
        },
        "spark": {
            "units": h["units"].iloc[-16:].tolist(), "revenue": h["revenue"].iloc[-16:].tolist(),
            "tx": h["tx"].iloc[-16:].tolist(),
        },
        "series": series,
        "monthly": S.meta["monthly"],
        "mix": mix,
        "dow": S.meta["dow"], "hour": S.meta["hour"],
        "season": {"current": cur, "next": nxt, "strongest": strongest_season(), "meta": S.meta["seasons"],
                   "current_movers": season_movers(cur, 6), "next_movers": season_movers(nxt, 6),
                   "strongest_movers": season_movers(strongest_season(), 6)},
    })


@app.get("/api/categories")
def categories():
    c = S.meds.groupby("category").agg(medicines=("medicine_name", "size"), units=("total_units", "sum"),
                                       revenue=("total_revenue", "sum"), next12=("next12", "sum"))
    return clean(c.sort_values("units", ascending=False).reset_index().to_dict("records"))


@app.get("/api/seasons")
def seasons():
    vol = S.meds.groupby("category")["total_units"].sum()
    ci = S.csi.merge(vol.rename("units"), left_on="category", right_index=True)
    ci = ci[ci["units"] >= 300]
    order = ci[ci["season"] == "Monsoon"].sort_values("index", ascending=False)["category"].tolist()
    heat = []
    for cat in order:
        g = ci[ci["category"] == cat].set_index("season")
        heat.append({"category": cat, "units": float(g["units"].iloc[0]),
                     "cells": {s: {"index": g.at[s, "index"], "lo": g.at[s, "ci_lo"], "hi": g.at[s, "ci_hi"],
                                   "significant": bool(g.at[s, "significant"]), "weeks": int(g.at[s, "n_weeks"])}
                               for s in C.SEASON_ORDER if s in g.index}})
    fest = S.fest.sort_values("uplift", ascending=False)
    fest = fest[fest["n_weeks"] >= 1]
    cur = season_today()
    return clean({
        "current": cur, "next": next_season(cur), "order": C.SEASON_ORDER,
        "meta": S.meta["seasons"], "heatmap": heat,
        "festivals": {k: fest[fest["festival"] == k].head(8).to_dict("records") for k in C.FESTIVALS},
    })


@app.get("/api/seasons/{season}")
def season_detail(season: str, category: str | None = None, n: int = 12):
    if season not in C.SEASONS:
        raise HTTPException(404, "Unknown season")
    mv = season_movers(season, n, category)
    m = S.meds[S.meds["base_level"] > 0]
    col = f"idx_{season}"
    cat = m.assign(base=m["base_level"], exp=m["base_level"] * m[col]).groupby("category")[["base", "exp"]].sum()
    cat = cat[cat["base"] >= 1.5]
    cat["uplift"] = cat["exp"] / cat["base"] - 1
    weeks_in = round(len(C.SEASONS[season]) * 4.345)
    extra_units = float((m["base_level"] * (m[col] - 1)).clip(lower=0).sum() * weeks_in)
    extra_rev = float((m["base_level"] * (m[col] - 1) * m["median_price"]).clip(lower=0).sum() * weeks_in)
    return clean({
        "season": season, "meta": S.meta["seasons"][season], "weeks": weeks_in,
        "extra_units": extra_units, "extra_revenue": extra_rev,
        "rising_count": int((m[col] > 1.1).sum()), "falling_count": int((m[col] < 0.9).sum()),
        "categories": cat.sort_values("uplift", ascending=False).reset_index()
                         .rename(columns={"base": "base_weekly", "exp": "expected_weekly"}).to_dict("records"),
        **mv,
    })


@app.get("/api/medicines")
def medicines(q: str = "", category: str | None = None, sort: str = "next4", limit: int = 500):
    m = S.meds.copy()
    if q:
        ql = q.lower()
        m = m[m["medicine_name"].str.lower().str.contains(ql, regex=False)
              | m["generic_name"].str.lower().str.contains(ql, regex=False)
              | m.index.str.lower().str.contains(ql, regex=False)]
    if category:
        m = m[m["category"] == category]
    idx_cols = [f"idx_{s}" for s in C.SEASON_ORDER]
    m["peak_season"] = m[idx_cols].idxmax(axis=1).str.replace("idx_", "")
    m["peak_index"] = m[idx_cols].max(axis=1)
    m["trend"] = np.where(m["last4"] > 0, m["next4"] / m["last4"] - 1, np.nan)
    if sort in m.columns:
        m = m.sort_values(sort, ascending=sort in ("medicine_name",))
    m = m.head(limit)
    spark = S.hist_wide.reindex(m.index).iloc[:, -16:]
    rows = []
    for mid, r in m.iterrows():
        rows.append({
            "id": mid, "name": r["medicine_name"], "generic": r["generic_name"], "category": r["category"],
            "form": r["form"], "price": r["median_price"], "abc": r["abc"],
            "total_units": r["total_units"], "avg_weekly": r["avg_weekly"],
            "next4": r["next4"], "next12": r["next12"], "last4": r["last4"], "trend": r["trend"],
            "peak_season": r["peak_season"], "peak_index": r["peak_index"],
            "season_index": {s: r[f"idx_{s}"] for s in C.SEASON_ORDER},
            "spark": spark.loc[mid].tolist(),
        })
    return clean({"count": len(rows), "items": rows})



def _schedule(mid: str) -> str | None:
    try:
        from backend.compliance import schedule_of
        return schedule_of(mid)
    except Exception:
        return None


@app.get("/api/medicines/{mid}")
def medicine(mid: str, lead_time: int = 1, review: int = 1, service: float = 0.95):
    if mid not in S.meds.index:
        raise HTTPException(404, "Unknown medicine")
    r = S.meds.loc[mid]
    hist = S.hist[S.hist["medicine_id"] == mid].sort_values("week")
    bt = S.bt[S.bt["medicine_id"] == mid].set_index("week")
    fc = S.fc[S.fc["medicine_id"] == mid].sort_values("week")
    series = []
    for _, x in hist.iterrows():
        w = x["week"]
        series.append({"week": w, "actual": x["units"],
                       "backtest": bt.at[w, "ensemble"] if w in bt.index else None})
    series[-1]["forecast"] = series[-1]["actual"]
    for _, x in fc.iterrows():
        series.append({"week": x["week"], "forecast": x["ensemble"], "lo": x["lo"], "hi": x["hi"],
                       "gbm": x["gbm"], "deep": x["deep"], "snaive": x["snaive"]})
    msi = S.msi[S.msi["medicine_id"] == mid].set_index("season")
    seasons = []
    for s in C.SEASON_ORDER:
        seasons.append({"season": s, "index": r[f"idx_{s}"],
                        "raw": msi.at[s, "raw_index"] if s in msi.index else None,
                        "category": msi.at[s, "cat_index"] if s in msi.index else None,
                        "expected_weekly": r["base_level"] * r[f"idx_{s}"],
                        "transactions": msi.at[s, "n_tx"] if s in msi.index else 0})
    h = hist.assign(month=pd.to_datetime(hist["week"]).dt.month)
    monthly = h.groupby("month")["units"].mean().reindex(range(1, 13)).tolist()
    p = plan_rows(lead_time, review, service, S.meds.loc[[mid]]).iloc[0]
    bt_err = None
    if len(bt):
        bt_err = {"actual": float(bt["actual"].sum()), "forecast": float(bt["ensemble"].sum()),
                  "covered": float(((bt["actual"] >= bt["lo"]) & (bt["actual"] <= bt["hi"])).mean())}
    return clean({
        "id": mid, "name": r["medicine_name"], "generic": r["generic_name"], "category": r["category"],
        "form": r["form"], "price": r["median_price"], "rx_share": r["rx_share"], "abc": r["abc"],
        "demand_class": r["demand_class"], "adi": r["adi"], "cv2": r["cv2"], "schedule": _schedule(mid),
        "total_units": r["total_units"], "total_revenue": r["total_revenue"], "total_tx": r["total_tx"],
        "avg_weekly": r["avg_weekly"], "base_level": r["base_level"],
        "next4": r["next4"], "next12": r["next12"], "last4": r["last4"], "last12": r["last12"],
        "series": series, "seasons": seasons, "monthly": monthly, "backtest": bt_err,
        "plan": {"lead_time": lead_time, "review": review, "service": service,
                 "cover_demand": p["cover_demand"], "safety_stock": p["safety_stock"], "order_up_to": p["order_up_to"],
                 "stock_value": p["stock_value"], "policy": p["policy"]},
        "current_season": season_today(),
    })


@app.get("/api/planner")
def planner(lead_time: int = Query(1, ge=0, le=8), review: int = Query(2, ge=1, le=8),
            service: float = Query(0.95, ge=0.5, le=0.999), category: str | None = None,
            abc: str | None = None, q: str = "", limit: int = Query(400, ge=1, le=1000),
            store_id: str | None = Query(None, max_length=32, description="Store (default: selected store)"),
            lead_source: str = Query("fixed", pattern="^(fixed|learned)$",
                                     description="fixed = lead_time for every medicine; learned = each medicine's "
                                                 "preferred supplier's learned lead time (falls back to its default)"),
            include_refills: bool = Query(True, description="Floor demand at refills due from consented patients"),
            user: dict = Depends(current_user)):
    """Order-up-to plan per medicine for one store, netted against live sellable stock.

    Branch stores are simulated: demand = main forecast x demand_scale (sd x sqrt(scale)).
    suggested_order = max(0, order_up_to - on_hand). Existing fields are unchanged."""
    from backend.routers.stock import on_hand_series, store_plan, _store_info
    from backend import inventory as inv
    sid = resolve_store(user, store_id)          # 403/404 for an inaccessible / unknown store
    st = inv.get_store(sid) if sid else None     # None: no stores yet -> main-shop plan, nothing on hand
    scale = float(st["demand_scale"]) if st else 1.0
    m = S.meds.copy()
    if category:
        m = m[m["category"] == category]
    if abc:
        m = m[m["abc"].isin(list(abc.upper()))]
    if q:
        m = m[m["medicine_name"].str.lower().str.contains(q.lower(), regex=False)]
    lead_weeks = pd.Series(lead_time, index=m.index, dtype=int)
    if lead_source == "learned":
        try:
            from backend.suppliers import lead_time_weeks
            lead_weeks = pd.Series({mid: int(math.ceil(max(0.0, lead_time_weeks(mid, sid)) - 1e-9)) for mid in m.index},
                                   dtype=int).clip(0, len(S.fweeks) - review)
        except Exception:
            lead_source = "fixed (supplier lead times unavailable)"
    # One plan per distinct lead time: each medicine's cover window = its own lead time + review.
    p = pd.concat([store_plan(scale, int(L), review, service, m.loc[g.index]) for L, g in lead_weeks.groupby(lead_weeks)])
    p.index.name = "medicine_id"
    p["lead_weeks"] = lead_weeks.reindex(p.index)
    p["committed_refills"] = 0.0
    if include_refills and sid:
        try:
            from backend.patients import committed_demand
            for L, g in p.groupby("lead_weeks"):
                cd = committed_demand(sid, weeks=int(L) + review).reindex(g.index).fillna(0.0)
                p.loc[g.index, "committed_refills"] = cd
        except Exception:
            pass
    # Refills already shape the sales history the forecast learned from, so they are a floor, not an add-on:
    # only the part of committed refills the forecast does not already cover raises the order-up-to level.
    shortfall = np.ceil((p["committed_refills"] - p["cover_demand"]).clip(lower=0))
    p["order_up_to"] = p["order_up_to"] + shortfall
    p["stock_value"] = p["order_up_to"] * p["median_price"]
    oh = on_hand_series(sid).reindex(p.index).fillna(0).astype(int) if sid else pd.Series(0, index=p.index)
    p["on_hand"] = oh
    p["suggested_order"] = (p["order_up_to"] - p["on_hand"]).clip(lower=0)
    p["order_value"] = p["suggested_order"] * p["median_price"]
    p = p[(p["order_up_to"] > 0) | (p["on_hand"] > 0)]
    cur = season_today()
    p["season_index"] = p[f"idx_{cur}"]
    p = p.sort_values("stock_value", ascending=False)
    rows = p.head(limit).reset_index()[["medicine_id", "medicine_name", "category", "form", "abc", "median_price",
                                        "weekly_rate", "cover_demand", "safety_stock", "order_up_to",
                                        "stock_value", "season_index", "last4", "policy", "demand_class",
                                        "on_hand", "suggested_order", "order_value", "lead_weeks", "committed_refills"]]
    planned = p[p["order_up_to"] > 0]
    return clean({
        "params": {"lead_time": lead_time, "review": review, "service": service, "z": z_for(service),
                   "cover_weeks": min(lead_time + review, len(S.fweeks)), "forecast_start": S.fweeks[0],
                   "store_id": sid, "demand_scale": scale, "lead_source": lead_source, "include_refills": include_refills},
        "store": _store_info(st) if st else None,
        "summary": {"items": int(len(planned)), "units": float(planned["order_up_to"].sum()),
                    "on_demand": int((planned["policy"] == "On demand").sum()),
                    "safety_units": float(planned["safety_stock"].sum()), "value": float(planned["stock_value"].sum()),
                    "by_abc": planned.groupby("abc")["stock_value"].sum().to_dict(),
                    "on_hand_units": float(p["on_hand"].sum()),
                    "order_lines": int((p["suggested_order"] > 0).sum()),
                    "order_units": float(p["suggested_order"].sum()),
                    "order_value": float(p["order_value"].sum()),
                    "listed_on_hand_only": int(((p["order_up_to"] <= 0) & (p["on_hand"] > 0)).sum())},
        "rows": rows.to_dict("records"),
    })


@app.get("/api/models")
def models():
    m = S.metrics
    bt = S.bt.groupby("week")[["actual", "gbm", "deep", "snaive", "ma8", "ensemble", "lo", "hi"]].sum().reset_index()
    return clean({**m, "importance": S.imp.head(15).to_dict("records"), "holdout_series": bt.to_dict("records")})


ROUTER_ERRORS: dict[str, str] = {}


def _mount_routers():
    """Mount every feature router. A module that fails to import is skipped and reported at
    /api/health instead of taking the whole API down."""
    import logging
    import traceback
    from backend import routers
    for mod in pkgutil.iter_modules(routers.__path__):
        try:
            m = importlib.import_module(f"backend.routers.{mod.name}")
        except Exception as e:
            ROUTER_ERRORS[mod.name] = f"{type(e).__name__}: {e}"
            logging.getLogger("medforecast").error("Router %s failed to load:\n%s", mod.name, traceback.format_exc())
            continue
        if hasattr(m, "router"):
            app.include_router(m.router)


_mount_routers()


@app.on_event("startup")
def _init_db():
    """Create/migrate the SQLite schema; seed demo stores/users/stock in the background if empty."""
    import threading
    from backend import db
    db.init_db()
    if not db.scalar("SELECT COUNT(*) FROM stores", default=0):
        from backend.seed import seed
        threading.Thread(target=seed, kwargs={"verbose": True}, daemon=True).start()


@app.on_event("startup")
def _warm_caches():
    """Parse the raw sales workbook in the background so the first alerts/optimizer request is fast."""
    import threading
    from backend.core import get_sales
    threading.Thread(target=get_sales, daemon=True).start()
