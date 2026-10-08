"""Slow / dead stock and return-to-vendor (RTV) optimiser ("Slow stock & returns").

Endpoints (prefix /api/deadstock; every read is one store, resolved with auth.resolve_store):
  GET  /summary                      value tied up, value at risk, ageing + expiry buckets, RTV deadlines
  GET  /items?class=&store_id=       store x medicine classification with each item's best batch option
  GET  /batches/{batch_id}/options   all five options for one batch with the explicit ₹ arithmetic
  GET  /assumptions | PUT            default assumptions (PUT: settings.edit, i.e. owner)
  POST /rtv                          create a return-to-vendor note (stock.writeoff)
  GET  /rtv, GET /rtv/{id}           RTV history / one printable note
  POST /markdowns, GET /markdowns, POST /markdowns/{id}/cancel     markdown price notes (purchase.plan)
  POST /transfer                     move at-risk stock to a branch (transfers.create) or, without that
                                     permission, file a transfer request (transfers.request)

Every GET accepts assumption overrides as query parameters (credit_pct, elasticity_otc, elasticity_rx,
transfer_cost) so the UI can explore "what if" without saving anything.

Classification (per store x medicine, sellable stock only; expired stock is reported separately)
  dead     on hand > 0, NO sales in the last DEAD_WEEKS (12) weeks - the sales history (main shop;
           branches are SIMULATED as main x demand_scale, so a zero stays zero) plus any POS/ledger
           sales recorded since - AND the forecast is ~0 (< SLOW_MOVER_RATE = 0.5 units/week).
  slow     not dead, weeks_cover (on hand / forecast weekly rate) > SLOW_WEEKS (26).
  at_risk  not dead/slow, but at least one batch is projected to be left unsold at expiry.
  An item may carry at_risk units in any class; `class` is the most severe one.

FEFO projection (same idea as the stock ledger): a medicine's batches sell earliest expiry first at the
forecast rate. Cumulative demand D(t) uses the weekly forecast from the current week (beyond the 12-week
horizon: mean of its last 4 weeks), x the store's demand_scale. A batch sells
min(qty, D(days_left) - units its earlier batches already took); the rest is "unsold at expiry".

Options per batch - "expected recovery" is the cash expected back from the WHOLE batch from today on
(the purchase cost is already sunk, so every option is compared on the same footing; write-off = ₹0):
  Holding cost h (default 15 %/yr: capital, shelf space, handling - an assumption, editable): a unit that
  sells t weeks from now is worth price x max(0, 1 - h x t/52) today, with t from the FEFO queue at the
  batch's mean forecast rate until expiry (sale_value() integrates this over the units). Without it a
  unit that sells in 3 years would look better than supplier credit today, which is not how cash works.
  hold      value of the units sold before expiry                       (unsold units are written off)
  rtv       returned x unit_cost x credit_pct + value of the units kept and sold. returned = projected
            unsold units + units that would sell later than t* = 52 x (1 - cost x credit / price) / h weeks
            (beyond t* the credit today is worth more than the far-off sale). Eligible only if the supplier
            accepts returns and days_to_expiry >= min_days_before_expiry; deadline = expiry - min_days.
  transfer  hold + value of the moved units sold at the branch - transfer_cost. The branch is the one that
            sells the most unsold units before expiry (its demand after its own earlier-expiring stock of
            the same medicine, minus TRANSIT_DAYS). Units it would not sell stay and are written off.
  markdown  price cut d on the grid 5..50 %: demand x (1 - d)^-e with a constant elasticity e blended
            from OTC (default 2.0) and Rx (default 0.3) by the medicine's prescription share (Rx demand
            is driven by prescriptions, so discounts move it little). Value of the units sold at
            price x (1 - d) (faster sales also cut holding cost); best d. Eligible only if it beats hold.
  writeoff  0.
  best = the option with the highest expected recovery (ties: hold > rtv > transfer > markdown).
Prices are the median selling price in the sales history (treated as the MRP-level price); unit_cost
is the batch's purchase cost. These are planning estimates, not guarantees.

RTV note: ref RTV/<STORE>/<FY>/<seq> (Indian financial year April-March, e.g. 2026-27 -> "26-27", seq per
store per FY). Each line is an inventory.adjust(-qty, reason "RTV <ref> ...") on that batch, all inside one
transaction with the note itself. Permission: stock.writeoff (a supplier return removes stock from the
shelf like a write-off; there is no separate permission). Pharmacists: own store only and at most
PHARMACIST_RTV_LIMIT (10) units per batch line - mirroring their adjustment limit; bigger returns are
raised by an owner or buyer. Expired batches cannot be returned through this flow (write them off).
Supplier credit is EXPECTED credit under the assumed policy until the supplier issues a credit note.

Markdown notes: stored in deadstock_markdowns (one active note per batch). Pricing is a commercial
decision, so it maps to purchase.plan (owner, buyer). POS may call active_markdown(store_id, medicine_id)
to show the note; this module does not change any price by itself. Selling below MRP is permitted; never
above it. Verify GST/claim treatment of returns and write-offs with your CA.
"""
from __future__ import annotations

import math
import threading
import time
from datetime import date, timedelta
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from backend import db
from backend import inventory as inv
from backend.auth import can_access_store, current_user, has_perm, require_perm, resolve_store
from backend.core import S, clean, SLOW_MOVER_RATE

router = APIRouter(prefix="/api/deadstock", tags=["deadstock"])

DEAD_WEEKS = 12
SLOW_WEEKS = 26
TRANSIT_DAYS = 2
PHARMACIST_RTV_LIMIT = 10
MARKDOWN_GRID = [round(0.05 * i, 2) for i in range(1, 11)]  # 5 % .. 50 %
AGE_BUCKETS = [("0–30 d", 0, 30), ("31–60 d", 31, 60), ("61–90 d", 61, 90), ("91–180 d", 91, 180), ("> 180 d", 181, 10**6)]
EXPIRY_BUCKETS = [("Expired", -10**6, 0), ("≤ 30 d", 1, 30), ("31–90 d", 31, 90), ("91–180 d", 91, 180),
                  ("181–365 d", 181, 365), ("> 1 yr", 366, 10**6)]
POLICY_DEFAULT = {"accepts_returns": True, "min_days_before_expiry": 90, "credit_pct": 0.8}
ASSUMPTION_DEFAULTS = {"credit_pct": None, "elasticity_otc": 2.0, "elasticity_rx": 0.3, "transfer_cost": 150.0,
                       "holding_cost_pct": 0.15}
ASSUMPTIONS_KEY = "deadstock.assumptions"
MAX_ID = 2**62

db.register_schema("deadstock", [
    """
    CREATE TABLE IF NOT EXISTS deadstock_rtv (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT NOT NULL UNIQUE,
        store_id TEXT NOT NULL REFERENCES stores(id),
        fy TEXT NOT NULL,
        seq INTEGER NOT NULL,
        supplier_id TEXT,
        status TEXT NOT NULL DEFAULT 'sent',
        note TEXT,
        total_units INTEGER NOT NULL,
        total_cost REAL NOT NULL,
        expected_credit REAL NOT NULL,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(store_id, fy, seq)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS deadstock_rtv_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rtv_id INTEGER NOT NULL REFERENCES deadstock_rtv(id),
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        medicine_id TEXT NOT NULL,
        batch_no TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        qty INTEGER NOT NULL CHECK (qty > 0),
        unit_cost REAL NOT NULL,
        credit_pct REAL NOT NULL,
        expected_credit REAL NOT NULL,
        eligible INTEGER NOT NULL DEFAULT 1
    )
    """,
    "CREATE INDEX IF NOT EXISTS deadstock_rtv_store ON deadstock_rtv(store_id, created_at)",
    """
    CREATE TABLE IF NOT EXISTS deadstock_markdowns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL REFERENCES stores(id),
        medicine_id TEXT NOT NULL,
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        batch_no TEXT NOT NULL,
        discount_pct REAL NOT NULL CHECK (discount_pct > 0 AND discount_pct < 1),
        list_price REAL NOT NULL,
        markdown_price REAL NOT NULL,
        valid_until TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        note TEXT,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        cancelled_by INTEGER,
        cancelled_at TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS deadstock_markdowns_store ON deadstock_markdowns(store_id, status)",
])


# ─────────────────────────────────────────────────────────────────────────────
# assumptions & supplier policy
# ─────────────────────────────────────────────────────────────────────────────
def _uid(user: dict):
    return user.get("id")


def saved_assumptions() -> dict:
    s = db.get_setting(ASSUMPTIONS_KEY, None) or {}
    out = dict(ASSUMPTION_DEFAULTS)
    if isinstance(s, dict):
        out.update({k: s[k] for k in ASSUMPTION_DEFAULTS if k in s})
    return out


def assumptions(credit_pct: float | None = None, elasticity_otc: float | None = None,
                elasticity_rx: float | None = None, transfer_cost: float | None = None,
                holding_cost_pct: float | None = None) -> dict:
    a = saved_assumptions()
    for k, v in (("credit_pct", credit_pct), ("elasticity_otc", elasticity_otc),
                 ("elasticity_rx", elasticity_rx), ("transfer_cost", transfer_cost),
                 ("holding_cost_pct", holding_cost_pct)):
        if v is not None:
            a[k] = float(v)
    return a


class AssumptionQuery:
    def __init__(self, credit_pct: float | None = Query(None, ge=0, le=1, allow_inf_nan=False),
                 elasticity_otc: float | None = Query(None, ge=0, le=6, allow_inf_nan=False),
                 elasticity_rx: float | None = Query(None, ge=0, le=6, allow_inf_nan=False),
                 transfer_cost: float | None = Query(None, ge=0, le=100_000, allow_inf_nan=False),
                 holding_cost_pct: float | None = Query(None, ge=0, le=1, allow_inf_nan=False)):
        self.a = assumptions(credit_pct, elasticity_otc, elasticity_rx, transfer_cost, holding_cost_pct)


def _policy_fn():
    try:
        from backend import suppliers  # built by the suppliers agent; may not exist yet
        return suppliers.return_policy, True
    except Exception:  # ImportError or a broken module: fall back to the documented defaults
        return None, False


def return_policy(supplier_id: str | None) -> dict:
    fn, _ = _policy_fn()
    pol = dict(POLICY_DEFAULT)
    if fn is not None:
        try:
            got = fn(supplier_id)
            if isinstance(got, dict):
                pol.update({k: got[k] for k in POLICY_DEFAULT if k in got})
        except Exception:
            pass
    else:
        s = db.get_setting("suppliers.return_policy", None)
        if isinstance(s, dict):
            pol.update({k: s[k] for k in POLICY_DEFAULT if k in s})
    pol["accepts_returns"] = bool(pol["accepts_returns"])
    pol["min_days_before_expiry"] = int(pol["min_days_before_expiry"])
    pol["credit_pct"] = float(pol["credit_pct"])
    return pol


def _store_row(user: dict, store_id: str | None) -> dict:
    sid = resolve_store(user, store_id)
    try:
        st = inv.get_store(sid)
    except inv.InventoryError as e:
        raise inv.as_http(e)
    return st


def _store_info(st: dict) -> dict:
    return {"id": st["id"], "name": st["name"], "city": st.get("city"), "demand_scale": st["demand_scale"],
            "is_main": bool(st["is_main"]), "simulated": not bool(st["is_main"])}


# ─────────────────────────────────────────────────────────────────────────────
# demand model
# ─────────────────────────────────────────────────────────────────────────────
def _week_offset(today: date) -> int:
    d0 = date.fromisoformat(str(S.fweeks[0])[:10])
    return max(0, (today - d0).days // 7)


def _weekly_matrix(today: date, horizon_weeks: int) -> pd.DataFrame:
    """Main-shop expected units per week from the current week for horizon_weeks (meds x weeks)."""
    fc = S.fc_wide.reindex(S.meds.index).fillna(0.0).clip(lower=0)
    off = _week_offset(today)
    cols = list(range(off, min(off + horizon_weeks, fc.shape[1])))
    tail = fc.iloc[:, -4:].mean(1).to_numpy()
    arr = np.zeros((len(fc), horizon_weeks))
    for j in range(horizon_weeks):
        arr[:, j] = fc.iloc[:, cols[j]].to_numpy() if j < len(cols) else tail
    return pd.DataFrame(arr, index=fc.index)


def _cum(weekly: np.ndarray, days: float) -> float:
    if days <= 0:
        return 0.0
    w = days / 7.0
    full = int(min(math.floor(w), len(weekly)))
    tot = float(weekly[:full].sum())
    if full < len(weekly):
        tot += float(weekly[full]) * (w - full)
    else:
        tot += float(weekly[-1]) * (w - len(weekly))
    return tot


class Model:
    """Everything one request needs, computed once: batches of every store, demand curves, sales."""

    def __init__(self, today: date | None = None):
        self.today = today or date.today()
        self.as_of = self.today.isoformat()
        self.stores = {s["id"]: s for s in inv.store_list()}
        rows = db.query("SELECT * FROM batches WHERE qty_on_hand > 0 ORDER BY store_id, medicine_id, expiry_date, id")
        self.by_key: dict[tuple[str, str], list[dict]] = {}
        max_days = 7
        for b in rows:
            b["days_left"] = (date.fromisoformat(b["expiry_date"]) - self.today).days
            b["expired"] = b["days_left"] <= 0
            try:
                b["age_days"] = max(0, (self.today - date.fromisoformat(str(b["received_at"])[:10])).days)
            except (TypeError, ValueError):
                b["age_days"] = 0
            max_days = max(max_days, b["days_left"])
            self.by_key.setdefault((b["store_id"], b["medicine_id"]), []).append(b)
        self.horizon = int(math.ceil(min(max_days, 3 * 365) / 7)) + 1
        w = _weekly_matrix(self.today, self.horizon)
        self.row = {mid: i for i, mid in enumerate(w.index)}
        self.weekly = w.to_numpy()
        self.scale = {sid: float(s["demand_scale"]) for sid, s in self.stores.items()}
        self._fefo_cache: dict[tuple[str, str, float], list[float]] = {}
        self._policy: dict[str | None, dict] = {}

    def policy(self, supplier_id: str | None) -> dict:
        if supplier_id not in self._policy:
            self._policy[supplier_id] = return_policy(supplier_id)
        return self._policy[supplier_id]

    def weekly_for(self, store_id: str, mid: str, mult: float = 1.0) -> np.ndarray:
        i = self.row.get(mid)
        if i is None:
            return np.zeros(self.horizon)
        return self.weekly[i] * (self.scale[store_id] * mult)

    def sellable(self, store_id: str, mid: str) -> list[dict]:
        return [b for b in self.by_key.get((store_id, mid), []) if not b["expired"]]

    def fefo_sold(self, store_id: str, mid: str, mult: float = 1.0) -> list[float]:
        """Expected units sold before expiry for each sellable batch (FEFO order)."""
        key = (store_id, mid, mult)
        if key not in self._fefo_cache:
            wk = self.weekly_for(store_id, mid, mult)
            used, out = 0.0, []
            for b in self.sellable(store_id, mid):
                cap = _cum(wk, b["days_left"])
                s = max(0.0, min(float(b["qty_on_hand"]), cap - used))
                used += s
                out.append(s)
            self._fefo_cache[key] = out
        return self._fefo_cache[key]


def _recent_sales(store_id: str, today: date) -> pd.Series:
    """Units sold per medicine in the last DEAD_WEEKS weeks: sales history (main shop; branches scaled, so a
    zero stays zero) + POS/ledger sales (negative 'sale' movements) in the same window at this store."""
    hist = S.hist_wide.reindex(S.meds.index).fillna(0.0)
    last_week = date.fromisoformat(str(S.weeks[-1])[:10])
    weeks_since = max(0, (today - last_week).days // 7)
    n_hist = max(0, DEAD_WEEKS - weeks_since)
    h = hist.iloc[:, -n_hist:].sum(1) if n_hist > 0 else pd.Series(0.0, index=hist.index)
    since = (today - timedelta(weeks=DEAD_WEEKS)).isoformat()
    led = db.query("SELECT medicine_id, -SUM(qty) AS u FROM movements WHERE store_id = ? AND kind = 'sale' AND qty < 0 "
                   "AND created_at >= ? GROUP BY medicine_id", (store_id, since))
    ledger = pd.Series({r["medicine_id"]: float(r["u"] or 0) for r in led}, dtype=float).reindex(S.meds.index).fillna(0.0)
    return h + ledger


# ─────────────────────────────────────────────────────────────────────────────
# options per batch
# ─────────────────────────────────────────────────────────────────────────────
def _elasticity(mid: str, a: dict) -> float:
    rx = float(S.meds.at[mid, "rx_share"]) if mid in S.meds.index and pd.notna(S.meds.at[mid, "rx_share"]) else 0.0
    rx = min(max(rx, 0.0), 1.0)
    return a["elasticity_otc"] * (1 - rx) + a["elasticity_rx"] * rx


def _price(mid: str) -> float:
    p = S.meds.at[mid, "median_price"] if mid in S.meds.index else 0.0
    return float(p) if pd.notna(p) else 0.0


def sale_value(price: float, before: float, n: float, rate: float, h: float) -> float:
    """Value today of selling units (before, before+n] of a FEFO queue at `rate` units/week, each unit worth
    price x max(0, 1 - h x t/52) where t = weeks until it sells (h = annual holding cost)."""
    if n <= 0 or price <= 0:
        return 0.0
    if h <= 0:
        return price * n
    if rate <= 0:
        return 0.0
    u0 = 52.0 * rate / h            # units sold after this many have no value left
    lo, hi = before, min(before + n, u0)
    if hi <= lo:
        return 0.0
    return price * ((hi - lo) - h / (52.0 * rate) * (hi * hi - lo * lo) / 2.0)


def batch_options(m: Model, b: dict, a: dict, *, detail: bool = True) -> dict:
    """All options for one batch with explicit arithmetic. b must be a row from m.by_key."""
    sid, mid = b["store_id"], b["medicine_id"]
    qty = int(b["qty_on_hand"])
    price, cost = _price(mid), float(b["unit_cost"] or 0.0)
    days = int(b["days_left"])
    h = float(a["holding_cost_pct"])
    pol = m.policy(b.get("supplier_id"))
    credit = float(a["credit_pct"]) if a.get("credit_pct") is not None else pol["credit_pct"]
    wk = m.weekly_for(sid, mid)
    idx = 0
    if b["expired"]:
        sold, prev, rate = 0.0, 0.0, 0.0
    else:
        idx = [x["id"] for x in m.sellable(sid, mid)].index(b["id"])
        fs = m.fefo_sold(sid, mid)
        sold, prev = fs[idx], float(sum(fs[:idx]))
        rate = _cum(wk, days) / (days / 7.0) if days > 0 else 0.0
    unsold = max(0.0, qty - sold)
    t_mid = (prev + sold / 2) / rate if rate > 0 and sold > 0 else 0.0
    opts: list[dict] = []

    # (d) hold
    hold = sale_value(price, prev, sold, rate, h)
    opts.append({"key": "hold", "label": "Hold & sell normally", "eligible": not b["expired"], "recovery": hold,
                 "units_sold": sold, "units_written_off": unsold, "weeks_to_sell": t_mid,
                 "formula": (f"{sold:.1f} sold × ₹{price:.2f} less {h:.0%}/yr holding cost (~{t_mid:.0f} wk to sell) "
                             f"= ₹{hold:,.0f}; {unsold:.1f} written off at expiry")})

    # (a) return to vendor: the projected-unsold units plus any unit whose sale is so far away that the credit
    # today is worth more: price x (1 - h t/52) < cost x credit  <=>  t > t_star
    deadline = (date.fromisoformat(b["expiry_date"]) - timedelta(days=pol["min_days_before_expiry"])).isoformat()
    extra = 0.0
    t_star = None
    if not b["expired"] and h > 0 and price > 0:
        t_star = max(0.0, 52.0 * (1 - cost * credit / price) / h)
        extra = min(max(0.0, prev + sold - rate * t_star), sold)
    elif not b["expired"] and price < cost * credit:
        # no holding cost (or no price data): a unit sold is worth `price`, a unit returned cost x credit
        extra = sold
    ret_units = min(qty, int(math.ceil(unsold + extra - 1e-9))) if not b["expired"] else 0
    keep_sold = max(0.0, min(sold, qty - ret_units))
    reasons = []
    if b["expired"]:
        reasons.append("batch has expired")
    if not pol["accepts_returns"]:
        reasons.append("supplier does not accept returns")
    if days < pol["min_days_before_expiry"]:
        reasons.append(f"only {max(days, 0)} days to expiry; supplier needs ≥ {pol['min_days_before_expiry']}")
    if ret_units <= 0 and not reasons:
        reasons.append("every unit is worth more sold here than returned")
    rtv_ok = not reasons
    credit_val = ret_units * cost * credit
    rtv = sale_value(price, prev, keep_sold, rate, h) + credit_val if rtv_ok else 0.0
    opts.append({"key": "rtv", "label": "Return to vendor", "eligible": rtv_ok, "recovery": rtv,
                 "units_returned": ret_units, "units_sold": keep_sold, "credit_pct": credit, "deadline": deadline,
                 "days_to_deadline": (date.fromisoformat(deadline) - m.today).days, "breakeven_weeks": t_star,
                 "supplier_id": b.get("supplier_id"), "policy": pol, "why_not": "; ".join(reasons) or None,
                 "formula": (f"{ret_units} returned × ₹{cost:.2f} cost × {credit:.0%} credit = ₹{credit_val:,.0f}"
                             + (f" + {keep_sold:.1f} kept & sold (₹{rtv - credit_val:,.0f})" if keep_sold > 0 else "")
                             + f"; return before {deadline}")})

    # (b) transfer the projected-unsold units to the branch that sells most of them before expiry
    best_t = None
    if not b["expired"] and unsold >= 1:
        for oid, ost in m.stores.items():
            if oid == sid:
                continue
            wk_d = m.weekly_for(oid, mid)
            dd = days - TRANSIT_DAYS
            cap = _cum(wk_d, dd)
            ahead = float(sum(x["qty_on_hand"] for x in m.sellable(oid, mid) if x["expiry_date"] <= b["expiry_date"]))
            spare = max(0.0, cap - ahead)
            moved = int(min(math.floor(unsold + 1e-9), math.floor(spare)))
            if moved <= 0:
                continue
            rate_d = cap / (dd / 7.0) if dd > 0 else 0.0
            there = sale_value(price, ahead, moved, rate_d, h)
            rec = hold + there - a["transfer_cost"]
            if best_t is None or rec > best_t["recovery"]:
                best_t = {"to_store": oid, "to_store_name": ost["name"], "units_moved": moved, "recovery": rec,
                          "dest_capacity": spare, "value_there": there}
    if best_t and best_t["value_there"] > a["transfer_cost"]:
        opts.append({"key": "transfer", "label": f"Transfer to {best_t['to_store_name']}", "eligible": True, **best_t,
                     "units_sold": sold, "units_written_off": max(0.0, unsold - best_t["units_moved"]),
                     "transfer_cost": a["transfer_cost"],
                     "formula": (f"₹{hold:,.0f} from {sold:.1f} sold here + ₹{best_t['value_there']:,.0f} from "
                                 f"{best_t['units_moved']} moved & sold there − ₹{a['transfer_cost']:.0f} transfer cost "
                                 f"= ₹{best_t['recovery']:,.0f}")})
    else:
        opts.append({"key": "transfer", "label": "Transfer to a branch", "eligible": False, "recovery": 0.0,
                     "why_not": ("batch has expired" if b["expired"] else
                                 "nothing projected unsold" if unsold < 1 else
                                 "no branch would sell enough before expiry to cover the transfer cost")})

    # (c) markdown on this batch: demand x (1-d)^-e, sold at price x (1-d)
    best_md = None
    grid = []
    if not b["expired"]:
        e = _elasticity(mid, a)
        for d in MARKDOWN_GRID:
            mult = round((1 - d) ** (-e), 6)
            fs_d = m.fefo_sold(sid, mid, mult)
            s_d, prev_d = fs_d[idx], float(sum(fs_d[:idx]))
            rec = sale_value(price * (1 - d), prev_d, s_d, rate * mult, h)
            grid.append({"discount": d, "units_sold": s_d, "recovery": rec})
            if best_md is None or rec > best_md["recovery"] + 1e-9:
                best_md = {"discount": d, "units_sold": s_d, "recovery": rec, "demand_multiplier": mult}
        md_ok = best_md["recovery"] > hold + 1e-6
        opts.append({"key": "markdown", "label": f"Markdown {best_md['discount']:.0%}", "eligible": md_ok,
                     "recovery": best_md["recovery"] if md_ok else 0.0,
                     **{k: best_md[k] for k in ("discount", "units_sold", "demand_multiplier")},
                     "best_grid_recovery": best_md["recovery"],
                     "elasticity": e, "markdown_price": price * (1 - best_md["discount"]),
                     "units_written_off": max(0.0, qty - best_md["units_sold"]),
                     "why_not": None if md_ok else "no discount on the grid beats selling at full price",
                     "grid": grid if detail else None,
                     "formula": (f"{best_md['units_sold']:.1f} sold × ₹{price * (1 - best_md['discount']):.2f} "
                                 f"({best_md['discount']:.0%} off; demand × {best_md['demand_multiplier']:.2f} at elasticity "
                                 f"{e:.2f}) less holding cost = ₹{best_md['recovery']:,.0f}")})
    else:
        opts.append({"key": "markdown", "label": "Markdown", "eligible": False, "recovery": 0.0, "why_not": "batch has expired"})

    # (e) write off
    opts.append({"key": "writeoff", "label": "Write off", "eligible": True, "recovery": 0.0,
                 "loss": qty * cost, "formula": f"₹0 recovered; ₹{qty * cost:,.0f} cost lost"})

    order = {"hold": 0, "rtv": 1, "transfer": 2, "markdown": 3, "writeoff": 4}
    elig = [o for o in opts if o["eligible"]]
    best = max(elig, key=lambda o: (round(o["recovery"], 2), -order[o["key"]]))
    for o in opts:
        o["best"] = o is best
        o["vs_hold"] = o["recovery"] - hold if o["eligible"] else None
    med = S.meds.loc[mid] if mid in S.meds.index else None
    return {
        "batch_id": b["id"], "store_id": sid, "medicine_id": mid,
        "medicine_name": None if med is None else med["medicine_name"],
        "generic_name": None if med is None else med["generic_name"],
        "category": None if med is None else med["category"],
        "batch_no": b["batch_no"], "expiry_date": b["expiry_date"], "days_left": days, "expired": b["expired"],
        "age_days": b["age_days"], "qty": qty, "unit_cost": cost, "price": price, "value": qty * cost,
        "supplier_id": b.get("supplier_id"), "projected_sold": sold, "projected_unsold": unsold,
        "value_at_risk": (qty if b["expired"] else unsold) * cost,
        "best": best["key"], "best_label": best["label"], "best_recovery": best["recovery"],
        "uplift_vs_hold": best["recovery"] - hold, "rtv_deadline": deadline if rtv_ok else None,
        "options": opts,
    }


# ─────────────────────────────────────────────────────────────────────────────
# classification
# ─────────────────────────────────────────────────────────────────────────────
def classify(store_id: str, m: Model, a: dict) -> tuple[pd.DataFrame, list[dict]]:
    pos = inv.stock_position(store_id, m.as_of)
    recent = _recent_sales(store_id, m.today)
    items, batch_rows = [], []
    for mid, r in pos.iterrows():
        bs = m.by_key.get((store_id, mid), [])
        if not bs:
            continue
        qty = int(r["qty"])
        rate = float(r["weekly_rate"])
        sold12 = float(recent.get(mid, 0.0))
        dead = qty > 0 and sold12 <= 0 and rate < SLOW_MOVER_RATE
        cover = float(r["weeks_cover"]) if np.isfinite(r["weeks_cover"]) else math.inf
        slow = (not dead) and qty > 0 and cover > SLOW_WEEKS
        sold = m.fefo_sold(store_id, mid)
        unsold_units = sum(max(0.0, x["qty_on_hand"] - s) for x, s in zip(m.sellable(store_id, mid), sold))
        risky = [x for x, s in zip(m.sellable(store_id, mid), sold) if x["qty_on_hand"] - s >= 0.5]
        expired = [x for x in bs if x["expired"]]
        cls = "dead" if dead else "slow" if slow else "at_risk" if risky else "expired" if expired else None
        if cls is None:
            continue
        # batches worth optimising: dead/slow -> every batch; at_risk -> risky + expired
        targets = list(bs) if cls in ("dead", "slow") else risky + expired
        opts = [batch_options(m, x, a, detail=False) for x in targets]
        for o in opts:
            o["class"] = cls
            for op in o["options"]:
                op.pop("grid", None)
        batch_rows.extend(opts)
        best_total = sum(o["best_recovery"] for o in opts)
        hold_total = sum(next(op["recovery"] for op in o["options"] if op["key"] == "hold") for o in opts)
        unsold_value = sum(max(0.0, x["qty_on_hand"] - s) * float(x["unit_cost"]) for x, s in zip(m.sellable(store_id, mid), sold))
        best_counts: dict[str, int] = {}
        for o in opts:
            best_counts[o["best"]] = best_counts.get(o["best"], 0) + 1
        top = max(opts, key=lambda o: o["uplift_vs_hold"]) if opts else None
        deadlines = [o["rtv_deadline"] for o in opts if o["rtv_deadline"]]
        items.append({
            "medicine_id": mid, "medicine_name": r["medicine_name"], "generic_name": r["generic_name"],
            "category": r["category"], "form": r["form"], "abc": r["abc"], "class": cls,
            "qty": qty, "value": float(r["value"]), "expired_qty": int(r["expired_qty"]),
            "expired_value": float(r["expired_value"]), "weekly_rate": rate,
            "weeks_cover": None if not math.isfinite(cover) else cover, "sold_last_12w": sold12,
            "unsold_units": unsold_units, "value_at_risk": unsold_value + float(r["expired_value"]),
            "n_batches": len(opts), "earliest_expiry": min(x["expiry_date"] for x in bs),
            "oldest_age_days": max(x["age_days"] for x in bs),
            "best": top["best"] if top else None, "best_label": top["best_label"] if top else None,
            "best_recovery": best_total, "hold_recovery": hold_total, "uplift_vs_hold": best_total - hold_total,
            "rtv_deadline": min(deadlines) if deadlines else None, "best_counts": best_counts,
            "batches": [{k: o[k] for k in ("batch_id", "batch_no", "expiry_date", "days_left", "expired", "qty",
                                           "value", "best", "best_label", "best_recovery", "uplift_vs_hold",
                                           "projected_unsold", "rtv_deadline", "supplier_id")} for o in opts],
        })
    df = pd.DataFrame(items)
    return df, batch_rows


CLASS_ORDER = {"dead": 0, "slow": 1, "at_risk": 2, "expired": 3}
_CACHE: dict[tuple, tuple[float, Model, pd.DataFrame, list[dict]]] = {}
_CACHE_TTL = 120.0
_cache_lock = threading.Lock()


def _fingerprint() -> tuple:
    """Changes whenever stock, sales, supplier policies or our own settings change."""
    r = db.query_one("SELECT (SELECT COALESCE(MAX(id), 0) FROM movements) AS mv, "
                     "(SELECT COALESCE(SUM(qty_on_hand), 0) FROM batches) AS oh, "
                     "(SELECT COUNT(*) FROM batches) AS nb")
    pol = db.query_one("SELECT group_concat(key || '=' || value, ';') AS v FROM settings "
                       "WHERE key LIKE 'suppliers%' OR key LIKE 'deadstock%'")
    try:
        sup = db.scalar("SELECT group_concat(id || ':' || COALESCE(return_policy, ''), ';') FROM suppliers_master", (), "")
    except Exception:  # suppliers table may not exist (feature not installed)
        sup = ""
    return (str(db.db_path()), r["mv"], r["oh"], r["nb"], (pol or {}).get("v"), sup)


def analyse(store_id: str, a: dict) -> tuple[Model, pd.DataFrame, list[dict]]:
    """classify() for today, cached briefly per (database state, store, assumptions)."""
    key = (_fingerprint(), date.today().isoformat(), store_id, tuple(sorted(a.items())))
    now = time.monotonic()
    with _cache_lock:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1], hit[2], hit[3]
    m = Model()
    df, brs = classify(store_id, m, a)
    with _cache_lock:
        for k in [k for k, v in _CACHE.items() if now - v[0] >= _CACHE_TTL]:
            _CACHE.pop(k, None)
        if len(_CACHE) > 32:
            _CACHE.clear()
        _CACHE[key] = (now, m, df, brs)
    return m, df, brs


def _definitions(a: dict) -> dict:
    _, from_module = _policy_fn()
    return {
        "dead": f"Stock on hand, no sales in the last {DEAD_WEEKS} weeks (history + POS ledger) and forecast < {SLOW_MOVER_RATE} units/week.",
        "slow": f"More than {SLOW_WEEKS} weeks of cover at the forecast rate.",
        "at_risk": "A batch is projected to be left unsold at expiry (FEFO sell-through at the forecast rate).",
        "expired": "Expired stock still on the shelf: write it off (or claim under a supplier expiry scheme if one applies).",
        "recovery": "Expected cash back from the whole batch from today; purchase cost is sunk, write-off = ₹0.",
        "policy_source": ("supplier module (learned/configured per supplier)" if from_module else
                          "default policy (settings 'suppliers.return_policy' or 90 days / 80 % credit) - per-supplier terms not configured"),
        "assumptions": a,
        "simulated_branches": "Branch demand is SIMULATED as main-shop forecast × demand_scale until real branch sales exist.",
        "legal": ("Planning estimates only. Return, credit-note and GST treatment depend on your supplier agreement - "
                  "verify with the supplier and your CA; destruction of expired drugs must follow your State Drugs Control rules."),
    }


# ─────────────────────────────────────────────────────────────────────────────
# reads
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/assumptions")
def get_assumptions(user: dict = Depends(current_user)):
    return clean({"saved": saved_assumptions(), "defaults": ASSUMPTION_DEFAULTS, "policy_default": return_policy(None),
                  "can_edit": has_perm(user, "settings.edit"),
                  "notes": {"credit_pct": "Blank = use each supplier's return policy credit %.",
                            "elasticity_otc": "Demand change per price change for OTC items (2.0 = 10 % off -> ~23 % more units).",
                            "elasticity_rx": "Prescription demand barely reacts to price (default 0.3).",
                            "transfer_cost": "₹ per transfer (courier/staff time), deducted from transfer recovery.",
                            "holding_cost_pct": ("Annual cost of keeping stock (capital, shelf space, handling). A unit "
                                                 "that takes t weeks to sell is worth price × (1 − holding % × t/52) today.")}})


class AssumptionsBody(BaseModel):
    credit_pct: float | None = Field(None, ge=0, le=1, allow_inf_nan=False)
    elasticity_otc: float = Field(2.0, ge=0, le=6, allow_inf_nan=False)
    elasticity_rx: float = Field(0.3, ge=0, le=6, allow_inf_nan=False)
    transfer_cost: float = Field(150.0, ge=0, le=100_000, allow_inf_nan=False)
    holding_cost_pct: float = Field(0.15, ge=0, le=1, allow_inf_nan=False)


@router.put("/assumptions")
def put_assumptions(body: AssumptionsBody, user: dict = Depends(require_perm("settings.edit"))):
    db.set_setting(ASSUMPTIONS_KEY, body.model_dump())
    return clean({"ok": True, "saved": saved_assumptions()})


@router.get("/summary")
def summary(store_id: str | None = Query(None, max_length=32), aq: AssumptionQuery = Depends(),
            user: dict = Depends(current_user)):
    st = _store_row(user, store_id)
    m, items, brs = analyse(st["id"], aq.a)
    by_class = {}
    for c in CLASS_ORDER:
        sub = items[items["class"] == c] if len(items) else items
        # value = all stock held in the class (sellable + expired still on the shelf), so it always
        # bounds value_at_risk, which also counts expired stock.
        by_class[c] = {"items": int(len(sub)),
                       "value": float((sub["value"] + sub["expired_value"]).sum()) if len(sub) else 0.0,
                       "sellable_value": float(sub["value"].sum()) if len(sub) else 0.0,
                       "value_at_risk": float(sub["value_at_risk"].sum()) if len(sub) else 0.0}
    tied = by_class["dead"]["value"] + by_class["slow"]["value"]
    var = float(sum(b["value_at_risk"] for b in brs))
    best = float(sum(b["best_recovery"] for b in brs))
    hold = float(sum(next(o["recovery"] for o in b["options"] if o["key"] == "hold") for b in brs))
    # ageing (days since received) and expiry buckets over ALL stock at the store, split by class
    cls_of = dict(zip(items["medicine_id"], items["class"])) if len(items) else {}
    age = [{"bucket": n, **{c: 0.0 for c in ("dead", "slow", "at_risk", "expired", "healthy")}} for n, *_ in AGE_BUCKETS]
    exp = [{"bucket": n, "value": 0.0, "units": 0} for n, *_ in EXPIRY_BUCKETS]
    total_value = 0.0
    for (sid, mid), bs in m.by_key.items():
        if sid != st["id"]:
            continue
        c = cls_of.get(mid, "healthy")
        for b in bs:
            v = b["qty_on_hand"] * float(b["unit_cost"])
            total_value += v
            # an item classed 'expired' only has expired stock as its problem: its in-date batches are healthy
            cc = "expired" if b["expired"] else ("healthy" if c == "expired" else c)
            for i, (_, lo, hi) in enumerate(AGE_BUCKETS):
                if lo <= b["age_days"] <= hi:
                    age[i][cc] += v
                    break
            for i, (_, lo, hi) in enumerate(EXPIRY_BUCKETS):
                if lo <= b["days_left"] <= hi:
                    exp[i]["value"] += v
                    exp[i]["units"] += b["qty_on_hand"]
                    break
    deadlines = sorted(
        [{"batch_id": b["batch_id"], "medicine_id": b["medicine_id"], "medicine_name": b["medicine_name"],
          "batch_no": b["batch_no"], "qty": b["qty"], "deadline": b["rtv_deadline"],
          "days_to_deadline": (date.fromisoformat(b["rtv_deadline"]) - m.today).days,
          "expected_credit": next(o["recovery"] for o in b["options"] if o["key"] == "rtv"),
          "supplier_id": b["supplier_id"], "best": b["best"]}
         for b in brs if b["rtv_deadline"]],
        key=lambda x: (x["deadline"], -x["expected_credit"]))
    best_mix: dict[str, dict] = {}
    for b in brs:
        d = best_mix.setdefault(b["best"], {"batches": 0, "recovery": 0.0})
        d["batches"] += 1
        d["recovery"] += b["best_recovery"]
    return clean({
        "store": _store_info(st), "as_of": m.as_of, "total_stock_value": total_value,
        "value_tied_up": tied, "value_at_risk": var, "best_recovery": best, "hold_recovery": hold,
        "uplift_vs_hold": best - hold, "by_class": by_class, "best_mix": best_mix,
        "ageing": age, "expiry_buckets": exp, "deadlines": deadlines[:40], "n_deadlines": len(deadlines),
        "definitions": _definitions(aq.a),
    })


@router.get("/items")
def items(store_id: str | None = Query(None, max_length=32),
          cls: Literal["all", "dead", "slow", "at_risk", "expired"] = Query("all", alias="class"),
          q: str | None = Query(None, max_length=80), sort: Literal["uplift", "value", "risk", "deadline"] = "risk",
          limit: int = Query(200, ge=1, le=500), aq: AssumptionQuery = Depends(), user: dict = Depends(current_user)):
    st = _store_row(user, store_id)
    m, df, _ = analyse(st["id"], aq.a)
    counts = {c: int((df["class"] == c).sum()) if len(df) else 0 for c in CLASS_ORDER}
    if len(df) and cls != "all":
        df = df[df["class"] == cls]
    if len(df) and q:
        ql = q.strip().lower()
        df = df[df["medicine_name"].str.lower().str.contains(ql, regex=False) |
                df["generic_name"].fillna("").str.lower().str.contains(ql, regex=False) |
                df["medicine_id"].str.lower().str.contains(ql, regex=False)]
    if len(df):
        key = {"uplift": ("uplift_vs_hold", False), "value": ("value", False), "risk": ("value_at_risk", False),
               "deadline": ("rtv_deadline", True)}[sort]
        df = df.sort_values(key[0], ascending=key[1], na_position="last", kind="stable")
    total = int(len(df))
    rows = df.head(limit).to_dict("records") if len(df) else []
    return clean({"store": _store_info(st), "as_of": m.as_of, "items": rows, "total": total, "counts": counts,
                  "definitions": _definitions(aq.a)})


@router.get("/batches/{batch_id}/options")
def options(batch_id: int = Path(gt=0, lt=MAX_ID), aq: AssumptionQuery = Depends(), user: dict = Depends(current_user)):
    b = db.query_one("SELECT store_id FROM batches WHERE id = ?", (batch_id,))
    if not b:
        raise HTTPException(404, f"Unknown batch {batch_id}")
    st = _store_row(user, b["store_id"])
    m = Model()
    row = next((x for x in m.by_key.get((st["id"], db.scalar("SELECT medicine_id FROM batches WHERE id=?", (batch_id,))), [])
                if x["id"] == batch_id), None)
    if row is None:
        raise HTTPException(409, f"Batch {batch_id} has no stock on hand")
    out = batch_options(m, row, aq.a, detail=True)
    md = active_markdown(st["id"], row["medicine_id"], batch_id)
    return clean({"store": _store_info(st), "as_of": m.as_of, **out, "active_markdown": md,
                  "definitions": _definitions(aq.a)})


# ─────────────────────────────────────────────────────────────────────────────
# RTV notes
# ─────────────────────────────────────────────────────────────────────────────
def fy_label(d: date) -> str:
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


class RtvLine(BaseModel):
    batch_id: int = Field(gt=0, lt=MAX_ID, strict=True)
    qty: int = Field(gt=0, le=1_000_000, strict=True)


class RtvBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    lines: list[RtvLine] = Field(min_length=1, max_length=100)
    note: str | None = Field(None, max_length=300)
    credit_pct: float | None = Field(None, ge=0, le=1, allow_inf_nan=False)


@router.post("/rtv", status_code=201)
def create_rtv(body: RtvBody, user: dict = Depends(require_perm("stock.writeoff"))):
    st = _store_row(user, body.store_id)
    sid = st["id"]
    ids = [ln.batch_id for ln in body.lines]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Each batch may appear only once on a return note")
    limit = None if has_perm(user, "stock.adjust.large") or has_perm(user, "stores.all") else PHARMACIST_RTV_LIMIT
    today = date.today()
    fy = fy_label(today)
    try:
        with db.tx():
            bs = {}
            for ln in body.lines:
                b = db.query_one("SELECT * FROM batches WHERE id = ?", (ln.batch_id,))
                if not b or b["store_id"] != sid:
                    raise HTTPException(404, f"Batch {ln.batch_id} not found at {sid}")
                if b["expiry_date"] <= today.isoformat():
                    raise HTTPException(400, f"Batch {b['batch_no']} has expired - write it off instead of returning it here")
                if ln.qty > b["qty_on_hand"]:
                    raise HTTPException(409, f"Batch {b['batch_no']} has only {b['qty_on_hand']} unit(s)")
                if limit is not None and ln.qty > limit:
                    raise HTTPException(403, f"Pharmacists can return at most {limit} units per batch; ask an owner or buyer")
                bs[ln.batch_id] = b
            sups = {b["supplier_id"] for b in bs.values()}
            if len(sups) > 1:
                raise HTTPException(400, "A return note is for one supplier: split batches from different suppliers")
            supplier = next(iter(sups))
            pol = return_policy(supplier)
            if not pol["accepts_returns"]:
                raise HTTPException(409, f"Supplier {supplier or '(unknown)'} does not accept returns under its policy")
            credit = body.credit_pct if body.credit_pct is not None else pol["credit_pct"]
            seq = int(db.scalar("SELECT COALESCE(MAX(seq), 0) FROM deadstock_rtv WHERE store_id = ? AND fy = ?", (sid, fy), 0)) + 1
            ref = f"RTV/{sid}/{fy}/{seq:04d}"
            lines, tu, tc, te = [], 0, 0.0, 0.0
            for ln in body.lines:
                b = bs[ln.batch_id]
                days = (date.fromisoformat(b["expiry_date"]) - today).days
                eligible = days >= pol["min_days_before_expiry"]
                med = S.meds["medicine_name"].get(b["medicine_id"], b["medicine_id"])
                inv.adjust(sid, ln.batch_id, -ln.qty, f"RTV {ref} to {supplier or 'supplier'}: {med} batch {b['batch_no']}",
                           _uid(user), max_abs=None)
                # a line outside the supplier's return window is recorded (the goods leave the shelf) but no
                # credit is EXPECTED for it under the policy; the note flags it as "past policy window"
                ec = ln.qty * float(b["unit_cost"]) * credit if eligible else 0.0
                lines.append((ln.batch_id, b["medicine_id"], b["batch_no"], b["expiry_date"], ln.qty, float(b["unit_cost"]),
                              credit, ec, int(eligible)))
                tu += ln.qty
                tc += ln.qty * float(b["unit_cost"])
                te += ec
            rid = db.execute("INSERT INTO deadstock_rtv(ref, store_id, fy, seq, supplier_id, status, note, total_units, total_cost, "
                             "expected_credit, created_by, created_at) VALUES (?,?,?,?,?,'sent',?,?,?,?,?,?)",
                             (ref, sid, fy, seq, supplier, body.note, tu, tc, te, _uid(user), db.now_iso())).lastrowid
            db.executemany("INSERT INTO deadstock_rtv_lines(rtv_id, batch_id, medicine_id, batch_no, expiry_date, qty, unit_cost, "
                           "credit_pct, expected_credit, eligible) VALUES (?,?,?,?,?,?,?,?,?,?)",
                           [(rid, *x) for x in lines])
    except inv.InventoryError as e:
        raise inv.as_http(e)
    return clean(_rtv_out(rid))


def _rtv_out(rid: int) -> dict:
    r = db.query_one("SELECT * FROM deadstock_rtv WHERE id = ?", (rid,))
    if not r:
        raise HTTPException(404, "Return note not found")
    lines = db.query("SELECT * FROM deadstock_rtv_lines WHERE rtv_id = ? ORDER BY id", (rid,))
    for ln in lines:
        ln["medicine_name"] = S.meds["medicine_name"].get(ln["medicine_id"])
        ln["generic_name"] = S.meds["generic_name"].get(ln["medicine_id"])
        ln["value"] = ln["qty"] * ln["unit_cost"]
    u = db.query_one("SELECT username, full_name FROM users WHERE id = ?", (r["created_by"],)) if r["created_by"] else None
    st = inv.get_store(r["store_id"])
    return {**r, "store_name": st["name"], "store_city": st.get("city"), "created_by_name": (u or {}).get("full_name") or (u or {}).get("username"),
            "lines": lines, "disclaimer": ("Expected credit is an estimate under the assumed return policy; the supplier's "
                                           "credit note is final. Verify GST treatment with your CA.")}


@router.get("/rtv")
def rtv_history(store_id: str | None = Query(None, max_length=32), limit: int = Query(50, ge=1, le=200),
                offset: int = Query(0, ge=0, le=100_000), user: dict = Depends(current_user)):
    sid = resolve_store(user, store_id, allow_all=True)
    where, params = ("WHERE store_id = ?", [sid]) if sid else ("", [])
    rows = db.query(f"SELECT * FROM deadstock_rtv {where} ORDER BY id DESC LIMIT ? OFFSET ?", params + [limit, offset])
    total = db.scalar(f"SELECT COUNT(*) FROM deadstock_rtv {where}", params, 0)
    agg = db.query_one(f"SELECT COALESCE(SUM(total_cost),0) AS cost, COALESCE(SUM(expected_credit),0) AS credit "
                       f"FROM deadstock_rtv {where}", params)
    n_lines = {r["rtv_id"]: r["n"] for r in db.query("SELECT rtv_id, COUNT(*) AS n FROM deadstock_rtv_lines GROUP BY rtv_id")}
    for r in rows:
        r["n_lines"] = n_lines.get(r["id"], 0)
    return clean({"notes": rows, "total": int(total), "store_id": sid, "totals": agg})


@router.get("/rtv/{rtv_id}")
def rtv_one(rtv_id: int = Path(gt=0, lt=MAX_ID), user: dict = Depends(current_user)):
    sid = db.scalar("SELECT store_id FROM deadstock_rtv WHERE id = ?", (rtv_id,), None)
    if sid is None or not can_access_store(user, sid):
        # same answer for "missing" and "another store's note" so note ids of other branches are not probeable
        raise HTTPException(404, "Return note not found")
    return clean(_rtv_out(rtv_id))


# ─────────────────────────────────────────────────────────────────────────────
# markdowns
# ─────────────────────────────────────────────────────────────────────────────
class MarkdownBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    batch_id: int = Field(gt=0, lt=MAX_ID, strict=True)
    discount_pct: float = Field(gt=0, le=0.9, allow_inf_nan=False)
    valid_until: date | None = None
    note: str | None = Field(None, max_length=300)


def active_markdown(store_id: str, medicine_id: str, batch_id: int | None = None) -> dict | None:
    """For POS: the active markdown note for a medicine (or a specific batch) at a store, if any."""
    sql = ("SELECT * FROM deadstock_markdowns WHERE store_id = ? AND medicine_id = ? AND status = 'active' "
           "AND valid_until >= ?")
    params: list = [store_id, medicine_id, date.today().isoformat()]
    if batch_id is not None:
        sql += " AND batch_id = ?"
        params.append(batch_id)
    return db.query_one(sql + " ORDER BY id DESC LIMIT 1", params)


@router.post("/markdowns", status_code=201)
def create_markdown(body: MarkdownBody, user: dict = Depends(require_perm("purchase.plan"))):
    st = _store_row(user, body.store_id)
    b = db.query_one("SELECT * FROM batches WHERE id = ?", (body.batch_id,))
    if not b or b["store_id"] != st["id"]:
        raise HTTPException(404, f"Batch {body.batch_id} not found at {st['id']}")
    today = date.today()
    if b["expiry_date"] <= today.isoformat():
        raise HTTPException(400, "This batch has expired and must not be sold")
    if b["qty_on_hand"] <= 0:
        raise HTTPException(409, "This batch has no stock on hand")
    last_ok = (date.fromisoformat(b["expiry_date"]) - timedelta(days=1))
    until = body.valid_until or last_ok
    if until < today:
        raise HTTPException(400, "valid_until must not be in the past")
    until = min(until, last_ok)
    price = _price(b["medicine_id"])
    if price <= 0:
        raise HTTPException(409, "No reference selling price for this medicine, so a markdown price cannot be set")
    with db.tx():
        db.execute("UPDATE deadstock_markdowns SET status='cancelled', cancelled_by=?, cancelled_at=? "
                   "WHERE batch_id=? AND status='active'", (_uid(user), db.now_iso(), body.batch_id))
        mid = db.execute("INSERT INTO deadstock_markdowns(store_id, medicine_id, batch_id, batch_no, discount_pct, list_price, "
                         "markdown_price, valid_until, status, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)",
                         (st["id"], b["medicine_id"], b["id"], b["batch_no"], body.discount_pct, price,
                          round(price * (1 - body.discount_pct), 2), until.isoformat(), body.note, _uid(user),
                          db.now_iso())).lastrowid
    return clean(db.query_one("SELECT * FROM deadstock_markdowns WHERE id = ?", (mid,)))


@router.get("/markdowns")
def list_markdowns(store_id: str | None = Query(None, max_length=32),
                   status: Literal["active", "cancelled", "all"] = "active", user: dict = Depends(current_user)):
    sid = resolve_store(user, store_id)
    sql, params = "SELECT * FROM deadstock_markdowns WHERE store_id = ?", [sid]
    if status != "all":
        sql += " AND status = ?"
        params.append(status)
    rows = db.query(sql + " ORDER BY id DESC LIMIT 200", params)
    for r in rows:
        r["medicine_name"] = S.meds["medicine_name"].get(r["medicine_id"])
    return clean({"markdowns": rows, "store_id": sid})


@router.post("/markdowns/{markdown_id}/cancel")
def cancel_markdown(markdown_id: int = Path(gt=0, lt=MAX_ID), user: dict = Depends(require_perm("purchase.plan"))):
    r = db.query_one("SELECT * FROM deadstock_markdowns WHERE id = ?", (markdown_id,))
    if not r:
        raise HTTPException(404, "Markdown not found")
    resolve_store(user, r["store_id"])
    if r["status"] != "active":
        raise HTTPException(409, "Markdown is not active")
    cur = db.execute("UPDATE deadstock_markdowns SET status='cancelled', cancelled_by=?, cancelled_at=? "
                     "WHERE id=? AND status='active'", (_uid(user), db.now_iso(), markdown_id))
    if cur.rowcount != 1:  # a concurrent cancel/replace got there first
        raise HTTPException(409, "Markdown is not active")
    return clean({"ok": True, "id": markdown_id})


# ─────────────────────────────────────────────────────────────────────────────
# transfer (execute or request, through the Branches feature)
# ─────────────────────────────────────────────────────────────────────────────
class TransferBody(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    batch_id: int = Field(gt=0, lt=MAX_ID, strict=True)
    to_store: str = Field(min_length=1, max_length=32)
    qty: int = Field(gt=0, le=100_000, strict=True)
    reason: str | None = Field(None, max_length=300)


@router.post("/transfer", status_code=201)
def transfer(body: TransferBody, user: dict = Depends(require_perm("transfers.request"))):
    """transfers.create -> executes now via the Branches API (inventory.transfer, FEFO from the source: the
    earliest-expiring sellable units move first, which is normally the at-risk batch). Otherwise files a
    transfer request an owner/buyer approves."""
    st = _store_row(user, body.store_id)
    b = db.query_one("SELECT * FROM batches WHERE id = ?", (body.batch_id,))
    if not b or b["store_id"] != st["id"]:
        raise HTTPException(404, f"Batch {body.batch_id} not found at {st['id']}")
    if b["expiry_date"] <= date.today().isoformat():
        # inventory.transfer only moves sellable stock, so this would silently move OTHER (good) batches
        raise HTTPException(400, f"Batch {b['batch_no']} has expired and cannot be transferred - write it off instead")
    if body.qty > b["qty_on_hand"]:
        raise HTTPException(409, f"Batch {b['batch_no']} has only {b['qty_on_hand']} unit(s)")
    to_store = body.to_store.strip()
    if not to_store:
        raise HTTPException(422, "to_store must not be blank")
    from pydantic import ValidationError
    from backend.routers import stores as br
    reason = body.reason or f"Slow stock: batch {b['batch_no']} projected unsold at expiry"
    payload = {"from_store": st["id"], "to_store": to_store, "medicine_id": b["medicine_id"],
               "qty": body.qty, "reason": reason[:300]}
    execute = has_perm(user, "transfers.create")
    try:
        req = (br.TransferBody if execute else br.RequestBody)(**payload)
    except ValidationError as e:
        raise HTTPException(422, str(e.errors()[0].get("msg", "invalid transfer")) if e.errors() else "invalid transfer")
    if execute:
        return {"mode": "executed", "result": br.create_transfer(req, user)}
    return {"mode": "requested", "result": br.create_request(req, user)}
