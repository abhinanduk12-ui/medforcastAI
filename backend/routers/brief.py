"""Daily morning brief: one page a pharmacist can read with their first coffee.

compose_brief(store_id, day) builds a deterministic, structured brief from data the system already has:

  headline numbers   expected demand today / this week (12-week ensemble forecast x the store's demand
                     scale x day-of-week share), the same calendar week last year (history), the latest
                     week with sales data, and sales actually recorded in the app yesterday
  focus of the day   one line chosen by explicit, ordered rules (FOCUS_RULES below)
  order today        stock below its order-up-to level that will run short before the next review,
                     ranked by urgency (weeks of cover vs lead time), then value
  expiring soon      batches expiring within 90 days with the units projected to remain unsold under
                     FEFO at the forecast rate
  alerts             the Smart Alert Center's own computation (backend.routers.alerts.build)
  season             current / next Kerala season, days to the switch, medicines that rise
  weather/outbreaks  from the signals module when it exists (imported defensively)

Renderers: JSON (web page), plain text (WhatsApp, <= 1,500 chars) and an inline-styled HTML email.
Delivery lives in backend/notify.py; every attempt is logged in the `briefs` table.
A daemon thread sends scheduled briefs once per store per day (Asia/Kolkata time).

Data honesty: the sales history comes from ONE shop. Branch numbers are that shop's forecast x the
branch's demand_scale and are labelled as simulated everywhere they appear.
"""
from __future__ import annotations

import concurrent.futures as cf
import html as _html
import importlib
import logging
import math
import os
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field, field_validator

from ml import config as C
from backend import db, notify
from backend import inventory as inv
from backend.auth import current_user, has_perm, require_perm, resolve_store, store_scope
from backend.core import S, clean, next_season, poisson_quantile, season_movers, season_today, z_for, SLOW_MOVER_RATE

log = logging.getLogger("medforecast.brief")
router = APIRouter(prefix="/api/brief", tags=["brief"])

IST = timezone(timedelta(hours=5, minutes=30), "Asia/Kolkata")

# Planning assumptions for the "Order today" list (the planner's defaults).
LEAD_WEEKS = 1
REVIEW_WEEKS = 2
SERVICE = 0.95
ORDER_LIMIT = 12
EXPIRY_DAYS = 90
EXPIRY_SOON = 60
EXPIRY_LIMIT = 10
ALERT_LIMIT = 5
WA_MAX_CHARS = 1500
ALERT_CACHE_S = 600
SIGNALS_TIMEOUT_S = 2.0   # brief_summary is cache-only but can take ~1-2 s under load
SEND_LIMIT_PER_HOUR = 30          # manual send attempts per store per hour (abuse guard)
MAX_RECIPIENTS = 10               # per channel
SCHEDULE_KEY = "brief.schedule"
CATCH_UP_HOURS = 3                # a scheduled brief is still sent up to 3 h late (e.g. after a restart)
SCHEDULER_TICK_S = 60

db.register_schema("brief", [
    """
    CREATE TABLE IF NOT EXISTS briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        date TEXT NOT NULL,
        channel TEXT NOT NULL,
        recipient TEXT,
        status TEXT NOT NULL,
        error TEXT,
        trigger TEXT NOT NULL DEFAULT 'manual',
        user_id INTEGER,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS briefs_store_date ON briefs(store_id, date);
    CREATE INDEX IF NOT EXISTS briefs_created ON briefs(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS briefs_schedule_once ON briefs(store_id, date) WHERE channel = 'run';
    """,
])

_pool = cf.ThreadPoolExecutor(max_workers=4, thread_name_prefix="brief")


# ── helpers ──────────────────────────────────────────────────────────────────

def _f(x, default=0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _store_info(store_id: str) -> dict:
    try:
        s = inv.get_store(store_id)
    except inv.InventoryError as e:
        raise inv.as_http(e)
    return {"id": s["id"], "name": s["name"], "city": s.get("city"), "demand_scale": _f(s.get("demand_scale"), 1.0),
            "is_main": bool(s.get("is_main")), "simulated": not bool(s.get("is_main"))}


def _fweek_index(day: date) -> tuple[int, bool]:
    """Index of the forecast week containing `day` (clamped), and whether `day` lies inside the horizon."""
    ws = [date.fromisoformat(w) for w in S.fweeks]
    for i, w in enumerate(ws):
        if w <= day < w + timedelta(days=7):
            return i, True
    return (0, False) if day < ws[0] else (len(ws) - 1, False)


def _hist_week_for(day: date) -> str | None:
    for w in S.weeks:
        d = date.fromisoformat(w)
        if d <= day < d + timedelta(days=7):
            return w
    return None


def _dow_share(day: date) -> float:
    dow = S.meta.get("dow") or []
    if len(dow) == 7 and sum(dow) > 0:
        return float(dow[day.weekday()]) / float(sum(dow))
    return 1 / 7


def _call_with_timeout(fn, timeout: float):
    fut = _pool.submit(fn)
    try:
        return fut.result(timeout=timeout)
    except cf.TimeoutError:
        return TimeoutError(f"timed out after {timeout:.1f}s")
    except Exception as e:  # noqa: BLE001 - optional integrations must never break the brief
        return e


# ── alerts (Smart Alert Center computation) ──────────────────────────────────
# Forecast-based alerts do not depend on the store: computed once per day (cached, warmed in the
# background). The alerts module's live-ledger alerts are per store and cached for a minute only.

_global_alerts: dict[str, tuple[float, list, bool]] = {}
_store_alerts: dict[tuple[str, str], tuple[float, list]] = {}
_alert_lock = threading.Lock()
STORE_ALERT_CACHE_S = 60


def _global_alert_list(day: date) -> tuple[list[dict], bool]:
    """(alerts, complete). Expiry-risk alerts need the raw sales workbook parsed (several seconds, warmed
    in the background); until it is ready they are left out so the brief stays fast."""
    from backend.routers import alerts as AL
    key, now = day.isoformat(), time.monotonic()
    with _alert_lock:
        hit = _global_alerts.get(key)
        if hit and now - hit[0] < ALERT_CACHE_S:
            return hit[1], hit[2]
    complete = AL.shelf_life.cache_info().currsize > 0
    if complete:
        out = AL.build(day, LEAD_WEEKS)
    else:
        out = (AL.season_alerts(day, LEAD_WEEKS) + AL.anomaly_alerts() + AL.trend_alerts() + AL.stockout_alerts()
               + AL.data_alerts())
    with _alert_lock:
        # Incomplete results are kept for 30 s only, so expiry alerts appear as soon as they are ready.
        _global_alerts.clear()
        _global_alerts[key] = (now if complete else now - ALERT_CACHE_S + 30, out, complete)
    return out, complete


def _store_alert_list(day: date, store_id: str) -> list[dict]:
    from backend.routers import alerts as AL
    key, now = (day.isoformat(), store_id), time.monotonic()
    with _alert_lock:
        hit = _store_alerts.get(key)
        if hit and now - hit[0] < STORE_ALERT_CACHE_S:
            return hit[1]
    try:
        st = inv.get_store(store_id)
    except inv.InventoryError:
        return []
    out: list[dict] = []
    for name, args in (("ledger_expiry_alerts", (st,)), ("stockout_now_alerts", (st, LEAD_WEEKS))):
        fn = getattr(AL, name, None)
        if callable(fn):
            out += fn(*args)
    with _alert_lock:
        for k in [k for k in _store_alerts if k[0] != key[0]]:
            _store_alerts.pop(k, None)
        _store_alerts[key] = (now, out)
    return out


def _alerts(day: date, store_id: str) -> tuple[list[dict], bool]:
    """Same alerts as backend.routers.alerts.build(day, lead, store), assembled from cached parts."""
    from backend.routers import alerts as AL
    glob, complete = _global_alert_list(day)
    out = glob + _store_alert_list(day, store_id)
    return sorted(out, key=lambda a: (AL.SEV_RANK[a["severity"]], -a["impact_inr"])), complete


def _warm_alerts():
    try:
        from backend.routers import alerts as AL
        AL.shelf_life()
        _global_alert_list(date.today())
    except Exception:  # noqa: BLE001 - the request path surfaces real errors
        pass


threading.Thread(target=_warm_alerts, name="brief-warm", daemon=True).start()




# ── optional integrations (other modules may or may not exist) ────────────────

SIGNALS_MODULES = ("backend.routers.signals", "backend.signals")
SIGNALS_FUNCS = ("brief_summary", "signals_summary", "summary", "current_signals", "get_signals")


def _find(modules, funcs):
    for mname in modules:
        try:
            mod = importlib.import_module(mname)
        except Exception:  # noqa: BLE001 - missing or broken optional module
            continue
        for fname in funcs:
            fn = getattr(mod, fname, None)
            if callable(fn):
                return mname, fname, fn
    return None


def _try_call(fn, store_id: str, day: date):
    for args, kw in (((), {"store_id": store_id, "as_of": day}), ((), {"store_id": store_id}), ((store_id,), {}), ((), {})):
        try:
            return fn(*args, **kw)
        except TypeError:
            continue
    raise TypeError("no compatible signature")


def _ledger():
    """The live stock ledger module (backend/routers/stock.py), or None when it is not installed."""
    try:
        from backend.routers import stock as ST
    except Exception:  # noqa: BLE001
        return None
    return ST if all(callable(getattr(ST, n, None)) for n in ("positions", "expiring_report")) else None


def _text_of(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v.strip()[:240] or None
    if isinstance(v, dict):
        for k in ("summary", "headline", "text", "title", "label", "name", "description"):
            if isinstance(v.get(k), str) and v[k].strip():
                lvl = v.get("level") or v.get("risk") or v.get("severity")
                return (v[k].strip() + (f" ({lvl})" if isinstance(lvl, str) and lvl not in v[k] else ""))[:240]
    return None


DISTRICTS = {"EKM": "Ernakulam", "KERALA": "Kerala (state-wide)"}


def _weather_text(w) -> str | None:
    """Weather from the signals contract: a string, a dict with a text field, or the signals module's
    numeric dict {next16_rain_mm, anomaly_pct, outlook, stale, source}."""
    t = _text_of(w)
    if t or not isinstance(w, dict):
        return t
    mm = w.get("next16_rain_mm")
    if mm is None or not math.isfinite(_f(mm, math.nan)):
        return None
    out = f"Rain forecast for the next 16 days: {_f(mm):.0f} mm"
    if isinstance(w.get("outlook"), str) and w["outlook"].strip():
        out += f", {w['outlook'].strip()}"
    an = w.get("anomaly_pct")
    if an is not None and math.isfinite(_f(an, math.nan)):
        out += f" ({_f(an) * 100:+.0f}% vs normal)"
    if isinstance(w.get("source"), str) and w["source"].strip():
        out += f" · {w['source'].strip()}"
    return out[:240]


def _outbreak_text(o) -> str | None:
    if isinstance(o, dict) and not any(isinstance(o.get(k), str) and o[k].strip() for k in ("summary", "headline", "text", "title")):
        label = o.get("label") or o.get("disease") or o.get("name")
        if isinstance(label, str) and label.strip():
            lvl = o.get("level") or o.get("risk") or o.get("severity")
            where = DISTRICTS.get(str(o.get("district") or ""), o.get("district_name") or o.get("district"))
            return (label.strip() + (f" {lvl}" if isinstance(lvl, str) else "")
                    + (f" in {where}" if isinstance(where, str) and where else ""))[:240]
    return _text_of(o)


def _signals(store_id: str, day: date) -> dict:
    found = _find(SIGNALS_MODULES, SIGNALS_FUNCS)
    base = {"available": False, "weather": None, "outbreaks": [], "source": None, "simulated": None,
            "note": "Weather and outbreak signals are not connected yet."}
    if not found:
        return base
    mname, fname, fn = found
    res = _call_with_timeout(lambda: _try_call(fn, store_id, day), SIGNALS_TIMEOUT_S)
    if isinstance(res, BaseException) or not isinstance(res, dict):
        return {**base, "note": "Weather and outbreak signals could not be loaded right now."}
    if res.get("available") is False:
        return {**base, "note": "No weather or outbreak data is cached yet (see the Signals page)."}
    weather = _weather_text(res.get("weather")) or _weather_text(res.get("weather_summary"))
    raw_ob = res.get("outbreaks") or res.get("outbreak") or res.get("alerts") or []
    if isinstance(raw_ob, (str, dict)):
        raw_ob = [raw_ob]
    outbreaks = [t for t in (_outbreak_text(o) for o in list(raw_ob)[:4]) if t]
    high = False
    for o in list(raw_ob)[:10]:
        if isinstance(o, dict) and str(o.get("level") or o.get("risk") or o.get("severity") or "").lower() in ("high", "critical", "severe"):
            high = True
    headline = _text_of(res.get("headline")) or _text_of(res.get("summary"))
    sim = res.get("simulated")
    w = res.get("weather")
    stale = [n for n, flag in (("weather forecast", isinstance(w, dict) and w.get("stale")),
                               ("disease reports", res.get("disease_stale"))) if flag]
    notes = [n for n in (_text_of(res.get("note")),
                         "Signals may be simulated; check the source before acting." if sim else None,
                         f"Stale data: the {' and '.join(stale)} could not be refreshed recently." if stale else None,
                         f"Disease reports as of {res['disease_as_of']}." if isinstance(res.get("disease_as_of"), str) else None) if n]
    return {"available": bool(weather or outbreaks or headline), "weather": weather, "outbreaks": outbreaks,
            "headline": headline, "high_risk": high, "source": _text_of(res.get("source")) or f"{mname}",
            "simulated": bool(sim) if sim is not None else None, "stale": bool(stale),
            "note": " ".join(notes) or None}


# ── sections ─────────────────────────────────────────────────────────────────

def _headline(store: dict, day: date, k: int, in_horizon: bool) -> dict:
    scale = store["demand_scale"]
    m = S.meds
    price = m["median_price"].fillna(0)
    col, scol = S.fc_wide.iloc[:, k], S.sig_wide.iloc[:, k]
    week_units = float(col.sum() * scale)
    week_value = float((col.reindex(m.index).fillna(0) * price).sum() * scale)
    week_sd = float(np.sqrt((scol.fillna(0) ** 2).sum()) * scale)
    share = _dow_share(day)
    today_units = week_units * share
    today_sd = week_sd * math.sqrt(share)
    z = 1.645
    out = {
        "expected_today": {"units": today_units, "value": week_value * share,
                           "lo": max(0.0, today_units - z * today_sd), "hi": today_units + z * today_sd,
                           "dow_share": share, "forecast_week": S.fweeks[k], "in_horizon": in_horizon},
        "expected_week": {"units": week_units, "value": week_value, "lo": max(0.0, week_units - z * week_sd),
                          "hi": week_units + z * week_sd, "week": S.fweeks[k]},
    }
    # The same calendar week one year earlier, from the sales history (main shop x scale).
    ly_day = day - timedelta(days=364)
    lw = _hist_week_for(ly_day)
    if lw is not None:
        h = S.hist[S.hist["week"] == lw]
        ly_units = float(h["units"].sum() * scale)
        out["same_week_last_year"] = {"week": lw, "units": ly_units, "value": float(h["revenue"].sum() * scale),
                                      "change": (week_units / ly_units - 1) if ly_units > 0 else None}
    else:
        out["same_week_last_year"] = None
    last = S.weeks[-1]
    h = S.hist[S.hist["week"] == last]
    prev = S.hist[S.hist["week"] == S.weeks[-2]] if len(S.weeks) > 1 else h
    lu, pu = float(h["units"].sum() * scale), float(prev["units"].sum() * scale)
    out["latest_actual_week"] = {"week": last, "units": lu, "value": float(h["revenue"].sum() * scale),
                                 "change_vs_prior": (lu / pu - 1) if pu > 0 else None,
                                 "days_old": (day - (date.fromisoformat(last) + timedelta(days=6))).days}
    # Sales actually recorded in this app yesterday (IST calendar day).
    y0 = datetime.combine(day - timedelta(days=1), datetime.min.time(), IST).astimezone(timezone.utc)
    y1 = y0 + timedelta(days=1)
    r = db.query_one(
        "SELECT COALESCE(-SUM(m.qty), 0) AS units, COUNT(*) AS lines, COUNT(DISTINCT m.medicine_id) AS meds "
        "FROM movements m WHERE m.store_id = ? AND m.kind = 'sale' AND m.created_at >= ? AND m.created_at < ?",
        (store["id"], y0.strftime("%Y-%m-%dT%H:%M:%S+00:00"), y1.strftime("%Y-%m-%dT%H:%M:%S+00:00"))) or {}
    rows = db.query(
        "SELECT medicine_id, -SUM(qty) AS units FROM movements WHERE store_id = ? AND kind = 'sale' "
        "AND created_at >= ? AND created_at < ? GROUP BY medicine_id",
        (store["id"], y0.strftime("%Y-%m-%dT%H:%M:%S+00:00"), y1.strftime("%Y-%m-%dT%H:%M:%S+00:00")))
    yval = sum(_f(x["units"]) * _f(price.get(x["medicine_id"])) for x in rows)
    out["yesterday_recorded"] = {"date": (day - timedelta(days=1)).isoformat(), "units": _f(r.get("units")),
                                 "lines": int(r.get("lines") or 0), "medicines": int(r.get("meds") or 0), "value": yval}
    return out


TIER_RANK = {"out": 0, "before_delivery": 1, "before_review": 2}
ABC_RANK = {"A": 0, "B": 1, "C": 2}


def _builtin_positions(store: dict, k: int, pos: pd.DataFrame) -> pd.DataFrame:
    """Fallback when the stock ledger module is missing: the planner's order-up-to policy for the
    store (mean x scale, sd x sqrt(scale) like the ledger), starting at the current forecast week."""
    scale = store["demand_scale"]
    cover = LEAD_WEEKS + REVIEW_WEEKS
    use = max(1, min(cover, len(S.fweeks) - k))
    fc = S.fc_wide.iloc[:, k:k + use].fillna(0)
    sg = S.sig_wide.iloc[:, k:k + use].fillna(0)
    demand = (fc.sum(1) * cover / use * scale).reindex(pos.index).fillna(0)
    sd = (np.sqrt((sg ** 2).sum(1) * cover / use) * math.sqrt(scale)).reindex(pos.index).fillna(0)
    out_to = np.ceil(demand + z_for(SERVICE) * sd)
    slow = (demand / cover) < SLOW_MOVER_RATE
    out_to[slow] = [poisson_quantile(float(mu), SERVICE) for mu in demand[slow]]
    m = pos.copy()
    m["cover_demand"] = demand
    m["order_up_to"] = out_to.astype(int)
    m["policy"] = np.where(slow, "On demand", "Forecast")
    m["suggested_order"] = (m["order_up_to"] - m["qty"]).clip(lower=0).astype(int)
    return m


def _order_today(store: dict, day: date, k: int, pos: pd.DataFrame) -> dict:
    """Lines to order today: suggested_order > 0 (order-up-to minus sellable stock, from the stock ledger)
    where the stock will not last until the next review (weeks of cover < lead + review), ranked by urgency
    (out of stock, runs out before a delivery can arrive, below reorder level), then ABC class, then cover
    vs lead time, then value."""
    ST = _ledger()
    if ST is not None:
        m = ST.positions(store["id"], store["demand_scale"], LEAD_WEEKS, REVIEW_WEEKS, SERVICE)
        source = "Stock ledger: order-up-to minus sellable on-hand stock"
    else:
        m = _builtin_positions(store, k, pos)
        source = "Built-in order-up-to policy (stock ledger module not installed)"
    cover = LEAD_WEEKS + REVIEW_WEEKS
    rate = m["weekly_rate"].fillna(0)
    df = m[(m["suggested_order"] > 0) & (rate > 0) & (m["weeks_cover"] < cover)].copy()
    df["order_value"] = df["suggested_order"] * df["median_price"].fillna(0) * inv.COST_FACTOR
    df["urgency"] = df["weeks_cover"] - LEAD_WEEKS
    df["tier"] = np.select([df["qty"] <= 0, df["weeks_cover"] < LEAD_WEEKS], ["out", "before_delivery"], "before_review") \
        if len(df) else pd.Series(dtype=object)
    df["tier_rank"] = df["tier"].map(TIER_RANK) if len(df) else pd.Series(dtype=float)
    df["abc_rank"] = df["abc"].map(ABC_RANK).fillna(3) if len(df) else pd.Series(dtype=float)
    df = df.rename_axis("medicine_id").reset_index().sort_values(
        ["tier_rank", "abc_rank", "urgency", "order_value", "medicine_id"],
        ascending=[True, True, True, False, True], kind="mergesort")
    rx = S.meds["rx_share"]
    items = [{
        "medicine_id": r["medicine_id"], "medicine_name": r["medicine_name"], "category": r["category"],
        "form": r["form"], "abc": r["abc"], "on_hand": int(r["qty"]), "weekly_rate": float(r["weekly_rate"]),
        "weeks_cover": float(r["weeks_cover"]), "order_up_to": int(r["order_up_to"]), "suggested": int(r["suggested_order"]),
        "order_value": float(r["order_value"]), "tier": r["tier"], "policy": r["policy"],
        "rx_share": _f(rx.get(r["medicine_id"]), None),
    } for _, r in df.head(ORDER_LIMIT).iterrows()]
    counts = df["tier"].value_counts().to_dict() if len(df) else {}
    a_out = df[(df["tier"] == "out") & (df["abc"] == "A")] if len(df) else df
    return {"count": int(len(df)), "a_out": int(len(a_out)),
            "a_out_names": [str(x) for x in a_out["medicine_name"].head(3)] if len(a_out) else [], "units": float(df["suggested_order"].sum()), "value": float(df["order_value"].sum()),
            "tiers": {t: int(counts.get(t, 0)) for t in TIER_RANK}, "items": items, "source": source,
            "assumptions": {"lead_weeks": LEAD_WEEKS, "review_weeks": REVIEW_WEEKS, "service": SERVICE,
                            "cost_factor": inv.COST_FACTOR,
                            "note": ("Stock already on order is not tracked, so it is not netted off. Order value is an "
                                     "estimated cost (median selling price x %.1f). Weekly rate: mean forecast of the "
                                     "next 4 forecast weeks x the store's demand scale." % inv.COST_FACTOR)}}


def _builtin_expiring(store: dict, day: date, k: int) -> list[dict]:
    """Fallback FEFO projection at a flat daily forecast rate (used when the stock ledger is missing)."""
    ne = inv.near_expiry(store["id"], EXPIRY_DAYS, as_of=day, include_expired=True)
    rate = inv.forecast_rate(store["id"], weeks=min(4, len(S.fweeks) - k), start=k) / 7.0
    rows: list[dict] = []
    if not len(ne):
        return rows
    for mid, g in ne.sort_values(["medicine_id", "expiry_date", "batch_id"]).groupby("medicine_id", sort=True):
        ahead, r_day = 0.0, float(rate.get(mid, 0.0))
        for _, b in g.iterrows():
            if b["expired"]:
                unsold = float(b["qty"])
            else:
                unsold = max(0.0, float(b["qty"]) - max(0.0, r_day * max(int(b["days_left"]), 0) - ahead))
                ahead += float(b["qty"]) - unsold      # only what this batch actually sells is consumed demand
            rows.append({"medicine_id": mid, "medicine_name": b["medicine_name"], "category": b["category"],
                         "batch_id": int(b["batch_id"]), "batch_no": b["batch_no"], "expiry_date": b["expiry_date"],
                         "days_left": int(b["days_left"]), "expired": bool(b["expired"]), "qty": int(b["qty"]),
                         "unit_cost": _f(b["unit_cost"]), "value": _f(b["value"]), "proj_unsold": unsold})
    return rows


def _expiring(store: dict, day: date, k: int) -> dict:
    ST = _ledger()
    if ST is not None:
        rows = ST.expiring_report(store["id"], store["demand_scale"], EXPIRY_DAYS, include_expired=True)["rows"]
        method = ("Stock ledger FEFO projection: each medicine's batches sell earliest-expiry first against the "
                  "store's day-by-day forecast; what is left at expiry is the projected unsold quantity.")
    else:
        rows = _builtin_expiring(store, day, k)
        method = "FEFO projection at a flat forecast rate (stock ledger module not installed)."
    items = []
    for r in rows:
        qty = int(r["qty"])
        unsold = qty if r.get("expired") else int(math.floor(_f(r.get("proj_unsold")) + 0.5))
        unsold = max(0, min(qty, unsold))
        items.append({"medicine_id": r["medicine_id"], "medicine_name": r.get("medicine_name") or r["medicine_id"],
                      "category": r.get("category"), "batch_id": int(r["batch_id"]), "batch_no": r["batch_no"],
                      "expiry_date": r["expiry_date"], "days_left": int(r["days_left"]), "expired": bool(r.get("expired")),
                      "qty": qty, "value": _f(r.get("value")), "projected_unsold": unsold,
                      "unsold_value": unsold * _f(r.get("unit_cost"))})
    expired = [r for r in items if r["expired"]]
    live = sorted((r for r in items if not r["expired"]), key=lambda r: (-r["unsold_value"], r["days_left"], r["batch_id"]))
    at_risk = [r for r in live if r["projected_unsold"] > 0]

    def within(d: int) -> list[dict]:
        return [r for r in live if r["days_left"] <= d]

    shown = [r for r in live if r["projected_unsold"] > 0 or r["days_left"] <= EXPIRY_SOON][:EXPIRY_LIMIT]
    return {
        "expired": {"batches": len(expired), "qty": sum(r["qty"] for r in expired), "value": sum(r["value"] for r in expired)},
        "within_30": {"batches": len(within(30)), "value": sum(r["value"] for r in within(30))},
        "within_60": {"batches": len(within(EXPIRY_SOON)), "value": sum(r["value"] for r in within(EXPIRY_SOON))},
        "within_90": {"batches": len(live), "value": sum(r["value"] for r in live)},
        "at_risk": {"batches": len(at_risk), "units": sum(r["projected_unsold"] for r in at_risk),
                    "value": sum(r["unsold_value"] for r in at_risk)},
        "items": shown, "method": method + " Value at unit cost.",
    }


def _season(day: date) -> dict:
    from backend.routers.alerts import season_start
    cur = season_today(day)
    nxt = next_season(cur)
    start = season_start(nxt, day)
    first = C.SEASONS[cur][0]
    cur_start = date(day.year if first <= day.month else day.year - 1, first, 1)
    rising = season_movers(nxt, 4)["rising"]
    cur_rising = season_movers(cur, 3)["rising"]
    fest = []
    for name, wins in C.FESTIVALS.items():
        for a, b in wins:
            da, db_ = date.fromisoformat(a), date.fromisoformat(b)
            if db_ >= day and (da - day).days <= 45:
                fest.append({"name": name, "start": a, "end": b, "days_to": max(0, (da - day).days)})
    meta = S.meta.get("seasons", {})
    return {
        "current": cur, "next": nxt, "next_start": start.isoformat(), "days_to_next": (start - day).days,
        "day_of_season": (day - cur_start).days + 1, "just_started": (day - cur_start).days < 14,
        "current_drivers": (meta.get(cur) or C.SEASON_META.get(cur, {})).get("drivers") if isinstance(meta.get(cur) or C.SEASON_META.get(cur), dict) else None,
        "next_drivers": C.SEASON_META.get(nxt, {}).get("drivers"),
        "next_rising": [{"medicine_id": r["medicine_id"], "medicine_name": r["medicine_name"], "uplift": r["uplift"],
                         "category": r["category"]} for r in rising],
        "current_rising": [{"medicine_id": r["medicine_id"], "medicine_name": r["medicine_name"], "uplift": r["uplift"],
                            "category": r["category"]} for r in cur_rising],
        "festivals": sorted(fest, key=lambda f: f["days_to"]),
    }


def _alerts_section(day: date, store: dict) -> dict:
    alerts, complete = _alerts(day, store["id"])
    counts = {s: 0 for s in ("critical", "serious", "warning", "info")}
    for a in alerts:
        counts[a["severity"]] = counts.get(a["severity"], 0) + 1
    top = [{k: a.get(k) for k in ("id", "type", "type_label", "severity", "title", "action", "impact_inr", "href",
                                  "medicine_id", "medicine_name")} for a in alerts[:ALERT_LIMIT]]
    return {"counts": counts, "total": len(alerts), "top": top, "complete": complete,
            "note": ("Forecast-based alerts use the main shop's sales history (the same for every branch); live-stock alerts use this store's ledger."
                     + ("" if complete else " Expiry-risk alerts are still loading and are not included yet."))}


# ── focus of the day ─────────────────────────────────────────────────────────

FOCUS_RULES = (
    "expired_on_shelf: expired units are still on the shelf (safety first)",
    "a_out_of_stock: A-class medicines with demand are out of stock",
    "critical_alert: the Alert Center has a critical alert",
    "order_before_delivery: items run out before a new delivery can arrive",
    "outbreak: a high-risk outbreak signal is active",
    "expiring_unsold: batches within 30 days are projected to remain unsold",
    "season_switch: the next season starts within 21 days, or the current one began this fortnight",
    "steady: none of the above",
)


def _focus(store, head, orders, exp, alerts, season, signals) -> dict:
    inr = lambda v: "₹" + f"{v:,.0f}"
    if exp["expired"]["batches"] > 0:
        e = exp["expired"]
        return {"rule": "expired_on_shelf", "tone": "critical",
                "title": f"Pull {e['qty']} expired units ({e['batches']} batch{'es' if e['batches'] != 1 else ''}) off the shelf",
                "detail": f"They must not be dispensed. Quarantine them and record the write-off ({inr(e['value'])} at cost).",
                "href": "/brief#expiring"}
    n_a_out = int(orders.get("a_out") or 0)
    a_out_all = orders["tiers"]["out"]
    if n_a_out:
        names = ", ".join((orders.get("a_out_names") or [])[:2])
        return {"rule": "a_out_of_stock", "tone": "critical",
                "title": f"Reorder {n_a_out} top-selling (class A) medicine{'s' if n_a_out != 1 else ''} that {'are' if n_a_out != 1 else 'is'} out of stock",
                "detail": f"{names}{' and more' if n_a_out > 2 else ''}. {a_out_all} item{'s' if a_out_all != 1 else ''} with forecast demand {'have' if a_out_all != 1 else 'has'} no sellable stock.",
                "href": "/brief#order"}
    crit = [a for a in alerts["top"] if a["severity"] == "critical"]
    if crit:
        return {"rule": "critical_alert", "tone": "critical", "title": crit[0]["title"],
                "detail": crit[0].get("action") or "", "href": crit[0].get("href") or "/alerts"}
    soon = orders["tiers"]["out"] + orders["tiers"]["before_delivery"]
    if soon:
        return {"rule": "order_before_delivery", "tone": "serious",
                "title": f"Place today's order: {soon} item{'s' if soon != 1 else ''} run out before a delivery can arrive",
                "detail": f"{orders['count']} items in all are below their order-up-to level ({inr(orders['value'])} at cost).",
                "href": "/brief#order"}
    if signals.get("high_risk") and signals.get("outbreaks"):
        return {"rule": "outbreak", "tone": "serious", "title": f"Outbreak watch: {signals['outbreaks'][0]}",
                "detail": "Check stock of the related medicines; signals may be simulated or delayed.", "href": "/brief#signals"}
    if exp["within_30"]["batches"] and any(r["projected_unsold"] > 0 and r["days_left"] <= 30 for r in exp["items"]):
        r = next(r for r in exp["items"] if r["projected_unsold"] > 0 and r["days_left"] <= 30)
        return {"rule": "expiring_unsold", "tone": "warning",
                "title": f"Move short-dated stock: {r['medicine_name']} expires in {r['days_left']} days",
                "detail": f"About {r['projected_unsold']} units are unlikely to sell in time. Consider a supplier return or a transfer.",
                "href": "/brief#expiring"}
    if season["days_to_next"] <= 21 or season["just_started"]:
        if season["days_to_next"] <= 21:
            title = f"{season['next']} starts in {season['days_to_next']} days: stock up on rising lines"
        else:
            title = f"{season['current']} has begun: watch the lines that rise this season"
        lines = season["next_rising"] if season["days_to_next"] <= 21 else season["current_rising"]
        return {"rule": "season_switch", "tone": "info", "title": title,
                "detail": ", ".join(r["medicine_name"] for r in lines[:3]) or "See the season planner.", "href": "/seasons"}
    return {"rule": "steady", "tone": "good", "title": "Steady day: shelves are in good shape",
            "detail": f"Review the {orders['count']} suggested order lines and serve customers.", "href": "/brief#order"}


# ── compose ──────────────────────────────────────────────────────────────────

def compose_brief(store_id: str, day: date | None = None) -> dict:
    day = day or date.today()
    store = _store_info(store_id)
    k, in_horizon = _fweek_index(day)
    sig_fut = _pool.submit(_signals, store_id, day)
    pos = inv.stock_position(store_id, as_of=day)
    head = _headline(store, day, k, in_horizon)
    orders = _order_today(store, day, k, pos)
    exp = _expiring(store, day, k)
    alerts = _alerts_section(day, store)
    season = _season(day)
    try:
        signals = sig_fut.result(timeout=SIGNALS_TIMEOUT_S + 0.2)
    except Exception:  # noqa: BLE001
        signals = {"available": False, "weather": None, "outbreaks": [], "note": "Weather and outbreak signals timed out."}
    has_rate = pos["weekly_rate"] > 0
    stock = {"value": float(pos["value"].fillna(0).sum()), "in_stock": int((pos["qty"] > 0).sum()),
             "out_with_demand": int(((pos["qty"] <= 0) & has_rate & (pos["weekly_rate"] >= SLOW_MOVER_RATE)).sum()),
             "medicines": int(len(pos))}
    focus = _focus(store, head, orders, exp, alerts, season, signals)
    notes = []
    if store["simulated"]:
        notes.append(f"Simulated branch: demand is the main shop's forecast x {store['demand_scale']:.2f}. Only the main shop has real sales history.")
    notes.append("Sales history in the workbook is synthetic (see its Read Me); forecasts are model estimates with 90% ranges.")
    if not in_horizon:
        notes.append("Today is outside the 12-week forecast horizon; numbers use the nearest forecast week. Retrain the model.")
    notes.append("Expected ranges sum medicine-level uncertainty as independent, so the real store-level range is somewhat wider.")
    return clean({
        "store": store, "date": day.isoformat(), "weekday": day.strftime("%A"),
        "generated_at": db.now_iso(), "greeting": f"Good morning, {store['name']}",
        "data_window": {"history_end": S.weeks[-1], "forecast_start": S.fweeks[0], "forecast_end": S.fweeks[-1],
                        "forecast_week": S.fweeks[k], "in_horizon": in_horizon, "model_generated_at": S.meta.get("generated_at")},
        "focus": focus, "focus_rules": list(FOCUS_RULES), "headline": head, "stock": stock,
        "order_today": orders, "expiring": exp, "alerts": alerts, "season": season, "signals": signals, "notes": notes,
    })


# ── renderers ────────────────────────────────────────────────────────────────

def _inr(v) -> str:
    v = _f(v)
    if abs(v) >= 1e7:
        return f"₹{v / 1e7:.1f} cr"
    if abs(v) >= 1e5:
        return f"₹{v / 1e5:.1f} L"
    return f"₹{v:,.0f}"


def _n(v) -> str:
    return f"{_f(v):,.0f}"


def _date_long(iso: str) -> str:
    d = date.fromisoformat(iso)
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b %Y')}"


def _cover(w) -> str:
    if w is None or not math.isfinite(_f(w, math.inf)):
        return "no demand"
    w = _f(w)
    return "out of stock" if w <= 0 else f"{w * 7:.0f} days left"


def _vs_ly(change: float) -> str:
    if abs(change) < 0.005:
        return "about the same as the same week last year"
    return f"{'+' if change > 0 else '−'}{abs(change) * 100:.0f}% vs same week last year"


def summary_line(b: dict) -> str:
    """One line (no newlines) for WhatsApp templates and email previews."""
    o = b["order_today"]
    return (f"{b['store']['name']} {_date_long(b['date'])}: {b['focus']['title']}. "
            f"Order today: {o['count']} items ({_inr(o['value'])}). "
            f"Expected today ~{_n(b['headline']['expected_today']['units'])} units. "
            f"Alerts: {b['alerts']['counts'].get('critical', 0)} critical.")


def render_text(b: dict, limit: int = WA_MAX_CHARS) -> str:
    """Plain text for WhatsApp: *bold* only, no tables, <= `limit` characters (lists shrink to fit)."""
    h, o, e, a, s, sig = b["headline"], b["order_today"], b["expiring"], b["alerts"], b["season"], b["signals"]
    et = h["expected_today"]

    def build(n_order: int, n_exp: int, n_alert: int, extras: bool) -> str:
        L = [f"*Good morning, {b['store']['name']}*", f"{_date_long(b['date'])} · {s['current']}"]
        if b["store"]["simulated"]:
            L.append(f"_Simulated branch: main-shop forecast x {b['store']['demand_scale']:.2f}_")
        L += ["", f"*Focus:* {b['focus']['title']}"]
        if extras and b["focus"].get("detail"):
            L.append(b["focus"]["detail"])
        L += ["", "*Today*",
              f"• Expected demand ~{_n(et['units'])} units ({_n(et['lo'])}–{_n(et['hi'])}, 90%), ~{_inr(et['value'])}"]
        ly = h.get("same_week_last_year")
        if extras and ly and ly.get("change") is not None:
            L.append(f"• This week {_n(h['expected_week']['units'])} units, {_vs_ly(ly['change'])}")
        yr = h["yesterday_recorded"]
        L.append(f"• Yesterday in the app: {_n(yr['units'])} units sold" if yr["lines"] else "• No sales recorded in the app yesterday")
        L += ["", f"*Order today* ({o['count']} items, {_inr(o['value'])} at cost)"]
        for i, it in enumerate(o["items"][:n_order], 1):
            L.append(f"{i}. {it['medicine_name']} — {it['suggested']} ({_cover(it['weeks_cover'])})")
        if o["count"] > n_order:
            L.append(f"…and {o['count'] - n_order} more")
        if o["count"] == 0:
            L.append("Nothing urgent.")
        L += ["", "*Expiry*"]
        if e["expired"]["batches"]:
            L.append(f"• {e['expired']['batches']} expired batches on shelf ({e['expired']['qty']} units): remove today")
        L.append(f"• {e['within_60']['batches']} batches expire within 60 days; next 90 days: {e['at_risk']['units']} units likely unsold ({_inr(e['at_risk']['value'])})")
        for it in e["items"][:n_exp]:
            L.append(f"  - {it['medicine_name']} {it['batch_no']}: {it['days_left']}d, {it['projected_unsold']} of {it['qty']} unsold")
        c = a["counts"]
        L += ["", f"*Alerts:* {c.get('critical', 0)} critical, {c.get('serious', 0)} serious, {c.get('warning', 0)} warning"]
        for al in a["top"][:n_alert]:
            L.append(f"• {al['title']}")
        L += ["", f"*Season:* {s['next']} in {s['days_to_next']} days"
              + (f"; rising: {', '.join(r['medicine_name'] for r in s['next_rising'][:2])}" if extras and s["next_rising"] else "")]
        if sig.get("available"):
            parts = [p for p in [sig.get("weather"), *(sig.get("outbreaks") or [])[:2]] if p] or [sig.get("headline")]
            parts = [p for p in parts if p]
            if parts:
                L.append("*Weather/outbreaks:* " + "; ".join(parts) + (" (stale data)" if sig.get("stale") else ""))
        L += ["", "— MedForecast AI (forecasts are estimates; Rx changes need a pharmacist)"]
        return "\n".join(L)

    for args in ((5, 3, 2, True), (4, 2, 2, True), (3, 1, 1, True), (3, 0, 1, False), (2, 0, 0, False), (1, 0, 0, False), (0, 0, 0, False)):
        t = build(*args)
        if len(t) <= limit:
            return t
    return t[: limit - 1] + "…"


def _esc(v) -> str:
    return _html.escape(str(v if v is not None else ""), quote=True)


def render_html(b: dict, app_url: str | None = None) -> str:
    """Email HTML: table layout, inline styles only (Gmail strips <style>), 600 px, premium light look."""
    INK, INK2, INK3, LINE, PAGE, BRAND, WASH = "#0b0b0b", "#3d3c39", "#6b6a65", "#e9e8e2", "#f6f5f1", "#0e5c4f", "#e7f1ee"
    TONE = {"critical": ("#d03b3b", "#fbeaea", "Act now"), "serious": ("#b4532a", "#fdf0ea", "Today"),
            "warning": ("#8a5a00", "#fef6e3", "This week"), "info": (BRAND, WASH, "Plan"), "good": ("#006300", "#e8f5e8", "All good")}
    font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
    h, o, e, a, s, sig, f = b["headline"], b["order_today"], b["expiring"], b["alerts"], b["season"], b["signals"], b["focus"]
    tc, tw, tl = TONE.get(f["tone"], TONE["info"])
    et = h["expected_today"]
    link = (app_url or "").rstrip("/")

    def card(inner: str, pad: str = "20px 24px") -> str:
        return (f'<tr><td style="padding:0 0 14px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
                f'style="background:#ffffff;border:1px solid {LINE};border-radius:16px;"><tr><td style="padding:{pad};{font}">'
                f'{inner}</td></tr></table></td></tr>')

    def h2(t: str, sub: str = "") -> str:
        return (f'<div style="font-size:15px;font-weight:600;color:{INK};margin:0 0 2px 0;">{_esc(t)}</div>'
                + (f'<div style="font-size:12px;color:{INK3};margin:0 0 12px 0;">{_esc(sub)}</div>' if sub else '<div style="height:10px"></div>'))

    def kpi(label: str, value: str, sub: str) -> str:
        return (f'<td valign="top" width="33%" style="padding:14px 12px;border:1px solid {LINE};border-radius:12px;background:#fbfaf7;{font}">'
                f'<div style="font-size:11px;color:{INK3};text-transform:uppercase;letter-spacing:.06em;">{_esc(label)}</div>'
                f'<div style="font-size:22px;font-weight:600;color:{INK};margin-top:6px;">{_esc(value)}</div>'
                f'<div style="font-size:11px;color:{INK3};margin-top:4px;">{_esc(sub)}</div></td>')

    ly = h.get("same_week_last_year") or {}
    ly_sub = (_vs_ly(ly["change"])
              if ly.get("change") is not None else f"week of {_date_long(h['expected_week']['week'])}")
    yr = h["yesterday_recorded"]
    kpis = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>'
            + kpi("Expected today", f"{_n(et['units'])} units", f"90% range {_n(et['lo'])}–{_n(et['hi'])} · ~{_inr(et['value'])}")
            + kpi("This week", f"{_n(h['expected_week']['units'])} units", ly_sub)
            + kpi("Yesterday (in app)", f"{_n(yr['units'])} units" if yr["lines"] else "No sales", f"{yr['lines']} sale lines recorded")
            + "</tr></table>")

    th = f'style="text-align:left;font-size:11px;color:{INK3};font-weight:600;padding:6px 8px;border-bottom:1px solid {LINE};text-transform:uppercase;letter-spacing:.05em;"'
    td = f'style="font-size:13px;color:{INK2};padding:8px;border-bottom:1px solid {LINE};"'
    tdr = f'style="font-size:13px;color:{INK};padding:8px;border-bottom:1px solid {LINE};text-align:right;white-space:nowrap;"'
    TIER = {"out": "Out of stock", "before_delivery": "Runs out before delivery", "before_review": "Below reorder level"}
    if o["items"]:
        rows = "".join(
            f'<tr><td {td}><b style="color:{INK};font-weight:600;">{_esc(i["medicine_name"])}</b>'
            f'<div style="font-size:11px;color:{INK3};">{_esc(TIER.get(i["tier"], ""))} · class {_esc(i["abc"])}</div></td>'
            f'<td {tdr}>{_n(i["on_hand"])}</td><td {tdr}>{_esc(_cover(i["weeks_cover"]))}</td>'
            f'<td {tdr}><b>{_n(i["suggested"])}</b></td><td {tdr}>{_esc(_inr(i["order_value"]))}</td></tr>'
            for i in o["items"][:10])
        order_tbl = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th {th}>Medicine</th>'
                     f'<th {th} align="right">On hand</th><th {th} align="right">Cover</th><th {th} align="right">Order</th>'
                     f'<th {th} align="right">Cost</th></tr>{rows}</table>'
                     + (f'<div style="font-size:12px;color:{INK3};margin-top:8px;">…and {o["count"] - 10} more in the app.</div>' if o["count"] > 10 else ""))
    else:
        order_tbl = f'<div style="font-size:13px;color:{INK2};">Nothing needs ordering today.</div>'

    exp_rows = "".join(
        f'<tr><td {td}><b style="color:{INK};font-weight:600;">{_esc(i["medicine_name"])}</b>'
        f'<div style="font-size:11px;color:{INK3};">Batch {_esc(i["batch_no"])} · expires {_esc(_date_long(i["expiry_date"]))}</div></td>'
        f'<td {tdr}>{i["days_left"]} d</td><td {tdr}>{_n(i["qty"])}</td><td {tdr}><b>{_n(i["projected_unsold"])}</b></td></tr>'
        for i in e["items"][:6])
    exp_html = ((f'<div style="background:#fbeaea;color:#a8302f;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:10px;">'
                 f'<b>&#9888; Expired on shelf:</b> {e["expired"]["batches"]} batches, {e["expired"]["qty"]} units. Remove and write off.</div>'
                 if e["expired"]["batches"] else "")
                + (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><th {th}>Batch</th>'
                   f'<th {th} align="right">Left</th><th {th} align="right">Units</th><th {th} align="right">Likely unsold</th></tr>{exp_rows}</table>'
                   if exp_rows else f'<div style="font-size:13px;color:{INK2};">No batches expiring within 60 days.</div>'))

    SEVC = {"critical": "#d03b3b", "serious": "#b4532a", "warning": "#8a5a00", "info": INK3}
    al_html = "".join(
        f'<div style="padding:8px 0;border-bottom:1px solid {LINE};font-size:13px;color:{INK2};">'
        f'<span style="font-size:11px;font-weight:600;color:{SEVC.get(x["severity"], INK3)};text-transform:uppercase;letter-spacing:.05em;">{_esc(x["severity"])}</span>'
        f' · {_esc(x["type_label"])}<div style="color:{INK};font-weight:600;margin-top:2px;">{_esc(x["title"])}</div>'
        f'<div style="font-size:12px;color:{INK3};">{_esc(x.get("action") or "")}</div></div>' for x in a["top"]) \
        or f'<div style="font-size:13px;color:{INK2};">No alerts.</div>'
    c = a["counts"]

    sig_html = ""
    parts = [p for p in [sig.get("weather"), *(sig.get("outbreaks") or [])] if p] or [sig.get("headline")]
    parts = [p for p in parts if p] + ([sig["note"]] if sig.get("note") else [])
    if sig.get("available") and parts:
        sig_html = f'<div style="font-size:13px;color:{INK2};margin-top:8px;"><b style="color:{INK};">Weather &amp; outbreaks:</b> {_esc("; ".join(parts))}</div>'
    season_html = (f'<div style="font-size:13px;color:{INK2};"><b style="color:{INK};">{_esc(s["current"])}</b> now · '
                   f'<b style="color:{INK};">{_esc(s["next"])}</b> starts {_esc(_date_long(s["next_start"]))} ({s["days_to_next"]} days).</div>'
                   + (f'<div style="font-size:12px;color:{INK3};margin-top:4px;">Rising next season: '
                      f'{_esc(", ".join(r["medicine_name"] for r in s["next_rising"][:4]))}</div>' if s["next_rising"] else "")
                   + sig_html)

    sim = (f'<div style="display:inline-block;margin-top:8px;font-size:11px;color:#8a5a00;background:#fef6e3;border-radius:999px;padding:3px 10px;">'
           f'Simulated branch · main-shop forecast &times; {b["store"]["demand_scale"]:.2f}</div>' if b["store"]["simulated"] else "")
    cta = (f'<a href="{_esc(link)}/brief" style="display:inline-block;background:{INK};color:#ffffff;text-decoration:none;'
           f'font-size:13px;font-weight:600;padding:10px 18px;border-radius:12px;">Open the brief</a>' if link else "")
    notes = "".join(f'<div style="margin-top:4px;">{_esc(n)}</div>' for n in b["notes"])

    body = (
        card(f'<div style="font-size:11px;color:{INK3};text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Morning brief · {_esc(_date_long(b["date"]))}</div>'
             f'<div style="font-size:26px;font-weight:600;color:{INK};letter-spacing:-.02em;margin-top:6px;">{_esc(b["greeting"])}</div>'
             f'<div style="font-size:13px;color:{INK3};margin-top:4px;">{_esc(b["store"].get("city") or "")} · {_esc(s["current"])} season</div>{sim}', "24px")
        + card(f'<div style="border-left:4px solid {tc};padding-left:14px;">'
               f'<div style="font-size:11px;font-weight:600;color:{tc};text-transform:uppercase;letter-spacing:.06em;">Focus of the day · {_esc(tl)}</div>'
               f'<div style="font-size:18px;font-weight:600;color:{INK};margin-top:4px;">{_esc(f["title"])}</div>'
               f'<div style="font-size:13px;color:{INK2};margin-top:4px;">{_esc(f.get("detail") or "")}</div></div>')
        + f'<tr><td style="padding:0 0 14px 0;">{kpis}</td></tr>'
        + card(h2("Order today", f"{o['count']} items · {_inr(o['value'])} at cost · lead {LEAD_WEEKS} wk, review {REVIEW_WEEKS} wk, {SERVICE:.0%} service") + order_tbl)
        + card(h2("Expiring soon", f"{e['within_60']['batches']} batches within 60 days · next 90 days: {e['at_risk']['units']} units likely unsold ({_inr(e['at_risk']['value'])} at cost)") + exp_html)
        + card(h2("Alerts", f"{c.get('critical', 0)} critical · {c.get('serious', 0)} serious · {c.get('warning', 0)} warning") + al_html)
        + card(h2("Season & signals") + season_html)
        + (f'<tr><td align="center" style="padding:4px 0 14px 0;">{cta}</td></tr>' if cta else "")
        + f'<tr><td style="padding:4px 8px 24px 8px;font-size:11px;line-height:1.5;color:{INK3};{font}">{notes}'
          f'<div style="margin-top:4px;">Forecasts are estimates. Any substitution or change to a prescription medicine needs pharmacist / prescriber confirmation.</div>'
          f'<div style="margin-top:8px;">Sent by MedForecast AI.</div></td></tr>'
    )
    preheader = _esc(summary_line(b))
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Morning brief · {_esc(b["store"]["name"])}</title></head>'
            f'<body style="margin:0;padding:0;background:{PAGE};">'
            f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{preheader}</div>'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAGE};"><tr><td align="center" style="padding:24px 12px;">'
            f'<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">{body}</table>'
            f'</td></tr></table></body></html>')


def subject_line(b: dict) -> str:
    return f"Morning brief · {b['store']['name']} · {_date_long(b['date'])}: {b['focus']['title']}"[:180]


# ── delivery + log ───────────────────────────────────────────────────────────

CHANNELS = ("email", "whatsapp")


def _log(store_id: str, day: str, results: list[dict], trigger: str, user_id: int | None) -> list[dict]:
    now = db.now_iso()
    rows = [(store_id, day, r["channel"], (r.get("recipient") or "")[:254], r["status"], (r.get("error") or None),
             trigger, user_id, now) for r in results]
    if rows:
        db.executemany("INSERT INTO briefs(store_id, date, channel, recipient, status, error, trigger, user_id, created_at) "
                       "VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return results


def deliver(brief: dict, channels: list[str], recipients: dict[str, list[str]], *, trigger: str = "manual",
            user_id: int | None = None, app_url: str | None = None) -> list[dict]:
    results: list[dict] = []
    if "email" in channels:
        to = recipients.get("email") or []
        if to:
            results += notify.send_email(to, subject_line(brief), render_text(brief, 10_000), render_html(brief, app_url))
        else:
            results.append({"channel": "email", "recipient": "", "status": "skipped", "error": "No email recipients"})
    if "whatsapp" in channels:
        to = recipients.get("whatsapp") or []
        if to:
            results += notify.send_whatsapp(to, render_text(brief), summary_line(brief))
        else:
            results.append({"channel": "whatsapp", "recipient": "", "status": "skipped", "error": "No WhatsApp recipients"})
    return _log(brief["store"]["id"], brief["date"], results, trigger, user_id)


# ── schedule (settings) ──────────────────────────────────────────────────────

TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DEFAULT_SCHEDULE = {"enabled": False, "time": "07:30", "channels": ["email"], "recipients": {"email": [], "whatsapp": []}}


def _schedules() -> dict:
    raw = db.get_setting(SCHEDULE_KEY, {}) or {}
    return raw if isinstance(raw, dict) else {}


def get_schedule(store_id: str) -> dict:
    s = _schedules().get(store_id) or {}
    out = {**DEFAULT_SCHEDULE, **{k: v for k, v in s.items() if k in DEFAULT_SCHEDULE}}
    out["recipients"] = {"email": list((s.get("recipients") or {}).get("email") or []),
                         "whatsapp": list((s.get("recipients") or {}).get("whatsapp") or [])}
    return out


def _ist_now(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)).astimezone(IST)


def run_due(now: datetime | None = None, app_url: str | None = None) -> list[dict]:
    """Send every scheduled brief that is due. Idempotent: the 'run' row in `briefs` (unique per
    store and IST date) is claimed in a transaction before anything is sent, so restarts or a second
    process never send twice. Returns what was done."""
    ist = _ist_now(now)
    day = ist.date()
    done = []
    for store_id, raw in sorted(_schedules().items()):
        sched = get_schedule(store_id)
        if not sched["enabled"] or not TIME_RE.match(str(sched["time"])):
            continue
        hh, mm = map(int, sched["time"].split(":"))
        due = datetime.combine(day, datetime.min.time(), IST).replace(hour=hh, minute=mm)
        if not (due <= ist <= due + timedelta(hours=CATCH_UP_HOURS)):
            continue
        try:
            inv.get_store(store_id)
        except inv.InventoryError:
            continue
        try:
            with db.tx():
                if db.scalar("SELECT 1 FROM briefs WHERE store_id = ? AND date = ? AND channel = 'run'", (store_id, day.isoformat())):
                    continue
                run_id = db.execute("INSERT INTO briefs(store_id, date, channel, recipient, status, error, trigger, user_id, created_at) "
                                    "VALUES (?, ?, 'run', '', 'claimed', NULL, 'schedule', NULL, ?)",
                                    (store_id, day.isoformat(), db.now_iso())).lastrowid
        except sqlite3.IntegrityError:
            continue   # another process claimed it first
        try:
            brief = compose_brief(store_id, day)
            res = deliver(brief, list(sched["channels"]), sched["recipients"], trigger="schedule", app_url=app_url)
            sent = sum(r["status"] == "sent" for r in res)
            status = "done" if sent else "no_delivery"
            err = None if sent else "; ".join(sorted({r.get("error") or r["status"] for r in res}))[:300] or "No channels"
        except Exception as e:  # noqa: BLE001 - log and keep the scheduler alive
            log.exception("scheduled brief failed for %s", store_id)
            status, err, res = "failed", f"{type(e).__name__}: {e}"[:300], []
        db.execute("UPDATE briefs SET status = ?, error = ? WHERE id = ?", (status, err, run_id))
        done.append({"store_id": store_id, "date": day.isoformat(), "status": status, "results": res})
    return done


_sched_thread: threading.Thread | None = None
_sched_stop = threading.Event()
_sched_state = {"running": False, "last_tick": None, "last_error": None}


def scheduler_enabled() -> bool:
    return os.environ.get("MEDFORECAST_BRIEF_SCHEDULER", "1").strip() != "0"


def _loop():
    _sched_state["running"] = True
    try:
        while not _sched_stop.is_set():
            if scheduler_enabled():
                try:
                    run_due(app_url=os.environ.get("MEDFORECAST_APP_URL"))
                    _sched_state["last_error"] = None
                except Exception as e:  # noqa: BLE001
                    _sched_state["last_error"] = f"{type(e).__name__}: {e}"[:300]
                    log.exception("brief scheduler tick failed")
                _sched_state["last_tick"] = db.now_iso()
            _sched_stop.wait(SCHEDULER_TICK_S)
    finally:
        _sched_state["running"] = False


def start_scheduler() -> bool:
    global _sched_thread
    if not scheduler_enabled():
        return False
    if _sched_thread and _sched_thread.is_alive():
        return True
    _sched_stop.clear()
    _sched_thread = threading.Thread(target=_loop, name="brief-scheduler", daemon=True)
    _sched_thread.start()
    return True


@router.on_event("startup")
def _start_scheduler_on_startup():
    start_scheduler()


@router.on_event("shutdown")
def _stop_scheduler():
    _sched_stop.set()


# ── endpoints ────────────────────────────────────────────────────────────────

def _day(as_of: date | None) -> date:
    today = date.today()
    d = as_of or today
    if abs((d - today).days) > 366:
        raise HTTPException(422, "date must be within a year of today")
    return d


@router.get("/today")
def today(store_id: str = Depends(store_scope),
          as_of: date | None = Query(None, alias="date", description="Override the brief date (YYYY-MM-DD)")):
    return compose_brief(store_id, _day(as_of))


@router.get("/today.txt", response_class=PlainTextResponse)
def today_txt(store_id: str = Depends(store_scope), as_of: date | None = Query(None, alias="date")):
    return PlainTextResponse(render_text(compose_brief(store_id, _day(as_of))), media_type="text/plain; charset=utf-8")


@router.get("/today.html", response_class=HTMLResponse)
def today_html(request: Request, store_id: str = Depends(store_scope), as_of: date | None = Query(None, alias="date")):
    app_url = os.environ.get("MEDFORECAST_APP_URL")
    return HTMLResponse(render_html(compose_brief(store_id, _day(as_of)), app_url),
                        headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:"})


@router.get("/share")
def share(store_id: str = Depends(store_scope), as_of: date | None = Query(None, alias="date")):
    b = compose_brief(store_id, _day(as_of))
    text = render_text(b)
    return {"store_id": store_id, "date": b["date"], "text": text, "chars": len(text), "url": notify.wa_share_link(text)}


@router.get("/channels")
def channels(_: dict = Depends(current_user)):
    return notify.channel_status()


class SendBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    channels: list[Literal["email", "whatsapp"]] = Field(..., min_length=1, max_length=2)
    recipients: list[str] = Field(default_factory=list, max_length=2 * MAX_RECIPIENTS,
                                  description="Email addresses and/or phone numbers. Empty = the store's scheduled recipients.")
    as_of: date | None = Field(None, alias="date", description="Override the brief date (YYYY-MM-DD)")
    model_config = {"populate_by_name": True}

    @field_validator("recipients")
    @classmethod
    def _rcpts(cls, v: list[str]) -> list[str]:
        out = []
        for r in v:
            r = (r or "").strip()
            if not r:
                continue
            if len(r) > 254:
                raise ValueError("recipient too long")
            out.append(r)
        return out


def _split_recipients(rcpts: list[str]) -> tuple[dict[str, list[str]], list[str]]:
    email, wa, bad = [], [], []
    for r in rcpts:
        if "@" in r:
            (email.append(notify.normalize_email(r)) if notify.normalize_email(r) else bad.append(r))
        else:
            (wa.append(notify.normalize_phone(r)) if notify.normalize_phone(r) else bad.append(r))
    return {"email": list(dict.fromkeys(email)), "whatsapp": list(dict.fromkeys(wa))}, bad


@router.post("/send")
def send(body: SendBody, user: dict = Depends(current_user)):
    store_id = resolve_store(user, body.store_id)
    if store_id is None:
        raise HTTPException(409, "No stores exist yet")
    chans = list(dict.fromkeys(body.channels))
    if body.recipients:
        rc, bad = _split_recipients(body.recipients)
        if bad:
            raise HTTPException(400, {"message": f"Not a valid email address or phone number: {', '.join(bad[:3])}", "invalid": bad[:10]})
    else:
        rc = get_schedule(store_id)["recipients"]
    for ch in chans:
        if len(rc.get(ch) or []) > MAX_RECIPIENTS:
            raise HTTPException(400, f"At most {MAX_RECIPIENTS} {ch} recipients per send")
    if not any(rc.get(ch) for ch in chans):
        raise HTTPException(400, "No recipients for the selected channels. Add an email address or phone number.")
    since = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    n = db.scalar("SELECT COUNT(*) FROM briefs WHERE store_id = ? AND trigger = 'manual' AND created_at >= ?",
                  (store_id, since), default=0)
    if n >= SEND_LIMIT_PER_HOUR:
        raise HTTPException(429, f"Send limit reached ({SEND_LIMIT_PER_HOUR} attempts per store per hour). Try again later.")
    brief = compose_brief(store_id, _day(body.as_of))
    res = deliver(brief, chans, rc, trigger="manual", user_id=user.get("id"), app_url=os.environ.get("MEDFORECAST_APP_URL"))
    summary = {s: sum(r["status"] == s for r in res) for s in ("sent", "failed", "not_configured", "invalid", "skipped")}
    masked = not body.recipients and not has_perm(user, "settings.edit")
    if masked:
        # Scheduled recipients are owner-managed settings: people who cannot read the schedule see them masked.
        res = [{**r, "recipient": notify.mask(r.get("recipient")), "error": notify.mask_text(r.get("error"))} for r in res]
    return clean({"store_id": store_id, "date": brief["date"], "results": res, "summary": summary,
                  "recipients_masked": masked,
                  "share_url": notify.wa_share_link(render_text(brief)), "channels": notify.channel_status()})


class ScheduleRecipients(BaseModel):
    email: list[str] = Field(default_factory=list, max_length=MAX_RECIPIENTS)
    whatsapp: list[str] = Field(default_factory=list, max_length=MAX_RECIPIENTS)


class ScheduleBody(BaseModel):
    store_id: str = Field(..., min_length=1, max_length=32)
    enabled: bool = False
    time: str = Field("07:30", min_length=5, max_length=5)
    channels: list[Literal["email", "whatsapp"]] = Field(default_factory=lambda: ["email"], max_length=2)
    recipients: ScheduleRecipients = Field(default_factory=ScheduleRecipients)

    @field_validator("time")
    @classmethod
    def _time(cls, v: str) -> str:
        if not TIME_RE.match(v):
            raise ValueError("time must be HH:MM (24-hour, Asia/Kolkata)")
        return v


def _last_runs() -> dict:
    rows = db.query("SELECT store_id, date, status, error, created_at FROM briefs WHERE channel = 'run' "
                    "AND id IN (SELECT MAX(id) FROM briefs WHERE channel = 'run' GROUP BY store_id)")
    return {r["store_id"]: r for r in rows}


def _next_run(sched: dict, now: datetime | None = None) -> str | None:
    if not sched["enabled"]:
        return None
    ist = _ist_now(now)
    hh, mm = map(int, sched["time"].split(":"))
    due = datetime.combine(ist.date(), datetime.min.time(), IST).replace(hour=hh, minute=mm)
    if due < ist:
        due += timedelta(days=1)
    return due.isoformat()


def _schedule_payload() -> dict:
    last = _last_runs()
    stores = []
    for s in inv.store_list():
        sc = get_schedule(s["id"])
        stores.append({"store_id": s["id"], "name": s["name"], "city": s.get("city"), "simulated": bool(s.get("simulated")),
                       **sc, "next_run": _next_run(sc), "last_run": last.get(s["id"])})
    return {"timezone": "Asia/Kolkata", "stores": stores, "channels": notify.channel_status(),
            "scheduler": {"env_enabled": scheduler_enabled(), "running": bool(_sched_thread and _sched_thread.is_alive()),
                          "last_tick": _sched_state["last_tick"], "last_error": _sched_state["last_error"],
                          "tick_seconds": SCHEDULER_TICK_S, "catch_up_hours": CATCH_UP_HOURS}}


@router.get("/schedule")
def schedule_get(_: dict = Depends(require_perm("settings.edit"))):
    return clean(_schedule_payload())


@router.put("/schedule")
def schedule_put(body: ScheduleBody, user: dict = Depends(require_perm("settings.edit"))):
    sid = resolve_store(user, body.store_id)
    rc, bad = _split_recipients(body.recipients.email + body.recipients.whatsapp)
    bad_e = [r for r in body.recipients.email if not notify.normalize_email(r)]
    bad_w = [r for r in body.recipients.whatsapp if not notify.normalize_phone(r)]
    if bad_e or bad_w:
        raise HTTPException(400, {"message": "Invalid recipients: " + ", ".join((bad_e + bad_w)[:3]), "invalid": (bad_e + bad_w)[:10]})
    chans = list(dict.fromkeys(body.channels))
    if body.enabled and not chans:
        raise HTTPException(400, "Choose at least one channel to enable the schedule")
    rec = {"email": list(dict.fromkeys(notify.normalize_email(r) for r in body.recipients.email)),
           "whatsapp": list(dict.fromkeys(notify.normalize_phone(r) for r in body.recipients.whatsapp))}
    if body.enabled and not any(rec[c] for c in chans):
        raise HTTPException(400, "Add at least one recipient for the selected channels to enable the schedule")
    with db.tx():
        all_s = _schedules()
        all_s[sid] = {"enabled": body.enabled, "time": body.time, "channels": chans, "recipients": rec,
                      "updated_at": db.now_iso(), "updated_by": user.get("username")}
        db.set_setting(SCHEDULE_KEY, all_s)
    return clean(_schedule_payload())


@router.get("/history")
def history(user: dict = Depends(current_user),
            store_id: str | None = Query(None, max_length=32, description="Store id, or 'all'"),
            limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=100_000)):
    sid = resolve_store(user, store_id or "all", allow_all=True) if (store_id or not user.get("store_id")) else resolve_store(user, None)
    where, params = ("WHERE b.store_id = ?", [sid]) if sid else ("", [])
    rows = db.query(
        f"SELECT b.id, b.store_id, s.name AS store_name, b.date, b.channel, b.recipient, b.status, b.error, b.trigger, "
        f"b.created_at, u.username FROM briefs b LEFT JOIN stores s ON s.id = b.store_id "
        f"LEFT JOIN users u ON u.id = b.user_id {where} ORDER BY b.id DESC LIMIT ? OFFSET ?", (*params, limit, offset))
    total = db.scalar(f"SELECT COUNT(*) FROM briefs b {where}", params, default=0)
    full = has_perm(user, "settings.edit")
    for r in rows:
        if not full:
            r["recipient"] = notify.mask(r["recipient"])
            r["error"] = notify.mask_text(r["error"])
    return clean({"store_id": sid, "total": total, "limit": limit, "offset": offset, "rows": rows,
                  "recipients_masked": not full})
