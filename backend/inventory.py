"""Batch-level stock service shared by every feature (receive, FEFO sales, adjustments, transfers, expiry).

Model
-----
* Stock lives in `batches` (one row per store x medicine x batch_no, with expiry_date and qty_on_hand).
* Every change writes a signed row to `movements` (receive +, sale -, adjust +/-, transfer_out -,
  transfer_in +, expire_writeoff -). Invariant: for every batch, SUM(movements.qty) == qty_on_hand.
* Every write function runs in ONE transaction (db.tx(), BEGIN IMMEDIATE): either everything is
  recorded or nothing is. Quantities can never go negative (CHECK constraint + guarded UPDATEs).
* A batch is EXPIRED when expiry_date <= as_of (today by default): it can not be sold on its expiry
  date. Expired batches are never sold or transferred; write_off_expired() removes them.
* FEFO (first-expiry-first-out): sales and transfers draw from the non-expired batch with the
  earliest expiry first (ties: oldest batch id).
* Branch stores are SIMULATED from the single real shop: demand there = main forecast x demand_scale.
* unit_cost is the purchase cost per unit. Opening stock uses median selling price x 0.8 (assumed
  20 % retail margin, since the sales data has no purchase prices). Stock "value" = qty x unit_cost.

Errors (all subclasses of InventoryError, a ValueError; .status is the suggested HTTP code)
    InventoryError(400)  bad input (qty <= 0, unknown medicine, bad date, expired receipt...)
    NotFound(404)        unknown store / batch
    Conflict(409)        batch number clash (same batch_no, different expiry)
    InsufficientStock(409)  .available = sellable units; raised unless allow_partial
Convert in a router with:  `except InventoryError as e: raise as_http(e)`.

Functions (dates are 'YYYY-MM-DD' strings or datetime.date; as_of defaults to date.today())
    store_list() -> list[dict]                     id, name, city, demand_scale, is_main, simulated
    get_store(store_id) -> dict                    (NotFound)
    main_store_id() -> str
    store_scale(store_id) -> float
    forecast_rate(store_id, weeks=4, start=0) -> pd.Series   weekly forecast units per medicine_id
    on_hand(store_id=None, as_of=None) -> pd.DataFrame
        [store_id, medicine_id, qty, value, earliest_expiry, n_batches, expired_qty, expired_value]
        qty/value/earliest_expiry/n_batches count SELLABLE (non-expired) stock only.
    stock_position(store_id, as_of=None, weeks=4) -> pd.DataFrame indexed by medicine_id (all 424)
        [medicine_name, generic_name, category, form, abc, median_price, qty, value, earliest_expiry,
         n_batches, expired_qty, weekly_rate, weeks_cover]
    batches(store_id, medicine_id=None, include_empty=False, as_of=None) -> list[dict]  (FEFO order)
    receive(store_id, medicine_id, qty, batch_no, expiry_date, unit_cost=None, supplier_id=None,
            user_id=None, ref=None, note=None) -> dict (the batch after receipt)
    sell(store_id, medicine_id, qty, user_id, ref=None, allow_partial=False, as_of=None)
            -> list[Allocation(batch_id, batch_no, expiry, qty)]
    adjust(store_id, batch_id, delta, reason, user_id, max_abs=None) -> dict (batch after)
    write_off_expired(store_id=None, as_of=None, user_id=None) -> list[dict]
    transfer(from_store, to_store, medicine_id, qty, user_id, reason=None, allow_partial=False, as_of=None)
            -> dict {transfer_id, moved, allocation:[Allocation...], from_store, to_store, medicine_id}
    near_expiry(store_id=None, days=90, as_of=None, include_expired=False) -> pd.DataFrame
        [store_id, medicine_id, medicine_name, category, batch_id, batch_no, expiry_date, days_left,
         qty, unit_cost, value, expired]
    movements(store_id=None, medicine_id=None, limit=100, offset=0, kind=None) -> list[dict]
    count_movements(store_id=None, medicine_id=None, kind=None) -> int
    transfers(store_id=None, medicine_id=None, limit=100, offset=0) -> list[dict]
"""
from __future__ import annotations

import functools
import math
import sqlite3
from datetime import date, datetime, timedelta
from typing import NamedTuple

import numpy as np
import pandas as pd
from fastapi import HTTPException

from backend import db
from backend.core import S

COST_FACTOR = 0.8          # default unit cost = median selling price x 0.8 (assumed 20 % margin)
MOVEMENT_KINDS = ("receive", "sale", "adjust", "transfer_out", "transfer_in", "expire_writeoff")
MAX_QTY = 1_000_000


class InventoryError(ValueError):
    status = 400


class NotFound(InventoryError):
    status = 404


class Conflict(InventoryError):
    status = 409


class InsufficientStock(InventoryError):
    status = 409

    def __init__(self, message: str, available: int = 0):
        super().__init__(message)
        self.available = int(available)


class Allocation(NamedTuple):
    batch_id: int
    batch_no: str
    expiry: str
    qty: int


def as_http(e: InventoryError) -> HTTPException:
    """Map an InventoryError to an HTTPException (InsufficientStock adds {available})."""
    detail: object = str(e)
    if isinstance(e, InsufficientStock):
        detail = {"message": str(e), "available": e.available}
    return HTTPException(getattr(e, "status", 400), detail)


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def _date(d: date | str | None, field: str = "date") -> str:
    if d is None:
        return date.today().isoformat()
    if isinstance(d, datetime):
        return d.date().isoformat()
    if isinstance(d, date):
        return d.isoformat()
    s = str(d).strip()
    if len(s) > 10 and s[10] not in "T ":  # allow 'YYYY-MM-DD' or an ISO datetime, not '2027-01-01junk'
        raise InventoryError(f"Invalid {field} '{d}' (expected YYYY-MM-DD)")
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        raise InventoryError(f"Invalid {field} '{d}' (expected YYYY-MM-DD)")


def _whole(q, field: str) -> int:
    """Strict whole number: ints (incl. numpy) or integral finite floats. Rejects bool, str, None,
    1.5, nan and inf (which used to slip through as True -> 1, '3' -> 3, 1.5 -> 1, or raise OverflowError)."""
    if isinstance(q, (bool, np.bool_)) or q is None or isinstance(q, (str, bytes)):
        raise InventoryError(f"{field} must be a whole number")
    if isinstance(q, (int, np.integer)):
        return int(q)
    if isinstance(q, (float, np.floating)) and math.isfinite(q) and float(q).is_integer():
        return int(q)
    raise InventoryError(f"{field} must be a whole number")


def _qty(q, field: str = "qty") -> int:
    qi = _whole(q, field)
    if qi <= 0:
        raise InventoryError(f"{field} must be positive")
    if qi > MAX_QTY:
        raise InventoryError(f"{field} is unrealistically large")
    return qi


def _int_arg(v, field: str, lo: int, hi: int) -> int:
    """Lenient integer for read/report arguments (accepts '30'), clamped to [lo, hi]."""
    try:
        i = int(v)
    except (TypeError, ValueError, OverflowError):
        raise InventoryError(f"{field} must be a whole number")
    return max(lo, min(i, hi))


def _text(v, field: str, max_len: int, *, truncate: bool = False) -> str | None:
    """Optional free-text / identifier field. None/'' -> None; too long -> error (or truncated)."""
    if v is None:
        return None
    if not isinstance(v, str):
        raise InventoryError(f"{field} must be text")
    v = v.strip()
    if not v:
        return None
    if len(v) > max_len:
        if truncate:
            return v[:max_len]
        raise InventoryError(f"{field} is too long (max {max_len} characters)")
    return v


def _cost(c) -> float:
    try:
        f = float(c)
    except (TypeError, ValueError):
        raise InventoryError("unit_cost must be a number")
    if isinstance(c, bool) or not math.isfinite(f) or f < 0 or f > 1e7:
        raise InventoryError("unit_cost must be a finite amount >= 0")
    return f


def _med(medicine_id: str) -> None:
    if medicine_id not in S.meds.index:
        raise InventoryError(f"Unknown medicine '{medicine_id}'")


def _store(store_id: str) -> dict:
    r = db.query_one("SELECT * FROM stores WHERE id = ?", (store_id,))
    if r is None:
        raise NotFound(f"Unknown store '{store_id}'")
    return r


def _days_left(expiry: str, as_of: str) -> int:
    return (date.fromisoformat(expiry) - date.fromisoformat(as_of)).days


# ---------------------------------------------------------------------------------------------
# stores & forecast
# ---------------------------------------------------------------------------------------------
def store_list() -> list[dict]:
    """All stores, main first: id, name, city, demand_scale, is_main (bool), simulated (bool)."""
    rows = db.query("SELECT id, name, city, demand_scale, is_main, created_at FROM stores "
                    "ORDER BY is_main DESC, demand_scale DESC, id")
    return [{**r, "is_main": bool(r["is_main"]), "simulated": not r["is_main"]} for r in rows]


def get_store(store_id: str) -> dict:
    r = _store(store_id)
    return {**r, "is_main": bool(r["is_main"]), "simulated": not r["is_main"]}


def main_store_id() -> str:
    sid = db.scalar("SELECT id FROM stores ORDER BY is_main DESC, demand_scale DESC, id LIMIT 1")
    if sid is None:
        raise NotFound("No stores exist - run `python -m backend.seed`")
    return sid


def store_scale(store_id: str) -> float:
    """Demand multiplier vs the real (main) shop: 1.0 for the main store, <1 for simulated branches."""
    return float(_store(store_id)["demand_scale"])


def forecast_rate(store_id: str, weeks: int = 4, start: int = 0) -> pd.Series:
    """Expected weekly units per medicine for a store: mean of the ensemble forecast over forecast
    weeks [start, start+weeks) (default the first 4 weeks from S.fweeks[0]) x the store's demand_scale.
    Index = medicine_id for every medicine in S.meds (0 where no forecast)."""
    weeks = max(1, int(weeks))
    start = max(0, min(int(start), len(S.fweeks) - 1))
    rate = S.fc_wide.iloc[:, start:start + weeks].mean(1)
    return (rate.reindex(S.meds.index).fillna(0.0) * store_scale(store_id)).rename("weekly_rate")


# ---------------------------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------------------------
def on_hand(store_id: str | None = None, as_of: date | str | None = None) -> pd.DataFrame:
    """Sellable stock per store x medicine (only pairs with any batch quantity > 0).

    Columns: store_id, medicine_id, qty, value (qty x unit_cost), earliest_expiry (of sellable stock),
    n_batches (sellable batches with qty > 0), expired_qty, expired_value (awaiting write-off)."""
    as_of = _date(as_of, "as_of")
    sql = ("SELECT store_id, medicine_id, "
           " SUM(CASE WHEN expiry_date > :d THEN qty_on_hand ELSE 0 END) AS qty, "
           " SUM(CASE WHEN expiry_date > :d THEN qty_on_hand * unit_cost ELSE 0 END) AS value, "
           " MIN(CASE WHEN expiry_date > :d THEN expiry_date END) AS earliest_expiry, "
           " SUM(CASE WHEN expiry_date > :d THEN 1 ELSE 0 END) AS n_batches, "
           " SUM(CASE WHEN expiry_date <= :d THEN qty_on_hand ELSE 0 END) AS expired_qty, "
           " SUM(CASE WHEN expiry_date <= :d THEN qty_on_hand * unit_cost ELSE 0 END) AS expired_value "
           "FROM batches WHERE qty_on_hand > 0" + (" AND store_id = :s" if store_id else "") +
           " GROUP BY store_id, medicine_id ORDER BY store_id, medicine_id")
    rows = db.query(sql, {"d": as_of, "s": store_id})
    cols = ["store_id", "medicine_id", "qty", "value", "earliest_expiry", "n_batches", "expired_qty", "expired_value"]
    df = pd.DataFrame(rows, columns=cols)
    for c in ("qty", "n_batches", "expired_qty"):
        df[c] = df[c].fillna(0).astype(int)
    for c in ("value", "expired_value"):
        df[c] = df[c].fillna(0.0).astype(float)
    return df


def stock_position(store_id: str, as_of: date | str | None = None, weeks: int = 4) -> pd.DataFrame:
    """One row per medicine (all of S.meds, 0-filled) for a store: sellable stock + forecast cover.

    weeks_cover = qty / weekly_rate (inf when no forecast demand; NaN-safe via core.clean())."""
    _store(store_id)
    oh = on_hand(store_id, as_of).set_index("medicine_id")
    m = S.meds[["medicine_name", "generic_name", "category", "form", "abc", "median_price"]].copy()
    for c, fill in (("qty", 0), ("value", 0.0), ("n_batches", 0), ("expired_qty", 0), ("expired_value", 0.0)):
        m[c] = oh[c].reindex(m.index).fillna(fill) if len(oh) else fill
    m["earliest_expiry"] = oh["earliest_expiry"].reindex(m.index) if len(oh) else None
    m["qty"] = m["qty"].astype(int)
    m["n_batches"] = m["n_batches"].astype(int)
    m["expired_qty"] = m["expired_qty"].astype(int)
    m["weekly_rate"] = forecast_rate(store_id, weeks)
    with np.errstate(divide="ignore", invalid="ignore"):
        m["weeks_cover"] = np.where(m["weekly_rate"] > 0, m["qty"] / m["weekly_rate"], np.inf)
    m.index.name = "medicine_id"
    return m


def batches(store_id: str, medicine_id: str | None = None, include_empty: bool = False,
            as_of: date | str | None = None) -> list[dict]:
    """Batches of a store (optionally one medicine) in FEFO order, each with days_left and expired flag."""
    as_of = _date(as_of, "as_of")
    sql = "SELECT * FROM batches WHERE store_id = ?"
    params: list = [store_id]
    if medicine_id:
        sql += " AND medicine_id = ?"
        params.append(medicine_id)
    if not include_empty:
        sql += " AND qty_on_hand > 0"
    sql += " ORDER BY medicine_id, expiry_date, id"
    out = db.query(sql, params)
    for b in out:
        b["days_left"] = _days_left(b["expiry_date"], as_of)
        b["expired"] = b["days_left"] <= 0
        b["value"] = b["qty_on_hand"] * b["unit_cost"]
    return out


def _batch(batch_id: int) -> dict:
    b = db.query_one("SELECT * FROM batches WHERE id = ?", (batch_id,))
    if b is None:
        raise NotFound(f"Unknown batch {batch_id}")
    return b


def _mv(store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, ts) -> None:
    db.execute("INSERT INTO movements(store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, created_at) "
               "VALUES (?,?,?,?,?,?,?,?,?,?)", (store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, ts))


def _take(batch_id: int, qty: int) -> None:
    cur = db.execute("UPDATE batches SET qty_on_hand = qty_on_hand - ? WHERE id = ? AND qty_on_hand >= ?",
                     (qty, batch_id, qty))
    if cur.rowcount != 1:  # pragma: no cover - guarded by the allocation, kept as a hard safety net
        raise InsufficientStock("Stock changed during the operation", 0)


def _allocate(store_id: str, medicine_id: str, qty: int, as_of: str, allow_partial: bool, verb: str) -> list[Allocation]:
    rows = db.query("SELECT id, batch_no, expiry_date, qty_on_hand FROM batches "
                    "WHERE store_id = ? AND medicine_id = ? AND qty_on_hand > 0 AND expiry_date > ? "
                    "ORDER BY expiry_date, id", (store_id, medicine_id, as_of))
    available = sum(r["qty_on_hand"] for r in rows)
    if available < qty and not allow_partial:
        raise InsufficientStock(f"Only {available} unit(s) of {medicine_id} available to {verb} at {store_id} "
                                f"(requested {qty}; expired stock is excluded)", available)
    alloc, need = [], qty
    for r in rows:
        if need <= 0:
            break
        take = min(need, r["qty_on_hand"])
        alloc.append(Allocation(r["id"], r["batch_no"], r["expiry_date"], take))
        need -= take
    return alloc


# ---------------------------------------------------------------------------------------------
# writes (each is one transaction)
# ---------------------------------------------------------------------------------------------
def _guard(fn):
    """Turn SQLite constraint violations (e.g. unknown user_id) into InventoryError (HTTP 400)."""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except sqlite3.IntegrityError as e:
            raise InventoryError(f"Rejected by data integrity rules: {e}") from e
    return wrapper


@_guard
def receive(store_id: str, medicine_id: str, qty: int, batch_no: str, expiry_date: date | str,
            unit_cost: float | None = None, supplier_id: str | None = None, user_id: int | None = None,
            ref: str | None = None, note: str | None = None, as_of: date | str | None = None) -> dict:
    """Receive `qty` units into batch `batch_no` (created, or merged when it already exists with the
    same expiry - a different expiry raises Conflict). Receiving already-expired goods is refused.
    unit_cost defaults to median_price x COST_FACTOR; on a merge the batch keeps a qty-weighted cost."""
    qty = _qty(qty)
    _med(medicine_id)
    if not isinstance(batch_no, str) or not batch_no.strip() or len(batch_no.strip()) > 40:
        raise InventoryError("batch_no is required (text, max 40 characters)")
    batch_no = batch_no.strip()
    if expiry_date is None:
        raise InventoryError("expiry_date is required (YYYY-MM-DD)")
    exp = _date(expiry_date, "expiry_date")
    as_of = _date(as_of, "as_of")
    if exp <= as_of:
        raise InventoryError(f"Batch {batch_no} expires {exp}; expired goods cannot be received")
    if unit_cost is None:
        unit_cost = float(S.meds.at[medicine_id, "median_price"]) * COST_FACTOR
    unit_cost = _cost(unit_cost)
    supplier_id = _text(supplier_id, "supplier_id", 64)
    ref = _text(ref, "ref", 100)
    note = _text(note, "note", 500, truncate=True)
    ts = db.now_iso()
    with db.tx():
        _store(store_id)
        b = db.query_one("SELECT * FROM batches WHERE store_id=? AND medicine_id=? AND batch_no=?",
                         (store_id, medicine_id, batch_no))
        if b is None:
            bid = db.execute("INSERT INTO batches(store_id, medicine_id, batch_no, expiry_date, qty_received, qty_on_hand, "
                             "unit_cost, supplier_id, received_at, source) VALUES (?,?,?,?,?,?,?,?,?,'receipt')",
                             (store_id, medicine_id, batch_no, exp, qty, qty, unit_cost, supplier_id, ts)).lastrowid
        else:
            if b["expiry_date"] != exp:
                raise Conflict(f"Batch {batch_no} already exists at {store_id} with expiry {b['expiry_date']} (not {exp})")
            bid = b["id"]
            tot = b["qty_on_hand"] + qty
            cost = (b["unit_cost"] * b["qty_on_hand"] + unit_cost * qty) / tot if tot else unit_cost
            db.execute("UPDATE batches SET qty_on_hand = qty_on_hand + ?, qty_received = qty_received + ?, unit_cost = ?, "
                       "supplier_id = COALESCE(?, supplier_id) WHERE id = ?", (qty, qty, cost, supplier_id, bid))
        _mv(store_id, medicine_id, bid, "receive", qty, unit_cost, ref, note, user_id, ts)
        return _batch(bid)


@_guard
def sell(store_id: str, medicine_id: str, qty: int, user_id: int | None, ref: str | None = None,
         allow_partial: bool = False, as_of: date | str | None = None) -> list[Allocation]:
    """Dispense `qty` units FEFO across non-expired batches. Raises InsufficientStock(available=...)
    unless allow_partial (then sells what is available; an empty list means nothing was sold)."""
    qty = _qty(qty)
    _med(medicine_id)
    as_of = _date(as_of, "as_of")
    ref = _text(ref, "ref", 100)
    ts = db.now_iso()
    with db.tx():
        _store(store_id)
        alloc = _allocate(store_id, medicine_id, qty, as_of, allow_partial, "sell")
        for a in alloc:
            cost = db.scalar("SELECT unit_cost FROM batches WHERE id = ?", (a.batch_id,))
            _take(a.batch_id, a.qty)
            _mv(store_id, medicine_id, a.batch_id, "sale", -a.qty, cost, ref, None, user_id, ts)
        return alloc


@_guard
def adjust(store_id: str, batch_id: int, delta: int, reason: str, user_id: int | None,
           max_abs: int | None = None) -> dict:
    """Stock-count correction on one batch (delta signed, != 0). `reason` is required (>= 3 chars).
    The result can not go below 0 (InsufficientStock). `max_abs` caps |delta| (pass
    auth.max_adjust(user) to enforce the pharmacist limit)."""
    delta = _whole(delta, "delta")
    if delta == 0:
        raise InventoryError("delta must not be 0")
    if abs(delta) > MAX_QTY:
        raise InventoryError("delta is unrealistically large")
    if max_abs is not None and abs(delta) > max_abs:
        raise InventoryError(f"Adjustments are limited to ±{max_abs} units for your role" if max_abs
                             else "Your role cannot adjust stock")
    reason = _text(reason, "reason", 500, truncate=True) or ""
    if len(reason) < 3:
        raise InventoryError("A reason is required for stock adjustments")
    ts = db.now_iso()
    with db.tx():
        b = _batch(batch_id)
        if b["store_id"] != store_id:
            raise NotFound(f"Batch {batch_id} does not belong to store {store_id}")
        if b["qty_on_hand"] + delta < 0:
            raise InsufficientStock(f"Batch {b['batch_no']} has only {b['qty_on_hand']} unit(s)", b["qty_on_hand"])
        db.execute("UPDATE batches SET qty_on_hand = qty_on_hand + ? WHERE id = ?", (delta, batch_id))
        _mv(store_id, b["medicine_id"], batch_id, "adjust", delta, b["unit_cost"], None, reason[:500], user_id, ts)
        return _batch(batch_id)


@_guard
def write_off_expired(store_id: str | None = None, as_of: date | str | None = None,
                      user_id: int | None = None) -> list[dict]:
    """Zero every expired batch (expiry_date <= as_of) with stock, in one store or all stores.
    Returns [{batch_id, store_id, medicine_id, batch_no, expiry_date, qty, unit_cost, value}]."""
    as_of = _date(as_of, "as_of")
    ts = db.now_iso()
    with db.tx():
        if store_id:
            _store(store_id)
        rows = db.query("SELECT * FROM batches WHERE qty_on_hand > 0 AND expiry_date <= ?"
                        + (" AND store_id = ?" if store_id else "") + " ORDER BY store_id, medicine_id, expiry_date",
                        (as_of, store_id) if store_id else (as_of,))
        out = []
        for b in rows:
            _take(b["id"], b["qty_on_hand"])
            _mv(b["store_id"], b["medicine_id"], b["id"], "expire_writeoff", -b["qty_on_hand"], b["unit_cost"],
                None, f"Expired {b['expiry_date']}", user_id, ts)
            out.append({"batch_id": b["id"], "store_id": b["store_id"], "medicine_id": b["medicine_id"],
                        "batch_no": b["batch_no"], "expiry_date": b["expiry_date"], "qty": b["qty_on_hand"],
                        "unit_cost": b["unit_cost"], "value": b["qty_on_hand"] * b["unit_cost"]})
        return out


@_guard
def transfer(from_store: str, to_store: str, medicine_id: str, qty: int, user_id: int | None,
             reason: str | None = None, allow_partial: bool = False, as_of: date | str | None = None) -> dict:
    """Move stock between stores, FEFO from the source's non-expired batches. Destination batches keep
    batch_no / expiry / unit_cost (merged into an existing identical batch, Conflict if the same
    batch_no exists there with another expiry). Writes transfer_out/transfer_in movements and a
    `transfers` row atomically; total units are conserved."""
    qty = _qty(qty)
    _med(medicine_id)
    if from_store == to_store:
        raise InventoryError("Source and destination store must differ")
    as_of = _date(as_of, "as_of")
    reason = _text(reason, "reason", 500, truncate=True)
    ts = db.now_iso()
    with db.tx():
        _store(from_store)
        _store(to_store)
        alloc = _allocate(from_store, medicine_id, qty, as_of, allow_partial, "transfer")
        moved = sum(a.qty for a in alloc)
        if moved == 0:
            raise InsufficientStock(f"No sellable stock of {medicine_id} at {from_store}", 0)
        tid = db.execute("INSERT INTO transfers(from_store, to_store, medicine_id, qty, status, reason, created_by, created_at) "
                         "VALUES (?,?,?,?,'completed',?,?,?)",
                         (from_store, to_store, medicine_id, moved, reason, user_id, ts)).lastrowid
        ref = f"TR-{tid}"
        for a in alloc:
            src = _batch(a.batch_id)
            _take(a.batch_id, a.qty)
            _mv(from_store, medicine_id, a.batch_id, "transfer_out", -a.qty, src["unit_cost"], ref, reason, user_id, ts)
            dst = db.query_one("SELECT * FROM batches WHERE store_id=? AND medicine_id=? AND batch_no=?",
                               (to_store, medicine_id, src["batch_no"]))
            if dst is None:
                did = db.execute("INSERT INTO batches(store_id, medicine_id, batch_no, expiry_date, qty_received, qty_on_hand, "
                                 "unit_cost, supplier_id, received_at, source) VALUES (?,?,?,?,?,?,?,?,?,'transfer')",
                                 (to_store, medicine_id, src["batch_no"], src["expiry_date"], a.qty, a.qty,
                                  src["unit_cost"], src["supplier_id"], ts)).lastrowid
            else:
                if dst["expiry_date"] != src["expiry_date"]:
                    raise Conflict(f"Batch {src['batch_no']} exists at {to_store} with a different expiry "
                                   f"({dst['expiry_date']} vs {src['expiry_date']})")
                did = dst["id"]
                tot = dst["qty_on_hand"] + a.qty
                cost = (dst["unit_cost"] * dst["qty_on_hand"] + src["unit_cost"] * a.qty) / tot
                db.execute("UPDATE batches SET qty_on_hand = qty_on_hand + ?, qty_received = qty_received + ?, unit_cost = ? "
                           "WHERE id = ?", (a.qty, a.qty, cost, did))
            _mv(to_store, medicine_id, did, "transfer_in", a.qty, src["unit_cost"], ref, reason, user_id, ts)
        return {"transfer_id": tid, "ref": ref, "moved": moved, "requested": qty, "from_store": from_store,
                "to_store": to_store, "medicine_id": medicine_id, "allocation": alloc}


# ---------------------------------------------------------------------------------------------
# reports
# ---------------------------------------------------------------------------------------------
def near_expiry(store_id: str | None = None, days: int = 90, as_of: date | str | None = None,
                include_expired: bool = False) -> pd.DataFrame:
    """Batches with stock expiring within `days` (days_left in 1..days; with include_expired also
    days_left <= 0), soonest first. value = qty x unit_cost."""
    as_of = _date(as_of, "as_of")
    days = _int_arg(days, "days", 0, 3650)
    limit_date = (date.fromisoformat(as_of) + timedelta(days=days)).isoformat()
    sql = ("SELECT id AS batch_id, store_id, medicine_id, batch_no, expiry_date, qty_on_hand AS qty, unit_cost, supplier_id "
           "FROM batches WHERE qty_on_hand > 0 AND expiry_date <= ?" + ("" if include_expired else " AND expiry_date > ?")
           + (" AND store_id = ?" if store_id else "") + " ORDER BY expiry_date, store_id, medicine_id")
    params: list = [limit_date] + ([] if include_expired else [as_of]) + ([store_id] if store_id else [])
    cols = ["store_id", "medicine_id", "medicine_name", "category", "batch_id", "batch_no", "expiry_date", "days_left",
            "qty", "unit_cost", "value", "expired", "supplier_id"]
    df = pd.DataFrame(db.query(sql, params))
    if df.empty:
        return pd.DataFrame(columns=cols)
    df["days_left"] = [_days_left(e, as_of) for e in df["expiry_date"]]
    df["expired"] = df["days_left"] <= 0
    df["value"] = df["qty"] * df["unit_cost"]
    df["medicine_name"] = S.meds["medicine_name"].reindex(df["medicine_id"]).to_numpy()
    df["category"] = S.meds["category"].reindex(df["medicine_id"]).to_numpy()
    return df[cols]


def movements(store_id: str | None = None, medicine_id: str | None = None, limit: int = 100, offset: int = 0,
              kind: str | None = None) -> list[dict]:
    """Movement ledger, newest first, with batch_no, expiry_date, username and medicine_name joined."""
    where, params = _mv_where(store_id, medicine_id, kind)
    limit = _int_arg(limit, "limit", 1, 1000)
    offset = _int_arg(offset, "offset", 0, 10**9)
    rows = db.query("SELECT m.*, b.batch_no, b.expiry_date, u.username FROM movements m "
                    "LEFT JOIN batches b ON b.id = m.batch_id LEFT JOIN users u ON u.id = m.user_id"
                    + where + " ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?",
                    params + [limit, offset])
    names = S.meds["medicine_name"]
    for r in rows:
        r["medicine_name"] = names.get(r["medicine_id"])
    return rows


def count_movements(store_id: str | None = None, medicine_id: str | None = None, kind: str | None = None) -> int:
    where, params = _mv_where(store_id, medicine_id, kind)
    return int(db.scalar("SELECT COUNT(*) FROM movements m" + where, params, default=0))


def _mv_where(store_id, medicine_id, kind) -> tuple[str, list]:
    cond, params = [], []
    if store_id:
        cond.append("m.store_id = ?")
        params.append(store_id)
    if medicine_id:
        cond.append("m.medicine_id = ?")
        params.append(medicine_id)
    if kind:
        if kind not in MOVEMENT_KINDS:
            raise InventoryError(f"Unknown movement kind '{kind}'")
        cond.append("m.kind = ?")
        params.append(kind)
    return (" WHERE " + " AND ".join(cond)) if cond else "", params


def transfers(store_id: str | None = None, medicine_id: str | None = None, limit: int = 100, offset: int = 0) -> list[dict]:
    """Transfers touching a store (either side), newest first, with creator username and medicine_name."""
    cond, params = [], []
    if store_id:
        cond.append("(t.from_store = ? OR t.to_store = ?)")
        params += [store_id, store_id]
    if medicine_id:
        cond.append("t.medicine_id = ?")
        params.append(medicine_id)
    where = (" WHERE " + " AND ".join(cond)) if cond else ""
    rows = db.query("SELECT t.*, u.username AS created_by_username FROM transfers t LEFT JOIN users u ON u.id = t.created_by"
                    + where + " ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?",
                    params + [_int_arg(limit, "limit", 1, 1000), _int_arg(offset, "offset", 0, 10**9)])
    names = S.meds["medicine_name"]
    for r in rows:
        r["medicine_name"] = names.get(r["medicine_id"])
    return rows
