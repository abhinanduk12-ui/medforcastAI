"""Suppliers, purchase orders, receiving & learned lead times — HTTP API (/api/suppliers).

Permissions (mapped onto the fixed permission set; no new permissions):
  view everything (scoped to the stores you can access) .... view (all roles)
  create / edit / send / close / cancel POs, import drafts .. purchase.plan (owner, buyer)
  edit supplier details, preferred supplier per medicine ... purchase.plan (owner, buyer)
  edit the default return policy (settings) ................ settings.edit (owner)
  receive goods against a PO ............................... stock.receive + access to the PO's store
                                                              (pharmacists: only their own store)
Service logic and the lead-time model live in backend/suppliers.py.
"""
from __future__ import annotations

import math
import re
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from backend import db
from backend import inventory as inv
from backend import suppliers as svc
from backend.auth import accessible_stores, can_access_store, current_user, has_perm, require_perm, resolve_store
from backend.core import S, clean

router = APIRouter(prefix="/api/suppliers", tags=["suppliers"])

MAX_LINES = 300
KNOWN = set(S.meds.index)
MAX_ID = 2**31 - 1          # path / body ids beyond this would overflow SQLite INTEGER binding (500)
PoId = Annotated[int, Path(ge=1, le=MAX_ID)]
# GSTIN: 2-digit state code + PAN (5 letters, 4 digits, 1 letter) + entity no. + 'Z' + check character.
# Format check only (the checksum and registration status are not verified).
GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")

NOTES = {
    "names": "Supplier ids come from the sales history; names start neutral ('Supplier 01') — edit them to your real distributors.",
    "lead_time": ("Lead time = days from 'sent' to each delivery. Shrunk toward the supplier's default with the default "
                  f"counted as {svc.PRIOR_K:g} deliveries; p90 = mean + 1.28 sd. 'Default' = no deliveries recorded yet; "
                  f"'learning' = fewer than {svc.LEARNED_N}. No history is invented."),
    "on_time": "On-time % = received POs whose last delivery arrived on or before the expected date, plus open POs already overdue (counted late).",
    "fill_rate": "Fill rate = units received / units ordered on POs that are fully received or closed short.",
    "price_index": "Price index = this supplier's received unit cost vs the median received cost of the same medicine across suppliers (1.00 = median). Only medicines bought from 2+ suppliers count.",
    "gst": "GST rates are entered per line (default 12%). Verify the HSN rate with your CA; the supplier's tax invoice is authoritative.",
    "policy": "Return policies are what you record here; confirm them with each supplier in writing.",
}


def _err(e: Exception) -> HTTPException:
    if isinstance(e, inv.InventoryError):
        return inv.as_http(e)
    detail = getattr(e, "detail", None) or str(e)
    return HTTPException(getattr(e, "status", 400), detail)


def _uid(user: dict):
    return user.get("id")


def _store_ids(user: dict) -> list[str] | None:
    """None = all stores (owner/buyer); else the stores a pharmacist may see."""
    if has_perm(user, "stores.all") and not user.get("store_id"):
        return None
    return [s["id"] for s in accessible_stores(user)]


def _po_for(user: dict, po_id: int) -> dict:
    try:
        po = svc._po(po_id)
    except svc.SupplierError as e:
        raise _err(e)
    if not can_access_store(user, po["store_id"]):
        raise HTTPException(403, "You can only access your own store's purchase orders")
    return po


# ─────────────────────────── bodies ───────────────────────────

def _finite_only(v):
    """Replace non-finite numbers (JSON 'NaN' / 'Infinity' literals are accepted by the parser) with a marker string,
    so validation answers 422 instead of crashing while echoing the float back in the error body (500)."""
    if isinstance(v, float) and not math.isfinite(v):
        return "non-finite number"
    if isinstance(v, dict):
        return {k: _finite_only(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite_only(x) for x in v]
    return v


class _Body(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def _no_nan_inf(cls, data):
        return _finite_only(data)


def _txt(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


class PolicyPatch(_Body):
    accepts_returns: bool | None = None
    min_days_before_expiry: int | None = Field(None, ge=0, le=730)
    credit_pct: float | None = Field(None, ge=0, le=1)


class SupplierIn(_Body):
    name: str | None = Field(None, min_length=1, max_length=80)
    gstin: str | None = Field(None, max_length=15)
    contact: str | None = Field(None, max_length=80)
    phone: str | None = Field(None, max_length=20)
    email: str | None = Field(None, max_length=120)
    default_lead_days: float | None = Field(None, gt=0, le=120)
    payment_terms: str | None = Field(None, max_length=80)
    notes: str | None = Field(None, max_length=500)
    active: bool | None = None
    return_policy: PolicyPatch | None = None
    reset_return_policy: bool = False

    @field_validator("name", "contact", "payment_terms", "notes", "phone", "email", "gstin")
    @classmethod
    def _strip(cls, v):
        return _txt(v)

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v and not GSTIN_RE.match(v.upper()):
            raise ValueError("GSTIN must be 15 characters in the GSTIN format, e.g. 32ABCDE1234F1Z5")
        return v.upper() if v else v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        if v and not all(c in "0123456789+ -" for c in v):
            raise ValueError("phone may contain digits, spaces, + and - only")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v):
        from backend.notify import normalize_email
        if v and not normalize_email(v):
            raise ValueError("not a valid email address")
        return v

    def fields(self) -> dict:
        d = self.model_dump(exclude_unset=True, exclude={"reset_return_policy", "return_policy"})
        if self.reset_return_policy:
            d["return_policy"] = None
        elif "return_policy" in self.model_fields_set and self.return_policy is not None:
            d["return_policy"] = self.return_policy.model_dump(exclude_none=True)
        return d


class PolicyIn(_Body):
    accepts_returns: bool = True
    min_days_before_expiry: int = Field(90, ge=0, le=730)
    credit_pct: float = Field(0.8, ge=0, le=1)


class LineIn(_Body):
    medicine_id: str = Field(..., min_length=1, max_length=32)
    qty_ordered: int = Field(..., ge=1, le=100_000)
    unit_cost: float = Field(..., ge=0, le=1e7)
    gst_rate: float = Field(svc.DEFAULT_GST, ge=0, le=28)

    @field_validator("unit_cost", "gst_rate")
    @classmethod
    def _finite(cls, v):
        if math.isnan(v) or math.isinf(v):
            raise ValueError("must be a finite number")
        return v


class POIn(_Body):
    store_id: str | None = Field(None, max_length=32)
    supplier_id: str = Field(..., min_length=1, max_length=16)
    lines: list[LineIn] = Field(..., min_length=1, max_length=MAX_LINES)
    notes: str | None = Field(None, max_length=500)
    expected_at: date | None = None


class POEdit(_Body):
    supplier_id: str | None = Field(None, min_length=1, max_length=16)
    lines: list[LineIn] | None = Field(None, min_length=1, max_length=MAX_LINES)
    notes: str | None = Field(None, max_length=500)
    expected_at: date | None = None


class SendIn(_Body):
    expected_at: date | None = None
    email: bool = False
    email_to: str | None = Field(None, max_length=120)


class ReasonIn(_Body):
    reason: str | None = Field(None, max_length=200)


class ReceiveLine(_Body):
    line_id: int = Field(..., ge=1, le=MAX_ID)
    qty: int = Field(..., ge=1, le=100_000)
    batch_no: str = Field(..., min_length=1, max_length=40)
    expiry_date: date
    unit_cost: float | None = Field(None, ge=0, le=1e7)


class ReceiveIn(_Body):
    lines: list[ReceiveLine] = Field(..., min_length=1, max_length=MAX_LINES)
    accept_short_expiry: bool = False
    request_id: str | None = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$",
                                   description="Client-generated id per receive dialog; a retry with the same id is a no-op")


class PrefIn(_Body):
    supplier_id: str | None = Field(None, max_length=16)


class ImportIn(_Body):
    store_id: str | None = Field(None, max_length=32)
    source: Literal["optimizer", "planner"] = "planner"
    preview: bool = True
    budget: float = Field(50_000, ge=0, le=1e9)
    lead_time: int = Field(1, ge=0, le=8)
    review: int = Field(2, ge=1, le=8)
    service: float = Field(0.95, ge=0.5, le=0.995)
    margin_pct: float = Field(20, ge=1, le=90)
    objective: Literal["profit", "fill_rate"] = "profit"
    supplier_ids: list[str] | None = Field(None, max_length=50)
    gst_rate: float = Field(svc.DEFAULT_GST, ge=0, le=28)


# ─────────────────────────── suppliers ───────────────────────────

def _summary_row(s: dict, card: dict, pref_counts: dict) -> dict:
    return {**s, "scorecard": card, "preferred_medicines": pref_counts.get(s["id"], 0)}


@router.get("")
def list_suppliers(include_inactive: bool = True, user: dict = Depends(current_user)):
    sids = _store_ids(user)
    cards = svc.scorecards(sids)
    pref = {}
    for v in svc.preferred_map(wait=False).values():
        pref[v["supplier_id"]] = pref.get(v["supplier_id"], 0) + 1
    rows = [_summary_row(s, cards.get(s["id"], {}), pref) for s in svc.list_suppliers(include_inactive)]
    return clean({"suppliers": rows, "policy_default": svc.policy_default(), "notes": NOTES,
                  "history_ready": svc.inferred_ready(),
                  "scope": "all stores" if sids is None else ", ".join(sids),
                  "can": {"edit": has_perm(user, "purchase.plan"), "policy_default": has_perm(user, "settings.edit")}})


@router.post("")
def create_supplier(body: SupplierIn, user: dict = Depends(require_perm("purchase.plan"))):
    if not body.name:
        raise HTTPException(422, "name is required")
    try:
        return clean(svc.create_supplier(body.fields(), user_id=_uid(user)))
    except (svc.SupplierError, TypeError, ValueError, OverflowError) as e:
        raise _err(e)


@router.get("/settings/return-policy")
def get_policy_default(user: dict = Depends(current_user)):
    return svc.policy_default()


@router.put("/settings/return-policy")
def put_policy_default(body: PolicyIn, user: dict = Depends(require_perm("settings.edit"))):
    return svc.set_policy_default(body.model_dump())


@router.get("/lead-time")
def lead_time(medicine_id: str = Query(..., max_length=32), store_id: str | None = Query(None, max_length=32),
              user: dict = Depends(current_user)):
    mid = medicine_id.strip().upper()
    if mid not in KNOWN:
        raise HTTPException(404, f"Unknown medicine '{mid}'")
    sid = resolve_store(user, store_id) if store_id else None
    info = svc.lead_time_info(mid, sid)
    pref = svc.preferred_map().get(mid)
    return clean({**info, "preferred_source": pref["source"] if pref else None,
                  "supplier_share": pref["share"] if pref else None})


@router.put("/preferred/{medicine_id}")
def set_preferred(medicine_id: str, body: PrefIn, user: dict = Depends(require_perm("purchase.plan"))):
    mid = medicine_id.strip().upper()
    if mid not in KNOWN:
        raise HTTPException(404, f"Unknown medicine '{mid}'")
    try:
        return svc.set_preferred(mid, body.supplier_id or None, user_id=_uid(user))
    except svc.SupplierError as e:
        raise _err(e)


# ─────────────────────────── purchase orders ───────────────────────────

@router.get("/po")
def list_pos(store_id: str | None = Query(None, max_length=32, description="Store id, or 'all'"),
             status: str | None = Query(None, max_length=24), supplier_id: str | None = Query(None, max_length=16),
             limit: int = Query(200, ge=1, le=1000), user: dict = Depends(current_user)):
    if status and status not in svc.STATUSES:
        raise HTTPException(422, f"status must be one of {', '.join(svc.STATUSES)}")
    if store_id and store_id.lower() in ("all", "*"):
        ids = _store_ids(user)          # "all" = every store this user can access (pharmacists: their own)
    else:
        ids = [resolve_store(user, store_id)]
    return clean({**svc.list_pos(ids, status, supplier_id, limit), "store_ids": ids,
                  "can": {"plan": has_perm(user, "purchase.plan"), "receive": has_perm(user, "stock.receive")}})


@router.post("/po")
def create_po(body: POIn, user: dict = Depends(require_perm("purchase.plan"))):
    sid = resolve_store(user, body.store_id)
    try:
        return clean(svc.create_po(sid, body.supplier_id, [l.model_dump() for l in body.lines], known=KNOWN,
                                   user_id=_uid(user), notes=_txt(body.notes), expected_at=body.expected_at))
    except (svc.SupplierError, inv.InventoryError) as e:
        raise _err(e)


def _import_groups(body: ImportIn, sid: str) -> tuple[list[dict], dict]:
    from backend.routers.stock import on_hand_series, store_plan
    oh = on_hand_series(sid)
    pref = svc.preferred_map()
    st = inv.get_store(sid)
    scale = float(st["demand_scale"])
    groups: dict[str, list[dict]] = {}
    meta: dict = {"source": body.source, "store_id": sid, "demand_scale": scale}
    if body.source == "planner":
        p = store_plan(scale, body.lead_time, body.review, body.service, S.meds)
        p["on_hand"] = oh.reindex(p.index).fillna(0)
        p["suggested_order"] = (p["order_up_to"] - p["on_hand"]).clip(lower=0)
        p = p[p["suggested_order"] > 0]
        for mid, r in p.iterrows():
            sup = (pref.get(mid) or {}).get("supplier_id") or "Unassigned"
            cost = float(r["median_price"]) * inv.COST_FACTOR if r["median_price"] == r["median_price"] else 0.0
            groups.setdefault(sup, []).append({"medicine_id": mid, "medicine_name": r["medicine_name"],
                                               "qty_ordered": int(r["suggested_order"]), "unit_cost": round(cost, 2)})
        meta["note"] = (f"Planner order-up-to (lead {body.lead_time} wk + review {body.review} wk, service "
                        f"{body.service:.0%}) minus sellable stock. Unit cost assumed at {inv.COST_FACTOR:.0%} of median "
                        "selling price; edit to your quoted rates.")
    else:
        from backend.routers import optimizer as opt
        res = opt.plan(opt.PlanIn(budget=body.budget, lead_time=body.lead_time, review=body.review,
                                  service_cap=body.service, margin_pct=body.margin_pct, objective=body.objective,
                                  on_hand={k: float(v) for k, v in oh.items() if v > 0}))
        for line in res["lines"]:
            mid = line["medicine_id"]
            sup = (pref.get(mid) or {}).get("supplier_id") or line.get("supplier_id") or "Unassigned"
            groups.setdefault(sup, []).append({"medicine_id": mid, "medicine_name": line["medicine_name"],
                                               "qty_ordered": int(line["qty"]),
                                               "unit_cost": round(float(line["unit_cost"] or 0), 2)})
        meta["note"] = ("Budget optimizer on this store's sellable stock. The optimizer uses the main-shop forecast "
                        "(not scaled to branch demand) and unit cost = price x (1 - margin)."
                        + (" This is a simulated branch: review quantities." if scale != 1 else ""))
        meta["totals"] = res["totals"]
    out = []
    for sup, ls in groups.items():
        ls = [l for l in ls if l["qty_ordered"] > 0]
        if not ls:
            continue
        if body.supplier_ids and sup not in body.supplier_ids:
            continue
        out.append({"supplier_id": sup, "lines": ls, "units": sum(l["qty_ordered"] for l in ls),
                    "value": round(sum(l["qty_ordered"] * l["unit_cost"] for l in ls), 2)})
    out.sort(key=lambda g: -g["value"])
    return out, meta


@router.post("/po/import")
def import_pos(body: ImportIn, user: dict = Depends(require_perm("purchase.plan"))):
    """Build draft POs grouped by preferred supplier from the planner's suggested orders or the budget optimizer.
    preview=true returns the groups without writing anything."""
    sid = resolve_store(user, body.store_id)
    groups, meta = _import_groups(body, sid)
    if body.preview:
        return clean({"preview": True, "groups": groups, **meta})
    created, skipped = [], []
    try:
        with db.tx():
            master = {r["id"]: r for r in db.query("SELECT id, active FROM suppliers_master")}
            for g in groups:
                if g["supplier_id"] == "Unassigned":
                    skipped.append({"supplier_id": "Unassigned", "lines": len(g["lines"]),
                                    "reason": "No supplier known for these medicines; set a preferred supplier first"})
                    continue
                m = master.get(g["supplier_id"])
                if not m or not m["active"]:
                    skipped.append({"supplier_id": g["supplier_id"], "lines": len(g["lines"]),
                                    "reason": ("Supplier is inactive" if m else "Supplier not in the directory")
                                    + "; set another preferred supplier for these medicines"})
                    continue
                dup = db.query_one("SELECT po_no FROM suppliers_po WHERE store_id = ? AND supplier_id = ? AND status = 'draft' "
                                   "AND source = ? ORDER BY id DESC LIMIT 1", (sid, g["supplier_id"], body.source))
                if dup:
                    skipped.append({"supplier_id": g["supplier_id"], "lines": len(g["lines"]), "existing": dup["po_no"],
                                    "reason": f"Draft {dup['po_no']} from the {body.source} is still open for this supplier; "
                                              "edit or cancel it instead of importing a duplicate order"})
                    continue
                for chunk in range(0, len(g["lines"]), MAX_LINES):
                    po = svc.create_po(sid, g["supplier_id"],
                                       [{**l, "gst_rate": body.gst_rate} for l in g["lines"][chunk:chunk + MAX_LINES]],
                                       known=KNOWN, user_id=_uid(user), source=body.source,
                                       notes=f"Draft from {body.source}")
                    created.append({"id": po["id"], "po_no": po["po_no"], "supplier_id": po["supplier_id"],
                                    "lines": len(po["lines"]), "total_value": po["total_value"]})
    except svc.SupplierError as e:
        raise _err(e)
    return clean({"preview": False, "created": created, "skipped": skipped, **meta})


@router.get("/po/{po_id}")
def get_po(po_id: PoId, user: dict = Depends(current_user)):
    _po_for(user, po_id)
    po = svc.po_detail(po_id)
    sup = svc.get_supplier(po["supplier_id"])
    st = inv.get_store(po["store_id"])
    text = svc.po_text(po, sup, st)
    from backend.notify import wa_share_link
    phone = "".join(c for c in (sup.get("phone") or "") if c.isdigit()) or None
    return clean({"po": po, "supplier": sup, "store": st, "share_text": text,
                  "wa_link": wa_share_link(text, phone if phone and len(phone) >= 10 else None),
                  "lead": svc.supplier_lead(po["supplier_id"], po["store_id"]),
                  "short_expiry_days": svc.SHORT_EXPIRY_DAYS,
                  "can": {"plan": has_perm(user, "purchase.plan"), "receive": has_perm(user, "stock.receive")}})


@router.put("/po/{po_id}")
def edit_po(po_id: PoId, body: POEdit, user: dict = Depends(require_perm("purchase.plan"))):
    _po_for(user, po_id)
    kw = {}
    if "notes" in body.model_fields_set:
        kw["notes"] = _txt(body.notes)
    if "expected_at" in body.model_fields_set:
        kw["expected_at"] = body.expected_at
    try:
        return clean(svc.update_po(po_id, known=KNOWN, supplier_id=body.supplier_id,
                                   lines=[l.model_dump() for l in body.lines] if body.lines is not None else None,
                                   user_id=_uid(user), **kw))
    except svc.SupplierError as e:
        raise _err(e)


@router.post("/po/{po_id}/send")
def send_po(po_id: PoId, body: SendIn, user: dict = Depends(require_perm("purchase.plan"))):
    """Mark the PO as sent (starts the lead-time clock). Emails it only if requested AND SMTP is configured;
    otherwise the response says it was only marked as sent — share it via the wa.me link or print."""
    _po_for(user, po_id)
    try:
        po = svc.mark_sent(po_id, body.expected_at, user_id=_uid(user))
    except svc.SupplierError as e:
        raise _err(e)
    sup = svc.get_supplier(po["supplier_id"])
    st = inv.get_store(po["store_id"])
    text = svc.po_text(po, sup, st)
    from backend import notify
    delivery = []
    if body.email:
        to = body.email_to or sup.get("email")
        if not to:
            delivery = [{"channel": "email", "recipient": None, "status": "invalid", "error": "No supplier email on file"}]
        else:
            delivery = notify.send_email([to], f"Purchase order {po['po_no']}", text)
            for d in delivery:
                d["recipient"] = notify.mask(d.get("recipient"))
        svc.event("po_email", po_id=po_id, supplier_id=po["supplier_id"], user_id=_uid(user),
                  detail=[{k: d.get(k) for k in ("channel", "status", "error")} for d in delivery])
    emailed = any(d.get("status") == "sent" for d in delivery)
    phone = "".join(c for c in (sup.get("phone") or "") if c.isdigit()) or None
    return clean({"po": po, "delivery": delivery, "emailed": emailed,
                  "message": (f"{po['po_no']} emailed to the supplier and marked as sent." if emailed else
                              f"{po['po_no']} marked as sent (not delivered by the app). Share it via WhatsApp or print it."),
                  "channels": notify.channel_status(), "share_text": text,
                  "wa_link": notify.wa_share_link(text, phone if phone and len(phone) >= 10 else None)})


@router.post("/po/{po_id}/receive")
def receive_po(po_id: PoId, body: ReceiveIn, user: dict = Depends(require_perm("stock.receive"))):
    _po_for(user, po_id)

    def allowed(store_id: str):
        if not can_access_store(user, store_id):
            raise HTTPException(403, "You can only receive at your own store")

    try:
        return clean(svc.receive_po(po_id, [{**l.model_dump(), "expiry_date": l.expiry_date.isoformat()} for l in body.lines],
                                    user_id=_uid(user), accept_short_expiry=body.accept_short_expiry,
                                    allowed_store=allowed, request_id=body.request_id))
    except (svc.SupplierError, inv.InventoryError) as e:
        raise _err(e)


@router.post("/po/{po_id}/close")
def close_po(po_id: PoId, body: ReasonIn | None = None, user: dict = Depends(require_perm("purchase.plan"))):
    _po_for(user, po_id)
    try:
        return clean(svc.close_po(po_id, user_id=_uid(user), reason=body.reason if body else None))
    except svc.SupplierError as e:
        raise _err(e)


@router.post("/po/{po_id}/cancel")
def cancel_po(po_id: PoId, body: ReasonIn | None = None, user: dict = Depends(require_perm("purchase.plan"))):
    _po_for(user, po_id)
    try:
        return clean(svc.cancel_po(po_id, user_id=_uid(user), reason=body.reason if body else None))
    except svc.SupplierError as e:
        raise _err(e)


# ─────────────────────────── one supplier (keep last: catches /{supplier_id}) ───────────────────────────

@router.get("/{supplier_id}")
def get_supplier(supplier_id: str, user: dict = Depends(current_user)):
    try:
        s = svc.get_supplier(supplier_id.strip().upper())
    except svc.SupplierError as e:
        raise _err(e)
    sids = _store_ids(user)
    card = svc.scorecards(sids).get(s["id"], {})
    pm = svc.preferred_map(wait=False)
    meds = [{"medicine_id": mid, "medicine_name": S.meds.at[mid, "medicine_name"], "category": S.meds.at[mid, "category"],
             "source": v["source"], "share": v["share"], "next4": S.meds.at[mid, "next4"]}
            for mid, v in pm.items() if v["supplier_id"] == s["id"] and mid in S.meds.index]
    meds.sort(key=lambda r: -(r["next4"] or 0))
    pos = svc.list_pos(sids, None, s["id"], 50)
    return clean({"supplier": s, "scorecard": card, "medicines": meds[:200], "medicine_count": len(meds),
                  "pos": pos["items"], "po_counts": pos["counts"], "notes": NOTES,
                  "history_ready": svc.inferred_ready(),
                  "can": {"edit": has_perm(user, "purchase.plan"), "policy_default": has_perm(user, "settings.edit")}})


@router.put("/{supplier_id}")
def edit_supplier(supplier_id: str, body: SupplierIn, user: dict = Depends(require_perm("purchase.plan"))):
    try:
        return clean(svc.update_supplier(supplier_id.strip().upper(), body.fields(), user_id=_uid(user)))
    except (svc.SupplierError, TypeError, ValueError, OverflowError) as e:
        raise _err(e)
