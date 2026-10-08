"""Compliance & pricing API: drug schedules, statutory registers, DPCO/NPPA ceiling prices, margins.

Permissions (mapped onto the fixed permission set):
  view            every read endpoint (all roles). Patient name/address in the register are masked for roles
                  without sales.record (buyers) - they never dispense, so they do not need the identity.
  sales.record    POST /register (manual register entry for a sale made outside POS)
  settings.edit   schedule overrides, ceiling upload/fetch/match decisions, GST settings (owner only)
Register CSV exports are audited (compliance_audit). Not legal advice - see compliance.DISCLAIMER.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from backend import compliance as C
from backend import db
from backend.auth import current_user, has_perm, require_perm, resolve_store, store_scope, store_scope_all
from backend.core import S, clean

router = APIRouter(prefix="/api/compliance", tags=["compliance"])

ScheduleT = Literal["OTC", "H", "H1", "X", "NDPS"]
DATE = r"^\d{4}-\d{2}-\d{2}$"


def _mid(mid: str) -> str:
    if mid not in S.meds.index:
        raise HTTPException(404, f"Unknown medicine '{mid}'")
    return mid


def _date(s: str | None, name: str) -> str | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")


@router.get("/summary")
def summary(store: str = Depends(store_scope), user: dict = Depends(current_user)):
    cls = C.all_classifications()
    counts = {s: 0 for s in C.SCHEDULES}
    for c in cls:
        counts[c["schedule"]] += 1
    today = date.today()
    reg_30 = db.scalar("SELECT COUNT(*) FROM compliance_register WHERE store_id = ? AND sold_at >= ?",
                       (store, (today - timedelta(days=30)).isoformat()), 0)
    nceil = db.scalar("SELECT COUNT(*) FROM compliance_ceilings", (), 0)
    return clean({
        "store_id": store, "schedule_counts": counts, "overrides": sum(1 for c in cls if c["source"] == "override"),
        "low_confidence": sum(1 for c in cls if c["confidence"] == "low" and c["source"] == "rule"),
        "register_entries_30d": reg_30, "ceiling_rows": nceil,
        "nppa_last_fetch": db.get_setting("compliance.nppa_last_fetch", None),
        "disclaimer": C.DISCLAIMER, "retention_note": C.RETENTION_NOTE, "price_note": C.PRICE_NOTE,
        "can_edit": has_perm(user, "settings.edit"), "can_record": has_perm(user, "sales.record"),
    })


# ------------------------------------------------------------------ schedules
@router.get("/schedules")
def schedules(q: str | None = Query(None, max_length=80), schedule: ScheduleT | None = None,
              source: Literal["rule", "override"] | None = None,
              confidence: Literal["high", "medium", "low"] | None = None,
              limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
              user: dict = Depends(current_user)):
    rows = C.all_classifications()
    if q:
        ql = q.lower().strip()
        rows = [r for r in rows if ql in r["medicine_name"].lower() or ql in r["generic_name"].lower()
                or ql == r["medicine_id"].lower()]
    if schedule:
        rows = [r for r in rows if r["schedule"] == schedule]
    if source:
        rows = [r for r in rows if r["source"] == source]
    if confidence:
        rows = [r for r in rows if r["confidence"] == confidence]
    order = {"NDPS": 0, "X": 1, "H1": 2, "H": 3, "OTC": 4}
    rows.sort(key=lambda r: (order[r["schedule"]], r["medicine_name"]))
    return clean({"total": len(rows), "rows": rows[offset:offset + limit], "sources": SOURCES,
                  "disclaimer": C.DISCLAIMER})


SOURCES = [
    {"schedule": "H1", "ref": "Drugs & Cosmetics (Third Amendment) Rules 2013, G.S.R. 588(E) dated 30-08-2013",
     "uncertainty": "Later additions not verified."},
    {"schedule": "NDPS", "ref": "NDPS Act 1985 - narcotic drugs and Schedule of psychotropic substances "
     "(tramadol S.O. 1761(E) 2018)", "uncertainty": "Psychotropics are labelled NDPS (stricter) even when also H1."},
    {"schedule": "X", "ref": "Drugs Rules 1945, Schedule X", "uncertainty": "Classical list; none in this catalogue."},
    {"schedule": "H / OTC", "ref": "Inferred from dosage form, therapeutic class and prescription share",
     "uncertainty": "Low confidence - review and override where needed."},
]


@router.get("/schedules/log")
def override_log(medicine_id: str | None = Query(None, max_length=20), limit: int = Query(100, ge=1, le=500),
                 user: dict = Depends(current_user)):
    sql = """SELECT l.*, u.username FROM compliance_override_log l LEFT JOIN users u ON u.id = l.user_id"""
    p: tuple = ()
    if medicine_id:
        sql += " WHERE l.medicine_id = ?"
        p = (medicine_id,)
    rows = db.query(sql + " ORDER BY l.id DESC LIMIT ?", p + (limit,))
    for r in rows:
        r["medicine_name"] = S.meds.at[r["medicine_id"], "medicine_name"] if r["medicine_id"] in S.meds.index else None
    return clean({"rows": rows})


@router.get("/schedules/{medicine_id}")
def schedule_one(medicine_id: str, user: dict = Depends(current_user)):
    return clean(C.classification(_mid(medicine_id)))


class OverrideBody(BaseModel):
    schedule: ScheduleT
    reason: str = Field(min_length=5, max_length=300)


class ReasonBody(BaseModel):
    reason: str = Field(min_length=5, max_length=300)


@router.put("/schedules/{medicine_id}/override")
def put_override(medicine_id: str, body: OverrideBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        return clean(C.set_override(_mid(medicine_id), body.schedule, body.reason, user.get("id")))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/schedules/{medicine_id}/override/clear")
def clear_override(medicine_id: str, body: ReasonBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        return clean(C.clear_override(_mid(medicine_id), body.reason, user.get("id")))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ------------------------------------------------------------------ register
def _register_query(user, store_id, schedule, date_from, date_to, q):
    store = resolve_store(user, store_id, allow_all=True)
    return store, schedule, _date(date_from, "from"), _date(date_to, "to"), q


@router.get("/register")
def register(schedule: Literal["H1", "X", "NDPS", "all"] = "all",
             date_from: str | None = Query(None, alias="from", pattern=DATE),
             date_to: str | None = Query(None, alias="to", pattern=DATE),
             store_id: str | None = Query(None, max_length=32), q: str | None = Query(None, max_length=60),
             limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
             user: dict = Depends(current_user)):
    store, sch, f, t, q = _register_query(user, store_id, schedule, date_from, date_to, q)
    masked = not has_perm(user, "sales.record")
    rows, total = C.register_rows(store, sch, f, t, q, limit, offset, search_patient=not masked)
    if masked:
        rows = [C.mask_row(r) for r in rows]
    return clean({"store_id": store, "total": total, "rows": rows, "masked": masked,
                  "columns": [{"key": k, "label": l} for k, l in C.REGISTER_COLUMNS],
                  "retention_note": C.RETENTION_NOTE, "disclaimer": C.DISCLAIMER})


@router.get("/register.csv")
def register_csv(schedule: Literal["H1", "X", "NDPS", "all"] = "all",
                 date_from: str | None = Query(None, alias="from", pattern=DATE),
                 date_to: str | None = Query(None, alias="to", pattern=DATE),
                 store_id: str | None = Query(None, max_length=32), q: str | None = Query(None, max_length=60),
                 user: dict = Depends(current_user)):
    store, sch, f, t, q = _register_query(user, store_id, schedule, date_from, date_to, q)
    masked = not has_perm(user, "sales.record")
    rows, total = C.register_rows(store, sch, f, t, q, limit=50_000, search_patient=not masked)
    if masked:
        rows = [C.mask_row(r) for r in rows]
    with db.tx():
        C.audit(user.get("id"), "register.export", f"store={store or 'all'} schedule={sch} from={f} to={t} rows={len(rows)}")
    name = f"register_{sch}_{store or 'all'}_{f or 'start'}_{t or date.today().isoformat()}.csv"
    return Response(C.register_csv(rows), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


class RegisterEntry(BaseModel):
    store_id: str | None = Field(None, max_length=32)
    invoice_no: str = Field(min_length=1, max_length=60)
    medicine_id: str = Field(min_length=1, max_length=20)
    batch_no: str | None = Field(None, max_length=40)
    qty: int = Field(ge=1, le=100_000)
    patient_name: str = Field(min_length=2, max_length=120)
    patient_address: str | None = Field(None, max_length=300)
    prescriber_name: str = Field(min_length=2, max_length=120)
    prescriber_address: str | None = Field(None, max_length=300)
    prescriber_reg_no: str | None = Field(None, max_length=60)
    rx_ref: str | None = Field(None, max_length=100)
    sold_at: str | None = Field(None, pattern=DATE)

    @field_validator("invoice_no", "patient_name", "prescriber_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v


@router.post("/register")
def add_register(body: RegisterEntry, user: dict = Depends(require_perm("sales.record"))):
    store = resolve_store(user, body.store_id)
    mid = _mid(body.medicine_id)
    if not C.needs_register(mid):
        raise HTTPException(400, f"{S.meds.at[mid, 'medicine_name']} is {C.schedule_of(mid)}: no register entry needed")
    sold_at = body.sold_at
    if sold_at:
        try:
            d = date.fromisoformat(sold_at)
        except ValueError:
            raise HTTPException(400, "sold_at must be a valid YYYY-MM-DD date")
        if d > datetime.now(C.IST).date():
            raise HTTPException(400, "sold_at cannot be in the future")
        sold_at = C.ist_day_start(sold_at)          # 00:00 IST on that day, stored in UTC like POS rows
    e = body.model_dump()
    e.update(store_id=store, medicine_id=mid, sold_by=user.get("id"), sold_at=sold_at or db.now_iso())
    try:
        with db.tx():
            ids = C.record_register_entries([e])
            C.audit(user.get("id"), "register.manual", f"{store} {body.invoice_no} {mid} x{body.qty}")
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    return {"id": ids[0], "schedule": C.schedule_of(mid)}


@router.get("/register/gaps")
def register_gaps(date_from: str | None = Query(None, alias="from", pattern=DATE),
                  date_to: str | None = Query(None, alias="to", pattern=DATE),
                  store_id: str | None = Query(None, max_length=32), user: dict = Depends(current_user)):
    store = resolve_store(user, store_id, allow_all=True)
    t = _date(date_to, "to") or date.today().isoformat()
    f = _date(date_from, "from") or t
    if f > t:
        raise HTTPException(400, "from must be on or before to")
    if (date.fromisoformat(t) - date.fromisoformat(f)).days > 92:
        raise HTTPException(400, "Check at most 92 days at a time")
    res = C.register_gaps(store, f, t)
    return clean({"store_id": store, "from": f, "to": t, **res})


# ------------------------------------------------------------------ ceilings
TEMPLATE = ",".join(C.CEILING_COLS) + "\n"


@router.get("/ceilings")
def ceilings(limit: int = Query(200, ge=1, le=5000), offset: int = Query(0, ge=0),
             user: dict = Depends(current_user)):
    rows = db.query("SELECT * FROM compliance_ceilings ORDER BY formulation, id LIMIT ? OFFSET ?", (limit, offset))
    total = db.scalar("SELECT COUNT(*) FROM compliance_ceilings", (), 0)
    src = db.query("SELECT source, COUNT(*) n, MAX(uploaded_at) uploaded_at FROM compliance_ceilings GROUP BY source")
    return clean({"total": total, "rows": rows, "sources": src,
                  "last_fetch": db.get_setting("compliance.nppa_last_fetch", None),
                  "nppa_url": db.get_setting("compliance.nppa_url", C.NPPA_DEFAULT_URL),
                  "columns": C.CEILING_COLS, "gst": C.gst_settings(),
                  "note": "NPPA ceiling prices exclude GST. Upload the current list (CSV template); nothing is "
                          "pre-filled because prices must come from the official notification."})


@router.get("/ceilings/template.csv")
def ceiling_template(user: dict = Depends(current_user)):
    return Response(TEMPLATE, media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="nppa_ceiling_template.csv"'})


class UploadBody(BaseModel):
    content: str = Field(min_length=1, max_length=2_000_000)
    filename: str | None = Field(None, max_length=120)
    mode: Literal["replace", "append"] = "replace"
    dry_run: bool = False


@router.post("/ceilings/upload")
def upload_ceilings(body: UploadBody, user: dict = Depends(require_perm("settings.edit"))):
    rows, errors = C.parse_ceiling_csv(body.content)
    if errors:
        raise HTTPException(422, {"message": f"{len(errors)} row(s) failed validation; nothing was imported",
                                  "errors": errors[:50], "valid_rows": len(rows)})
    if not rows:
        raise HTTPException(400, "The file has no data rows")
    if body.dry_run:
        return {"dry_run": True, "valid_rows": len(rows), "preview": rows[:10]}
    n = C.store_ceilings(rows, "upload:" + (body.filename or "csv"), user.get("id"), body.mode)
    return {"imported": n, "mode": body.mode}


class FetchBody(BaseModel):
    url: str | None = Field(None, max_length=400)


@router.post("/ceilings/fetch")
def fetch_ceilings(body: FetchBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        res = C.fetch_nppa(body.url, user.get("id"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    if body.url and res.get("status") != "unreachable":
        db.set_setting("compliance.nppa_url", body.url)
    return clean(res)


@router.get("/ceilings/matches")
def matches(status: Literal["auto", "review", "confirmed", "rejected"] | None = None,
            q: str | None = Query(None, max_length=80), user: dict = Depends(current_user)):
    rows = C.match_table()
    counts = {s: 0 for s in ("auto", "review", "confirmed", "rejected")}
    for r in rows:
        counts[r["status"]] += 1
    if status:
        rows = [r for r in rows if r["status"] == status]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r["medicine_name"].lower() or ql in r["generic_name"].lower()]
    return clean({"rows": rows, "counts": counts, "auto_accept": C.AUTO_ACCEPT})


class MatchBody(BaseModel):
    status: Literal["confirmed", "rejected"]
    ceiling_id: int | None = Field(None, ge=1)
    units_per_sale: float = Field(1.0, gt=0, le=10_000)
    note: str | None = Field(None, max_length=200)


@router.put("/ceilings/matches/{medicine_id}")
def put_match(medicine_id: str, body: MatchBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        C.set_match(_mid(medicine_id), body.status, body.ceiling_id, body.units_per_sale, body.note, user.get("id"))
    except LookupError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@router.delete("/ceilings/matches/{medicine_id}")
def delete_match(medicine_id: str, user: dict = Depends(require_perm("settings.edit"))):
    C.clear_match(_mid(medicine_id), user.get("id"))
    return {"ok": True}


@router.get("/ceilings/violations")
def ceiling_violations(store: str = Depends(store_scope)):
    from backend import inventory as inv
    return clean({"store_id": store, **C.violations(inv.store_scale(store))})


@router.get("/price-increases")
def price_increases(user: dict = Depends(current_user)):
    return clean(C.price_increases())


# ------------------------------------------------------------------ GST settings
class GstBody(BaseModel):
    default: float = Field(ge=0, le=0.28)
    by_category: dict[str, float] = Field(default_factory=dict)

    @field_validator("by_category")
    @classmethod
    def _cats(cls, v: dict[str, float]) -> dict[str, float]:
        cats = set(S.meds["category"].unique())
        for k, r in v.items():
            if k not in cats:
                raise ValueError(f"unknown category '{k}'")
            if not 0 <= r <= 0.28:
                raise ValueError("GST rates must be between 0 and 0.28")
        return v


@router.get("/settings")
def get_settings(user: dict = Depends(current_user)):
    return clean({"gst": C.gst_settings(), "categories": sorted(S.meds["category"].unique())})


@router.put("/settings")
def put_settings(body: GstBody, user: dict = Depends(require_perm("settings.edit"))):
    db.set_setting("compliance.gst", {"default": body.default, "by_category": body.by_category})
    with db.tx():
        C.audit(user.get("id"), "settings.gst", f"default={body.default} cats={len(body.by_category)}")
    return clean({"gst": C.gst_settings()})


# ------------------------------------------------------------------ margins
@router.get("/margins")
def margins(store: str = Depends(store_scope), limit: int = Query(100, ge=1, le=500)):
    res = C.margins(store)
    res["medicines"] = res["medicines"][:limit]
    return clean(res)
