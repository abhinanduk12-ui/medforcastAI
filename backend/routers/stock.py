"""Live stock & expiry ledger (FEFO) on top of backend/inventory.py.

Every endpoint works on ONE store, resolved with auth.resolve_store (default: the session's selected
store; pharmacists only their own). Branch stores are SIMULATED from the single real shop: their
demand is the main-shop forecast x demand_scale, and every response says so (store.simulated).

Definitions (also returned under `definitions` so the UI can show them verbatim)
  weekly_rate    mean ensemble forecast over the first 4 forecast weeks (from S.fweeks[0]) x demand_scale
  order_up_to    stock planner target (core.plan_rows) for the store: forecast demand over lead time +
                 review period + safety stock. Branches: mean x scale, uncertainty x sqrt(scale)
                 (a smaller shop is relatively noisier, so this is the cautious choice)
  suggested_order max(0, order_up_to - on_hand)
  out            on_hand = 0 although the planner wants >= 1 unit on the shelf (forecast > 0)
  low            0 < on_hand < forecast demand until the next delivery after this review
  excess         more than EXCESS_WEEKS of cover and above the order-up-to level
  expiring       sellable stock with a batch expiring within EXPIRING_DAYS, or expired stock on shelf

FEFO expiry projection (GET /expiring, alerts): the batches of a medicine are sold earliest-expiry
first. Expected cumulative demand D(t) comes from the weekly forecast (days after the 12-week horizon
use the mean of its last 4 weeks). A batch sells min(qty, D(expiry) - demand already served); what
is left at expiry is the projected loss. A cautious "slow demand" scenario repeats this with a 95%
one-sided lower bound of cumulative demand (D - 1.645 sd).
"""
from __future__ import annotations

import csv
import io
import math
import re
from datetime import date, timedelta
from functools import lru_cache
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from backend import db
from backend import inventory as inv
from backend.auth import current_user, max_adjust, require_perm, resolve_store
from backend.core import S, clean, plan_rows, poisson_quantile, z_for, SLOW_MOVER_RATE

router = APIRouter(prefix="/api/stock", tags=["stock"])

EXCESS_WEEKS = 12          # cover beyond this (and above order-up-to) counts as excess
EXPIRING_DAYS = 90         # "expiring" status window
LOW_Z = 1.645              # one-sided 95% for the slow-demand scenario
PLAN_DEFAULT = (1, 2, 0.95)
COVER_BINS = [("Out", 0, 0), ("< 1 wk", 0, 1), ("1–2 wk", 1, 2), ("2–4 wk", 2, 4), ("4–8 wk", 4, 8),
              ("8–12 wk", 8, 12), ("12–26 wk", 12, 26), ("> 26 wk", 26, math.inf)]
IMPORT_MAX_BYTES = 2_000_000
IMPORT_MAX_ROWS = 1000     # keeps the all-or-nothing write transaction to a few seconds
IMPORT_COLS = ["medicine_id", "batch_no", "expiry_date", "qty", "unit_cost", "supplier_id"]
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+\-Z]*)?$")

DEFINITIONS = {
    "weekly_rate": (f"Mean forecast units/week over the first 4 weeks of the 12-week forecast (weeks starting "
                    f"{S.fweeks[0]} to {S.fweeks[min(3, len(S.fweeks) - 1)]}), x the store's demand scale. Expiry "
                    f"projections instead follow the forecast day by day from today."),
    "order_up_to": "Stock planner target: forecast demand over lead time + review period plus safety stock.",
    "suggested_order": "Order-up-to minus sellable on-hand stock, never below 0.",
    "out": "No sellable stock although the planner wants at least one unit on the shelf.",
    "low": "Some stock, but less than the forecast demand until the next delivery after this review.",
    "excess": f"More than {EXCESS_WEEKS} weeks of cover and above the order-up-to level.",
    "expiring": f"A sellable batch expires within {EXPIRING_DAYS} days, or expired stock is still on the shelf.",
    "simulated": "Branch stores are simulated from the single real shop: demand = main forecast x demand scale.",
    "cost": "Stock value is at unit cost (opening stock assumed at 80% of median selling price); retail value uses median selling price.",
}


# ─────────────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────────────

def _err(e: inv.InventoryError) -> HTTPException:
    return inv.as_http(e)


def _store_for(user: dict, requested: str | None) -> dict:
    sid = resolve_store(user, requested)
    if sid is None:
        raise HTTPException(409, "No stores exist yet - run `python -m backend.seed`")
    try:
        return inv.get_store(sid)
    except inv.InventoryError as e:
        raise _err(e)


def _store_info(st: dict) -> dict:
    return {"id": st["id"], "name": st["name"], "city": st.get("city"), "demand_scale": float(st["demand_scale"]),
            "is_main": bool(st["is_main"]), "simulated": bool(st.get("simulated", not st["is_main"]))}


def store_plan(scale: float, lead_time: int, review: int, service: float, m: pd.DataFrame) -> pd.DataFrame:
    """core.plan_rows for a store whose demand is `scale` x the main shop.

    Mean demand scales by `scale`; the forecast's standard deviation by sqrt(scale) (cautious: a
    smaller shop is relatively noisier). Slow movers keep the exact Poisson-quantile policy on the
    scaled mean. scale == 1 returns plan_rows unchanged."""
    p = plan_rows(lead_time, review, service, m)
    if abs(scale - 1.0) < 1e-9:
        return p
    p = p.copy()
    cover = min(lead_time + review, len(S.fweeks))
    z = z_for(service)
    sd = np.sqrt((S.sig_wide.iloc[:, :cover] ** 2).sum(1)).reindex(p.index) * math.sqrt(scale)
    p["cover_demand"] = p["cover_demand"] * scale
    p["safety_stock"] = z * sd
    p["weekly_rate"] = p["cover_demand"] / cover
    p["order_up_to"] = np.ceil(p["cover_demand"] + p["safety_stock"])
    p["policy"] = "Forecast"
    slow = p["weekly_rate"] < SLOW_MOVER_RATE
    p.loc[slow, "policy"] = "On demand"
    p.loc[slow, "order_up_to"] = [poisson_quantile(mu, service) for mu in p.loc[slow, "cover_demand"].fillna(0)]
    p.loc[slow, "safety_stock"] = (p.loc[slow, "order_up_to"] - p.loc[slow, "cover_demand"]).clip(lower=0)
    p["stock_value"] = p["order_up_to"] * p["median_price"]
    return p


def positions(store_id: str, scale: float, lead_time: int = 1, review: int = 2, service: float = 0.95) -> pd.DataFrame:
    """One row per medicine for a store: sellable stock, forecast, plan, status flags."""
    m = inv.stock_position(store_id)
    p = store_plan(scale, lead_time, review, service, S.meds)
    m["cover_demand"] = p["cover_demand"].reindex(m.index).fillna(0.0)
    m["safety_stock"] = p["safety_stock"].reindex(m.index).fillna(0.0)
    m["order_up_to"] = p["order_up_to"].reindex(m.index).fillna(0).astype(int)
    m["policy"] = p["policy"].reindex(m.index).fillna("On demand")
    m["suggested_order"] = (m["order_up_to"] - m["qty"]).clip(lower=0).astype(int)
    m["order_value"] = m["suggested_order"] * m["median_price"]
    m["retail_value"] = m["qty"] * m["median_price"]
    m["rx_share"] = S.meds["rx_share"].reindex(m.index)
    today = date.today()
    soon = (today + timedelta(days=EXPIRING_DAYS)).isoformat()
    ee = m["earliest_expiry"]
    m["days_to_expiry"] = [(date.fromisoformat(x) - today).days if isinstance(x, str) else None for x in ee]
    has_rate = m["weekly_rate"] > 0
    out = (m["qty"] <= 0) & has_rate & (m["order_up_to"] >= 1)
    low = (m["qty"] > 0) & has_rate & (m["qty"] < m["cover_demand"])
    excess = (m["qty"] > 0) & (m["weeks_cover"] > EXCESS_WEEKS) & (m["qty"] > m["order_up_to"])
    expiring = (ee.notna() & (ee.astype(str) <= soon) & (m["qty"] > 0)) | (m["expired_qty"] > 0)
    m["status"] = np.select([out, low, excess], ["out", "low", "excess"], default="ok")
    m.loc[(m["qty"] <= 0) & ~out, "status"] = "none"     # not stocked and not needed
    m["expiring"] = expiring.to_numpy()
    m["no_demand"] = ~has_rate
    return m


def _row(mid: str, r: pd.Series) -> dict:
    return {
        "medicine_id": mid, "medicine_name": r["medicine_name"], "generic_name": r["generic_name"],
        "category": r["category"], "form": r["form"], "abc": r["abc"], "median_price": r["median_price"],
        "rx_share": r.get("rx_share"),
        "on_hand": int(r["qty"]), "value": r["value"], "retail_value": r["retail_value"],
        "earliest_expiry": r["earliest_expiry"] if isinstance(r["earliest_expiry"], str) else None,
        "days_to_expiry": r["days_to_expiry"], "n_batches": int(r["n_batches"]),
        "expired_qty": int(r["expired_qty"]), "expired_value": r["expired_value"],
        "weekly_rate": r["weekly_rate"], "weeks_of_cover": r["weeks_cover"],
        "cover_demand": r["cover_demand"], "safety_stock": r["safety_stock"], "order_up_to": int(r["order_up_to"]),
        "policy": r["policy"], "suggested_order": int(r["suggested_order"]), "order_value": r["order_value"],
        "status": r["status"], "expiring": bool(r["expiring"]), "no_demand": bool(r["no_demand"]),
    }


# ── FEFO expiry projection ───────────────────────────────────────────────────

@lru_cache(maxsize=8)
def _curves(today_iso: str, scale: float, fc_id: int):
    """Expected cumulative demand (and its variance) per medicine by day from today.

    Returns (index, cum_mu[M, L+1], cum_var[M, L+1], tail_mu[M], tail_var[M], L, fc_wide). The forecast
    frame itself is returned so callers can detect a reload (an id() can be reused once freed)."""
    today = date.fromisoformat(today_iso)
    fw0 = date.fromisoformat(S.fweeks[0])
    n = len(S.fweeks)
    off = max((today - fw0).days, 0)
    idx = S.meds.index
    mu_w = S.fc_wide.reindex(idx).fillna(0.0).to_numpy(float) * scale
    var_w = (S.sig_wide.reindex(idx).fillna(0.0).to_numpy(float) ** 2) * scale
    L = max(0, 7 * n - off)
    days = np.arange(L) + off
    wk = np.minimum(days // 7, n - 1)
    mu_d = mu_w[:, wk] / 7.0 if L else np.zeros((len(idx), 0))
    var_d = var_w[:, wk] / 7.0 if L else np.zeros((len(idx), 0))
    cum_mu = np.concatenate([np.zeros((len(idx), 1)), np.cumsum(mu_d, 1)], 1)
    cum_var = np.concatenate([np.zeros((len(idx), 1)), np.cumsum(var_d, 1)], 1)
    k = min(4, n)
    tail_mu = mu_w[:, -k:].mean(1) / 7.0
    tail_var = var_w[:, -k:].mean(1) / 7.0
    return {m: i for i, m in enumerate(idx)}, cum_mu, cum_var, tail_mu, tail_var, L, S.fc_wide


def _get_curves(scale: float, today_iso: str):
    c = _curves(today_iso, round(scale, 6), id(S.fc_wide))
    if c[-1] is not S.fc_wide:          # artifacts were reloaded and the old frame's id got reused
        _curves.cache_clear()
        c = _curves(today_iso, round(scale, 6), id(S.fc_wide))
    return c


def _demand(curves, rows: np.ndarray, t: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Expected and cautious (95% lower) cumulative demand over the next t days, per (row, t)."""
    _, cum_mu, cum_var, tail_mu, tail_var, L, _fc = curves
    tc = np.clip(t, 0, L)
    extra = np.clip(t - L, 0, None)
    mu = cum_mu[rows, tc] + tail_mu[rows] * extra
    var = cum_var[rows, tc] + tail_var[rows] * extra
    lo = np.maximum(mu - LOW_Z * np.sqrt(np.maximum(var, 0)), 0)
    return mu, lo


def fefo_projection(store_id: str, scale: float, medicine_id: str | None = None) -> pd.DataFrame:
    """Every batch with stock in a store (expired ones too), with projected FEFO sell-through.

    Columns: batch fields + days_left, expired, proj_sold, proj_unsold, loss_value, proj_unsold_slow,
    loss_value_slow, sellout_share (expected share of the batch sold before expiry)."""
    bl = inv.batches(store_id, medicine_id)
    cols = ["id", "medicine_id", "batch_no", "expiry_date", "qty_on_hand", "unit_cost", "supplier_id", "days_left",
            "expired", "value", "received_at", "source"]
    if not bl:
        return pd.DataFrame(columns=cols + ["proj_sold", "proj_unsold", "loss_value", "proj_unsold_slow",
                                            "loss_value_slow", "sellout_share"])
    b = pd.DataFrame(bl)[cols].sort_values(["medicine_id", "expiry_date", "id"]).reset_index(drop=True)
    curves = _get_curves(scale, date.today().isoformat())   # one snapshot for the whole projection
    pos = curves[0]
    rows = np.array([pos.get(m, -1) for m in b["medicine_id"]])
    known = rows >= 0
    t = np.clip(b["days_left"].to_numpy(int), 0, None)
    mu = np.zeros(len(b))
    lo = np.zeros(len(b))
    if known.any():
        mu[known], lo[known] = _demand(curves, rows[known], t[known])
    q = b["qty_on_hand"].to_numpy(float)
    sold = np.zeros(len(b))
    sold_lo = np.zeros(len(b))
    for mid, g in b.groupby("medicine_id", sort=False).groups.items():
        p_mu = p_lo = 0.0
        run_lo = 0.0
        for i in g:
            if b.at[i, "expired"]:
                continue                      # expired: never sold (FEFO skips it), all of it is lost
            d_mu = mu[i]
            run_lo = max(run_lo, lo[i])       # keep the cautious curve non-decreasing
            s = min(q[i], max(0.0, d_mu - p_mu))
            p_mu = p_mu + s if s >= q[i] - 1e-9 else max(p_mu, d_mu)
            s2 = min(q[i], max(0.0, run_lo - p_lo))
            p_lo = p_lo + s2 if s2 >= q[i] - 1e-9 else max(p_lo, run_lo)
            sold[i], sold_lo[i] = s, s2
    b["proj_sold"] = sold
    b["proj_unsold"] = q - sold
    b["proj_unsold_slow"] = q - sold_lo
    b["loss_value"] = b["proj_unsold"] * b["unit_cost"]
    b["loss_value_slow"] = b["proj_unsold_slow"] * b["unit_cost"]
    b["sellout_share"] = np.where(q > 0, sold / np.maximum(q, 1e-9), 1.0)
    return b


def expiring_report(store_id: str, scale: float, days: int, include_expired: bool = True) -> dict:
    b = fefo_projection(store_id, scale)
    if len(b):
        win = b[(b["days_left"] <= days) & (include_expired | ~b["expired"].astype(bool))].copy()
    else:
        win = b
    meds = S.meds
    out = []
    for _, r in win.iterrows():
        mid = r["medicine_id"]
        out.append({
            "batch_id": int(r["id"]), "medicine_id": mid,
            "medicine_name": meds.at[mid, "medicine_name"] if mid in meds.index else mid,
            "category": meds.at[mid, "category"] if mid in meds.index else None,
            "abc": meds.at[mid, "abc"] if mid in meds.index else None,
            "batch_no": r["batch_no"], "expiry_date": r["expiry_date"], "days_left": int(r["days_left"]),
            "expired": bool(r["expired"]), "qty": int(r["qty_on_hand"]), "unit_cost": r["unit_cost"],
            "value": r["value"], "supplier_id": r["supplier_id"],
            "proj_sold": round(float(r["proj_sold"]), 1), "proj_unsold": round(float(r["proj_unsold"]), 1),
            "proj_unsold_slow": round(float(r["proj_unsold_slow"]), 1),
            "loss_value": r["loss_value"], "loss_value_slow": r["loss_value_slow"],
            "sellout_share": r["sellout_share"],
            "will_sell_out": bool(not r["expired"] and r["proj_unsold"] < 0.5),
        })
    out.sort(key=lambda x: (not x["expired"], -x["loss_value"], x["days_left"]))
    at_risk = [x for x in out if not x["will_sell_out"]]
    return {
        "days": days,
        "totals": {
            "batches": len(out), "units": sum(x["qty"] for x in out), "value": sum(x["value"] for x in out),
            "expired_batches": sum(x["expired"] for x in out),
            "expired_units": sum(x["qty"] for x in out if x["expired"]),
            "expired_value": sum(x["value"] for x in out if x["expired"]),
            "at_risk_batches": len(at_risk),
            "proj_unsold_units": sum(x["proj_unsold"] for x in out),
            "proj_loss_value": sum(x["loss_value"] for x in out),
            "proj_unsold_units_slow": sum(x["proj_unsold_slow"] for x in out),
            "proj_loss_value_slow": sum(x["loss_value_slow"] for x in out),
        },
        "rows": out,
    }


# ─────────────────────────────────────────────────────────────────────────────
# reads
# ─────────────────────────────────────────────────────────────────────────────

PlanQ = dict(lead_time=Query(1, ge=0, le=8), review=Query(2, ge=1, le=8), service=Query(0.95, ge=0.5, le=0.999))


@router.get("/summary")
def summary(store_id: str | None = Query(None, max_length=32), lead_time: int = PlanQ["lead_time"],
            review: int = PlanQ["review"], service: float = PlanQ["service"], user: dict = Depends(current_user)):
    st = _store_for(user, store_id)
    scale = float(st["demand_scale"])
    m = positions(st["id"], scale, lead_time, review, service)
    stocked = m[m["qty"] > 0]
    today = date.today()
    ne = inv.near_expiry(st["id"], days=90, include_expired=True)
    exp_win = {}
    for d in (30, 60, 90):
        w = ne[(~ne["expired"].astype(bool)) & (ne["days_left"] <= d)] if len(ne) else ne
        exp_win[str(d)] = {"batches": int(len(w)), "units": int(w["qty"].sum()) if len(w) else 0,
                           "value": float(w["value"].sum()) if len(w) else 0.0}
    expired = ne[ne["expired"].astype(bool)] if len(ne) else ne
    # Weeks-of-cover distribution over medicines that have demand or stock.
    active = m[(m["weekly_rate"] > 0) | (m["qty"] > 0)]
    dist = []
    wc = active["weeks_cover"].to_numpy(float)
    q = active["qty"].to_numpy(float)
    for label, lo, hi in COVER_BINS:
        if label == "Out":
            n = int(((q <= 0) & np.isfinite(wc)).sum())
        else:
            n = int(((q > 0) & (wc > lo) & (wc <= hi)).sum()) if hi != math.inf else int(((q > 0) & (wc > lo) & np.isfinite(wc)).sum())
        dist.append({"bin": label, "count": n})
    dist.append({"bin": "No forecast demand", "count": int(((q > 0) & ~np.isfinite(wc)).sum())})
    proj = expiring_report(st["id"], scale, 90, include_expired=False)["totals"]
    counts = m["status"].value_counts().to_dict()
    return clean({
        "store": _store_info(st), "as_of": today.isoformat(), "forecast_start": S.fweeks[0],
        "params": {"lead_time": lead_time, "review": review, "service": service},
        "stock": {"value_cost": float(stocked["value"].sum()), "value_retail": float(stocked["retail_value"].sum()),
                  "units": int(stocked["qty"].sum()), "skus_in_stock": int(len(stocked)), "skus_total": int(len(m)),
                  "batches": int(stocked["n_batches"].sum())},
        "stockouts": {"count": int(counts.get("out", 0)),
                      "a_class": int(((m["status"] == "out") & (m["abc"] == "A")).sum()),
                      "weekly_units_unserved": float(m.loc[m["status"] == "out", "weekly_rate"].sum())},
        "status_counts": {k: int(counts.get(k, 0)) for k in ("out", "low", "ok", "excess", "none")},
        "expiring_count": int(m["expiring"].sum()),
        "near_expiry": exp_win,
        "expired_on_shelf": {"batches": int(len(expired)), "units": int(expired["qty"].sum()) if len(expired) else 0,
                             "value": float(expired["value"].sum()) if len(expired) else 0.0},
        "projected_expiry_loss_90d": {"units": proj["proj_unsold_units"], "value": proj["proj_loss_value"],
                                      "units_slow": proj["proj_unsold_units_slow"], "value_slow": proj["proj_loss_value_slow"],
                                      "batches": proj["at_risk_batches"]},
        "reorder": {"lines": int((m["suggested_order"] > 0).sum()), "units": int(m["suggested_order"].sum()),
                    "value_retail": float(m["order_value"].sum())},
        "cover_distribution": dist,
        "definitions": DEFINITIONS,
    })


SORTS = {
    "value": ("value", False), "name": ("medicine_name", True), "cover": ("weeks_cover", True),
    "order": ("order_value", False), "expiry": ("earliest_expiry", True), "on_hand": ("qty", False),
    "rate": ("weekly_rate", False), "risk": ("_risk", True),
}
STATUS_RANK = {"out": 0, "low": 1, "excess": 3, "ok": 4, "none": 5}


@router.get("/items")
def items(store_id: str | None = Query(None, max_length=32), q: str = Query("", max_length=80),
          category: str | None = Query(None, max_length=80),
          status: Literal["all", "low", "out", "excess", "expiring", "ok", "reorder", "stocked"] = "all",
          sort: Literal["value", "name", "cover", "order", "expiry", "on_hand", "rate", "risk"] = "risk",
          abc: str | None = Query(None, max_length=3, pattern="^[ABCabc]{1,3}$"),
          lead_time: int = PlanQ["lead_time"], review: int = PlanQ["review"], service: float = PlanQ["service"],
          limit: int = Query(500, ge=1, le=1000), offset: int = Query(0, ge=0),
          user: dict = Depends(current_user)):
    st = _store_for(user, store_id)
    m = positions(st["id"], float(st["demand_scale"]), lead_time, review, service)
    counts = {"all": int(len(m)), **{k: int((m["status"] == k).sum()) for k in ("out", "low", "excess", "ok")},
              "expiring": int(m["expiring"].sum()), "reorder": int((m["suggested_order"] > 0).sum()),
              "stocked": int((m["qty"] > 0).sum())}
    if q:
        ql = q.strip().lower()
        m = m[m["medicine_name"].str.lower().str.contains(ql, regex=False)
              | m["generic_name"].fillna("").str.lower().str.contains(ql, regex=False)
              | m.index.str.lower().str.contains(ql, regex=False)]
    if category:
        m = m[m["category"] == category]
    if abc:
        m = m[m["abc"].isin(list(abc.upper()))]
    if status in ("low", "out", "excess", "ok"):
        m = m[m["status"] == status]
    elif status == "expiring":
        m = m[m["expiring"]]
    elif status == "reorder":
        m = m[m["suggested_order"] > 0]
    elif status == "stocked":
        m = m[m["qty"] > 0]
    col, asc = SORTS[sort]
    if sort == "risk":
        m = m.assign(_risk=m["status"].map(STATUS_RANK).fillna(9) - m["abc"].map({"A": 0.3, "B": 0.2, "C": 0.1}).fillna(0)
                     - np.where(m["expiring"], 0.5, 0))
        m = m.sort_values(["_risk", "order_value"], ascending=[True, False])
    else:
        m = m.sort_values(col, ascending=asc, na_position="last")
    total = len(m)
    page = m.iloc[offset:offset + limit]
    return clean({
        "store": _store_info(st), "as_of": date.today().isoformat(), "total": total, "counts": counts,
        "params": {"lead_time": lead_time, "review": review, "service": service, "status": status, "sort": sort},
        "items": [_row(mid, r) for mid, r in page.iterrows()],
    })


def _check_med(mid: str) -> None:
    if mid not in S.meds.index:
        raise HTTPException(404, "Unknown medicine")


@router.get("/items/{medicine_id}")
def item(medicine_id: str, store_id: str | None = Query(None, max_length=32),
         lead_time: int = PlanQ["lead_time"], review: int = PlanQ["review"], service: float = PlanQ["service"],
         movements_limit: int = Query(25, ge=1, le=200), user: dict = Depends(current_user)):
    _check_med(medicine_id)
    st = _store_for(user, store_id)
    scale = float(st["demand_scale"])
    m = positions(st["id"], scale, lead_time, review, service)
    row = _row(medicine_id, m.loc[medicine_id])
    proj = fefo_projection(st["id"], scale, medicine_id)
    batches = []
    for _, b in proj.iterrows():
        batches.append({
            "batch_id": int(b["id"]), "batch_no": b["batch_no"], "expiry_date": b["expiry_date"],
            "days_left": int(b["days_left"]), "expired": bool(b["expired"]), "qty": int(b["qty_on_hand"]),
            "unit_cost": b["unit_cost"], "value": b["value"], "supplier_id": b["supplier_id"],
            "received_at": b["received_at"], "source": b["source"],
            "proj_sold": round(float(b["proj_sold"]), 1), "proj_unsold": round(float(b["proj_unsold"]), 1),
            "proj_unsold_slow": round(float(b["proj_unsold_slow"]), 1), "loss_value": b["loss_value"],
        })
    mv = inv.movements(st["id"], medicine_id, limit=movements_limit)
    # Other stores: totals only (single-store users see the numbers, never batch detail).
    oh = inv.on_hand(None)
    oh = oh[oh["medicine_id"] == medicine_id].set_index("store_id")
    others = []
    for s in inv.store_list():
        if s["id"] == st["id"]:
            continue
        rate = float(S.fc_wide.iloc[:, :4].mean(1).get(medicine_id, 0.0) or 0.0) * float(s["demand_scale"])
        qty = int(oh.at[s["id"], "qty"]) if s["id"] in oh.index else 0
        others.append({"store_id": s["id"], "name": s["name"], "simulated": s["simulated"], "on_hand": qty,
                       "earliest_expiry": oh.at[s["id"], "earliest_expiry"] if s["id"] in oh.index else None,
                       "weekly_rate": rate, "weeks_of_cover": (qty / rate) if rate > 0 else None,
                       "spare": max(0, int(qty - math.ceil(rate * (lead_time + review)))) if rate > 0 else qty})
    hist = S.hist_wide.loc[medicine_id].iloc[-12:].fillna(0).tolist() if medicine_id in S.hist_wide.index else []
    return clean({
        "store": _store_info(st), "as_of": date.today().isoformat(), "item": row, "batches": batches,
        "movements": mv, "movements_total": inv.count_movements(st["id"], medicine_id),
        "other_stores": others, "recent_weekly_sales_main": hist,
        "forecast_weekly": (S.fc_wide.loc[medicine_id] * scale).tolist() if medicine_id in S.fc_wide.index else [],
        "forecast_weeks": S.fweeks,
    })


@router.get("/movements")
def movements(store_id: str | None = Query(None, max_length=32), medicine_id: str | None = Query(None, max_length=32),
              kind: Literal["receive", "sale", "adjust", "transfer_out", "transfer_in", "expire_writeoff"] | None = None,
              limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=10**7),
              user: dict = Depends(current_user)):
    st = _store_for(user, store_id)
    if medicine_id:
        _check_med(medicine_id)
    try:
        rows = inv.movements(st["id"], medicine_id, limit=limit, offset=offset, kind=kind)
        total = inv.count_movements(st["id"], medicine_id, kind)
    except inv.InventoryError as e:
        raise _err(e)
    return clean({"store": _store_info(st), "total": total, "limit": limit, "offset": offset, "items": rows})


@router.get("/expiring")
def expiring(store_id: str | None = Query(None, max_length=32), days: int = Query(90, ge=1, le=365),
             include_expired: bool = True, user: dict = Depends(current_user)):
    st = _store_for(user, store_id)
    rep = expiring_report(st["id"], float(st["demand_scale"]), days, include_expired)
    return clean({"store": _store_info(st), "as_of": date.today().isoformat(), **rep,
                  "method": ("FEFO projection: each medicine's batches sell earliest-expiry first at the forecast rate "
                             "(x store demand scale). 'Slow demand' uses a 95% lower bound of cumulative demand. "
                             "Projections are expected values, not guarantees.")})


# ─────────────────────────────────────────────────────────────────────────────
# writes
# ─────────────────────────────────────────────────────────────────────────────

class ReceiveBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    medicine_id: str = Field(min_length=1, max_length=32)
    batch_no: str = Field(min_length=1, max_length=40)
    expiry_date: date
    qty: int = Field(gt=0, le=1_000_000, strict=True)   # strict: JSON true / "5" / 5.0 are rejected
    unit_cost: float | None = Field(None, ge=0, le=1e7, allow_inf_nan=False)
    supplier_id: str | None = Field(None, max_length=64)
    ref: str | None = Field(None, max_length=100)
    note: str | None = Field(None, max_length=500)


class SellBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    medicine_id: str = Field(min_length=1, max_length=32)
    qty: int = Field(gt=0, le=100_000, strict=True)
    ref: str | None = Field(None, max_length=100)
    allow_partial: bool = False
    dry_run: bool = False


class AdjustBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    batch_id: int = Field(gt=0, strict=True)
    delta: int = Field(ge=-1_000_000, le=1_000_000, strict=True)
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("delta")
    @classmethod
    def _nz(cls, v: int) -> int:
        if v == 0:
            raise ValueError("delta must not be 0")
        return v


class StoreBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)


def substitutes_hint(store_id: str, medicine_id: str, limit: int = 5) -> list[dict]:
    """In-stock alternatives from the substitutes engine: exact matches (same molecule, strength and
    form) first, then same molecule at a different strength/form, which needs a pharmacist's dose check."""
    if medicine_id not in S.meds.index:
        return []
    try:
        from backend.routers.substitutes import substitutes_for
        res = substitutes_for(medicine_id, store_id, qty_req=1, redact=True)
    except Exception:
        return []
    out = []
    for tier, items in (("exact", res.get("exact") or []), ("same_molecule", res.get("same_molecule") or [])):
        for c in items:
            q = int(c.get("on_hand_here") or 0)
            if q <= 0:
                continue
            out.append({"medicine_id": c["id"], "medicine_name": c["name"], "generic_name": S.meds.at[c["id"], "generic_name"],
                        "form": c.get("form"), "strength": c.get("strength"), "tier": tier, "same_form": tier == "exact",
                        "on_hand": q, "median_price": c.get("price"), "rx_share": float(S.meds.at[c["id"], "rx_share"]),
                        "match_note": c.get("match_note")})
    return out[:limit]


SUB_NOTE = ("Exact matches share molecule, strength and form. Same-molecule items differ in strength or form and "
            "need a pharmacist's dose check; prescription items need the prescriber's agreement before substituting.")


@router.post("/receive", status_code=201)
def receive(body: ReceiveBody, user: dict = Depends(require_perm("stock.receive"))):
    st = _store_for(user, body.store_id)
    try:
        b = inv.receive(st["id"], body.medicine_id, body.qty, body.batch_no, body.expiry_date.isoformat(),
                        unit_cost=body.unit_cost, supplier_id=body.supplier_id, user_id=user.get("id"),
                        ref=body.ref, note=body.note)
    except inv.InventoryError as e:
        raise _err(e)
    return clean({"ok": True, "store": _store_info(st), "batch": b})


@router.post("/sell")
def sell(body: SellBody, user: dict = Depends(require_perm("sales.record"))):
    st = _store_for(user, body.store_id)
    _check_med(body.medicine_id)
    try:
        if body.dry_run:
            sellable = [b for b in inv.batches(st["id"], body.medicine_id) if not b["expired"]]
            available = sum(b["qty_on_hand"] for b in sellable)
            alloc, need = [], body.qty
            for b in sellable:
                if need <= 0:
                    break
                t = min(need, b["qty_on_hand"])
                alloc.append({"batch_id": b["id"], "batch_no": b["batch_no"], "expiry": b["expiry_date"], "qty": t,
                              "days_left": b["days_left"]})
                need -= t
            ok = available >= body.qty
            return clean({"ok": ok, "dry_run": True, "available": available, "requested": body.qty,
                          "allocation": alloc,
                          "substitutes": [] if ok else substitutes_hint(st["id"], body.medicine_id),
                          "substitute_note": None if ok else SUB_NOTE})
        alloc = inv.sell(st["id"], body.medicine_id, body.qty, user.get("id"), ref=body.ref,
                         allow_partial=body.allow_partial)
    except inv.InsufficientStock as e:
        raise HTTPException(409, {"message": str(e), "available": e.available,
                                  "substitutes": clean(substitutes_hint(st["id"], body.medicine_id)),
                                  "substitute_note": SUB_NOTE})
    except inv.InventoryError as e:
        raise _err(e)
    sold = sum(a.qty for a in alloc)
    return clean({"ok": True, "store": _store_info(st), "sold": sold, "requested": body.qty,
                  "allocation": [a._asdict() for a in alloc],
                  "on_hand_after": int(sum(b["qty_on_hand"] for b in inv.batches(st["id"], body.medicine_id) if not b["expired"]))})


@router.post("/adjust")
def adjust(body: AdjustBody, user: dict = Depends(require_perm("stock.adjust"))):
    st = _store_for(user, body.store_id)
    try:
        b = inv.adjust(st["id"], body.batch_id, body.delta, body.reason, user.get("id"), max_abs=max_adjust(user))
    except inv.InventoryError as e:
        raise _err(e)
    return clean({"ok": True, "store": _store_info(st), "batch": b})


@router.post("/writeoff-expired")
def writeoff_expired(body: StoreBody | None = None, user: dict = Depends(require_perm("stock.writeoff"))):
    st = _store_for(user, body.store_id if body else None)
    try:
        rows = inv.write_off_expired(st["id"], user_id=user.get("id"))
    except inv.InventoryError as e:
        raise _err(e)
    meds = S.meds["medicine_name"]
    for r in rows:
        r["medicine_name"] = meds.get(r["medicine_id"])
    return clean({"ok": True, "store": _store_info(st), "batches": len(rows),
                  "units": sum(r["qty"] for r in rows), "value": sum(r["value"] for r in rows), "rows": rows})


# ── CSV import ───────────────────────────────────────────────────────────────

def _parse_import(text: str, store_id: str) -> dict:
    today = date.today()
    errors, warnings, valid = [], [], []
    try:
        reader = csv.reader(io.StringIO(text))
        raw = [r for r in reader]
    except csv.Error as e:
        raise HTTPException(400, f"Could not parse CSV: {e}")
    raw = [r for r in raw if any(c.strip() for c in r)]
    if not raw:
        raise HTTPException(400, "The file is empty")
    header = [h.strip().lower().lstrip("﻿") for h in raw[0]]
    if "medicine_id" not in header:
        raise HTTPException(400, "Missing header row. Expected: " + ",".join(IMPORT_COLS[:5]) + "[,supplier_id]")
    missing = [c for c in IMPORT_COLS[:5] if c not in header]
    if missing:
        raise HTTPException(400, f"Missing column(s): {', '.join(missing)}")
    body = raw[1:]
    if len(body) > IMPORT_MAX_ROWS:
        raise HTTPException(400, f"Too many rows ({len(body)}); the limit is {IMPORT_MAX_ROWS}")
    col = {c: header.index(c) for c in IMPORT_COLS if c in header}
    seen: dict[tuple[str, str], tuple[int, str]] = {}
    existing = {(r["medicine_id"], r["batch_no"]): r["expiry_date"]
                for r in db.query("SELECT medicine_id, batch_no, expiry_date FROM batches WHERE store_id = ?", (store_id,))}

    def get(r, c):
        i = col.get(c)
        return r[i].strip() if i is not None and i < len(r) else ""

    for n, r in enumerate(body, start=2):
        errs = []
        mid = get(r, "medicine_id").upper()
        bno = get(r, "batch_no")
        exp_s = get(r, "expiry_date")
        qty_s = get(r, "qty")
        cost_s = get(r, "unit_cost")
        sup = get(r, "supplier_id") or None
        if mid not in S.meds.index:
            errs.append(("medicine_id", f"Unknown medicine '{mid}'" if mid else "medicine_id is required"))
        if not bno:
            errs.append(("batch_no", "batch_no is required"))
        elif len(bno) > 40:
            errs.append(("batch_no", "batch_no is longer than 40 characters"))
        exp = None
        try:
            # 'YYYY-MM-DD' (or an ISO datetime starting with it). Short/odd strings fail cleanly.
            exp = date.fromisoformat(exp_s[:10]) if _DATE_RE.match(exp_s) else None
            if exp is None:
                raise ValueError
        except ValueError:
            errs.append(("expiry_date", f"Invalid expiry_date '{exp_s}' (use YYYY-MM-DD)"))
        if exp is not None and exp <= today:
            errs.append(("expiry_date", f"Already expired ({exp.isoformat()}); expired goods cannot be received"))
        qty = None
        try:
            fq = float(qty_s)
            if not math.isfinite(fq) or not fq.is_integer():
                raise ValueError
            qty = int(fq)
            if qty <= 0 or qty > 1_000_000:
                errs.append(("qty", "qty must be between 1 and 1,000,000"))
                qty = None
        except ValueError:
            errs.append(("qty", f"qty '{qty_s}' is not a whole number"))
        cost = None
        if cost_s:
            try:
                cost = float(cost_s)
                if not math.isfinite(cost) or cost < 0 or cost > 1e7:
                    raise ValueError
            except ValueError:
                errs.append(("unit_cost", f"unit_cost '{cost_s}' must be a number between 0 and 10,000,000"))
                cost = None
        if sup and len(sup) > 64:
            errs.append(("supplier_id", "supplier_id is longer than 64 characters"))
        if not errs:
            key = (mid, bno)
            e_iso = exp.isoformat()
            if key in existing and existing[key] != e_iso:
                errs.append(("expiry_date", f"Batch {bno} already exists in this store with expiry {existing[key]}"))
            elif key in seen and seen[key][1] != e_iso:
                errs.append(("expiry_date", f"Row {seen[key][0]} has the same batch with expiry {seen[key][1]}"))
            elif key in seen:
                warnings.append({"row": n, "message": f"Same batch as row {seen[key][0]}: quantities will be merged"})
            elif key in existing:
                warnings.append({"row": n, "message": f"Batch {bno} already in stock: quantity will be added to it"})
            seen.setdefault(key, (n, e_iso))
            if exp is not None and (exp - today).days <= 90 and not errs:
                warnings.append({"row": n, "message": f"Short-dated: expires in {(exp - today).days} days"})
        if errs:
            for f, msg in errs:
                errors.append({"row": n, "field": f, "message": msg})
            continue
        unit_cost = cost if cost is not None else float(S.meds.at[mid, "median_price"]) * inv.COST_FACTOR
        valid.append({"row": n, "medicine_id": mid, "medicine_name": S.meds.at[mid, "medicine_name"], "batch_no": bno,
                      "expiry_date": exp.isoformat(), "qty": qty, "unit_cost": unit_cost, "cost_assumed": cost is None,
                      "supplier_id": sup, "value": qty * unit_cost})
    return {"rows": len(body), "valid": valid, "errors": errors, "warnings": warnings}


def _commit_import(store_id: str, valid: list[dict], user_id: int | None) -> None:
    ref = f"IMPORT-{date.today():%Y%m%d}"
    try:
        with db.tx():
            for v in valid:
                inv.receive(store_id, v["medicine_id"], v["qty"], v["batch_no"], v["expiry_date"],
                            unit_cost=v["unit_cost"], supplier_id=v["supplier_id"], user_id=user_id,
                            ref=ref, note="CSV import")
    except inv.InventoryError as e:
        raise HTTPException(e.status if e.status != 404 else 400, f"Import rolled back, nothing was saved: {e}")


@router.post("/import")
async def import_csv(request: Request, store_id: str | None = Query(None, max_length=32),
                     commit: bool = Query(False, description="false = validate only; true = all-or-nothing commit"),
                     user: dict = Depends(require_perm("stock.receive"))):
    """Body: raw CSV text (text/csv or text/plain) or JSON {"csv": "..."}.
    Columns: medicine_id,batch_no,expiry_date,qty,unit_cost[,supplier_id] (unit_cost may be blank)."""
    st = _store_for(user, store_id)
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        raise HTTPException(400, "Invalid Content-Length header")
    if declared > IMPORT_MAX_BYTES:       # refuse before buffering an oversized body
        raise HTTPException(413, "File is larger than 2 MB")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > IMPORT_MAX_BYTES:
            raise HTTPException(413, "File is larger than 2 MB")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if len(raw) > IMPORT_MAX_BYTES:
        raise HTTPException(413, "File is larger than 2 MB")
    ctype = request.headers.get("content-type", "")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "File must be UTF-8 text")
    if "application/json" in ctype:
        import json
        try:
            j = json.loads(text or "{}")
        except json.JSONDecodeError:
            raise HTTPException(400, "Invalid JSON body")
        if not isinstance(j, dict) or not isinstance(j.get("csv"), str):
            raise HTTPException(422, "JSON body must be {\"csv\": \"...\"}")
        text = j["csv"]
        if len(text.encode("utf-8")) > IMPORT_MAX_BYTES:
            raise HTTPException(413, "File is larger than 2 MB")
    # Parsing and the all-or-nothing commit are blocking SQLite work: run them in the threadpool so a
    # large import never stalls the event loop (and every other request) while it holds the write lock.
    rep = await run_in_threadpool(_parse_import, text, st["id"])
    committed = False
    if commit:
        if rep["errors"]:
            raise HTTPException(422, {"message": f"{len(rep['errors'])} row error(s): nothing was imported. Fix them and try again.",
                                      "errors": rep["errors"][:200]})
        if not rep["valid"]:
            raise HTTPException(400, "No rows to import")
        await run_in_threadpool(_commit_import, st["id"], rep["valid"], user.get("id"))
        committed = True
    return clean({
        "store": _store_info(st), "committed": committed, "rows": rep["rows"], "valid_rows": len(rep["valid"]),
        "error_rows": len({e["row"] for e in rep["errors"]}), "errors": rep["errors"][:500], "warnings": rep["warnings"][:500],
        "totals": {"units": sum(v["qty"] for v in rep["valid"]), "value": sum(v["value"] for v in rep["valid"]),
                   "medicines": len({v["medicine_id"] for v in rep["valid"]})},
        "preview": rep["valid"][:200], "can_commit": not rep["errors"] and bool(rep["valid"]),
    })


@router.get("/template.csv")
def template(user: dict = Depends(current_user)):
    exp = (date.today() + timedelta(days=540)).isoformat()
    ids = list(S.meds.sort_values("total_units", ascending=False).index[:2])
    lines = [",".join(IMPORT_COLS)]
    for i, mid in enumerate(ids):
        lines.append(f"{mid},B{date.today():%y%m}-{i + 1:03d},{exp},{10 * (i + 1)},{S.meds.at[mid, 'median_price'] * 0.8:.2f},SUP-EXAMPLE")
    return Response("\n".join(lines) + "\n", media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="stock-import-template.csv"'})


# ── helpers for other modules (planner, alerts) ──────────────────────────────

def on_hand_series(store_id: str) -> pd.Series:
    """Sellable on-hand units per medicine_id (0-filled for all medicines)."""
    oh = inv.on_hand(store_id)
    s = oh.set_index("medicine_id")["qty"] if len(oh) else pd.Series(dtype=float)
    return s.reindex(S.meds.index).fillna(0).astype(int)
