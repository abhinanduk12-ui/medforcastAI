"""Refill reminders for consented chronic patients: /api/patients.

Permission mapping (no new permissions exist, so actions map onto the foundation set):
  * personal data (list, detail, create, edit, consent, dispenses, due list, reminders, reveal,
    erasure)                                  -> sales.record (owner, pharmacist) + store access
                                                 (pharmacists only their own store; others' patients 404)
  * adherence (PDC) insight                   -> inside the patient detail, so sales.record only
  * committed demand (aggregated, no names)   -> view (all roles); patient counts only for sales.record
  * notice, settings (read)                   -> view
  * settings edit, retention run, access log  -> settings.edit (owner)
Every read of personal data and every write is recorded in patients_access_log.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from backend import notify
from backend import patients as P
from backend.auth import can_access_store, current_user, has_perm, require_perm, resolve_store, store_scope
from backend.core import clean

router = APIRouter(prefix="/api/patients", tags=["patients"])

Channel = Literal["whatsapp", "sms", "call"]
MAX_ID = 2**62          # larger path/query ids overflow SQLite INTEGER (was a 500)
PatientId = Annotated[int, Path(ge=1, le=MAX_ID)]
ReminderId = Annotated[int, Path(ge=1, le=MAX_ID)]


def _http(e: P.PatientError) -> HTTPException:
    return HTTPException(getattr(e, "status", 400), str(e))


def _own_patient(pid: int, user: dict) -> dict:
    """The patient row if the user may see it; 404 otherwise (does not reveal other stores' patients)."""
    try:
        r = P._patient_row(pid)
    except P.PatientError as e:
        raise _http(e) from None
    if not can_access_store(user, r["store_id"]):
        raise HTTPException(404, "Patient not found")
    return r


def _own_reminder(rid: int, user: dict) -> str:
    try:
        sid = P.reminder_store(rid)
    except P.PatientError as e:
        raise _http(e) from None
    if not can_access_store(user, sid):
        raise HTTPException(404, "Reminder not found")
    return sid


# ── bodies ───────────────────────────────────────────────────────────────────

class ConsentIn(BaseModel):
    notice_version: str = Field(..., max_length=40)
    channel: Channel
    evidence: str = Field(..., min_length=2, max_length=200, description='e.g. "verbal at counter" or "signed form #123"')
    confirmed: bool = Field(..., strict=True, description="Notice given and the patient agreed (JSON true only)")


class PatientIn(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=60)
    phone: str = Field(..., min_length=6, max_length=24)
    year_of_birth: int | None = Field(None, ge=1900, le=2100)
    consent: ConsentIn
    store_id: str | None = Field(None, max_length=32)


class PatientPatch(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=60)
    phone: str | None = Field(None, min_length=6, max_length=24)
    year_of_birth: int | None = Field(None, ge=1900, le=2100)


class WithdrawIn(BaseModel):
    note: str | None = Field(None, max_length=200, description='e.g. "replied STOP on WhatsApp"')


class EraseIn(BaseModel):
    confirm: Literal["ERASE"]
    reason: str | None = Field(None, max_length=120)


class RevealIn(BaseModel):
    reason: str | None = Field(None, max_length=120)


class DispenseIn(BaseModel):
    medicine_id: str = Field(..., min_length=1, max_length=32)
    qty: int = Field(..., ge=1, le=P.MAX_QTY)
    days_supply: int | None = Field(None, ge=1, le=P.MAX_DAYS_SUPPLY)
    invoice_no: str | None = Field(None, max_length=100)
    dispensed_at: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class MarkIn(BaseModel):
    note: str | None = Field(None, max_length=200)
    channel: Literal["whatsapp_link", "sms_link", "call", "in_person", "manual"] | None = None


class SendIn(BaseModel):
    override_quiet_hours: bool = False


class SettingsIn(BaseModel):
    notice_version: str | None = Field(None, max_length=40)
    lead_days: int | None = Field(None, ge=0, le=14)
    quiet_start: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    retention_months: int | None = Field(None, ge=1, le=120)
    withdrawn_erase_days: int | None = Field(None, ge=0, le=365)
    include_medicine_name: bool | None = None
    auto_send: bool | None = None
    days_per_unit: dict[str, float] | None = None


# ── public-ish (no personal data) ────────────────────────────────────────────

@router.get("/notice")
def get_notice(version: str | None = Query(None, max_length=40), _: dict = Depends(require_perm("view"))):
    if version and version not in P.NOTICES:
        raise HTTPException(404, "Unknown notice version")
    return P.notice(version)


@router.get("/settings")
def get_settings(user: dict = Depends(require_perm("view"))):
    s = P.get_settings()
    return clean({**s, "channels": notify.channel_status(), "refill_whatsapp": P.refill_whatsapp_mode(),
                  "quiet_now": P.in_quiet_hours(settings=s),
                  "retention": P.retention_status(), "job": P.JOB_STATE, "can_edit": has_perm(user, "settings.edit"),
                  "notices": list(P.NOTICES)})


@router.put("/settings")
def put_settings(body: SettingsIn, user: dict = Depends(require_perm("settings.edit"))):
    try:
        s = P.update_settings(body.model_dump(exclude_none=True))
    except P.PatientError as e:
        raise _http(e) from None
    P.log_access(user, "settings_update", None, None, ",".join(body.model_dump(exclude_none=True)))
    return clean(s)


@router.get("/committed-demand")
def committed_demand(weeks: int = Query(4, ge=1, le=12), store_id: str = Depends(store_scope),
                     user: dict = Depends(require_perm("view"))):
    """Aggregated expected refill units per medicine (no personal data). Patient counts only for staff
    who may see patient data; buyers get units only."""
    df = P.committed_demand(store_id, weeks, with_patients=True)
    staff = has_perm(user, "sales.record")
    rows = [{"medicine_id": mid, "medicine_name": P.medicine_name(mid), "units": float(r["units"]),
             **({"patients": int(r["patients"])} if staff else {})}
            for mid, r in df.sort_values("units", ascending=False).iterrows()]
    return clean({"store_id": store_id, "weeks": weeks, "total_units": float(df["units"].sum()) if len(df) else 0.0,
                  "medicines": rows,
                  "basis": (f"Pending/sent refill reminders of consented patients due in the next {weeks} week(s) "
                            f"(plus up to {P.COMMITTED_OVERDUE_DAYS} days overdue), using each patient's last dispensed quantity.")})


@router.get("/default-days")
def default_days(medicine_id: str = Query(..., max_length=32), qty: int = Query(..., ge=1, le=P.MAX_QTY),
                 _: dict = Depends(require_perm("sales.record"))):
    try:
        return P.default_days_supply(medicine_id, qty)
    except P.PatientError as e:
        raise _http(e) from None


@router.get("/channels")
def channels(_: dict = Depends(require_perm("sales.record"))):
    return notify.channel_status()


# ── owner: access log & retention ───────────────────────────────────────────

@router.get("/access-log")
def get_access_log(patient_id: int | None = Query(None, ge=1, le=MAX_ID), limit: int = Query(100, ge=1, le=500),
                   offset: int = Query(0, ge=0), store_id: str | None = Query(None, max_length=32),
                   user: dict = Depends(require_perm("settings.edit"))):
    sid = resolve_store(user, store_id, allow_all=True) if store_id else None
    return P.access_log(sid, patient_id, limit, offset)


@router.post("/retention/run")
def run_retention(user: dict = Depends(require_perm("settings.edit"))):
    return P.run_retention(user)


# ── personal data (sales.record) ────────────────────────────────────────────

@router.get("")
def list_patients(q: str | None = Query(None, max_length=60), status: Literal["active", "withdrawn", "all"] = "active",
                  store_id: str = Depends(store_scope), user: dict = Depends(require_perm("sales.record"))):
    rows = P.list_patients(store_id, q, status)
    P.log_access(user, "list", None, store_id, f"{len(rows)} patient(s), status={status}" + (", search" if q else ""))
    counts = {"due_7d": sum(1 for r in rows if r["days_to_due"] is not None and r["days_to_due"] <= 7)}
    return clean({"store_id": store_id, "patients": rows, "counts": counts})


@router.post("", status_code=201)
def create_patient(body: PatientIn, user: dict = Depends(require_perm("sales.record"))):
    sid = resolve_store(user, body.store_id)
    try:
        return clean(P.create_patient(sid, body.display_name, body.phone, body.year_of_birth, body.consent.model_dump(), user))
    except P.PatientError as e:
        raise _http(e) from None


@router.get("/due")
def due(days: int = Query(7, ge=0, le=60), store_id: str = Depends(store_scope),
        user: dict = Depends(require_perm("sales.record"))):
    rows = P.due_list(store_id, days)
    P.log_access(user, "due_list", None, store_id, f"{len(rows)} reminder(s)")
    s = P.get_settings()
    return clean({"store_id": store_id, "days": days, "reminders": rows, "quiet_hours": P.in_quiet_hours(settings=s),
                  "quiet_window": f"{s['quiet_start']}-{s['quiet_end']} IST",
                  "whatsapp_api": notify.whatsapp_config()["configured"]})


@router.get("/lookup")
def lookup(q: str = Query(..., min_length=2, max_length=60), store_id: str = Depends(store_scope),
           user: dict = Depends(require_perm("sales.record"))):
    return P.consented_patient_lookup(q, store_id, user.get("id"))


@router.get("/{pid}")
def detail(pid: PatientId, user: dict = Depends(require_perm("sales.record"))):
    r = _own_patient(pid, user)
    try:
        out = P.patient_detail(pid)
    except P.PatientError as e:
        raise _http(e) from None
    P.log_access(user, "view", pid, r["store_id"])
    return clean(out)


@router.patch("/{pid}")
def patch(pid: PatientId, body: PatientPatch, user: dict = Depends(require_perm("sales.record"))):
    _own_patient(pid, user)
    try:
        return clean(P.update_patient(pid, body.model_dump(exclude_unset=True), user))
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/{pid}/reveal")
def reveal(pid: PatientId, body: RevealIn | None = None, user: dict = Depends(require_perm("sales.record"))):
    _own_patient(pid, user)
    return P.reveal_phone(pid, user, body.reason if body else None)


@router.post("/{pid}/consent")
def grant(pid: PatientId, body: ConsentIn, user: dict = Depends(require_perm("sales.record"))):
    _own_patient(pid, user)
    try:
        return clean(P.grant_consent(pid, body.notice_version, body.channel, body.evidence, user, body.confirmed))
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/{pid}/consent/withdraw")
def withdraw(pid: PatientId, body: WithdrawIn, user: dict = Depends(require_perm("sales.record"))):
    _own_patient(pid, user)
    try:
        return clean(P.withdraw_consent(pid, body.note, user))
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/{pid}/dispenses", status_code=201)
def add_dispense(pid: PatientId, body: DispenseIn, user: dict = Depends(require_perm("sales.record"))):
    r = _own_patient(pid, user)
    try:
        did = P.record_dispense(pid, body.medicine_id, body.qty, r["store_id"], body.invoice_no, body.dispensed_at,
                                body.days_supply, user.get("id"))
    except P.PatientError as e:
        raise _http(e) from None
    return clean({"dispense_id": did, "patient": P.patient_detail(pid)})


@router.post("/{pid}/erase")
def erase(pid: PatientId, body: EraseIn, user: dict = Depends(require_perm("sales.record"))):
    _own_patient(pid, user)
    try:
        return P.erase_patient(pid, body.reason, user)
    except P.PatientError as e:
        raise _http(e) from None


# ── reminders ────────────────────────────────────────────────────────────────

@router.post("/reminders/{rid}/link")
def reminder_link(rid: ReminderId, user: dict = Depends(require_perm("sales.record"))):
    _own_reminder(rid, user)
    try:
        return P.reminder_link(rid, user)
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/reminders/{rid}/send")
def reminder_send(rid: ReminderId, body: SendIn | None = None, user: dict = Depends(require_perm("sales.record"))):
    _own_reminder(rid, user)
    try:
        return P.send_reminder(rid, user, force_quiet=bool(body and body.override_quiet_hours))
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/reminders/{rid}/mark-sent")
def reminder_mark_sent(rid: ReminderId, body: MarkIn | None = None, user: dict = Depends(require_perm("sales.record"))):
    _own_reminder(rid, user)
    try:
        return P.mark_reminder(rid, "sent", user, body.note if body else None, body.channel if body else None)
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/reminders/{rid}/skip")
def reminder_skip(rid: ReminderId, body: MarkIn | None = None, user: dict = Depends(require_perm("sales.record"))):
    _own_reminder(rid, user)
    try:
        return P.mark_reminder(rid, "skipped", user, body.note if body else None)
    except P.PatientError as e:
        raise _http(e) from None


@router.post("/reminders/{rid}/retry")
def reminder_retry(rid: ReminderId, user: dict = Depends(require_perm("sales.record"))):
    _own_reminder(rid, user)
    try:
        return P.retry_reminder(rid, user)
    except P.PatientError as e:
        raise _http(e) from None


@router.on_event("startup")
def _start_job():
    P.start_job()


@router.on_event("shutdown")
def _stop_job():
    P.stop_job()
