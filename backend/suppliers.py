"""Suppliers, purchase orders, receiving and learned lead times (service layer).

Public contract (imported by other features, e.g. the planner and dead-stock agents):

    lead_time_weeks(medicine_id, store_id=None) -> float     learned mean lead time of the preferred supplier
    lead_time_info(medicine_id, store_id=None)  -> dict      mean / p90 / n / status ("default" | "learning" | "learned")
    preferred_supplier(medicine_id) -> str | None            per-medicine override, else most frequent in sales history
    return_policy(supplier_id) -> {accepts_returns, min_days_before_expiry, credit_pct}

Learned lead times
------------------
Every delivery (all receipts of one PO on one calendar day) is one observation:
    days = received_at - sent_at.
Per supplier we shrink the sample toward the supplier's default_lead_days with a normal-normal model in which the
default counts as PRIOR_K = 3 pseudo-deliveries:
    mean = (k * default + sum(days)) / (k + n)
    var  = (k * (PRIOR_CV * default)^2 + SS + k*n/(k+n) * (xbar - default)^2) / (k + n)
    p90  = mean + 1.2816 * sd           (one-sided 90 %, used for safety stock)
With no deliveries the default is returned unchanged and the status is "default". Nothing is fabricated: the history
starts empty and the model only learns from POs actually sent and received in this app.

Store-specific: when a store is given and that store has at least one delivery from the supplier, only that store's
deliveries are used; otherwise all stores' deliveries are pooled.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any

from backend import db

COMPONENT = "suppliers"
PRIOR_K = 3.0               # the default lead time counts as this many deliveries
PRIOR_CV = 0.35             # assumed coefficient of variation of the default lead time
Z90 = 1.2816
DEFAULT_LEAD_DAYS = 7.0     # = the optimizer's / planner's default 1-week lead time
DEFAULT_GST = 12.0          # common GST rate for medicines; editable per line (verify HSN rate with your CA)
SHORT_EXPIRY_DAYS = 183     # "short expiry" warning when a received batch expires within ~6 months
LEARNED_N = 5               # deliveries after which the estimate is labelled "learned"
STATUSES = ("draft", "sent", "partially_received", "received", "cancelled")
OPEN_STATUSES = ("sent", "partially_received")
POLICY_KEY = "suppliers.return_policy"
POLICY_DEFAULT = {"accepts_returns": True, "min_days_before_expiry": 90, "credit_pct": 0.8}
SUP_ID_RE = re.compile(r"^SUP\d{3,6}$")

db.register_schema(COMPONENT, [
    # step 1: tables
    """
    CREATE TABLE IF NOT EXISTS suppliers_master (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        gstin             TEXT,
        contact           TEXT,
        phone             TEXT,
        email             TEXT,
        default_lead_days REAL NOT NULL DEFAULT 7 CHECK (default_lead_days > 0 AND default_lead_days <= 120),
        return_policy     TEXT,
        payment_terms     TEXT,
        notes             TEXT,
        active            INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT NOT NULL,
        updated_at        TEXT
    );
    CREATE TABLE IF NOT EXISTS suppliers_med_pref (
        medicine_id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers_master(id),
        updated_by  INTEGER,
        updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suppliers_po (
        id          INTEGER PRIMARY KEY,
        po_no       TEXT NOT NULL UNIQUE,
        store_id    TEXT NOT NULL REFERENCES stores(id),
        supplier_id TEXT NOT NULL REFERENCES suppliers_master(id),
        status      TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','partially_received','received','cancelled')),
        source      TEXT NOT NULL DEFAULT 'manual',
        fy          TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        created_by  INTEGER,
        created_at  TEXT NOT NULL,
        sent_at     TEXT,
        expected_at TEXT,
        closed_at   TEXT,
        notes       TEXT,
        total_value REAL NOT NULL DEFAULT 0,
        UNIQUE (store_id, fy, seq)
    );
    CREATE INDEX IF NOT EXISTS suppliers_po_store ON suppliers_po(store_id, status);
    CREATE INDEX IF NOT EXISTS suppliers_po_supplier ON suppliers_po(supplier_id, status);
    CREATE TABLE IF NOT EXISTS suppliers_po_lines (
        id           INTEGER PRIMARY KEY,
        po_id        INTEGER NOT NULL REFERENCES suppliers_po(id) ON DELETE CASCADE,
        medicine_id  TEXT NOT NULL,
        qty_ordered  INTEGER NOT NULL CHECK (qty_ordered > 0),
        qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
        unit_cost    REAL NOT NULL CHECK (unit_cost >= 0),
        gst_rate     REAL NOT NULL DEFAULT 12 CHECK (gst_rate >= 0 AND gst_rate <= 28),
        UNIQUE (po_id, medicine_id)
    );
    CREATE TABLE IF NOT EXISTS suppliers_receipts (
        id          INTEGER PRIMARY KEY,
        po_id       INTEGER NOT NULL REFERENCES suppliers_po(id),
        line_id     INTEGER NOT NULL REFERENCES suppliers_po_lines(id),
        batch_id    INTEGER REFERENCES batches(id),
        batch_no    TEXT,
        expiry_date TEXT,
        qty         INTEGER NOT NULL CHECK (qty > 0),
        unit_cost   REAL NOT NULL,
        received_at TEXT NOT NULL,
        user_id     INTEGER
    );
    CREATE INDEX IF NOT EXISTS suppliers_receipts_po ON suppliers_receipts(po_id);
    CREATE TABLE IF NOT EXISTS suppliers_events (
        id         INTEGER PRIMARY KEY,
        po_id      INTEGER REFERENCES suppliers_po(id),
        supplier_id TEXT,
        kind       TEXT NOT NULL,
        detail     TEXT,
        user_id    INTEGER,
        created_at TEXT NOT NULL
    );
    """,
    # step 2: the 15 supplier ids present in the sales history, with neutral editable names
    """
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 15)
    INSERT OR IGNORE INTO suppliers_master(id, name, default_lead_days, active, created_at)
    SELECT printf('SUP%03d', i), printf('Supplier %02d', i), 7, 1, strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now') FROM n;
    """,
])


class SupplierError(ValueError):
    status = 400


class NotFound(SupplierError):
    status = 404


class Conflict(SupplierError):
    status = 409


# ─────────────────────────── small helpers ───────────────────────────

def today() -> date:
    return date.today()


def fy_label(d: date) -> str:
    """Indian financial year (April-March), e.g. 2026-10-01 -> '26-27'."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def _parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso_date(v: str | date | None, field: str) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, date):
        return v.isoformat()
    try:
        return date.fromisoformat(str(v)[:10]).isoformat()
    except ValueError:
        raise SupplierError(f"{field} must be a date YYYY-MM-DD")


def event(kind: str, *, po_id: int | None = None, supplier_id: str | None = None, detail: Any = None,
          user_id: int | None = None) -> None:
    db.execute("INSERT INTO suppliers_events(po_id, supplier_id, kind, detail, user_id, created_at) VALUES (?,?,?,?,?,?)",
               (po_id, supplier_id, kind, json.dumps(detail, default=str) if detail is not None else None, user_id,
                db.now_iso()))


# ─────────────────────────── suppliers master ───────────────────────────

def _row_to_supplier(r: dict) -> dict:
    out = dict(r)
    out["active"] = bool(out.get("active"))
    try:
        out["return_policy_override"] = json.loads(r["return_policy"]) if r.get("return_policy") else None
    except (TypeError, ValueError):
        out["return_policy_override"] = None
    out.pop("return_policy", None)
    out["return_policy"] = return_policy(r["id"], _override=out["return_policy_override"])
    return out


def list_suppliers(include_inactive: bool = True) -> list[dict]:
    rows = db.query("SELECT * FROM suppliers_master" + ("" if include_inactive else " WHERE active = 1") + " ORDER BY id")
    return [_row_to_supplier(r) for r in rows]


def get_supplier(supplier_id: str) -> dict:
    r = db.query_one("SELECT * FROM suppliers_master WHERE id = ?", (supplier_id,))
    if not r:
        raise NotFound(f"Unknown supplier '{supplier_id}'")
    return _row_to_supplier(r)


def _clean_policy(p: dict | None) -> dict | None:
    if p is None:
        return None
    if not isinstance(p, dict):
        raise SupplierError("return_policy must be an object")
    out = {}
    if "accepts_returns" in p and p["accepts_returns"] is not None:
        out["accepts_returns"] = bool(p["accepts_returns"])
    if "min_days_before_expiry" in p and p["min_days_before_expiry"] is not None:
        try:
            f = float(p["min_days_before_expiry"])
        except (TypeError, ValueError):
            raise SupplierError("min_days_before_expiry must be a whole number of days 0-730")
        if not (math.isfinite(f) and 0 <= f <= 730 and f == int(f)):
            raise SupplierError("min_days_before_expiry must be a whole number of days 0-730")
        out["min_days_before_expiry"] = int(f)
    if "credit_pct" in p and p["credit_pct"] is not None:
        try:
            v = float(p["credit_pct"])
        except (TypeError, ValueError):
            raise SupplierError("credit_pct must be a fraction 0-1")
        if not (math.isfinite(v) and 0 <= v <= 1):
            raise SupplierError("credit_pct must be a fraction 0-1")
        out["credit_pct"] = v
    return out


SUPPLIER_FIELDS = ("name", "gstin", "contact", "phone", "email", "default_lead_days", "payment_terms", "notes", "active")


def create_supplier(fields: dict, user_id: int | None = None) -> dict:
    with db.tx():
        n = db.scalar("SELECT MAX(CAST(SUBSTR(id, 4) AS INTEGER)) FROM suppliers_master WHERE id LIKE 'SUP%'", (), 0) or 0
        sid = f"SUP{int(n) + 1:03d}"
        db.execute("INSERT INTO suppliers_master(id, name, created_at, default_lead_days) VALUES (?,?,?,?)",
                   (sid, fields.get("name") or sid, db.now_iso(), fields.get("default_lead_days") or DEFAULT_LEAD_DAYS))
        update_supplier(sid, fields, user_id=user_id, _event=False)
        event("supplier_created", supplier_id=sid, user_id=user_id)
    return get_supplier(sid)


def update_supplier(supplier_id: str, fields: dict, user_id: int | None = None, _event: bool = True) -> dict:
    """fields: any of SUPPLIER_FIELDS plus return_policy (dict, or None to fall back to the default)."""
    with db.tx():
        get_supplier(supplier_id)
        sets, vals = [], []
        for k in SUPPLIER_FIELDS:
            if k in fields:
                v = fields[k]
                if k == "active":
                    v = 1 if v else 0
                if k in ("name", "default_lead_days") and not v:
                    continue          # required columns: an empty value keeps the current one
                sets.append(f"{k} = ?")
                vals.append(v)
        if "return_policy" in fields:
            pol = _clean_policy(fields["return_policy"])
            sets.append("return_policy = ?")
            vals.append(json.dumps(pol) if pol else None)
        if sets:
            sets.append("updated_at = ?")
            vals.append(db.now_iso())
            db.execute(f"UPDATE suppliers_master SET {', '.join(sets)} WHERE id = ?", (*vals, supplier_id))
            if _event:
                event("supplier_updated", supplier_id=supplier_id, user_id=user_id,
                      detail=sorted(k for k in fields if k in SUPPLIER_FIELDS or k == "return_policy"))
    return get_supplier(supplier_id)


def policy_default() -> dict:
    stored = db.get_setting(POLICY_KEY, None)
    out = dict(POLICY_DEFAULT)
    if isinstance(stored, dict):
        try:
            out.update(_clean_policy(stored) or {})
        except (SupplierError, TypeError, ValueError):
            pass
    return out


def set_policy_default(p: dict) -> dict:
    pol = {**POLICY_DEFAULT, **(_clean_policy(p) or {})}
    db.set_setting(POLICY_KEY, pol)
    return pol


def return_policy(supplier_id: str | None, _override: dict | None | bool = False) -> dict:
    """{accepts_returns, min_days_before_expiry, credit_pct}: supplier override merged over the settings default."""
    out = policy_default()
    if _override is False:
        r = db.query_one("SELECT return_policy FROM suppliers_master WHERE id = ?", (supplier_id,)) if supplier_id else None
        try:
            _override = json.loads(r["return_policy"]) if r and r["return_policy"] else None
        except (TypeError, ValueError):
            _override = None
    if isinstance(_override, dict):
        out.update({k: v for k, v in _override.items() if k in POLICY_DEFAULT})
    out["source"] = "supplier" if _override else "default"
    return out


# ─────────────────────────── preferred supplier ───────────────────────────

def inferred_ready() -> bool:
    """True once the sales-history supplier table is cached (it takes ~20 s to parse after a cold start)."""
    try:
        from backend.routers.optimizer import _preferred_suppliers
        return _preferred_suppliers.cache_info().currsize > 0
    except Exception:  # noqa: BLE001
        return False


def _inferred(wait: bool = True) -> Any:
    """medicine_id -> supplier_id inferred from the sales history (optimizer's cached table).
    wait=False returns an empty table instead of blocking while the cache warms up."""
    try:
        from backend.routers.optimizer import preferred_suppliers
        if not wait and not inferred_ready():
            raise LookupError("warming up")
        return preferred_suppliers()
    except Exception:  # noqa: BLE001
        import pandas as pd
        return pd.DataFrame(columns=["supplier_id", "share", "n_suppliers"])


def preferred_map(wait: bool = True) -> dict[str, dict]:
    """{medicine_id: {supplier_id, source: override|history, share}} for every medicine with an assignment."""
    out: dict[str, dict] = {}
    inf = _inferred(wait)
    for mid, r in inf.iterrows():
        out[mid] = {"supplier_id": r["supplier_id"], "source": "history",
                    "share": float(r["share"]) if r["share"] == r["share"] else None}
    for r in db.query("SELECT medicine_id, supplier_id FROM suppliers_med_pref"):
        out[r["medicine_id"]] = {"supplier_id": r["supplier_id"], "source": "override", "share": None}
    return out


def preferred_supplier(medicine_id: str) -> str | None:
    r = db.query_one("SELECT supplier_id FROM suppliers_med_pref WHERE medicine_id = ?", (medicine_id,))
    if r:
        return r["supplier_id"]
    inf = _inferred()
    if medicine_id in inf.index:
        return str(inf.at[medicine_id, "supplier_id"])
    return None


def set_preferred(medicine_id: str, supplier_id: str | None, user_id: int | None = None) -> dict:
    with db.tx():
        if supplier_id is None:
            db.execute("DELETE FROM suppliers_med_pref WHERE medicine_id = ?", (medicine_id,))
        else:
            get_supplier(supplier_id)
            db.execute("INSERT INTO suppliers_med_pref(medicine_id, supplier_id, updated_by, updated_at) VALUES (?,?,?,?) "
                       "ON CONFLICT(medicine_id) DO UPDATE SET supplier_id = excluded.supplier_id, "
                       "updated_by = excluded.updated_by, updated_at = excluded.updated_at",
                       (medicine_id, supplier_id, user_id, db.now_iso()))
        event("preferred_set", supplier_id=supplier_id, user_id=user_id, detail={"medicine_id": medicine_id})
    return {"medicine_id": medicine_id, "supplier_id": preferred_supplier(medicine_id),
            "source": "override" if supplier_id else "history"}


# ─────────────────────────── learned lead times ───────────────────────────

def _local_day(ts: str | None) -> str | None:
    """UTC ISO timestamp -> the server's local calendar date (expected_at and today() are local dates)."""
    dt = _parse_ts(ts)
    return dt.astimezone().date().isoformat() if dt else None


def deliveries(supplier_id: str | None = None, store_id: str | None = None) -> list[dict]:
    """One row per delivery (PO x local receipt day): supplier_id, store_id, po_id, po_no, received_on, days, on_time."""
    where, params = ["p.sent_at IS NOT NULL"], []
    if supplier_id:
        where.append("p.supplier_id = ?")
        params.append(supplier_id)
    if store_id:
        where.append("p.store_id = ?")
        params.append(store_id)
    rows = db.query(
        "SELECT p.id AS po_id, p.po_no, p.supplier_id, p.store_id, p.sent_at, p.expected_at, r.received_at, r.qty "
        "FROM suppliers_receipts r JOIN suppliers_po p ON p.id = r.po_id "
        f"WHERE {' AND '.join(where)} ORDER BY r.received_at, r.id", params)
    groups: dict[tuple, dict] = {}
    for r in rows:
        day = _local_day(r["received_at"])
        key = (r["po_id"], day)
        g = groups.get(key)
        if g is None:
            groups[key] = {k: r[k] for k in ("po_id", "po_no", "supplier_id", "store_id", "sent_at", "expected_at",
                                              "received_at")} | {"received_on": day, "units": int(r["qty"])}
        else:
            g["units"] += int(r["qty"])
    out = []
    for g in groups.values():
        s, e = _parse_ts(g["sent_at"]), _parse_ts(g["received_at"])
        if not s or not e:
            continue
        days = max((e - s).total_seconds() / 86400.0, 0.0)
        out.append({**g, "days": round(days, 2),
                    "on_time": (g["received_on"] <= g["expected_at"]) if g["expected_at"] else None})
    out.sort(key=lambda d: d["received_at"])
    return out


def shrink(default_days: float, obs: list[float]) -> dict:
    d = float(default_days or DEFAULT_LEAD_DAYS)
    n = len(obs)
    prior_sd = PRIOR_CV * d
    if n == 0:
        mean, sd = d, prior_sd
        xbar = None
    else:
        xbar = sum(obs) / n
        ss = sum((x - xbar) ** 2 for x in obs)
        mean = (PRIOR_K * d + n * xbar) / (PRIOR_K + n)
        var = (PRIOR_K * prior_sd ** 2 + ss + PRIOR_K * n / (PRIOR_K + n) * (xbar - d) ** 2) / (PRIOR_K + n)
        sd = math.sqrt(max(var, 0.0))
    return {
        "mean_days": round(mean, 2), "p90_days": round(mean + Z90 * sd, 2), "sd_days": round(sd, 2),
        "n": n, "sample_mean_days": round(xbar, 2) if xbar is not None else None,
        "sample_p90_days": round(_quantile(obs, 0.9), 2) if n >= 5 else None,
        "default_days": d, "weight_on_data": round(n / (PRIOR_K + n), 3),
        "status": "default" if n == 0 else ("learning" if n < LEARNED_N else "learned"),
        "mean_weeks": round(mean / 7, 3), "p90_weeks": round((mean + Z90 * sd) / 7, 3),
    }


def _quantile(xs: list[float], q: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    pos = (len(s) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def supplier_lead(supplier_id: str, store_id: str | None = None) -> dict:
    r = db.query_one("SELECT default_lead_days FROM suppliers_master WHERE id = ?", (supplier_id,))
    default = float(r["default_lead_days"]) if r else DEFAULT_LEAD_DAYS
    scope = "all stores"
    obs = []
    if store_id:
        obs = [x["days"] for x in deliveries(supplier_id, store_id)]
        scope = store_id
    if not obs:
        obs = [x["days"] for x in deliveries(supplier_id)]
        scope = "all stores"
    return {"supplier_id": supplier_id, "scope": scope, **shrink(default, obs)}


def lead_time_info(medicine_id: str, store_id: str | None = None) -> dict:
    sid = preferred_supplier(medicine_id)
    if not sid:
        return {"medicine_id": medicine_id, "supplier_id": None, **shrink(DEFAULT_LEAD_DAYS, []), "scope": None}
    return {"medicine_id": medicine_id, **supplier_lead(sid, store_id)}


def lead_time_weeks(medicine_id: str, store_id: str | None = None) -> float:
    """Learned mean lead time (weeks) of the medicine's preferred supplier, shrunk toward its default."""
    try:
        return float(lead_time_info(medicine_id, store_id)["mean_weeks"])
    except Exception:  # noqa: BLE001 - planner integration must never fail on this
        return DEFAULT_LEAD_DAYS / 7


# ─────────────────────────── scorecards ───────────────────────────

def scorecards(store_ids: list[str] | None = None) -> dict[str, dict]:
    """Per supplier: lead time, on-time %, fill rate, price index, open POs. store_ids=None = all stores."""
    sups = {r["id"]: r for r in db.query("SELECT id, default_lead_days FROM suppliers_master")}
    st_sql, st_par = "", []
    if store_ids is not None:
        if not store_ids:
            store_ids = ["__none__"]
        st_sql = f" AND p.store_id IN ({','.join('?' * len(store_ids))})"
        st_par = list(store_ids)

    dels: dict[str, list[dict]] = {}
    for d in deliveries():
        if store_ids is None or d["store_id"] in store_ids:
            dels.setdefault(d["supplier_id"], []).append(d)

    # On-time: closed (received) POs with an expected date, judged by their last delivery; plus open POs already overdue.
    today_s = today().isoformat()
    ot: dict[str, list[bool]] = {}
    for r in db.query("SELECT p.id, p.supplier_id, p.status, p.expected_at, MAX(r.received_at) AS last_rcv "
                      "FROM suppliers_po p LEFT JOIN suppliers_receipts r ON r.po_id = p.id "
                      f"WHERE p.expected_at IS NOT NULL AND p.sent_at IS NOT NULL{st_sql} GROUP BY p.id", st_par):
        last_day = _local_day(r["last_rcv"])
        if r["status"] == "received" and last_day:
            ot.setdefault(r["supplier_id"], []).append(last_day <= r["expected_at"])
        elif r["status"] in OPEN_STATUSES and r["expected_at"] < today_s:
            ot.setdefault(r["supplier_id"], []).append(False)

    fill = {r["supplier_id"]: r for r in db.query(
        "SELECT p.supplier_id, SUM(l.qty_ordered) AS ordered, SUM(l.qty_received) AS received, COUNT(DISTINCT p.id) AS n "
        "FROM suppliers_po p JOIN suppliers_po_lines l ON l.po_id = p.id "
        f"WHERE p.status = 'received'{st_sql} GROUP BY p.supplier_id", st_par)}

    openp = {r["supplier_id"]: r for r in db.query(
        "SELECT p.supplier_id, COUNT(*) AS n, SUM(p.total_value) AS value FROM suppliers_po p "
        f"WHERE p.status IN ('draft','sent','partially_received'){st_sql} GROUP BY p.supplier_id", st_par)}

    # Price index: each supplier's qty-weighted received unit cost of a medicine vs the MEDIAN ACROSS SUPPLIERS of
    # those per-supplier costs (so a supplier with many receipts does not set the benchmark on its own).
    rc = db.query("SELECT p.supplier_id, l.medicine_id, r.qty, r.unit_cost FROM suppliers_receipts r "
                  "JOIN suppliers_po p ON p.id = r.po_id JOIN suppliers_po_lines l ON l.id = r.line_id "
                  f"WHERE 1=1{st_sql}", st_par)
    agg: dict[tuple[str, str], list[float]] = {}           # (supplier, medicine) -> [qty, value]
    spend: dict[str, float] = {}
    for r in rc:
        a = agg.setdefault((r["supplier_id"], r["medicine_id"]), [0.0, 0.0])
        a[0] += r["qty"]
        a[1] += r["qty"] * float(r["unit_cost"])
        spend[r["supplier_id"]] = spend.get(r["supplier_id"], 0.0) + r["qty"] * float(r["unit_cost"])
    per_med: dict[str, list[float]] = {}
    for (sid_, mid), (q, v) in agg.items():
        if q > 0:
            per_med.setdefault(mid, []).append(v / q)
    med_median = {m: median(v) for m, v in per_med.items() if len(v) >= 2}
    pidx: dict[str, list] = {}
    for (sid_, mid), (q, v) in agg.items():
        m = med_median.get(mid)
        if not m or m <= 0 or q <= 0:
            continue
        a = pidx.setdefault(sid_, [0.0, 0.0, set()])
        a[0] += v
        a[1] += q * m
        a[2].add(mid)

    out = {}
    for sid, s in sups.items():
        ds = dels.get(sid, [])
        lead = shrink(s["default_lead_days"], [d["days"] for d in ds])
        o = ot.get(sid, [])
        f = fill.get(sid)
        p = pidx.get(sid)
        op = openp.get(sid) or {}
        out[sid] = {
            "lead": lead,
            "lead_history": [{"po_no": d["po_no"], "received_on": d["received_on"], "days": d["days"],
                              "on_time": d["on_time"]} for d in ds[-24:]],
            "on_time_pct": (sum(o) / len(o)) if o else None, "on_time_n": len(o),
            "fill_rate": (f["received"] / f["ordered"]) if f and f["ordered"] else None, "fill_n": f["n"] if f else 0,
            "price_index": (p[0] / p[1]) if p and p[1] > 0 else None, "price_n": len(p[2]) if p else 0,
            "open_pos": int(op.get("n") or 0), "open_value": float(op.get("value") or 0.0),
            "received_value": round(spend.get(sid, 0.0), 2),
        }
    return out


# ─────────────────────────── purchase orders ───────────────────────────

def _po(po_id: int) -> dict:
    r = db.query_one("SELECT * FROM suppliers_po WHERE id = ?", (po_id,))
    if not r:
        raise NotFound(f"Purchase order {po_id} not found")
    return r


def _lines(po_id: int) -> list[dict]:
    return db.query("SELECT * FROM suppliers_po_lines WHERE po_id = ? ORDER BY id", (po_id,))


def _recompute_total(po_id: int) -> None:
    db.execute("UPDATE suppliers_po SET total_value = COALESCE((SELECT ROUND(SUM(qty_ordered * unit_cost), 2) "
               "FROM suppliers_po_lines WHERE po_id = ?), 0) WHERE id = ?", (po_id, po_id))


def _check_lines(lines: list[dict], known: set[str]) -> list[dict]:
    if not lines:
        raise SupplierError("A purchase order needs at least one line")
    seen, out = set(), []
    for ln in lines:
        mid = str(ln["medicine_id"]).strip().upper()
        if mid not in known:
            raise SupplierError(f"Unknown medicine '{mid}'")
        if mid in seen:
            raise SupplierError(f"{mid} appears twice; combine it into one line")
        seen.add(mid)
        out.append({"medicine_id": mid, "qty_ordered": int(ln["qty_ordered"]), "unit_cost": float(ln["unit_cost"]),
                    "gst_rate": float(ln.get("gst_rate", DEFAULT_GST) if ln.get("gst_rate") is not None else DEFAULT_GST)})
    return out


def create_po(store_id: str, supplier_id: str, lines: list[dict], *, known: set[str], user_id: int | None = None,
              notes: str | None = None, expected_at: str | None = None, source: str = "manual") -> dict:
    lines = _check_lines(lines, known)
    expected_at = _iso_date(expected_at, "expected_at")
    with db.tx():
        sup = get_supplier(supplier_id)
        if not sup["active"]:
            raise Conflict(f"Supplier {supplier_id} is inactive")
        if not db.query_one("SELECT 1 FROM stores WHERE id = ?", (store_id,)):
            raise NotFound(f"Unknown store '{store_id}'")
        fy = fy_label(today())
        seq = int(db.scalar("SELECT COALESCE(MAX(seq), 0) FROM suppliers_po WHERE store_id = ? AND fy = ?",
                            (store_id, fy), 0) or 0) + 1
        po_no = f"{store_id}/PO/{fy}/{seq:04d}"
        pid = db.execute("INSERT INTO suppliers_po(po_no, store_id, supplier_id, status, source, fy, seq, created_by, "
                         "created_at, expected_at, notes) VALUES (?,?,?,'draft',?,?,?,?,?,?,?)",
                         (po_no, store_id, supplier_id, source, fy, seq, user_id, db.now_iso(), expected_at,
                          notes)).lastrowid
        db.executemany("INSERT INTO suppliers_po_lines(po_id, medicine_id, qty_ordered, unit_cost, gst_rate) VALUES (?,?,?,?,?)",
                       [(pid, l["medicine_id"], l["qty_ordered"], l["unit_cost"], l["gst_rate"]) for l in lines])
        _recompute_total(pid)
        event("po_created", po_id=pid, supplier_id=supplier_id, user_id=user_id, detail={"source": source, "lines": len(lines)})
    return po_detail(pid)


def update_po(po_id: int, *, known: set[str], lines: list[dict] | None = None, supplier_id: str | None = None,
              notes: str | None | bool = False, expected_at: str | None | bool = False, user_id: int | None = None) -> dict:
    with db.tx():
        po = _po(po_id)
        if po["status"] != "draft":
            raise Conflict(f"{po['po_no']} is {po['status'].replace('_', ' ')}; only drafts can be edited")
        if supplier_id and supplier_id != po["supplier_id"]:
            if not get_supplier(supplier_id)["active"]:
                raise Conflict(f"Supplier {supplier_id} is inactive")
            db.execute("UPDATE suppliers_po SET supplier_id = ? WHERE id = ?", (supplier_id, po_id))
        if notes is not False:
            db.execute("UPDATE suppliers_po SET notes = ? WHERE id = ?", (notes, po_id))
        if expected_at is not False:
            db.execute("UPDATE suppliers_po SET expected_at = ? WHERE id = ?", (_iso_date(expected_at, "expected_at"), po_id))
        if lines is not None:
            lines = _check_lines(lines, known)
            db.execute("DELETE FROM suppliers_po_lines WHERE po_id = ?", (po_id,))
            db.executemany("INSERT INTO suppliers_po_lines(po_id, medicine_id, qty_ordered, unit_cost, gst_rate) VALUES (?,?,?,?,?)",
                           [(po_id, l["medicine_id"], l["qty_ordered"], l["unit_cost"], l["gst_rate"]) for l in lines])
            _recompute_total(po_id)
        event("po_edited", po_id=po_id, user_id=user_id)
    return po_detail(po_id)


def mark_sent(po_id: int, expected_at: str | None, user_id: int | None = None) -> dict:
    with db.tx():
        po = _po(po_id)
        if po["status"] != "draft":
            raise Conflict(f"{po['po_no']} is already {po['status'].replace('_', ' ')}")
        if not _lines(po_id):
            raise Conflict("Add at least one line before sending")
        exp = _iso_date(expected_at, "expected_at")
        if not exp:
            lead = supplier_lead(po["supplier_id"], po["store_id"])
            exp = (today() + timedelta(days=math.ceil(lead["mean_days"]))).isoformat()
        if exp < today().isoformat():
            raise SupplierError("expected_at cannot be in the past")
        db.execute("UPDATE suppliers_po SET status = 'sent', sent_at = ?, expected_at = ? WHERE id = ?",
                   (db.now_iso(), exp, po_id))
        event("po_sent", po_id=po_id, supplier_id=po["supplier_id"], user_id=user_id, detail={"expected_at": exp})
    return po_detail(po_id)


def close_po(po_id: int, user_id: int | None = None, reason: str | None = None) -> dict:
    """Close a partially received PO: the remaining quantity is no longer expected (counts against fill rate)."""
    with db.tx():
        po = _po(po_id)
        if po["status"] != "partially_received":
            raise Conflict("Only a partially received PO can be closed short; cancel a PO with no deliveries instead")
        db.execute("UPDATE suppliers_po SET status = 'received', closed_at = ? WHERE id = ?", (db.now_iso(), po_id))
        event("po_closed_short", po_id=po_id, supplier_id=po["supplier_id"], user_id=user_id, detail={"reason": reason})
    return po_detail(po_id)


def cancel_po(po_id: int, user_id: int | None = None, reason: str | None = None) -> dict:
    with db.tx():
        po = _po(po_id)
        if po["status"] not in ("draft", "sent"):
            raise Conflict(f"{po['po_no']} is {po['status'].replace('_', ' ')}; only a draft or sent PO with no deliveries can be cancelled")
        db.execute("UPDATE suppliers_po SET status = 'cancelled', closed_at = ? WHERE id = ?", (db.now_iso(), po_id))
        event("po_cancelled", po_id=po_id, supplier_id=po["supplier_id"], user_id=user_id, detail={"reason": reason})
    return po_detail(po_id)


def receive_po(po_id: int, items: list[dict], *, user_id: int | None, accept_short_expiry: bool = False,
               allowed_store: Any = None, request_id: str | None = None) -> dict:
    """items: [{line_id, qty, batch_no, expiry_date, unit_cost?}]. All-or-nothing in ONE transaction.

    Each item goes through inventory.receive(store, medicine, qty, batch_no, expiry, unit_cost, supplier_id,
    ref=po_no), so the stock ledger invariant is kept by the inventory module. allowed_store(store_id) -> None or
    raises (used by the router for the store-access check inside the same read).

    request_id (optional, client-generated per receive dialog) makes the call idempotent: a retried or
    double-submitted request with the same id on the same PO returns the first result (duplicate=True)
    instead of booking the stock twice."""
    from backend import inventory as inv
    if not items:
        raise SupplierError("Enter at least one received line")
    soon = (today() + timedelta(days=SHORT_EXPIRY_DAYS)).isoformat()
    warnings = []
    with db.tx():
        po = _po(po_id)
        if allowed_store:
            allowed_store(po["store_id"])
        if request_id:
            prev = db.query_one("SELECT detail FROM suppliers_events WHERE po_id = ? AND kind = 'po_received' "
                                "AND json_extract(detail, '$.request_id') = ?", (po_id, request_id))
            if prev:
                d = json.loads(prev["detail"] or "{}")
                return {"po": po_detail(po_id), "received": d.get("received") or [], "short_expiry": [],
                        "duplicate": True}
        if po["status"] not in OPEN_STATUSES:
            raise Conflict(f"{po['po_no']} is {po['status'].replace('_', ' ')}; only a sent or partially received PO "
                           "can be received against (mark the draft as sent first)")
        lines = {l["id"]: l for l in _lines(po_id)}
        want: dict[int, int] = {}
        for it in items:
            ln = lines.get(int(it["line_id"]))
            if not ln:
                raise SupplierError(f"Line {it['line_id']} is not on {po['po_no']}")
            want[ln["id"]] = want.get(ln["id"], 0) + int(it["qty"])
            exp = _iso_date(it.get("expiry_date"), "expiry_date")
            if exp and exp < soon:
                warnings.append({"line_id": ln["id"], "medicine_id": ln["medicine_id"], "batch_no": it.get("batch_no"),
                                 "expiry_date": exp, "days_left": (date.fromisoformat(exp) - today()).days})
        for lid, q in want.items():
            ln = lines[lid]
            left = ln["qty_ordered"] - ln["qty_received"]
            if q > left:
                raise Conflict(f"Over-receipt: {ln['medicine_id']} has {left} unit(s) outstanding on {po['po_no']}, "
                               f"you entered {q}. Raise a new PO for the extra quantity.")
        if warnings and not accept_short_expiry:
            e = Conflict("Short expiry: " + ", ".join(f"{w['medicine_id']} batch {w['batch_no']} expires {w['expiry_date']}"
                                                      for w in warnings) + ". Confirm to accept these batches.")
            e.detail = {"message": str(e), "short_expiry": warnings}
            raise e
        ts = db.now_iso()
        received = []
        for it in items:
            ln = lines[int(it["line_id"])]
            cost = float(it["unit_cost"]) if it.get("unit_cost") is not None else float(ln["unit_cost"])
            b = inv.receive(po["store_id"], ln["medicine_id"], int(it["qty"]), it.get("batch_no"), it.get("expiry_date"),
                            unit_cost=cost, supplier_id=po["supplier_id"], user_id=user_id, ref=po["po_no"],
                            note=f"PO receipt line {ln['id']}")
            db.execute("INSERT INTO suppliers_receipts(po_id, line_id, batch_id, batch_no, expiry_date, qty, unit_cost, "
                       "received_at, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
                       (po_id, ln["id"], b["id"], b["batch_no"], b["expiry_date"], int(it["qty"]), cost, ts, user_id))
            db.execute("UPDATE suppliers_po_lines SET qty_received = qty_received + ? WHERE id = ?", (int(it["qty"]), ln["id"]))
            received.append({"line_id": ln["id"], "medicine_id": ln["medicine_id"], "qty": int(it["qty"]),
                             "batch_id": b["id"], "batch_no": b["batch_no"], "expiry_date": b["expiry_date"]})
        left = db.scalar("SELECT SUM(qty_ordered - qty_received) FROM suppliers_po_lines WHERE po_id = ?", (po_id,), 0)
        status = "received" if not left else "partially_received"
        db.execute("UPDATE suppliers_po SET status = ?, closed_at = ? WHERE id = ?",
                   (status, ts if status == "received" else None, po_id))
        event("po_received", po_id=po_id, supplier_id=po["supplier_id"], user_id=user_id,
              detail={"units": sum(r["qty"] for r in received), "lines": len(received), "short_expiry": len(warnings),
                      "request_id": request_id, "received": received})
    return {"po": po_detail(po_id), "received": received, "short_expiry": warnings, "duplicate": False}


def po_detail(po_id: int) -> dict:
    from backend.core import S
    po = dict(_po(po_id))
    lines = []
    sub = gst = 0.0
    for l in _lines(po_id):
        mid = l["medicine_id"]
        name = S.meds.at[mid, "medicine_name"] if mid in S.meds.index else mid
        amt = l["qty_ordered"] * l["unit_cost"]
        sub += amt
        gst += amt * l["gst_rate"] / 100
        lines.append({**l, "medicine_name": name,
                      "generic_name": S.meds.at[mid, "generic_name"] if mid in S.meds.index else None,
                      "form": S.meds.at[mid, "form"] if mid in S.meds.index else None,
                      "median_price": float(S.meds.at[mid, "median_price"]) if mid in S.meds.index else None,
                      "amount": round(amt, 2), "outstanding": l["qty_ordered"] - l["qty_received"]})
    po["lines"] = lines
    po["subtotal"] = round(sub, 2)
    po["gst"] = round(gst, 2)
    po["grand_total"] = round(sub + gst, 2)
    po["units_ordered"] = sum(l["qty_ordered"] for l in lines)
    po["units_received"] = sum(l["qty_received"] for l in lines)
    po["receipts"] = db.query("SELECT r.*, l.medicine_id FROM suppliers_receipts r JOIN suppliers_po_lines l ON l.id = r.line_id "
                              "WHERE r.po_id = ? ORDER BY r.id", (po_id,))
    po["events"] = db.query("SELECT kind, detail, user_id, created_at FROM suppliers_events WHERE po_id = ? ORDER BY id",
                            (po_id,))
    po["overdue"] = bool(po["status"] in OPEN_STATUSES and po["expected_at"] and po["expected_at"] < today().isoformat())
    return po


def po_text(po: dict, supplier: dict, store: dict) -> str:
    """Plain-text PO for email / WhatsApp share. Contains no patient data."""
    lines = [f"Purchase order {po['po_no']}",
             f"From: {store['name']}{(', ' + store['city']) if store.get('city') else ''}",
             f"To: {supplier['name']} ({supplier['id']})",
             f"Expected by: {po.get('expected_at') or 'to be confirmed'}", ""]
    for i, l in enumerate(po["lines"], 1):
        lines.append(f"{i}. {l['medicine_name']} ({l['medicine_id']}) x {l['qty_ordered']} @ Rs {l['unit_cost']:.2f}")
    lines += ["", f"Subtotal Rs {po['subtotal']:,.2f} + GST Rs {po['gst']:,.2f} = Rs {po['grand_total']:,.2f}",
              "GST shown at the rates entered per line; the supplier's tax invoice is authoritative."]
    if po.get("notes"):
        lines += ["", f"Notes: {po['notes']}"]
    return "\n".join(lines)


def list_pos(store_ids: list[str] | None, status: str | None = None, supplier_id: str | None = None,
             limit: int = 200) -> dict:
    where, params = ["1=1"], []
    if store_ids is not None:
        where.append(f"store_id IN ({','.join('?' * len(store_ids)) or 'NULL'})")
        params += store_ids
    if supplier_id:
        where.append("supplier_id = ?")
        params.append(supplier_id)
    counts = {s: 0 for s in STATUSES}
    for r in db.query(f"SELECT status, COUNT(*) AS n FROM suppliers_po WHERE {' AND '.join(where)} GROUP BY status", params):
        counts[r["status"]] = r["n"]
    if status:
        where.append("status = ?")
        params.append(status)
    rows = db.query(
        "SELECT p.*, (SELECT COUNT(*) FROM suppliers_po_lines l WHERE l.po_id = p.id) AS n_lines, "
        "(SELECT COALESCE(SUM(qty_ordered),0) FROM suppliers_po_lines l WHERE l.po_id = p.id) AS units_ordered, "
        "(SELECT COALESCE(SUM(qty_received),0) FROM suppliers_po_lines l WHERE l.po_id = p.id) AS units_received, "
        "(SELECT name FROM suppliers_master s WHERE s.id = p.supplier_id) AS supplier_name "
        f"FROM suppliers_po p WHERE {' AND '.join(where)} ORDER BY p.id DESC LIMIT ?", (*params, limit))
    t = today().isoformat()
    for r in rows:
        r["overdue"] = bool(r["status"] in OPEN_STATUSES and r["expected_at"] and r["expected_at"] < t)
    return {"counts": counts, "items": rows}
