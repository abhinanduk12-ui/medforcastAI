"""Multi-store comparison and expiry-aware stock transfers ("Branches").

Endpoints (prefix /api/stores):
  GET  /compare                         branch KPIs, medicine x branch cover matrix, per-category comparison
  GET  /transfers/suggest               expiry-aware rebalancing suggestions (+ network before/after)
  POST /transfers                       execute one transfer                       (transfers.create)
  POST /transfers/apply-suggestions     execute suggestions by id, or all          (transfers.create)
  GET  /transfers                       transfer history
  GET  /transfers/requests              pending / decided transfer requests
  POST /transfers/requests              a pharmacist (or anyone with transfers.request) asks for a move
  POST /transfers/requests/{id}/approve execute a request                          (transfers.create)
  POST /transfers/requests/{id}/reject  reject (approver) or cancel (the requester)

Access (permission matrix): every role may view. Owners and buyers (stores.all) see the whole network.
A pharmacist is limited to their own store's data: /compare returns only their branch, suggestions and
history only those that touch their store (the other branch's stock figures are redacted). Executing a
transfer needs transfers.create (owner, buyer); pharmacists hold transfers.request, so they can file a
request that an owner/buyer approves. Executing, applying suggestions, approving or rejecting also
needs access to BOTH branches, so a buyer an admin restricted to one branch (users.store_id set) is
treated like a pharmacist for scope: they see only their branch and cannot move stock between others.

Honesty: the sales data comes from ONE shop. Branch demand is SIMULATED as the main shop's forecast x
the branch's demand_scale until real branch sales are loaded; every store row carries `simulated`.

Model (all deterministic, expected values - no randomness):
  rate     units/week = mean ensemble forecast of the first 4 forecast weeks x demand_scale
           (same as inventory.stock_position, so cover matches the rest of the app)
  target   order-up-to of plan_rows(lead 1, review 2, service 95 %) x demand_scale (the policy the
           opening stock was seeded from)
  buffer   safety stock x demand_scale: stock above target + buffer counts as donatable excess
  expiry   FEFO sell-through: cumulative forecast demand from today, day by day (each day = 1/7 of its
           forecast week; beyond the 12-week horizon the mean of the last 4 weeks is extrapolated). A batch sells
           min(qty, D(days_left) - units consumed by earlier batches); the rest is projected write-off.
           Only batches expiring within EXPIRY_HORIZON_DAYS are scored (forecasts further out are too weak).
           Moved units lose TRANSIT_DAYS of selling time at the destination.
Greedy, per medicine, in priority order:
  1. stockout   A/B items where a branch holds less than its lead+review demand -> fill to target
  2. expiry     units a branch will not sell before expiry -> the branch that sells them fastest,
                if the net projected write-off (both branches) falls
  3. rebalance  any remaining shortfall below target, filled from excess
  Donors keep >= target, except for units that would expire unsold anyway. Moves below a minimum
  value / quantity are dropped.
"""
from __future__ import annotations

import hashlib
import math
import threading
from datetime import date

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, field_validator

from backend import db
from backend import inventory as inv
from backend.auth import (can_access_store, current_user, has_perm, require_perm, resolve_store)
from backend.core import S, clean, plan_rows, poisson_quantile

router = APIRouter(prefix="/api/stores", tags=["stores"])

LEAD, REVIEW, SERVICE = 1, 2, 0.95
COVER_WEEKS = 4             # forecast weeks behind the weekly rate (as inventory.stock_position)
EXCESS_COVER_WEEKS = 8      # stock beyond 8 weeks of cover is "excess"
NEAR_EXPIRY_DAYS = 90
EXPIRY_HORIZON_DAYS = 180   # only batches expiring within this window are scored for write-off
TRANSIT_DAYS = 2            # selling days lost to moving stock between branches
MIN_VALUE_DEFAULT = 300.0   # ₹ cost value below which a move is not worth the paperwork
MIN_QTY = 2                 # ... or fewer units (a single unit is allowed for stockout prevention)
MATRIX_TOP = 60
MAX_ID = 2**62              # path ids beyond SQLite's INTEGER range would raise OverflowError (500)

# Serialises "plan + execute" so two concurrent Approve-all clicks cannot both act on the same plan
# (each transfer is still checked against stock, but the second batch would over-move).
_APPLY_LOCK = threading.Lock()

db.register_schema("stores", [
    """
    CREATE TABLE IF NOT EXISTS stores_transfer_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_store TEXT NOT NULL REFERENCES stores(id),
        to_store TEXT NOT NULL REFERENCES stores(id),
        medicine_id TEXT NOT NULL,
        qty INTEGER NOT NULL CHECK (qty > 0),
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
        requested_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL,
        decided_by INTEGER REFERENCES users(id),
        decided_at TEXT,
        decision_note TEXT,
        transfer_id INTEGER REFERENCES transfers(id),
        CHECK (from_store <> to_store)
    );
    CREATE INDEX IF NOT EXISTS ix_stores_treq_status ON stores_transfer_requests(status, created_at);
    """,
])


# ---------------------------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------------------------
def _today() -> date:
    return date.today()


def _visible_stores(user: dict) -> list[dict]:
    stores = inv.store_list()
    if user.get("store_id"):
        stores = [s for s in stores if s["id"] == user["store_id"]]
    return stores


def _uid(user: dict):
    return user.get("id")


def _week_offset(today: date) -> int:
    """Index of the forecast week containing today (may exceed the horizon)."""
    return max(0, (today - date.fromisoformat(S.fweeks[0])).days // 7)


def _demand_curves(today: date, horizon_days: int) -> tuple[np.ndarray, list[str]]:
    """Unscaled expected cumulative demand from TODAY, per medicine.

    Returns (curves [n_meds, horizon_days + 2], medicine ids): curves[:, d] = expected units demanded in
    the next d days (d = 0..horizon_days); the last column holds the daily rate used beyond the horizon.
    Each day takes 1/7 of its own forecast week, so the days of the current week that have already
    passed are not counted as future demand. Beyond the 12-week forecast the mean of its last 4 weeks
    is extrapolated. Curves are linear in demand, so scaling by a branch's demand_scale is a multiply."""
    fc = S.fc_wide.reindex(S.meds.index).fillna(0.0).to_numpy(dtype=float)
    tail = fc[:, -4:].mean(1)
    start = (today - date.fromisoformat(S.fweeks[0])).days
    wk = np.clip((start + np.arange(horizon_days)) // 7, 0, None)
    daily = np.where(wk[None, :] < fc.shape[1], fc[:, np.minimum(wk, fc.shape[1] - 1)], tail[:, None]) / 7.0
    cum = np.concatenate([np.zeros((fc.shape[0], 1)), np.cumsum(daily, axis=1)], axis=1)
    return np.concatenate([cum, (tail / 7.0)[:, None]], axis=1), list(S.meds.index)


def _cum_demand(curve: np.ndarray, days: float) -> float:
    """Expected units demanded over the next `days` days (curve from _demand_curves, already scaled)."""
    if days <= 0:
        return 0.0
    h = len(curve) - 2                      # last cumulative index
    if days <= h:
        lo = int(math.floor(days))
        frac = days - lo
        return float(curve[lo] + (curve[min(lo + 1, h)] - curve[lo]) * frac)
    return float(curve[h] + curve[-1] * (days - h))


def _fefo_sold(batches: list[dict], weekly: np.ndarray) -> list[float]:
    """Expected units sold per batch (FEFO, deterministic demand). batches sorted by expiry."""
    consumed, out = 0.0, []
    for b in batches:
        avail = _cum_demand(weekly, b["sell_days"]) - consumed
        sold = min(float(b["qty"]), max(0.0, avail))
        consumed += sold
        out.append(sold)
    return out


def _waste(batches: list[dict], weekly: np.ndarray) -> tuple[float, float]:
    """(units, cost value) projected to expire unsold among batches expiring within the horizon."""
    sold = _fefo_sold(batches, weekly)
    u = v = 0.0
    for b, s in zip(batches, sold):
        if b["days_left"] <= EXPIRY_HORIZON_DAYS:
            left = b["qty"] - s
            u += left
            v += left * b["unit_cost"]
    return u, v


def _targets() -> dict[str, dict]:
    """Unscaled plan for every medicine: {medicine_id: {order_up_to, safety_stock, cover_demand, policy}}.
    A plain dict: per-row DataFrame.loc lookups dominated the request time."""
    return plan_rows(LEAD, REVIEW, SERVICE, S.meds)[["order_up_to", "safety_stock", "cover_demand", "policy"]].to_dict("index")


def _scaled_target(plan_row, scale: float) -> tuple[int, float, float]:
    """(order-up-to, safety buffer, lead+review demand) for one medicine at one store."""
    cover_demand = float(plan_row["cover_demand"] or 0.0) * scale
    if plan_row["policy"] == "On demand":
        tgt = poisson_quantile(cover_demand, SERVICE)
        buf = max(0.0, tgt - cover_demand)
    else:
        # scale the unrounded level (cover demand + safety stock), then round once: ceil(ceil(x) * s)
        # would inflate small branches' targets by up to one unit
        buf = float(plan_row["safety_stock"] or 0.0) * scale
        tgt = int(math.ceil(cover_demand + buf - 1e-9))
    return int(tgt), buf, cover_demand


def _load_batches(today: date) -> dict[tuple[str, str], list[dict]]:
    """Sellable batches (qty > 0, not expired) per (store, medicine), FEFO order."""
    rows = db.query("SELECT id, store_id, medicine_id, batch_no, expiry_date, qty_on_hand, unit_cost FROM batches "
                    "WHERE qty_on_hand > 0 AND expiry_date > ? ORDER BY store_id, medicine_id, expiry_date, id",
                    (today.isoformat(),))
    out: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        dl = (date.fromisoformat(r["expiry_date"]) - today).days
        out.setdefault((r["store_id"], r["medicine_id"]), []).append({
            "batch_id": r["id"], "batch_no": r["batch_no"], "expiry": r["expiry_date"], "days_left": dl,
            "sell_days": dl, "qty": int(r["qty_on_hand"]), "unit_cost": float(r["unit_cost"])})
    return out


# ---------------------------------------------------------------------------------------------
# compare
# ---------------------------------------------------------------------------------------------
@router.get("/compare")
def compare(user: dict = Depends(current_user)):
    """Branch KPIs side by side, a medicine x branch cover matrix and a per-category comparison.
    Pharmacists (single-store users) get their own branch only."""
    today = _today()
    stores = _visible_stores(user)
    if not stores:
        raise HTTPException(409, "No stores exist yet - run `python -m backend.seed`")
    plan = _targets()
    fc_total = S.fc_wide.reindex(S.meds.index).fillna(0.0).sum(0).to_numpy(dtype=float)
    off = _week_offset(today)
    positions: dict[str, pd.DataFrame] = {}
    cards, cat_rows = [], []
    for s in stores:
        sid, scale = s["id"], float(s["demand_scale"])
        pos = inv.stock_position(sid, as_of=today, weeks=COVER_WEEKS)
        ne = inv.near_expiry(sid, days=NEAR_EXPIRY_DAYS, as_of=today)
        pos["near_expiry_value"] = ne.groupby("medicine_id")["value"].sum().reindex(pos.index).fillna(0.0) if len(ne) else 0.0
        pos["target"] = [_scaled_target(plan[m], scale)[0] for m in pos.index]
        unit_val = np.where(pos["qty"] > 0, pos["value"] / pos["qty"].clip(lower=1), pos["median_price"] * inv.COST_FACTOR)
        pos["excess_value"] = (pos["qty"] - EXCESS_COVER_WEEKS * pos["weekly_rate"]).clip(lower=0) * unit_val
        pos["stockout"] = (pos["qty"] == 0) & (pos["weekly_rate"] > 0)
        positions[sid] = pos
        cov = pos.loc[(pos["weekly_rate"] > 0) & np.isfinite(pos["weeks_cover"]), "weeks_cover"]
        demand_units = float(pos["weekly_rate"].sum())
        cards.append({
            **s,
            "stock_value": float(pos["value"].sum()),
            "units": int(pos["qty"].sum()),
            "skus_in_stock": int((pos["qty"] > 0).sum()),
            "skus_total": int(len(pos)),
            "stockouts": int(pos["stockout"].sum()),
            "stockouts_ab": int((pos["stockout"] & pos["abc"].isin(["A", "B"])).sum()),
            "below_target": int((pos["qty"] < pos["target"]).sum()),
            "median_cover_weeks": float(cov.median()) if len(cov) else None,
            "excess_value": float(pos["excess_value"].sum()),
            "near_expiry_value": float(pos["near_expiry_value"].sum()),
            "near_expiry_batches": int(len(ne)),
            "expired_value": float(pos["expired_value"].sum()),
            "forecast_weekly_units": demand_units,
            "forecast_weekly_value": float((pos["weekly_rate"] * pos["median_price"]).sum()),
            "forecast_weeks": list(S.fweeks),
            "forecast_series": [float(v) * scale for v in fc_total],
            "forecast_current_index": min(off, len(S.fweeks) - 1) if off < len(S.fweeks) else None,
        })
        g = pos.groupby("category")
        cat = pd.DataFrame({
            "value": g["value"].sum(), "units": g["qty"].sum(), "stockouts": g["stockout"].sum(),
            "near_expiry_value": g["near_expiry_value"].sum(), "excess_value": g["excess_value"].sum(),
            "weekly_rate": g["weekly_rate"].sum(),
        })
        for c, r in cat.iterrows():
            cat_rows.append({"category": c, "store_id": sid, **{k: float(v) for k, v in r.items()},
                             "weeks_cover": float(r["units"] / r["weekly_rate"]) if r["weekly_rate"] > 0 else None})

    # Medicine x store cover matrix: top medicines by total stock value across the visible stores.
    total_val = sum(p["value"] for p in positions.values())
    top = total_val.sort_values(ascending=False).head(MATRIX_TOP).index
    matrix = []
    pos_rows = {sid: p.loc[top, ["qty", "value", "weekly_rate", "weeks_cover", "target", "near_expiry_value"]].to_dict("index")
                for sid, p in positions.items()}
    for mid in top:
        row = {"medicine_id": mid, "medicine_name": S.meds.at[mid, "medicine_name"],
               "category": S.meds.at[mid, "category"], "abc": S.meds.at[mid, "abc"],
               "total_value": float(total_val[mid]), "cells": []}
        for s in stores:
            p = pos_rows[s["id"]][mid]
            rate = float(p["weekly_rate"])
            row["cells"].append({
                "store_id": s["id"], "qty": int(p["qty"]), "value": float(p["value"]), "weekly_rate": rate,
                "weeks_cover": float(p["weeks_cover"]) if rate > 0 else None,
                "target": int(p["target"]),
                "target_cover_weeks": float(p["target"] / rate) if rate > 0 else None,
                "near_expiry_value": float(p["near_expiry_value"]),
            })
        matrix.append(row)

    # Category comparison sorted by total value
    cats = pd.DataFrame(cat_rows)
    categories = []
    if len(cats):
        order = cats.groupby("category")["value"].sum().sort_values(ascending=False).index
        for c in order:
            sub = cats[cats["category"] == c]
            categories.append({"category": c, "total_value": float(sub["value"].sum()),
                               "stores": sub.drop(columns=["category"]).to_dict("records")})

    tot = {k: float(sum(c[k] for c in cards)) for k in
           ("stock_value", "units", "stockouts", "excess_value", "near_expiry_value", "forecast_weekly_units", "expired_value")}
    return clean({
        "as_of": today.isoformat(),
        "scope": "own" if user.get("store_id") else "all",
        "stores": cards,
        # names only (no stock figures): lets single-store users address transfer requests
        "directory": [{k: s[k] for k in ("id", "name", "city", "demand_scale", "is_main", "simulated")} for s in inv.store_list()],
        "totals": tot,
        "matrix": matrix,
        "categories": categories,
        "params": {"cover_weeks": COVER_WEEKS, "excess_cover_weeks": EXCESS_COVER_WEEKS,
                   "near_expiry_days": NEAR_EXPIRY_DAYS, "lead_time": LEAD, "review": REVIEW, "service": SERVICE,
                   "matrix_top": MATRIX_TOP},
        "notes": {
            "simulated": "Only the main store has real sales history. Branch demand = main-store forecast x demand_scale.",
            "value": "Stock values are at cost (median selling price x 0.8, assumed: the data has no purchase prices).",
            "excess": f"Excess value = units beyond {EXCESS_COVER_WEEKS} weeks of forecast cover, at cost.",
            "stockout": "Stockout = no sellable stock while the forecast expects demand.",
        },
    })


# ---------------------------------------------------------------------------------------------
# suggestion engine
# ---------------------------------------------------------------------------------------------
def _take_fefo(batches: list[dict], qty: int) -> tuple[list[dict], list[dict]]:
    """Split a FEFO batch list: (moved parts, remaining) for qty units."""
    moved, rest, need = [], [], qty
    for b in batches:
        if need > 0:
            t = min(need, b["qty"])
            moved.append({**b, "qty": t})
            if b["qty"] - t > 0:
                rest.append({**b, "qty": b["qty"] - t})
            need -= t
        else:
            rest.append(dict(b))
    return moved, rest


def _arrive(dest: list[dict], moved: list[dict]) -> list[dict]:
    """Destination batch list after receiving moved parts (selling time reduced by transit)."""
    out = [dict(b) for b in dest]
    for m in moved:
        hit = next((b for b in out if b["batch_no"] == m["batch_no"]), None)
        if hit:
            tot = hit["qty"] + m["qty"]
            hit["unit_cost"] = (hit["unit_cost"] * hit["qty"] + m["unit_cost"] * m["qty"]) / tot
            hit["qty"] = tot
            hit["sell_days"] = min(hit["sell_days"], m["days_left"] - TRANSIT_DAYS)
        else:
            out.append({**m, "sell_days": m["days_left"] - TRANSIT_DAYS})
    out.sort(key=lambda b: (b["expiry"], b["batch_id"]))
    return out


def _qty(bs: list[dict]) -> int:
    return int(sum(b["qty"] for b in bs))


def _sid(kind: str, frm: str, to: str, mid: str, qty: int) -> str:
    return hashlib.sha1(f"{kind}|{frm}|{to}|{mid}|{qty}".encode()).hexdigest()[:12]


def _shortfall(qty: float, lead_demand: float) -> float:
    return max(0.0, lead_demand - qty)


def _plan_suggestions(min_value: float, medicine_id: str | None, today: date) -> dict:
    stores = inv.store_list()
    if len(stores) < 2:
        return {"suggestions": [], "before": None, "after": None, "stores": stores}
    plan = _targets()
    weekly_base, ids = _demand_curves(today, EXPIRY_HORIZON_DAYS + 60)
    row_of = {m: i for i, m in enumerate(ids)}
    rate_base = S.fc_wide.iloc[:, :COVER_WEEKS].mean(1).reindex(S.meds.index).fillna(0.0)
    all_b = _load_batches(today)
    # every batch number ever held per (store, medicine), including empty/expired ones (merge conflicts)
    known_bn: dict[tuple[str, str], dict[str, str]] = {}
    for r in db.query("SELECT store_id, medicine_id, batch_no, expiry_date FROM batches"):
        known_bn.setdefault((r["store_id"], r["medicine_id"]), {})[r["batch_no"]] = r["expiry_date"]
    meds = [medicine_id] if medicine_id else list(S.meds.index)
    names = {s["id"]: s["name"] for s in stores}
    out: list[dict] = []
    tot_before = {"waste_units": 0.0, "waste_value": 0.0, "stockouts": 0, "at_risk": 0, "shortfall_units": 0.0}
    tot_after = dict(tot_before)

    med_rows = S.meds[["medicine_name", "category", "abc", "median_price"]].to_dict("index")
    rate_of = rate_base.to_dict()
    for mid in meds:
        med = med_rows[mid]
        prow = plan[mid]
        abc = med["abc"]
        price = float(med["median_price"])
        base_weekly = weekly_base[row_of[mid]]
        st = {}
        for s in stores:
            sc = float(s["demand_scale"])
            tgt, buf, lead_d = _scaled_target(prow, sc)
            st[s["id"]] = {"bs": [dict(b) for b in all_b.get((s["id"], mid), [])], "weekly": base_weekly * sc,
                           "rate": float(rate_of[mid]) * sc, "target": tgt, "buffer": buf, "lead": lead_d}

        def metrics(state):
            w_u = w_v = 0.0
            so = risk = 0
            short = 0.0
            for v in state.values():
                u, val = _waste(v["bs"], v["weekly"])
                w_u += u
                w_v += val
                q = _qty(v["bs"])
                if q == 0 and v["rate"] > 0:
                    so += 1
                if v["rate"] > 0 and q < v["lead"]:
                    risk += 1
                short += _shortfall(q, v["lead"])
            return {"waste_units": w_u, "waste_value": w_v, "stockouts": so, "at_risk": risk, "shortfall_units": short}

        m0 = metrics(st)
        for k in tot_before:
            tot_before[k] += m0[k]

        def waste_units(sid_):
            return _waste(st[sid_]["bs"], st[sid_]["weekly"])[0]

        def donatable(sid_, buffer=True):
            """Units a donor may give without dropping below target (+ safety buffer for need moves),
            or - if larger - the units projected to expire there unsold anyway."""
            v = st[sid_]
            q = _qty(v["bs"])
            excess = q - v["target"] - (math.ceil(v["buffer"]) if buffer else 0)
            return int(min(q, max(0, excess, int(math.floor(waste_units(sid_) + 1e-9)))))

        def try_move(kind, frm, to, qty):
            """Evaluate a move; returns the suggestion dict (not yet applied) or None."""
            if qty <= 0 or frm == to:
                return None
            src, dst = st[frm], st[to]
            moved, rest = _take_fefo(src["bs"], qty)
            qty = _qty(moved)
            if qty <= 0:
                return None
            # inventory.transfer refuses (409) to merge into a destination batch with the same batch_no
            # but another expiry date, so never suggest such a move
            dst_exp = {**known_bn.get((to, mid), {}), **{b["batch_no"]: b["expiry"] for b in dst["bs"]}}
            if any(dst_exp.get(m["batch_no"], m["expiry"]) != m["expiry"] for m in moved):
                return None
            new_dst = _arrive(dst["bs"], moved)
            wb_s, wb_d = _waste(src["bs"], src["weekly"]), _waste(dst["bs"], dst["weekly"])
            wa_s, wa_d = _waste(rest, src["weekly"]), _waste(new_dst, dst["weekly"])
            saved_u = (wb_s[0] + wb_d[0]) - (wa_s[0] + wa_d[0])
            saved_v = (wb_s[1] + wb_d[1]) - (wa_s[1] + wa_d[1])
            q_s0, q_d0 = _qty(src["bs"]), _qty(dst["bs"])
            short_gain = (_shortfall(q_s0, src["lead"]) + _shortfall(q_d0, dst["lead"])) - \
                         (_shortfall(q_s0 - qty, src["lead"]) + _shortfall(q_d0 + qty, dst["lead"]))
            value = sum(m["qty"] * m["unit_cost"] for m in moved)
            return {"kind": kind, "frm": frm, "to": to, "qty": qty, "moved": moved, "rest": rest, "new_dst": new_dst,
                    "saved_units": saved_u, "saved_value": saved_v, "short_gain": short_gain, "value": value,
                    "q_s0": q_s0, "q_d0": q_d0, "src_waste": wb_s[0], "dst_waste_added": wa_d[0] - wb_d[0]}

        def accept(mv):
            src, dst = st[mv["frm"]], st[mv["to"]]
            soonest = min(mv["moved"], key=lambda b: b["expiry"])
            cov = lambda q, r: (q / r) if r > 0 else None
            sugg = {
                "id": _sid(mv["kind"], mv["frm"], mv["to"], mid, mv["qty"]),
                "kind": mv["kind"],
                "priority": {"stockout": 1, "expiry": 2, "rebalance": 3}[mv["kind"]],
                "medicine_id": mid, "medicine_name": med["medicine_name"], "category": med["category"],
                "abc": abc, "median_price": price,
                "from_store": mv["frm"], "from_name": names[mv["frm"]],
                "to_store": mv["to"], "to_name": names[mv["to"]],
                "qty": mv["qty"], "value": mv["value"],
                "batches": [{"batch_no": b["batch_no"], "expiry_date": b["expiry"], "days_left": b["days_left"], "qty": b["qty"]}
                            for b in mv["moved"]],
                "soonest_expiry": soonest["expiry"], "days_to_expiry": soonest["days_left"],
                "writeoff_saved_units": max(0.0, mv["saved_units"]), "writeoff_saved_value": max(0.0, mv["saved_value"]),
                "shortfall_units_avoided": max(0.0, mv["short_gain"]),
                "revenue_protected": max(0.0, mv["short_gain"]) * price,
                "from": {"qty_before": mv["q_s0"], "qty_after": mv["q_s0"] - mv["qty"], "target": src["target"],
                         "projected_writeoff_units": mv["src_waste"],
                         "weekly_rate": src["rate"], "cover_before": cov(mv["q_s0"], src["rate"]),
                         "cover_after": cov(mv["q_s0"] - mv["qty"], src["rate"])},
                "to": {"qty_before": mv["q_d0"], "qty_after": mv["q_d0"] + mv["qty"], "target": dst["target"],
                       "weekly_rate": dst["rate"], "cover_before": cov(mv["q_d0"], dst["rate"]),
                       "cover_after": cov(mv["q_d0"] + mv["qty"], dst["rate"])},
            }
            sugg["rationale"] = _rationale(sugg)
            out.append(sugg)
            src["bs"], dst["bs"] = mv["rest"], mv["new_dst"]

        def big_enough(mv, allow_single=False):
            if mv is None:
                return False
            if mv["qty"] < (1 if allow_single else MIN_QTY):
                return False
            gain = max(mv["value"], mv["saved_value"], mv["short_gain"] * price)
            return gain >= min_value

        def fill_needs(kind, only_ab_risk):
            needy = sorted((sid_ for sid_ in st if _qty(st[sid_]["bs"]) < st[sid_]["target"]),
                           key=lambda s_: _qty(st[s_]["bs"]) / max(st[s_]["target"], 1))
            for to in needy:
                d = st[to]
                if only_ab_risk and not (abc in ("A", "B") and _qty(d["bs"]) < d["lead"] and d["rate"] > 0):
                    continue
                need = d["target"] - _qty(d["bs"])
                donors = sorted((s_ for s_ in st if s_ != to and donatable(s_) > 0),
                                key=lambda s_: (-donatable(s_), st[s_]["bs"][0]["expiry"] if st[s_]["bs"] else "9999"))
                for frm in donors:
                    if need <= 0:
                        break
                    q = min(need, donatable(frm))
                    mv = try_move(kind, frm, to, q)
                    # never ship units the destination will not sell before they expire
                    if mv is None or mv["dst_waste_added"] > max(0.5, 0.1 * mv["qty"]) or mv["saved_value"] < -1e-6:
                        continue
                    if big_enough(mv, allow_single=(kind == "stockout")):
                        accept(mv)
                        need -= mv["qty"]

        # 1. stockouts of A/B items
        fill_needs("stockout", True)

        # 2. expiry rescue: soonest-expiring units go to the branch that sells them fastest
        for frm in sorted(st, key=lambda s_: st[s_]["bs"][0]["expiry"] if st[s_]["bs"] else "9999"):
            wu = waste_units(frm)
            if wu < 1:
                continue
            # keep the source at/above target unless the units would expire anyway
            cap = donatable(frm, buffer=False)
            # candidate quantities: the projected write-off, half of it, and the soonest wasting batch
            cands = {int(math.ceil(wu)), int(math.ceil(wu / 2))}
            sold = _fefo_sold(st[frm]["bs"], st[frm]["weekly"])
            cum = 0
            for b, s_ in zip(st[frm]["bs"], sold):
                cum += b["qty"]
                if b["qty"] - s_ >= 1 and b["days_left"] <= EXPIRY_HORIZON_DAYS:
                    cands.add(cum)
                    break
            best = None
            for to in sorted((s_ for s_ in st if s_ != frm), key=lambda s_: -st[s_]["rate"]):
                for q in sorted(cands):
                    mv = try_move("expiry", frm, to, min(q, cap))
                    if mv and mv["saved_value"] > 0 and (best is None or mv["saved_value"] > best["saved_value"] + 1e-9):
                        best = mv
            if best and best["saved_units"] >= 1 and best["saved_value"] >= min_value and best["qty"] >= MIN_QTY:
                accept(best)

        # 3. remaining shortfalls below target, filled from excess
        fill_needs("rebalance", False)

        m1 = metrics(st)
        for k in tot_after:
            tot_after[k] += m1[k]

    out.sort(key=lambda s: (s["priority"], -(s["revenue_protected"] + s["writeoff_saved_value"] + 0.1 * s["value"])))
    return {"suggestions": out, "before": tot_before, "after": tot_after, "stores": stores}


def _rationale(s: dict) -> str:
    f, t = s["from"], s["to"]
    cov = lambda v: "no demand" if v is None else f"{v:.1f} wk"
    parts = []
    if s["kind"] == "stockout":
        parts.append(f"{s['to_name']} holds {t['qty_before']} units of an {s['abc']}-class item against a target of {t['target']} "
                     f"(~{t['weekly_rate']:.1f}/wk expected), so it is likely to run out before the next delivery.")
    elif s["kind"] == "expiry":
        why = (f"sells faster (~{t['weekly_rate']:.1f}/wk)" if t["weekly_rate"] > f["weekly_rate"] else
               f"has unmet demand (its own stock covers {t['cover_before']:.1f} wk at ~{t['weekly_rate']:.1f}/wk)"
               if t["cover_before"] is not None else f"expects demand of ~{t['weekly_rate']:.1f}/wk")
        parts.append(f"At {s['from_name']}'s pace (~{f['weekly_rate']:.1f}/wk) about {f['projected_writeoff_units']:.0f} units would expire unsold. "
                     f"{s['to_name']} {why}, so moving them should save about {s['writeoff_saved_units']:.0f} units "
                     f"(~₹{s['writeoff_saved_value']:,.0f} at cost) from write-off.")
    else:
        parts.append(f"{s['to_name']} is below target ({t['qty_before']} of {t['target']}) while {s['from_name']} holds more than it needs.")
    parts.append(f"Soonest batch expires in {s['days_to_expiry']} days. Cover: {s['from_name']} {cov(f['cover_before'])} → {cov(f['cover_after'])}, "
                 f"{s['to_name']} {cov(t['cover_before'])} → {cov(t['cover_after'])}.")
    if f["qty_after"] < f["target"]:
        parts.append(f"{s['from_name']} drops below its target only by units projected to expire there anyway.")
    return " ".join(parts)


def _redact_for(user: dict, sugs: list[dict]) -> list[dict]:
    """Single-store users only see moves touching their store; the other side's stock is hidden."""
    own = user.get("store_id")
    if not own:
        return sugs
    out = []
    for s in sugs:
        if own not in (s["from_store"], s["to_store"]):
            continue
        s = dict(s)
        other = "to" if s["from_store"] == own else "from"
        s[other] = {k: None for k in s[other]}
        s["rationale"] = None
        out.append(s)
    return out


@router.get("/transfers/suggest")
def suggest(min_value: float = Query(MIN_VALUE_DEFAULT, ge=0, le=1_000_000),
            medicine_id: str | None = Query(None, max_length=64),
            user: dict = Depends(current_user)):
    if medicine_id is not None and medicine_id not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine '{medicine_id}'")
    today = _today()
    res = _plan_suggestions(min_value, medicine_id, today)
    sugs = _redact_for(user, res["suggestions"])
    summ = {k: sum(s[k] for s in sugs) for k in ("qty", "value", "writeoff_saved_value", "revenue_protected")}
    summ.update({"count": len(sugs), "by_kind": {k: sum(1 for s in sugs if s["kind"] == k) for k in ("stockout", "expiry", "rebalance")}})
    network = {"before": res["before"], "after": res["after"]} if not user.get("store_id") else None
    return clean({
        "as_of": today.isoformat(), "suggestions": sugs, "summary": summ, "network": network,
        # Applying needs access to BOTH branches of a move. A single-store user only ever sees moves that touch
        # another branch, so they could never apply one: offer "Request" instead of an Approve that always 403s.
        "can_apply": has_perm(user, "transfers.create") and not user.get("store_id"),
        "can_request": has_perm(user, "transfers.request"),
        "params": {"min_value": min_value, "medicine_id": medicine_id, "min_qty": MIN_QTY, "transit_days": TRANSIT_DAYS,
                   "expiry_horizon_days": EXPIRY_HORIZON_DAYS, "lead_time": LEAD, "review": REVIEW, "service": SERVICE},
        "assumptions": [
            "Branch demand is simulated: the main shop's forecast x each branch's demand scale.",
            "Sell-through uses expected (mean) forecast demand with FEFO picking; real sales vary, so treat write-off figures as estimates.",
            f"Moved stock loses {TRANSIT_DAYS} selling days in transit. Only batches expiring within {EXPIRY_HORIZON_DAYS} days are scored for write-off.",
            "Values are at cost (median price x 0.8, assumed). Revenue protected = shortfall units avoided x median price.",
            "A source branch never drops below its target, except by units projected to expire there unsold.",
        ],
    })


# ---------------------------------------------------------------------------------------------
# execute transfers
# ---------------------------------------------------------------------------------------------
class TransferBody(BaseModel):
    from_store: str = Field(min_length=1, max_length=32)
    to_store: str = Field(min_length=1, max_length=32)
    medicine_id: str = Field(min_length=1, max_length=64)
    qty: int = Field(ge=1, le=100_000, strict=True)   # strict: true/"5"/5.0 are rejected, not coerced
    reason: str | None = Field(None, max_length=500)

    @field_validator("from_store", "to_store", "medicine_id")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


def _check_pair(user: dict, frm: str, to: str, medicine_id: str) -> None:
    if frm == to:
        raise HTTPException(400, "Source and destination store must differ")
    if medicine_id not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine '{medicine_id}'")
    resolve_store(user, frm)
    resolve_store(user, to)


def _do_transfer(user: dict, frm: str, to: str, medicine_id: str, qty: int, reason: str | None) -> dict:
    try:
        r = inv.transfer(frm, to, medicine_id, qty, _uid(user), reason=reason)
    except inv.InventoryError as e:
        raise inv.as_http(e)
    r["allocation"] = [a._asdict() for a in r["allocation"]]
    r["medicine_name"] = S.meds.at[medicine_id, "medicine_name"]
    return r


@router.post("/transfers", status_code=201)
def create_transfer(body: TransferBody, user: dict = Depends(require_perm("transfers.create"))):
    _check_pair(user, body.from_store, body.to_store, body.medicine_id)
    return clean(_do_transfer(user, body.from_store, body.to_store, body.medicine_id, body.qty, body.reason))


class ApplyBody(BaseModel):
    ids: list[str] | None = Field(None, max_length=5000)
    all: bool = Field(False, strict=True)
    min_value: float = Field(MIN_VALUE_DEFAULT, ge=0, le=1_000_000)
    medicine_id: str | None = Field(None, max_length=64)

    @field_validator("ids")
    @classmethod
    def _ids(cls, v):
        if v is not None:
            for i in v:
                if not isinstance(i, str) or not (1 <= len(i) <= 32):
                    raise ValueError("each id must be a 1-32 character string")
        return v


@router.post("/transfers/apply-suggestions")
def apply_suggestions(body: ApplyBody, user: dict = Depends(require_perm("transfers.create"))):
    if not body.all and not body.ids:
        raise HTTPException(400, "Pass ids or all=true")
    if body.medicine_id is not None and body.medicine_id not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine '{body.medicine_id}'")
    with _APPLY_LOCK:
        return _apply_locked(body, user)


def _apply_locked(body: "ApplyBody", user: dict) -> dict:
    today = _today()
    res = _plan_suggestions(body.min_value, body.medicine_id, today)
    sugs = res["suggestions"]
    # Executing a transfer needs access to BOTH stores (as POST /transfers and request approval do), so a
    # buyer restricted to one branch cannot move stock between other branches through this endpoint.
    in_scope = lambda s: can_access_store(user, s["from_store"]) and can_access_store(user, s["to_store"])
    failed: list[dict] = []
    if not body.all:
        wanted = list(dict.fromkeys(body.ids or []))
        by_id = {s["id"]: s for s in sugs}
        missing = [i for i in wanted if i not in by_id]
        chosen = [by_id[i] for i in wanted if i in by_id]
        for s in chosen:
            if not in_scope(s):
                failed.append({"id": s["id"], "medicine_id": s["medicine_id"], "status": 403,
                               "error": "This transfer involves a branch you cannot access"})
        chosen = [s for s in chosen if in_scope(s)]
    else:
        missing, chosen = [], [s for s in sugs if in_scope(s)]
    # Execute in engine order per medicine so dependent moves stay consistent.
    order = {s["id"]: k for k, s in enumerate(sugs)}
    chosen.sort(key=lambda s: order[s["id"]])
    applied = []
    for s in chosen:
        reason = f"Suggested ({s['kind']}): {s['from_name']} → {s['to_name']}"
        try:
            r = inv.transfer(s["from_store"], s["to_store"], s["medicine_id"], s["qty"], _uid(user), reason=reason)
            applied.append({"id": s["id"], "ref": r["ref"], "transfer_id": r["transfer_id"], "moved": r["moved"],
                            "medicine_id": s["medicine_id"], "medicine_name": s["medicine_name"],
                            "from_store": s["from_store"], "to_store": s["to_store"]})
        except inv.InventoryError as e:
            failed.append({"id": s["id"], "medicine_id": s["medicine_id"], "error": str(e), "status": e.status})
    return clean({"applied": applied, "failed": failed, "stale_ids": missing,
                  "moved_units": sum(a["moved"] for a in applied),
                  "network_before": res["before"] if not user.get("store_id") else None})


@router.get("/transfers")
def history(store_id: str | None = Query(None, max_length=32), medicine_id: str | None = Query(None, max_length=64),
            limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0, le=1_000_000),
            user: dict = Depends(current_user)):
    sid = resolve_store(user, store_id, allow_all=True) if store_id else (user.get("store_id") or None)
    try:
        rows = inv.transfers(sid, medicine_id, limit=limit, offset=offset)
    except inv.InventoryError as e:
        raise inv.as_http(e)
    cond, params = [], []
    if sid:
        cond.append("(from_store = ? OR to_store = ?)")
        params += [sid, sid]
    if medicine_id:
        cond.append("medicine_id = ?")
        params.append(medicine_id)
    where = (" WHERE " + " AND ".join(cond)) if cond else ""
    total = db.scalar("SELECT COUNT(*) FROM transfers" + where, params, default=0)
    agg = db.query_one("SELECT COALESCE(SUM(qty),0) AS units, COUNT(*) AS n FROM transfers" + where +
                       (" AND " if where else " WHERE ") + "created_at >= ?",
                       params + [(pd.Timestamp(_today()) - pd.Timedelta(days=30)).strftime("%Y-%m-%d")])
    price = S.meds["median_price"]
    for r in rows:
        r["est_value"] = float(r["qty"] * float(price.get(r["medicine_id"], 0.0)) * inv.COST_FACTOR)
    return clean({"transfers": rows, "total": int(total), "store_id": sid, "limit": limit, "offset": offset,
                  "last30": {"count": int(agg["n"]), "units": int(agg["units"])}})


# ---------------------------------------------------------------------------------------------
# transfer requests (pharmacists ask, owners/buyers approve)
# ---------------------------------------------------------------------------------------------
class RequestBody(TransferBody):
    pass


class DecisionBody(BaseModel):
    note: str | None = Field(None, max_length=500)


def _req(rid: int) -> dict:
    r = db.query_one("SELECT * FROM stores_transfer_requests WHERE id = ?", (rid,))
    if not r:
        raise HTTPException(404, "Transfer request not found")
    return r


@router.post("/transfers/requests", status_code=201)
def create_request(body: RequestBody, user: dict = Depends(require_perm("transfers.request"))):
    if body.from_store == body.to_store:
        raise HTTPException(400, "Source and destination store must differ")
    if body.medicine_id not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine '{body.medicine_id}'")
    for s in (body.from_store, body.to_store):
        if not db.query_one("SELECT 1 FROM stores WHERE id = ?", (s,)):
            raise HTTPException(404, f"Unknown store '{s}'")
    if not (can_access_store(user, body.from_store) or can_access_store(user, body.to_store)):
        raise HTTPException(403, "A request must involve your own store")
    dup = db.query_one("SELECT id FROM stores_transfer_requests WHERE status='pending' AND from_store=? AND to_store=? "
                       "AND medicine_id=? AND requested_by IS ?", (body.from_store, body.to_store, body.medicine_id, _uid(user)))
    if dup:
        raise HTTPException(409, f"You already have a pending request #{dup['id']} for this medicine and route")
    rid = db.execute("INSERT INTO stores_transfer_requests(from_store, to_store, medicine_id, qty, reason, status, "
                     "requested_by, created_at) VALUES (?,?,?,?,?,'pending',?,?)",
                     (body.from_store, body.to_store, body.medicine_id, body.qty, body.reason, _uid(user),
                      db.now_iso())).lastrowid
    return clean(_req_out(_req(rid)))


def _req_out(r: dict) -> dict:
    names = {s["id"]: s["name"] for s in inv.store_list()}
    users = {u["id"]: u["username"] for u in db.query("SELECT id, username FROM users")}
    return {**r, "medicine_name": S.meds["medicine_name"].get(r["medicine_id"]),
            "from_name": names.get(r["from_store"]), "to_name": names.get(r["to_store"]),
            "requested_by_username": users.get(r["requested_by"]), "decided_by_username": users.get(r["decided_by"])}


@router.get("/transfers/requests")
def list_requests(status: str | None = Query(None, pattern="^(pending|approved|rejected|cancelled)$"),
                  limit: int = Query(50, ge=1, le=500), user: dict = Depends(current_user)):
    cond, params = [], []
    if status:
        cond.append("status = ?")
        params.append(status)
    own = user.get("store_id")
    if own:
        cond.append("(from_store = ? OR to_store = ?)")
        params += [own, own]
    where = (" WHERE " + " AND ".join(cond)) if cond else ""
    rows = db.query("SELECT * FROM stores_transfer_requests" + where +
                    " ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT ?",
                    params + [limit])
    approver = has_perm(user, "transfers.create")
    out = []
    for r in rows:
        o = _req_out(r)
        # per row: approving/rejecting needs access to both branches (single-store buyers)
        o["can_approve"] = bool(approver and can_access_store(user, r["from_store"]) and can_access_store(user, r["to_store"]))
        out.append(o)
    return clean({"requests": out,
                  "pending": int(db.scalar("SELECT COUNT(*) FROM stores_transfer_requests WHERE status='pending'" +
                                           (" AND (from_store = ? OR to_store = ?)" if own else ""),
                                           [own, own] if own else [], default=0)),
                  "can_approve": has_perm(user, "transfers.create")})


@router.post("/transfers/requests/{rid}/approve")
def approve_request(rid: int = Path(ge=1, le=MAX_ID), body: DecisionBody | None = None, user: dict = Depends(require_perm("transfers.create"))):
    with db.tx():
        r = _req(rid)
        if r["status"] != "pending":
            raise HTTPException(409, f"Request is already {r['status']}")
        _check_pair(user, r["from_store"], r["to_store"], r["medicine_id"])
        res = _do_transfer(user, r["from_store"], r["to_store"], r["medicine_id"], r["qty"],
                           f"Request #{rid}" + (f": {r['reason']}" if r["reason"] else ""))
        db.execute("UPDATE stores_transfer_requests SET status='approved', decided_by=?, decided_at=?, decision_note=?, "
                   "transfer_id=? WHERE id=?", (_uid(user), db.now_iso(), body.note if body else None, res["transfer_id"], rid))
    return clean({"request": _req_out(_req(rid)), "transfer": res})


@router.post("/transfers/requests/{rid}/reject")
def reject_request(rid: int = Path(ge=1, le=MAX_ID), body: DecisionBody | None = None, user: dict = Depends(current_user)):
    with db.tx():
        r = _req(rid)
        if r["status"] != "pending":
            raise HTTPException(409, f"Request is already {r['status']}")
        is_requester = user.get("id") is not None and user.get("id") == r["requested_by"]
        approver = has_perm(user, "transfers.create") and can_access_store(user, r["from_store"])             and can_access_store(user, r["to_store"])
        if not approver and not is_requester:
            raise HTTPException(403, "Only an owner or buyer with access to both branches can reject a request "
                                     "(the requester may cancel it)")
        status = "rejected" if approver and not is_requester else "cancelled"
        db.execute("UPDATE stores_transfer_requests SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?",
                   (status, _uid(user), db.now_iso(), body.note if body else None, rid))
    return clean({"request": _req_out(_req(rid))})
