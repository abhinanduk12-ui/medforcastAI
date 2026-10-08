"""Consented refill reminders for chronic patients (privacy-first; India DPDP Act, 2023).

This module holds the data model and every rule that touches personal data. The HTTP layer is
backend/routers/patients.py.

Design (conservative reading of the Digital Personal Data Protection Act, 2023 -- this is NOT
legal advice; verify with counsel / your State Drugs Control authority before going live):

* Purpose limitation: the only purpose is ``refill_reminders``. A patient record cannot be created
  without capturing consent for that purpose (notice version + evidence), and nothing is tracked
  or sent while no consent is active.
* Data minimisation: a display name (first name / initials is enough), a phone number and an
  optional year of birth. No address, diagnosis or prescription images.
* Phones are stored (needed to send) but masked in every response. The full number is returned
  only by an explicit "reveal" or "open WhatsApp link" action, which is access-logged.
* Every read of personal data (list, detail, due list, lookup, reveal) and every write is written
  to ``patients_access_log``.
* Withdrawal is immediate: active consent is closed, pending reminders are skipped, and
  ``record_dispense`` refuses further tracking.
* Erasure soft-deletes the patient and scrubs every personal field (name, phone, year of birth,
  consent evidence, invoice numbers). Anonymised dispense rows (medicine, qty, dates, store) stay
  for demand statistics.
* Retention: personal data is erased automatically N months (setting) after the patient's last
  activity (latest of: last dispense, record creation, latest consent grant), and a short grace
  period (setting, default 30 days) after consent is withdrawn -- once consent is withdrawn the
  purpose is no longer served, so the data is not kept "just in case". A daily job applies both.

Inbound "STOP": there is no inbound webhook. Each reminder ends with "Reply STOP to stop"; when a
patient replies STOP (WhatsApp/SMS) or asks at the counter, staff withdraw consent in the app
(evidence e.g. "STOP via WhatsApp 01-10-2026"). Withdrawal takes effect immediately.

Contract used by other features:
    record_dispense(patient_id, medicine_id, qty, store_id, invoice_no, dispensed_at=None,
                    days_supply=None, user_id=None) -> int   (ValueError if no active consent)
    consented_patient_lookup(query, store_id, user_id=None) -> [{id, display_name, masked_phone}]
    committed_demand(store_id, weeks=4) -> pd.Series (expected refill units per medicine_id)
"""
from __future__ import annotations

import logging
import math
import re
import threading
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from backend import db
from backend import notify

log = logging.getLogger("medforecast.patients")

IST = timezone(timedelta(hours=5, minutes=30), "Asia/Kolkata")
PURPOSE = "refill_reminders"
CHANNELS = ("whatsapp", "sms", "call")
SETTINGS_KEY = "patients.settings"
RETENTION_STATE_KEY = "patients.retention_last_run"
MAX_QTY = 10_000
MAX_DAYS_SUPPLY = 365
OVERDUE_WINDOW_DAYS = 30          # due list shows reminders overdue by up to this many days
COMMITTED_OVERDUE_DAYS = 14       # committed demand counts refills overdue by up to this many days
PDC_MIN_PERIOD = 30               # adherence needs at least 30 observed days and 2 fills
PDC_LOOKBACK = 365
PDC_ADHERENT = 0.8                # conventional PDC >= 80% threshold

# Privacy notices, by version. Text is shown to the patient (read out or printed) before consent.
NOTICES: dict[str, dict] = {
    "2026-10-v1": {
        "title": "Refill reminders - privacy notice",
        "purpose": ("We will use your first name and mobile number, and a record of the chronic medicines you buy here "
                    "(name, quantity, date), only to remind you a few days before your medicine is due to run out."),
        "points": [
            "What we keep: your first name or initials, mobile number, optional year of birth, and refill dates for the medicines you choose.",
            "Why: only to send refill reminders (WhatsApp, SMS or a call). We do not use it for marketing and do not sell or share it.",
            "Who sees it: the pharmacists and owner of this pharmacy. Every look at your details is logged.",
            "Your choice: saying no does not affect your purchase. You can stop at any time by replying STOP or telling us at the counter.",
            "Your rights: you can ask to see, correct or erase your details. We erase them automatically after a period without purchases.",
            "Contact / grievance: speak to the pharmacist in charge or the owner of this pharmacy.",
        ],
        "legal_note": ("Prepared with India's Digital Personal Data Protection Act, 2023 in mind. This is not legal advice: "
                       "verify the notice, consent process and retention period with counsel before relying on it."),
    },
}
CURRENT_NOTICE = "2026-10-v1"

# Pack-size heuristic for the default days of supply: days = qty x days_per_unit[form], i.e. a tablet or
# capsule = 1 day (1 a day), a syrup bottle ~ 10 days, an inhaler ~ 30 days. The pharmacist should
# always correct it from the prescription; owners can edit the table in settings.
DEFAULT_DAYS_PER_UNIT = {
    "Tablet": 1.0, "Capsule": 1.0, "Sachet": 1.0, "Syrup": 10.0, "Suspension": 10.0, "Solution": 10.0,
    "Injection": 7.0, "Inhaler": 30.0, "Eye Drop": 30.0, "Cream": 14.0, "Gel": 14.0, "Lotion": 14.0,
    "_default": 1.0,
}

DEFAULT_SETTINGS = {
    "notice_version": CURRENT_NOTICE,
    "lead_days": 3,                   # remind this many days before the due date
    "quiet_start": "21:00",           # no automatic/API sends between these times (Asia/Kolkata)
    "quiet_end": "09:00",
    "retention_months": 24,           # erase personal data this long after the last dispense
    "withdrawn_erase_days": 30,       # erase personal data this many days after consent is withdrawn
    "include_medicine_name": False,   # put the medicine name in the message (health data on a third-party app)
    "auto_send": False,               # daily job sends due WhatsApp reminders via the Cloud API (if configured)
    "days_per_unit": DEFAULT_DAYS_PER_UNIT,
}

db.register_schema("patients", [
    """
    CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL REFERENCES stores(id),
        display_name TEXT,
        phone TEXT,
        year_of_birth INTEGER,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        deleted_at TEXT,
        erase_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS patients_store ON patients(store_id, deleted_at);
    CREATE TABLE IF NOT EXISTS patients_consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        purpose TEXT NOT NULL,
        notice_version TEXT NOT NULL,
        channel TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        withdrawn_at TEXT,
        captured_by INTEGER,
        withdrawn_by INTEGER,
        evidence TEXT,
        withdraw_note TEXT
    );
    CREATE INDEX IF NOT EXISTS patients_consents_patient ON patients_consents(patient_id, withdrawn_at);
    CREATE TABLE IF NOT EXISTS patients_dispenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        medicine_id TEXT NOT NULL,
        qty INTEGER NOT NULL CHECK (qty > 0),
        days_supply INTEGER NOT NULL CHECK (days_supply > 0),
        store_id TEXT NOT NULL,
        invoice_no TEXT,
        dispensed_at TEXT NOT NULL,
        user_id INTEGER,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patients_dispenses_patient ON patients_dispenses(patient_id, medicine_id, dispensed_at);
    CREATE TABLE IF NOT EXISTS patients_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id),
        medicine_id TEXT NOT NULL,
        dispense_id INTEGER REFERENCES patients_dispenses(id),
        store_id TEXT NOT NULL,
        qty INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        remind_on TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
        channel TEXT,
        sent_at TEXT,
        sent_by INTEGER,
        error TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patients_reminders_due ON patients_reminders(store_id, status, due_date);
    CREATE INDEX IF NOT EXISTS patients_reminders_patient ON patients_reminders(patient_id, medicine_id);
    CREATE TABLE IF NOT EXISTS patients_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        store_id TEXT,
        patient_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patients_access_log_at ON patients_access_log(at);
    CREATE INDEX IF NOT EXISTS patients_access_log_patient ON patients_access_log(patient_id);
    """,
])


# ── errors ───────────────────────────────────────────────────────────────────

class PatientError(ValueError):
    status = 400


class NotFound(PatientError):
    status = 404


class Conflict(PatientError):
    status = 409


class ConsentRequired(Conflict):
    """No active refill-reminder consent: nothing may be tracked or sent."""


# ── time / settings ──────────────────────────────────────────────────────────

def now_ist(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc)).astimezone(IST)


def today() -> date:
    return now_ist().date()


def _hhmm(s: str) -> tuple[int, int]:
    m = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", str(s or ""))
    if not m:
        raise PatientError("time must be HH:MM (24-hour, Asia/Kolkata)")
    return int(m.group(1)), int(m.group(2))


def get_settings() -> dict:
    s = db.get_setting(SETTINGS_KEY, None) or {}
    out = {**DEFAULT_SETTINGS, **{k: v for k, v in s.items() if k in DEFAULT_SETTINGS}}
    out["days_per_unit"] = {**DEFAULT_DAYS_PER_UNIT, **(s.get("days_per_unit") or {})}
    return out


def update_settings(patch: dict) -> dict:
    cur = get_settings()
    for k, v in patch.items():
        if v is None or k not in DEFAULT_SETTINGS:
            continue
        if k == "notice_version":
            if v not in NOTICES:
                raise PatientError(f"Unknown notice version '{v}'")
        elif k == "lead_days":
            if not isinstance(v, int) or not 0 <= v <= 14:
                raise PatientError("lead_days must be a whole number 0..14")
        elif k in ("quiet_start", "quiet_end"):
            _hhmm(v)
        elif k == "retention_months":
            if not isinstance(v, int) or not 1 <= v <= 120:
                raise PatientError("retention_months must be a whole number 1..120")
        elif k == "withdrawn_erase_days":
            if not isinstance(v, int) or not 0 <= v <= 365:
                raise PatientError("withdrawn_erase_days must be a whole number 0..365")
        elif k in ("include_medicine_name", "auto_send"):
            v = bool(v)
        elif k == "days_per_unit":
            if not isinstance(v, dict) or len(v) > 40:
                raise PatientError("days_per_unit must be an object of form -> days")
            clean_map = {}
            for form, d in v.items():
                if not isinstance(form, str) or not 0 < len(form) <= 40:
                    raise PatientError("days_per_unit keys must be form names")
                try:
                    d = float(d)
                except (TypeError, ValueError):
                    raise PatientError(f"days_per_unit[{form}] must be a number") from None
                if not math.isfinite(d) or not 0.1 <= d <= 120:
                    raise PatientError(f"days_per_unit[{form}] must be between 0.1 and 120")
                clean_map[form] = round(d, 2)
            v = {**cur["days_per_unit"], **clean_map}
        cur[k] = v
    with db.tx():
        old_lead = get_settings()["lead_days"]
        db.set_setting(SETTINGS_KEY, cur)
        if int(cur["lead_days"]) != int(old_lead):
            # keep pending reminders consistent with the new lead time
            db.execute("UPDATE patients_reminders SET remind_on = date(due_date, ?) WHERE status = 'pending'",
                       (f"-{int(cur['lead_days'])} days",))
    return cur


def in_quiet_hours(now: datetime | None = None, settings: dict | None = None) -> bool:
    s = settings or get_settings()
    t = now_ist(now)
    mins = t.hour * 60 + t.minute
    sh, sm = _hhmm(s["quiet_start"])
    eh, em = _hhmm(s["quiet_end"])
    a, b = sh * 60 + sm, eh * 60 + em
    if a == b:
        return False
    return (a <= mins < b) if a < b else (mins >= a or mins < b)


def notice(version: str | None = None) -> dict:
    v = version or get_settings()["notice_version"]
    return {"version": v, **NOTICES[v], "purpose_code": PURPOSE}


# ── validation helpers ───────────────────────────────────────────────────────

_CTRL = re.compile(r"[\x00-\x1f\x7f]+")


def _text(v, field: str, max_len: int, required: bool = False) -> str | None:
    s = _CTRL.sub(" ", str(v or "")).strip()
    if not s:
        if required:
            raise PatientError(f"{field} is required")
        return None
    if len(s) > max_len:
        raise PatientError(f"{field} must be at most {max_len} characters")
    return s


def _phone(v) -> str:
    p = notify.normalize_phone(str(v or ""))
    # country code + subscriber number; Indian mobiles must be 91 + [6-9]XXXXXXXXX
    if not p or len(p) < 11 or (p.startswith("91") and not re.fullmatch(r"91[6-9]\d{9}", p)):
        raise PatientError("Enter a valid mobile number (10 digits, or with country code)")
    return p


def _yob(v) -> int | None:
    if v in (None, ""):
        return None
    try:
        y = int(v)
    except (TypeError, ValueError):
        raise PatientError("year_of_birth must be a year") from None
    if not 1900 <= y <= today().year:
        raise PatientError("year_of_birth is out of range")
    return y


def _date(v, field: str) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise PatientError(f"{field} must be YYYY-MM-DD") from None


def _whole(v, field: str, lo: int, hi: int) -> int:
    if isinstance(v, bool):
        raise PatientError(f"{field} must be a whole number")
    if isinstance(v, float):
        if not math.isfinite(v) or v != int(v):
            raise PatientError(f"{field} must be a whole number")
        v = int(v)
    if not isinstance(v, int):
        try:
            v = int(str(v))
        except ValueError:
            raise PatientError(f"{field} must be a whole number") from None
    if not lo <= v <= hi:
        raise PatientError(f"{field} must be between {lo} and {hi}")
    return v


def _like(s: str) -> str:
    """Escape LIKE wildcards so user input matches literally (use with ESCAPE '!')."""
    return s.replace("!", "!!").replace("%", "!%").replace("_", "!_")


def mask_phone(p: str | None) -> str | None:
    if not p:
        return None
    m = notify.mask(p)
    return ("+" + m) if p.startswith("91") and len(p) == 12 else m


def _meds():
    from backend.core import S
    return S.meds


def medicine_name(mid: str) -> str:
    m = _meds()
    return str(m.at[mid, "medicine_name"]) if mid in m.index else mid


def _check_medicine(mid: str) -> str:
    mid = str(mid or "").strip()
    if mid not in _meds().index:
        raise NotFound(f"Unknown medicine '{mid}'")
    return mid


def default_days_supply(medicine_id: str, qty: int, settings: dict | None = None) -> dict:
    """Explicit pack-size heuristic: days = qty x days_per_unit[form] (1 per day for tablets)."""
    s = settings or get_settings()
    mid = _check_medicine(medicine_id)
    form = str(_meds().at[mid, "form"])
    dpu = s["days_per_unit"]
    per = float(dpu.get(form, dpu.get("_default", 1.0)))
    days = int(max(1, min(MAX_DAYS_SUPPLY, round(qty * per))))
    return {"medicine_id": mid, "form": form, "qty": qty, "days_per_unit": per, "days_supply": days,
            "basis": f"{qty} x {per:g} day(s) per {form.lower()} unit (default heuristic; check the prescribed dose)"}


# ── access log ───────────────────────────────────────────────────────────────

def log_access(user: dict | None, action: str, patient_id: int | None = None, store_id: str | None = None,
               detail: str | None = None) -> None:
    db.execute(
        "INSERT INTO patients_access_log (user_id, username, store_id, patient_id, action, detail, at) VALUES (?,?,?,?,?,?,?)",
        ((user or {}).get("id"), (user or {}).get("username"), store_id, patient_id, action,
         (detail or None) and str(detail)[:300], db.now_iso()),
    )


def access_log(store_id: str | None = None, patient_id: int | None = None, limit: int = 200, offset: int = 0) -> dict:
    where, params = [], []
    if store_id:
        where.append("store_id = ?")
        params.append(store_id)
    if patient_id is not None:
        where.append("patient_id = ?")
        params.append(patient_id)
    w = (" WHERE " + " AND ".join(where)) if where else ""
    rows = db.query(f"SELECT id, user_id, username, store_id, patient_id, action, detail, at FROM patients_access_log{w} "
                    "ORDER BY id DESC LIMIT ? OFFSET ?", (*params, limit, offset))
    total = db.scalar(f"SELECT COUNT(*) FROM patients_access_log{w}", params, 0)
    return {"rows": rows, "total": total, "limit": limit, "offset": offset}


# ── core reads ───────────────────────────────────────────────────────────────

def _patient_row(pid: int, include_deleted: bool = False) -> dict:
    r = db.query_one("SELECT * FROM patients WHERE id = ?", (pid,))
    if not r or (r["deleted_at"] and not include_deleted):
        raise NotFound("Patient not found")
    return r


def active_consent(pid: int) -> dict | None:
    return db.query_one(
        "SELECT * FROM patients_consents WHERE patient_id = ? AND purpose = ? AND withdrawn_at IS NULL "
        "ORDER BY id DESC LIMIT 1", (pid, PURPOSE))


def _has_consent(pid: int) -> bool:
    return active_consent(pid) is not None


def _public(r: dict, consent: dict | None) -> dict:
    return {
        "id": r["id"], "store_id": r["store_id"], "display_name": r["display_name"],
        "masked_phone": mask_phone(r["phone"]), "year_of_birth": r["year_of_birth"],
        "created_at": r["created_at"], "updated_at": r["updated_at"],
        "consent": ({"active": True, "channel": consent["channel"], "granted_at": consent["granted_at"],
                     "notice_version": consent["notice_version"]} if consent else {"active": False}),
    }


def list_patients(store_id: str, q: str | None = None, status: str = "active", limit: int = 200) -> list[dict]:
    """Non-erased patients of a store with masked phones, consent state and next due refill."""
    t = today()
    params: list = [store_id]
    where = "p.store_id = ? AND p.deleted_at IS NULL"
    qq = (q or "").strip()
    if qq:
        digits = re.sub(r"\D", "", qq)
        if digits and len(digits) >= 4:
            where += " AND (p.display_name LIKE ? ESCAPE '!' OR p.phone LIKE ?)"
            params += [f"%{_like(qq)}%", f"%{digits}"]
        else:
            where += " AND p.display_name LIKE ? ESCAPE '!'"
            params.append(f"%{_like(qq)}%")
    rows = db.query(
        f"""SELECT p.*, c.channel AS c_channel, c.granted_at AS c_granted, c.notice_version AS c_notice,
                   (SELECT MIN(due_date) FROM patients_reminders r WHERE r.patient_id = p.id AND r.status = 'pending') AS next_due,
                   (SELECT COUNT(DISTINCT medicine_id) FROM patients_dispenses d WHERE d.patient_id = p.id) AS n_medicines,
                   (SELECT MAX(dispensed_at) FROM patients_dispenses d WHERE d.patient_id = p.id) AS last_dispense
            FROM patients p
            LEFT JOIN patients_consents c ON c.id = (SELECT id FROM patients_consents c2 WHERE c2.patient_id = p.id
                     AND c2.purpose = ? AND c2.withdrawn_at IS NULL ORDER BY id DESC LIMIT 1)
            WHERE {where} ORDER BY p.display_name COLLATE NOCASE LIMIT ?""",
        (PURPOSE, *params, limit))
    out = []
    for r in rows:
        consent = {"channel": r["c_channel"], "granted_at": r["c_granted"], "notice_version": r["c_notice"]} if r["c_channel"] else None
        if status == "active" and not consent:
            continue
        if status == "withdrawn" and consent:
            continue
        p = _public(r, consent)
        nd = r["next_due"] if consent else None
        p.update({"next_due": nd, "days_to_due": (date.fromisoformat(nd) - t).days if nd else None,
                  "n_medicines": r["n_medicines"], "last_dispense": r["last_dispense"]})
        out.append(p)
    return out


def _pdc(fills: list[dict], t: date) -> dict:
    """Proportion of days covered, carrying overlapping supply forward (standard PDC method)."""
    if len(fills) < 2:
        return {"pdc": None, "reason": "Needs at least 2 refills at this pharmacy"}
    start = max(date.fromisoformat(fills[0]["dispensed_at"]), t - timedelta(days=PDC_LOOKBACK))
    period = (t - start).days
    if period < PDC_MIN_PERIOD:
        return {"pdc": None, "reason": f"Needs at least {PDC_MIN_PERIOD} days of history"}
    covered = set()
    # carry-over starts from the first fill itself (not the window start), so supply that ran out
    # before the look-back window is never shifted into it
    cursor = date.fromisoformat(fills[0]["dispensed_at"])
    for f in fills:
        d = date.fromisoformat(f["dispensed_at"])
        s = max(d, cursor)
        for i in range(int(f["days_supply"])):
            day = s + timedelta(days=i)
            if start <= day < t:
                covered.add(day)
        cursor = s + timedelta(days=int(f["days_supply"]))
    pdc = len(covered) / period
    return {"pdc": round(pdc, 3), "period_days": period, "covered_days": len(covered),
            "adherent": pdc >= PDC_ADHERENT, "reason": None}


def patient_detail(pid: int) -> dict:
    r = _patient_row(pid)
    consent = active_consent(pid)
    t = today()
    consents = db.query("SELECT id, purpose, notice_version, channel, granted_at, withdrawn_at, captured_by, withdrawn_by, "
                        "evidence, withdraw_note FROM patients_consents WHERE patient_id = ? ORDER BY id DESC", (pid,))
    disp = db.query("SELECT id, medicine_id, qty, days_supply, store_id, invoice_no, dispensed_at, user_id "
                    "FROM patients_dispenses WHERE patient_id = ? ORDER BY dispensed_at DESC, id DESC", (pid,))
    rem = db.query("SELECT id, medicine_id, dispense_id, qty, due_date, remind_on, status, channel, sent_at, error "
                   "FROM patients_reminders WHERE patient_id = ? ORDER BY due_date DESC, id DESC LIMIT 100", (pid,))
    for d in disp:
        d["medicine_name"] = medicine_name(d["medicine_id"])
        d["due_date"] = (date.fromisoformat(d["dispensed_at"]) + timedelta(days=d["days_supply"])).isoformat()
    for x in rem:
        x["medicine_name"] = medicine_name(x["medicine_id"])
    meds = []
    by_med: dict[str, list[dict]] = {}
    for d in sorted(disp, key=lambda d: (d["dispensed_at"], d["id"])):
        by_med.setdefault(d["medicine_id"], []).append(d)
    for mid, fills in by_med.items():
        last = fills[-1]
        nxt = next((x for x in rem if x["medicine_id"] == mid and x["status"] == "pending"), None)
        meds.append({"medicine_id": mid, "medicine_name": medicine_name(mid), "n_fills": len(fills),
                     "last_dispensed": last["dispensed_at"], "last_qty": last["qty"], "days_supply": last["days_supply"],
                     "next_due": nxt["due_date"] if nxt and consent else None,
                     "adherence": _pdc(fills, t)})
    meds.sort(key=lambda m: m["last_dispensed"], reverse=True)
    return {**_public(r, consent), "consents": consents, "dispenses": disp, "reminders": rem, "medicines": meds,
            "adherence_note": ("Proportion of days covered (PDC) over up to the last 12 months, counting only refills "
                               "recorded at this pharmacy; >= 80% is the usual 'adherent' threshold. A clinical prompt "
                               "for the pharmacist, not a diagnosis.")}


# ── writes ───────────────────────────────────────────────────────────────────

def _evidence(v) -> str:
    return _text(v, "evidence", 200, required=True)  # type: ignore[return-value]


def create_patient(store_id: str, display_name, phone, year_of_birth, consent: dict, user: dict | None) -> dict:
    name = _text(display_name, "display_name", 60, required=True)
    ph = _phone(phone)
    yob = _yob(year_of_birth)
    nv = consent.get("notice_version")
    if nv not in NOTICES:
        raise PatientError("Unknown privacy notice version")
    ch = consent.get("channel")
    if ch not in CHANNELS:
        raise PatientError(f"channel must be one of {', '.join(CHANNELS)}")
    if consent.get("confirmed") is not True:
        raise PatientError("Consent must be explicitly confirmed (the notice was given and the patient agreed)")
    ev = _evidence(consent.get("evidence"))
    with db.tx():
        dup = db.query_one("SELECT id FROM patients WHERE store_id = ? AND phone = ? AND deleted_at IS NULL", (store_id, ph))
        if dup:
            raise Conflict("A patient with this mobile number already exists at this store")
        now = db.now_iso()
        pid = db.execute("INSERT INTO patients (store_id, display_name, phone, year_of_birth, created_by, created_at, updated_at) "
                         "VALUES (?,?,?,?,?,?,?)", (store_id, name, ph, yob, (user or {}).get("id"), now, now)).lastrowid
        db.execute("INSERT INTO patients_consents (patient_id, purpose, notice_version, channel, granted_at, captured_by, evidence) "
                   "VALUES (?,?,?,?,?,?,?)", (pid, PURPOSE, nv, ch, now, (user or {}).get("id"), ev))
        log_access(user, "create", pid, store_id, f"consent {nv} via {ch}")
    return _public(_patient_row(pid), active_consent(pid))


def update_patient(pid: int, patch: dict, user: dict | None) -> dict:
    r = _patient_row(pid)
    sets, params, changed = [], [], []
    if patch.get("display_name") is not None:
        sets.append("display_name = ?")
        params.append(_text(patch["display_name"], "display_name", 60, required=True))
        changed.append("name")
    if patch.get("phone") is not None:
        ph = _phone(patch["phone"])
        if db.query_one("SELECT id FROM patients WHERE store_id = ? AND phone = ? AND deleted_at IS NULL AND id != ?",
                        (r["store_id"], ph, pid)):
            raise Conflict("Another patient at this store has this mobile number")
        sets.append("phone = ?")
        params.append(ph)
        changed.append("phone")
    if "year_of_birth" in patch:
        sets.append("year_of_birth = ?")
        params.append(_yob(patch["year_of_birth"]))
        changed.append("year_of_birth")
    if not sets:
        raise PatientError("Nothing to update")
    with db.tx():
        db.execute(f"UPDATE patients SET {', '.join(sets)}, updated_at = ? WHERE id = ?", (*params, db.now_iso(), pid))
        log_access(user, "update", pid, r["store_id"], ",".join(changed))
    return _public(_patient_row(pid), active_consent(pid))


def reveal_phone(pid: int, user: dict | None, reason: str | None = None) -> dict:
    r = _patient_row(pid)
    log_access(user, "reveal_phone", pid, r["store_id"], reason)
    return {"id": pid, "phone": "+" + r["phone"] if r["phone"] else None}


def grant_consent(pid: int, notice_version: str, channel: str, evidence, user: dict | None, confirmed: bool) -> dict:
    r = _patient_row(pid)
    if notice_version not in NOTICES:
        raise PatientError("Unknown privacy notice version")
    if channel not in CHANNELS:
        raise PatientError(f"channel must be one of {', '.join(CHANNELS)}")
    if confirmed is not True:
        raise PatientError("Consent must be explicitly confirmed")
    ev = _evidence(evidence)
    with db.tx():
        if active_consent(pid):
            raise Conflict("Consent is already active")
        db.execute("INSERT INTO patients_consents (patient_id, purpose, notice_version, channel, granted_at, captured_by, evidence) "
                   "VALUES (?,?,?,?,?,?,?)", (pid, PURPOSE, notice_version, channel, db.now_iso(), (user or {}).get("id"), ev))
        log_access(user, "consent_grant", pid, r["store_id"], f"{notice_version} via {channel}")
    return patient_detail(pid)


def withdraw_consent(pid: int, note, user: dict | None) -> dict:
    """Immediate: closes the consent and skips every pending reminder."""
    r = _patient_row(pid)
    note = _text(note, "note", 200) or "withdrawn"
    with db.tx():
        c = active_consent(pid)
        if not c:
            raise Conflict("No active consent to withdraw")
        now = db.now_iso()
        db.execute("UPDATE patients_consents SET withdrawn_at = ?, withdrawn_by = ?, withdraw_note = ? "
                   "WHERE patient_id = ? AND withdrawn_at IS NULL", (now, (user or {}).get("id"), note, pid))
        n = db.execute("UPDATE patients_reminders SET status = 'skipped', error = 'consent withdrawn' "
                       "WHERE patient_id = ? AND status = 'pending'", (pid,)).rowcount
        log_access(user, "consent_withdraw", pid, r["store_id"], f"{n} pending reminder(s) cancelled")
    return patient_detail(pid)


def record_dispense(patient_id: int, medicine_id: str, qty: int, store_id: str, invoice_no: str | None,
                    dispensed_at=None, days_supply: int | None = None, user_id: int | None = None) -> int:
    """Track a dispense for refill reminders. Raises ValueError (ConsentRequired) without active consent.

    Creates the next reminder (due = dispensed_at + days_supply, remind on due - lead_days) and
    supersedes older pending reminders for the same medicine. Safe inside an outer db.tx().
    """
    pid = _whole(patient_id, "patient_id", 1, 2**62)
    mid = _check_medicine(medicine_id)
    q = _whole(qty, "qty", 1, MAX_QTY)
    inv_no = _text(invoice_no, "invoice_no", 100)
    d = _date(dispensed_at, "dispensed_at") if dispensed_at else today()
    if d > today():
        raise PatientError("dispensed_at cannot be in the future")
    s = get_settings()
    days = _whole(days_supply, "days_supply", 1, MAX_DAYS_SUPPLY) if days_supply not in (None, "") else \
        default_days_supply(mid, q, s)["days_supply"]
    with db.tx():
        r = db.query_one("SELECT id, store_id, deleted_at FROM patients WHERE id = ?", (pid,))
        if not r or r["deleted_at"]:
            raise NotFound("Patient not found")
        if r["store_id"] != store_id:
            raise NotFound("Patient not found at this store")
        if not _has_consent(pid):
            raise ConsentRequired("No active refill-reminder consent: dispense not tracked")
        now = db.now_iso()
        did = db.execute("INSERT INTO patients_dispenses (patient_id, medicine_id, qty, days_supply, store_id, invoice_no, "
                         "dispensed_at, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                         (pid, mid, q, days, store_id, inv_no, d.isoformat(), user_id, now)).lastrowid
        newer = db.scalar("SELECT MAX(dispensed_at) FROM patients_dispenses WHERE patient_id = ? AND medicine_id = ? "
                          "AND id != ?", (pid, mid, did), None)
        if not newer or d.isoformat() >= newer:
            # only the latest dispense drives the reminder; back-filled history never supersedes it
            db.execute("UPDATE patients_reminders SET status = 'skipped', error = 'superseded by a newer dispense' "
                       "WHERE patient_id = ? AND medicine_id = ? AND status = 'pending'", (pid, mid))
            due = d + timedelta(days=days)
            db.execute("INSERT INTO patients_reminders (patient_id, medicine_id, dispense_id, store_id, qty, due_date, "
                       "remind_on, status, created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)",
                       (pid, mid, did, store_id, q, due.isoformat(),
                        (due - timedelta(days=int(s["lead_days"]))).isoformat(), now))
        log_access({"id": user_id, "username": None} if user_id else None, "dispense", pid, store_id,
                   f"{mid} x{q}, {days} days")
    return int(did)


def erase_patient(pid: int, reason, user: dict | None, *, system: bool = False) -> dict:
    """Erasure: soft-delete + scrub personal fields. Anonymised dispense rows are kept for demand stats."""
    r = _patient_row(pid)
    why = _text(reason, "reason", 120) or ("retention policy" if system else "erasure request")
    with db.tx():
        now = db.now_iso()
        db.execute("UPDATE patients SET display_name = NULL, phone = NULL, year_of_birth = NULL, deleted_at = ?, "
                   "updated_at = ?, erase_reason = ? WHERE id = ?", (now, now, why, pid))
        db.execute("UPDATE patients_consents SET withdrawn_at = COALESCE(withdrawn_at, ?), "
                   "withdraw_note = '[erased]', evidence = '[erased]' WHERE patient_id = ?", (now, pid))
        db.execute("UPDATE patients_reminders SET status = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END, "
                   "error = CASE WHEN status = 'pending' THEN 'erased' ELSE NULL END WHERE patient_id = ?", (pid,))
        db.execute("UPDATE patients_dispenses SET invoice_no = NULL WHERE patient_id = ?", (pid,))
        log_access(user, "erase", pid, r["store_id"], why)
    return {"id": pid, "erased": True, "erased_at": now, "reason": why}


# ── due list & reminders ─────────────────────────────────────────────────────

def _first_name(name: str | None) -> str:
    return (name or "").split(" ")[0][:30] or "there"


def message_text(rem: dict, patient: dict, store_name: str, settings: dict | None = None) -> str:
    s = settings or get_settings()
    what = f"your {medicine_name(rem['medicine_id'])}" if s["include_medicine_name"] else "your regular medicine"
    due = date.fromisoformat(rem["due_date"]).strftime("%d %b")
    return (f"Hello {_first_name(patient['display_name'])}, this is {store_name}. A friendly reminder that {what} "
            f"is due for a refill around {due}. We can keep it ready for you. Reply STOP to stop these reminders.")


def due_list(store_id: str, days: int = 7) -> list[dict]:
    """Pending reminders (active consent only) due within `days`, plus those overdue up to 30 days."""
    t = today()
    rows = db.query(
        """SELECT r.id, r.patient_id, r.medicine_id, r.qty, r.due_date, r.remind_on, r.status,
                  p.display_name, p.phone, c.channel
           FROM patients_reminders r
           JOIN patients p ON p.id = r.patient_id AND p.deleted_at IS NULL
           JOIN patients_consents c ON c.id = (SELECT id FROM patients_consents c2 WHERE c2.patient_id = p.id
                AND c2.purpose = ? AND c2.withdrawn_at IS NULL ORDER BY id DESC LIMIT 1)
           WHERE r.store_id = ? AND r.status = 'pending' AND r.due_date >= ? AND r.due_date <= ?
           ORDER BY r.due_date, r.id""",
        (PURPOSE, store_id, (t - timedelta(days=OVERDUE_WINDOW_DAYS)).isoformat(), (t + timedelta(days=days)).isoformat()))
    out = []
    for r in rows:
        dd = (date.fromisoformat(r["due_date"]) - t).days
        out.append({"id": r["id"], "patient_id": r["patient_id"], "display_name": r["display_name"],
                    "masked_phone": mask_phone(r["phone"]), "medicine_id": r["medicine_id"],
                    "medicine_name": medicine_name(r["medicine_id"]), "qty": r["qty"], "due_date": r["due_date"],
                    "remind_on": r["remind_on"], "days_to_due": dd, "ready": r["remind_on"] <= t.isoformat(),
                    "state": "overdue" if dd < 0 else "due_today" if dd == 0 else "due_soon" if dd <= 3 else "upcoming",
                    "channel": r["channel"]})
    return out


def _reminder(rid: int) -> dict:
    r = db.query_one("SELECT * FROM patients_reminders WHERE id = ?", (rid,))
    if not r:
        raise NotFound("Reminder not found")
    return r


def _sendable(rid: int) -> tuple[dict, dict]:
    rem = _reminder(rid)
    p = db.query_one("SELECT * FROM patients WHERE id = ?", (rem["patient_id"],))
    if not p or p["deleted_at"]:
        raise NotFound("Reminder not found")
    if not _has_consent(p["id"]):
        raise ConsentRequired("Consent has been withdrawn: this reminder cannot be sent")
    if rem["status"] != "pending":
        raise Conflict(f"Reminder is already {rem['status']}")
    return rem, p


def reminder_store(rid: int) -> str:
    return _reminder(rid)["store_id"]


def _store_name(store_id: str) -> str:
    r = db.query_one("SELECT name FROM stores WHERE id = ?", (store_id,))
    return (r or {}).get("name") or "your pharmacy"


def reminder_link(rid: int, user: dict | None) -> dict:
    """wa.me / sms: link with the message pre-filled, for one-tap manual sending (access-logged)."""
    rem, p = _sendable(rid)
    s = get_settings()
    text = message_text(rem, p, _store_name(rem["store_id"]), s)
    c = active_consent(p["id"]) or {}
    import urllib.parse
    ch = c.get("channel")
    if ch == "sms":
        link = f"sms:+{p['phone']}?body={urllib.parse.quote(text, safe='')}"
    elif ch == "call":   # the patient agreed to a call, not a message: dial, and use the text as a script
        link = f"tel:+{p['phone']}"
    else:
        link = notify.wa_share_link(text, p["phone"])
    log_access(user, "reminder_link", p["id"], rem["store_id"], f"reminder {rid} ({c.get('channel')})")
    return {"id": rid, "channel": c.get("channel"), "link": link, "text": text,
            "quiet_hours": in_quiet_hours(settings=s),
            "note": "Opens WhatsApp/SMS on this device with the message filled in. Press send there, then 'Mark sent' here."}


def mark_reminder(rid: int, status: str, user: dict | None, note: str | None = None, channel: str | None = None) -> dict:
    if status not in ("sent", "skipped"):
        raise PatientError("status must be sent or skipped")
    with db.tx():
        if status == "sent":
            rem, p = _sendable(rid)
        else:
            rem = _reminder(rid)
            if rem["status"] != "pending":
                raise Conflict(f"Reminder is already {rem['status']}")
            p = {"id": rem["patient_id"]}
        if _in_flight(rem):
            raise Conflict("This reminder is being sent through the WhatsApp API right now")
        db.execute("UPDATE patients_reminders SET status = ?, channel = ?, sent_at = ?, sent_by = ?, error = ? WHERE id = ?",
                   (status, (channel or "manual") if status == "sent" else None, db.now_iso() if status == "sent" else None,
                    (user or {}).get("id"), _text(note, "note", 200), rid))
        log_access(user, f"reminder_{status}", p["id"], rem["store_id"], f"reminder {rid}")
    return _reminder(rid)


SENDING_PREFIX = "sending@"
SEND_CLAIM_TTL_S = 120            # an API send claim older than this (crashed worker) can be re-claimed
REFILL_TEMPLATE_ENV = "MEDFORECAST_WA_REFILL_TEMPLATE"


def _in_flight(rem: dict) -> bool:
    err = rem.get("error") or ""
    if not err.startswith(SENDING_PREFIX):
        return False
    try:
        at = datetime.fromisoformat(err[len(SENDING_PREFIX):].replace("Z", "+00:00"))
    except ValueError:
        return False
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - at).total_seconds() < SEND_CLAIM_TTL_S


def refill_whatsapp_mode() -> dict:
    """How API sends go out. The morning-brief template (MEDFORECAST_WA_TEMPLATE) is never reused for
    patients: refill reminders use MEDFORECAST_WA_REFILL_TEMPLATE (one body parameter = the message)
    when set, otherwise free-form text, which Meta delivers only inside the 24-hour service window."""
    import os
    tpl = os.environ.get(REFILL_TEMPLATE_ENV, "").strip()
    return {"mode": "template" if tpl else "text", "template": tpl or None,
            "lang": os.environ.get("MEDFORECAST_WA_REFILL_TEMPLATE_LANG", "").strip() or "en"}


def _wa_send(phone: str, text: str) -> tuple[bool, str | None]:
    import os
    cfg = notify.whatsapp_config()
    mode = refill_whatsapp_mode()
    to = notify.normalize_phone(phone)
    if not to:
        return False, "invalid phone number"
    if mode["template"]:
        param = re.sub(r"\s+", " ", text).strip()[:notify.WA_PARAM_LIMIT]
        payload = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "template",
                   "template": {"name": mode["template"], "language": {"code": mode["lang"]},
                                "components": [{"type": "body", "parameters": [{"type": "text", "text": param}]}]}}
    else:
        payload = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "text",
                   "text": {"preview_url": False, "body": text[:notify.WA_TEXT_LIMIT]}}
    url = (f"https://graph.facebook.com/{cfg['api_version']}/"
           f"{os.environ.get('MEDFORECAST_WA_PHONE_ID', '').strip()}/messages")
    headers = {"Authorization": f"Bearer {os.environ.get('MEDFORECAST_WA_TOKEN', '').strip()}"}
    try:
        status, body = notify._http_post_json(url, payload, headers)
    except Exception as e:  # noqa: BLE001 -- report, never pretend
        return False, notify._short_error(e)
    msgs = body.get("messages") if isinstance(body, dict) else None
    if 200 <= status < 300 and msgs:
        return True, None
    err = body.get("error", {}) if isinstance(body, dict) else {}
    msg = err.get("message") if isinstance(err, dict) else None
    return False, f"HTTP {status}" + (f": {str(msg)[:200]}" if msg else "")


def send_reminder(rid: int, user: dict | None, *, force_quiet: bool = False) -> dict:
    """Send through the WhatsApp Cloud API when configured. Never claims a send that did not happen.

    The reminder is claimed (error = 'sending@<ts>') inside a write transaction before the network
    call, so concurrent sends (double click, the daily job) cannot message the patient twice."""
    s = get_settings()
    rem, p = _sendable(rid)
    c = active_consent(p["id"]) or {}
    if c.get("channel") != "whatsapp":
        raise Conflict(f"Patient chose {c.get('channel')} reminders: use the manual link or call")
    if in_quiet_hours(settings=s) and not force_quiet:
        raise Conflict(f"Quiet hours ({s['quiet_start']}-{s['quiet_end']} IST): reminders are not sent now")
    if not notify.whatsapp_config()["configured"]:
        log_access(user, "reminder_send_unconfigured", p["id"], rem["store_id"], f"reminder {rid}")
        return {"id": rid, "status": "not_configured", "sent": False,
                "error": "WhatsApp Cloud API is not configured; use the one-tap wa.me link instead"}
    marker = SENDING_PREFIX + db.now_iso()
    with db.tx():
        rem, p = _sendable(rid)            # re-check under the write lock
        if _in_flight(rem):
            raise Conflict("This reminder is already being sent")
        db.execute("UPDATE patients_reminders SET error = ? WHERE id = ? AND status = 'pending'", (marker, rid))
    text = message_text(rem, p, _store_name(rem["store_id"]), s)
    ok, err = False, "send interrupted"
    try:
        ok, err = _wa_send(p["phone"], text)
        err = None if ok else notify.mask_text(err)
    finally:
        with db.tx():
            db.execute("UPDATE patients_reminders SET status = ?, channel = 'whatsapp_api', sent_at = ?, sent_by = ?, "
                       "error = ? WHERE id = ? AND status = 'pending' AND error = ?",
                       ("sent" if ok else "failed", db.now_iso() if ok else None, (user or {}).get("id"), err, rid, marker))
            log_access(user, "reminder_send", p["id"], rem["store_id"], f"reminder {rid}: {'sent' if ok else 'failed'}")
    return {"id": rid, "status": "sent" if ok else "failed", "sent": ok, "error": err}


def retry_reminder(rid: int, user: dict | None) -> dict:
    with db.tx():
        rem = _reminder(rid)
        if rem["status"] != "failed":
            raise Conflict("Only failed reminders can be retried")
        db.execute("UPDATE patients_reminders SET status = 'pending', error = NULL WHERE id = ?", (rid,))
        log_access(user, "reminder_retry", rem["patient_id"], rem["store_id"], f"reminder {rid}")
    return _reminder(rid)


# ── contract: lookup & committed demand ─────────────────────────────────────

def consented_patient_lookup(query: str, store_id: str, user_id: int | None = None, limit: int = 10) -> list[dict]:
    """Patients with active consent matching a name fragment or the last 4+ digits of their phone."""
    qq = _CTRL.sub(" ", str(query or "")).strip()[:60]
    if len(qq) < 2:
        return []
    digits = re.sub(r"\D", "", qq)
    if len(digits) >= 4:
        cond, params = "p.phone LIKE ?", [f"%{digits}"]
    else:
        cond, params = "p.display_name LIKE ? ESCAPE '!'", [f"%{_like(qq)}%"]
    rows = db.query(
        f"""SELECT p.id, p.display_name, p.phone FROM patients p
            WHERE p.store_id = ? AND p.deleted_at IS NULL AND {cond}
              AND EXISTS (SELECT 1 FROM patients_consents c WHERE c.patient_id = p.id AND c.purpose = ? AND c.withdrawn_at IS NULL)
            ORDER BY p.display_name COLLATE NOCASE LIMIT ?""", (store_id, *params, PURPOSE, int(limit)))
    if rows:
        log_access({"id": user_id, "username": None} if user_id else None, "lookup", None, store_id, f"{len(rows)} match(es)")
    return [{"id": r["id"], "display_name": r["display_name"], "masked_phone": mask_phone(r["phone"])} for r in rows]


def committed_demand(store_id: str, weeks: int = 4, *, with_patients: bool = False):
    """Expected refill units per medicine for pending reminders due in [today - 14d, today + weeks).

    Only patients with active consent count; the quantity is the last dispensed quantity. Returns a
    pandas Series (index medicine_id, name 'committed_units'); with_patients=True returns a DataFrame
    with units and patient counts (for owner/pharmacist views only).
    """
    t = today()
    rows = db.query(
        """SELECT r.medicine_id, SUM(r.qty) AS units, COUNT(DISTINCT r.patient_id) AS patients
           FROM patients_reminders r JOIN patients p ON p.id = r.patient_id AND p.deleted_at IS NULL
           WHERE r.store_id = ? AND r.status IN ('pending', 'sent') AND r.due_date >= ? AND r.due_date < ?
             AND EXISTS (SELECT 1 FROM patients_consents c WHERE c.patient_id = p.id AND c.purpose = ? AND c.withdrawn_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM patients_dispenses d WHERE d.patient_id = r.patient_id
                             AND d.medicine_id = r.medicine_id AND d.id > COALESCE(r.dispense_id, 0))
           GROUP BY r.medicine_id""",
        (store_id, (t - timedelta(days=COMMITTED_OVERDUE_DAYS)).isoformat(),
         (t + timedelta(weeks=max(1, int(weeks)))).isoformat(), PURPOSE))
    df = pd.DataFrame(rows, columns=["medicine_id", "units", "patients"]).set_index("medicine_id")
    if with_patients:
        return df
    return df["units"].astype(float).rename("committed_units")


# ── retention ────────────────────────────────────────────────────────────────

def retention_candidates(months: int | None = None, withdrawn_days: int | None = None) -> list[dict]:
    """Non-erased patients due for erasure: (a) no activity for `months` -- activity is the latest of
    last dispense, record creation and latest consent grant (a back-dated dispense entered today
    must not erase a new patient); (b) no active consent, withdrawn at least `withdrawn_days` ago."""
    s = get_settings()
    m = int(months or s["retention_months"])
    wd = int(s["withdrawn_erase_days"] if withdrawn_days is None else withdrawn_days)
    t = today()
    cutoff = (t - timedelta(days=round(m * 30.44))).isoformat()
    wcut = (t - timedelta(days=wd)).isoformat()
    rows = db.query(
        """SELECT p.id, p.store_id,
                  MAX(substr(p.created_at, 1, 10),
                      COALESCE((SELECT MAX(dispensed_at) FROM patients_dispenses d WHERE d.patient_id = p.id), ''),
                      COALESCE((SELECT substr(MAX(granted_at), 1, 10) FROM patients_consents c
                                WHERE c.patient_id = p.id), '')) AS last_activity,
                  EXISTS (SELECT 1 FROM patients_consents c WHERE c.patient_id = p.id AND c.purpose = ?
                          AND c.withdrawn_at IS NULL) AS consent_active,
                  (SELECT substr(MAX(withdrawn_at), 1, 10) FROM patients_consents c
                    WHERE c.patient_id = p.id) AS withdrawn_on
           FROM patients p WHERE p.deleted_at IS NULL""", (PURPOSE,))
    out = []
    for r in rows:
        if r["last_activity"] < cutoff:
            out.append({**r, "why": f"retention policy ({m} months without activity)"})
        elif not r["consent_active"] and r["withdrawn_on"] and r["withdrawn_on"] <= wcut:
            out.append({**r, "why": f"consent withdrawn ({wd}-day grace period over)"})
    return out


def run_retention(user: dict | None = None) -> dict:
    s = get_settings()
    cands = retention_candidates(s["retention_months"])
    for c in cands:
        try:
            erase_patient(c["id"], c["why"], user, system=True)
        except NotFound:          # erased concurrently
            pass
    state = {"at": db.now_iso(), "date": today().isoformat(), "erased": len(cands), "months": s["retention_months"]}
    db.set_setting(RETENTION_STATE_KEY, state)
    return state


def retention_status() -> dict:
    s = get_settings()
    return {"months": s["retention_months"], "last_run": db.get_setting(RETENTION_STATE_KEY, None),
            "withdrawn_erase_days": s["withdrawn_erase_days"],
            "due_for_erasure": len(retention_candidates(s["retention_months"]))}


def auto_send_due(user: dict | None = None) -> dict:
    """Daily job part 2: if enabled + WhatsApp API configured + outside quiet hours, send ready reminders."""
    s = get_settings()
    if not s["auto_send"] or not notify.whatsapp_config()["configured"] or in_quiet_hours(settings=s):
        return {"sent": 0, "failed": 0, "skipped": "disabled, unconfigured or quiet hours"}
    t = today().isoformat()
    rows = db.query("SELECT r.id FROM patients_reminders r JOIN patients p ON p.id = r.patient_id AND p.deleted_at IS NULL "
                    "JOIN patients_consents c ON c.patient_id = p.id AND c.purpose = 'refill_reminders' AND c.withdrawn_at IS NULL AND c.channel = 'whatsapp' "
                    "WHERE r.status = 'pending' AND r.remind_on <= ? AND r.due_date >= ? LIMIT 200",
                    (t, (today() - timedelta(days=OVERDUE_WINDOW_DAYS)).isoformat()))
    sent = failed = 0
    for r in rows:
        try:
            res = send_reminder(r["id"], user)
            sent += res["sent"]
            failed += not res["sent"]
        except PatientError:
            failed += 1
    return {"sent": sent, "failed": failed}


# ── daily job thread ─────────────────────────────────────────────────────────

_job_stop = threading.Event()
_job_thread: threading.Thread | None = None
JOB_TICK_S = 900
JOB_STATE: dict = {"running": False, "last_tick": None, "last_error": None, "last_auto_send": None}


def daily_tick() -> None:
    last = db.get_setting(RETENTION_STATE_KEY, None) or {}
    if last.get("date") != today().isoformat():
        run_retention(None)
    JOB_STATE["last_auto_send"] = auto_send_due(None)


def _loop():
    JOB_STATE["running"] = True
    try:
        while not _job_stop.is_set():
            try:
                daily_tick()
                JOB_STATE["last_error"] = None
            except Exception as e:  # noqa: BLE001
                JOB_STATE["last_error"] = f"{type(e).__name__}: {e}"[:300]
                log.exception("patients daily job failed")
            JOB_STATE["last_tick"] = db.now_iso()
            _job_stop.wait(JOB_TICK_S)
    finally:
        JOB_STATE["running"] = False


def start_job() -> bool:
    global _job_thread
    import os
    if os.environ.get("MEDFORECAST_PATIENTS_JOB", "1") == "0":
        return False
    if _job_thread and _job_thread.is_alive():
        return True
    _job_stop.clear()
    _job_thread = threading.Thread(target=_loop, name="patients-daily", daemon=True)
    _job_thread.start()
    return True


def stop_job() -> None:
    _job_stop.set()
