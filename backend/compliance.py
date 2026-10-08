"""Drug-schedule classification, statutory registers, DPCO/NPPA ceiling prices and margin analytics.

CONTRACT (other modules rely on these signatures; extend, never break):
    schedule_of(medicine_id) -> "OTC" | "H" | "H1" | "X" | "NDPS"
    needs_prescription(medicine_id) -> bool          # H, H1, X, NDPS
    needs_register(medicine_id) -> bool              # H1, X, NDPS: a register entry is mandatory per sale
    REGISTER_FIELDS                                  # fields the billing screen must collect for register items
    record_register_entries(entries: list[dict]) -> list[int]
        each entry: {store_id, invoice_no, medicine_id, batch_no, qty, patient_name, patient_address?,
                     prescriber_name, prescriber_reg_no?, rx_ref?, sold_by (user id), sold_at (ISO UTC)}
        Must be called inside the billing transaction (db.tx()) so the sale and its register entry commit together.

NOT LEGAL ADVICE. Everything below is a decision-support aid built from public knowledge of Indian drug law
as understood at build time. Schedules, register formats, retention periods, GST rates and ceiling prices
change by notification; verify with your State Drugs Control authority, the current NPPA/DPCO notifications
and your CA before relying on any of it.

Schedule classification (one label per medicine = the MOST STRINGENT regime that applies)
------------------------------------------------------------------------------------------
Sources (from knowledge; the official texts were not machine-fetched at build time):
  * Schedule H1: Drugs & Cosmetics (Third Amendment) Rules 2013, G.S.R. 588(E), 30-Aug-2013 (46 molecules:
    3rd/4th-gen cephalosporins, carbapenems, newer fluoroquinolones, anti-TB drugs, some benzodiazepines and
    opioids). Later additions, if any, were NOT verified -> use owner overrides.
  * NDPS: Narcotic Drugs and Psychotropic Substances Act 1985 schedule of psychotropic substances and the
    narcotic drugs list (morphine, fentanyl, pethidine ...). Tramadol was notified as a psychotropic substance
    in 2018 (S.O. 1761(E)); ketamine in 2011 (as understood; verify). Psychotropics that are ALSO in H1 are
    labelled NDPS here (stricter) and carry also=["H1"].
  * Schedule X: classical list (amphetamines, methylphenidate, barbiturates such as pentobarbital/secobarbital,
    meprobamate, glutethimide, methaqualone, phencyclidine ...). None is in this shop's catalogue.
  * Schedule H vs OTC: there is no machine-readable Schedule H list here. A medicine that is not in the lists
    above is labelled H when it is injectable, belongs to a prescription-only therapeutic class, or >= 50 % of
    its historical sales lines carried a prescription; otherwise OTC. basis="inferred", confidence "low".
Owner overrides (table compliance_overrides, audited in compliance_override_log) always win.
schedule_of() is served from an in-memory map keyed by database path, rebuilt on override changes.
"""
from __future__ import annotations

import csv
import io
import math
import re
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any

import numpy as np
import pandas as pd

from backend import db
from backend.core import S

SCHEDULES = ("OTC", "H", "H1", "X", "NDPS")
REGISTER_SCHEDULES = ("H1", "X", "NDPS")
IST = timezone(timedelta(hours=5, minutes=30))   # registers are kept in local (IST) calendar days
REGISTER_FIELDS = ("patient_name", "patient_address", "prescriber_name", "prescriber_reg_no", "rx_ref")

DISCLAIMER = ("Decision support only, not legal advice. Drug schedules, register rules, ceiling prices and GST "
              "rates change by notification - verify with your State Drugs Control authority, the current "
              "NPPA/DPCO notifications and your CA.")
RETENTION_NOTE = ("Schedule H1 register: as understood, Drugs Rules 1945 Rule 65 (as amended by G.S.R. 588(E), 2013) "
                  "asks for the prescriber's name and address, the patient's name, the drug and quantity, recorded "
                  "at the time of supply and kept for 3 years. NDPS/psychotropic and Schedule X records have their "
                  "own formats and retention rules (commonly 2 years or more). Dates are Indian Standard Time. "
                  "Verify the columns and periods with your State Drugs Control authority.")
PRICE_NOTE = ("Dataset prices are synthetic (median selling price per unit in the demo dataset), so any "
              "'violation' shown here is illustrative until real MRPs are loaded.")

# ---------------------------------------------------------------------------------------------
# Classification lists (lower-case molecule keywords, matched on word boundaries in generic_name)
# ---------------------------------------------------------------------------------------------
_NDPS_NARCOTIC = ("morphine", "fentanyl", "pethidine", "methadone", "codeine", "dihydrocodeine", "hydrocodone",
                  "oxycodone", "hydromorphone", "tapentadol", "opium", "cocaine", "sufentanil", "remifentanil")
_NDPS_PSYCHOTROPIC = ("alprazolam", "chlordiazepoxide", "diazepam", "clonazepam", "lorazepam", "midazolam",
                      "nitrazepam", "clobazam", "oxazepam", "temazepam", "flurazepam", "bromazepam", "zolpidem",
                      "phenobarbitone", "phenobarbital", "buprenorphine", "pentazocine", "tramadol", "ketamine",
                      "dextropropoxyphene", "butorphanol", "nalbuphine")
_X = ("amobarbital", "amphetamine", "barbital", "cyclobarbital", "dexamphetamine", "ethchlorvynol", "glutethimide",
      "meprobamate", "methamphetamine", "methylphenidate", "methylphenobarbital", "pentobarbital", "phencyclidine",
      "phenmetrazine", "secobarbital", "methaqualone", "lisdexamfetamine")
_H1_2013 = ("alprazolam", "balofloxacin", "buprenorphine", "capreomycin", "cefdinir", "cefditoren", "cefepime",
            "cefetamet", "cefixime", "cefoperazone", "cefotaxime", "cefpirome", "cefpodoxime", "ceftazidime",
            "ceftibuten", "ceftizoxime", "ceftriaxone", "chlordiazepoxide", "clofazimine", "codeine", "cycloserine",
            "dextropropoxyphene", "diazepam", "diphenoxylate", "doripenem", "ertapenem", "ethambutol", "ethionamide",
            "faropenem", "feropenem", "gemifloxacin", "imipenem", "isoniazid", "levofloxacin", "meropenem",
            "midazolam", "moxifloxacin", "nitrazepam", "pentazocine", "prulifloxacin", "pyrazinamide", "rifabutin",
            "rifampicin", "para-aminosalicylic", "aminosalicylate", "sparfloxacin", "thiacetazone", "tramadol",
            "zolpidem")
# Prescription-only therapeutic classes / forms used for the inferred H label.
_RX_CATEGORIES = ("Antibiotic", "Antineoplastic (Oncology)", "Antiretroviral (ART Program)", "Cardiac/Antihypertensive",
                  "Neuro/Psychiatric", "Antiepileptic", "Antidiabetic", "Hormone/Endocrine", "Immunosuppressant",
                  "Anticoagulant", "Anesthetic", "Antiviral", "Antitubercular", "Antimalarial", "Opioid Analgesic",
                  "Blood Product/Coagulation", "Vaccine/Immunological", "Reproductive/Hormonal Health",
                  "Antidote/Emergency", "Diagnostic/Contrast Agent", "Muscle Relaxant", "Endocrine/Metabolic")
_RX_FORMS = ("Injection",)
_OTC_HINT = ("Vitamin/Supplement", "Antiseptic/Disinfectant")

NOTES = {
    "tramadol": "NDPS psychotropic since 2018 (S.O. 1761(E)) and Schedule H1.",
    "ketamine": "NDPS psychotropic (2011, as understood); earlier seed listed it as Schedule X - verify.",
    "bedaquiline": "Not in the 2013 H1 list; supplied through the national TB programme. Classified H.",
    "delamanid": "Not in the 2013 H1 list; programme drug. Classified H.",
    "linezolid": "Not in the 2013 H1 list (some states treat it as restricted). Classified H.",
    "thalidomide": "Restricted-distribution drug; not in H1/X here. Consider an override if your licence requires.",
    "lenalidomide": "Restricted-distribution drug; not in H1/X here. Consider an override if your licence requires.",
}

db.register_schema("compliance", [
    """
    CREATE TABLE IF NOT EXISTS compliance_register (
        id INTEGER PRIMARY KEY,
        store_id TEXT NOT NULL,
        invoice_no TEXT NOT NULL,
        medicine_id TEXT NOT NULL,
        schedule TEXT NOT NULL,
        batch_no TEXT,
        qty INTEGER NOT NULL CHECK (qty > 0),
        patient_name TEXT NOT NULL,
        patient_address TEXT,
        prescriber_name TEXT NOT NULL,
        prescriber_reg_no TEXT,
        rx_ref TEXT,
        sold_by INTEGER,
        sold_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_compliance_register_store_date ON compliance_register(store_id, sold_at);
    """,
    """
    CREATE TABLE IF NOT EXISTS compliance_overrides (
        medicine_id TEXT PRIMARY KEY,
        schedule TEXT NOT NULL CHECK (schedule IN ('OTC','H','H1','X','NDPS')),
        reason TEXT NOT NULL,
        user_id INTEGER,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compliance_override_log (
        id INTEGER PRIMARY KEY,
        medicine_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('set','clear')),
        old_schedule TEXT,
        new_schedule TEXT,
        reason TEXT NOT NULL,
        user_id INTEGER,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_compliance_override_log_med ON compliance_override_log(medicine_id, id);
    CREATE TABLE IF NOT EXISTS compliance_ceilings (
        id INTEGER PRIMARY KEY,
        formulation TEXT NOT NULL,
        strength TEXT,
        dosage_form TEXT,
        unit TEXT,
        ceiling_price REAL NOT NULL CHECK (ceiling_price > 0),
        notification_ref TEXT,
        effective_date TEXT,
        source TEXT NOT NULL,
        uploaded_by INTEGER,
        uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compliance_ceiling_matches (
        medicine_id TEXT PRIMARY KEY,
        ceiling_id INTEGER,
        status TEXT NOT NULL CHECK (status IN ('confirmed','rejected')),
        units_per_sale REAL NOT NULL DEFAULT 1 CHECK (units_per_sale > 0),
        note TEXT,
        user_id INTEGER,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS compliance_audit (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        action TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
    );
    """,    # H1 rule asks for the prescriber's address (optional column, appended step)
    "ALTER TABLE compliance_register ADD COLUMN prescriber_address TEXT",
])


def audit(user_id: int | None, action: str, detail: str = "") -> None:
    db.execute("INSERT INTO compliance_audit (user_id, action, detail, created_at) VALUES (?,?,?,?)",
               (user_id, action, detail[:500], db.now_iso()))


# ---------------------------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------------------------
def _generic(medicine_id: str) -> str:
    if medicine_id not in S.meds.index:
        raise KeyError(medicine_id)
    return str(S.meds.at[medicine_id, "generic_name"]).lower()


def _hits(generic: str, words: tuple[str, ...]) -> list[str]:
    return [w for w in words if re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", generic)]


def base_classification(medicine_id: str) -> dict:
    """Rule-based classification (no overrides): {schedule, basis, confidence, also, matched, note}."""
    g = _generic(medicine_id)
    row = S.meds.loc[medicine_id]
    narc, psy, x, h1 = _hits(g, _NDPS_NARCOTIC), _hits(g, _NDPS_PSYCHOTROPIC), _hits(g, _X), _hits(g, _H1_2013)
    note = next((NOTES[k] for k in NOTES if k in g), None)
    also = ["H1"] if h1 else []
    if narc:
        return dict(schedule="NDPS", basis="NDPS Act - narcotic drug", confidence="high", also=also, matched=narc, note=note)
    if psy:
        return dict(schedule="NDPS", basis="NDPS Act - psychotropic substance", confidence="medium", also=also,
                    matched=psy, note=note or ("Also Schedule H1 (2013); NDPS is the stricter regime." if h1 else
                                               "Psychotropic under the NDPS Act; not in the 2013 H1 list."))
    if x:
        return dict(schedule="X", basis="Drugs Rules Schedule X", confidence="medium", also=[], matched=x, note=note)
    if h1:
        return dict(schedule="H1", basis="Schedule H1 - G.S.R. 588(E), 2013", confidence="high", also=[],
                    matched=h1, note=note)
    rx = float(row.get("rx_share") or 0)
    reasons = []
    if str(row.get("form")) in _RX_FORMS:
        reasons.append("injectable")
    if str(row.get("category")) in _RX_CATEGORIES:
        reasons.append(f"prescription class ({row.get('category')})")
    if rx >= 0.5 and str(row.get("category")) not in _OTC_HINT:
        reasons.append(f"{rx:.0%} of sales lines had a prescription")
    if reasons:
        return dict(schedule="H", basis="Inferred: " + ", ".join(reasons), confidence="low", also=[], matched=[],
                    note=note)
    return dict(schedule="OTC", basis=f"Inferred: no prescription signal ({rx:.0%} Rx lines)", confidence="low",
                also=[], matched=[], note=note)


_base_memo: dict[str, dict] = {}   # rule classification depends only on the static catalogue


def _base_all() -> dict[str, dict]:
    if not _base_memo:
        cols = S.meds[["medicine_name", "generic_name", "category", "form", "abc"]].to_dict("index")
        for mid in S.meds.index:
            _base_memo[mid] = {**base_classification(mid), "_m": cols[mid]}
    return _base_memo


_cache_lock = threading.Lock()
_cache: dict[str, dict] = {}       # db path -> {"base": {mid: schedule}, "over": {mid: row}}


_cache_gen = [0]                   # bumped on every invalidation


def invalidate_cache() -> None:
    with _cache_lock:
        _cache_gen[0] += 1
        _cache.clear()


def _state() -> dict:
    key = str(db.db_path())
    st = _cache.get(key)
    if st is None:
        gen = _cache_gen[0]
        base = _base_all()
        over = {r["medicine_id"]: r for r in db.query("SELECT * FROM compliance_overrides")}
        st = {"base": base, "over": over}
        with _cache_lock:
            # an override committed while we were reading: do not cache a possibly stale snapshot
            if gen == _cache_gen[0] and not db.in_tx():
                _cache[key] = st
    return st


def schedule_of(medicine_id: str) -> str:
    st = _state()
    if medicine_id in st["over"]:
        return st["over"][medicine_id]["schedule"]
    if medicine_id not in st["base"]:
        raise KeyError(medicine_id)
    return st["base"][medicine_id]["schedule"]


def needs_prescription(medicine_id: str) -> bool:
    return schedule_of(medicine_id) != "OTC"


def needs_register(medicine_id: str) -> bool:
    return schedule_of(medicine_id) in REGISTER_SCHEDULES


def classification(medicine_id: str) -> dict:
    """Full classification for one medicine incl. override (effective schedule first)."""
    st = _state()
    b = st["base"][medicine_id]
    o = st["over"].get(medicine_id)
    m = b["_m"]
    out = {"medicine_id": medicine_id, "medicine_name": m["medicine_name"], "generic_name": m["generic_name"],
           "category": m["category"], "form": m["form"], "abc": m.get("abc"), "also": list(b["also"]), "matched": list(b["matched"]),
           "rule_schedule": b["schedule"], "schedule": b["schedule"], "source": "rule", **{k: b[k] for k in
           ("basis", "confidence", "note")}, "override": None}
    if o:
        out.update(schedule=o["schedule"], source="override",
                   override={"schedule": o["schedule"], "reason": o["reason"], "user_id": o["user_id"],
                             "updated_at": o["updated_at"]})
    out["needs_register"] = out["schedule"] in REGISTER_SCHEDULES
    out["needs_prescription"] = out["schedule"] != "OTC"
    return out


def all_classifications() -> list[dict]:
    return [classification(mid) for mid in S.meds.index]


def set_override(medicine_id: str, schedule: str, reason: str, user_id: int | None) -> dict:
    if medicine_id not in S.meds.index:
        raise KeyError(medicine_id)
    if schedule not in SCHEDULES:
        raise ValueError(f"schedule must be one of {SCHEDULES}")
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValueError("Give a reason of at least 5 characters (it goes into the audit trail)")
    old = schedule_of(medicine_id)
    now = db.now_iso()
    with db.tx():
        db.execute("""INSERT INTO compliance_overrides (medicine_id, schedule, reason, user_id, updated_at)
                      VALUES (?,?,?,?,?) ON CONFLICT(medicine_id) DO UPDATE SET schedule=excluded.schedule,
                      reason=excluded.reason, user_id=excluded.user_id, updated_at=excluded.updated_at""",
                   (medicine_id, schedule, reason, user_id, now))
        db.execute("""INSERT INTO compliance_override_log (medicine_id, action, old_schedule, new_schedule, reason,
                      user_id, created_at) VALUES (?,?,?,?,?,?,?)""",
                   (medicine_id, "set", old, schedule, reason, user_id, now))
    invalidate_cache()
    return classification(medicine_id)


def clear_override(medicine_id: str, reason: str, user_id: int | None) -> dict:
    if medicine_id not in S.meds.index:
        raise KeyError(medicine_id)
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise ValueError("Give a reason of at least 5 characters (it goes into the audit trail)")
    row = db.query_one("SELECT schedule FROM compliance_overrides WHERE medicine_id = ?", (medicine_id,))
    if not row:
        raise LookupError("No override for this medicine")
    with db.tx():
        db.execute("DELETE FROM compliance_overrides WHERE medicine_id = ?", (medicine_id,))
        db.execute("""INSERT INTO compliance_override_log (medicine_id, action, old_schedule, new_schedule, reason,
                      user_id, created_at) VALUES (?,?,?,?,?,?,?)""",
                   (medicine_id, "clear", row["schedule"], base_classification(medicine_id)["schedule"], reason,
                    user_id, db.now_iso()))
    invalidate_cache()
    return classification(medicine_id)


# ---------------------------------------------------------------------------------------------
# Register
# ---------------------------------------------------------------------------------------------
_LIMITS = {"invoice_no": 60, "batch_no": 40, "patient_name": 120, "patient_address": 300, "prescriber_name": 120,
           "prescriber_address": 300, "prescriber_reg_no": 60, "rx_ref": 100, "store_id": 32}
# Optional extension (not part of REGISTER_FIELDS, so existing callers are unaffected): the H1 rule asks for the
# prescriber's ADDRESS as well as the name; callers that collect it may pass it.
REGISTER_OPTIONAL_FIELDS = ("prescriber_address",)


def _text(v: Any) -> str | None:
    if v is None:
        return None
    v = re.sub(r"\s+", " ", str(v)).strip()
    return v or None


def record_register_entries(entries: list[dict]) -> list[int]:
    """Insert register rows (all-or-nothing). Raises ValueError (never KeyError/TypeError) on bad input."""
    ids = []
    with db.tx():
        for e in entries:
            if not isinstance(e, dict):
                raise ValueError("Each register entry must be an object")
            missing = [k for k in ("store_id", "invoice_no", "medicine_id", "qty") if e.get(k) in (None, "")]
            if missing:
                raise ValueError(f"Register entry is missing {', '.join(missing)}")
            vals = {k: _text(e.get(k)) for k in _LIMITS}
            if not vals["patient_name"] or not vals["prescriber_name"]:
                raise ValueError("Register entries need patient_name and prescriber_name")
            for k, n in _LIMITS.items():
                if vals[k] is not None and len(vals[k]) > n:
                    raise ValueError(f"{k} is longer than {n} characters")
            mid = str(e["medicine_id"])
            if mid not in S.meds.index:
                raise ValueError(f"Unknown medicine '{mid}'")
            q = e["qty"]
            if isinstance(q, bool) or not isinstance(q, (int, float, str)):
                raise ValueError("qty must be a whole number")
            try:
                qf = float(q)
            except ValueError:
                raise ValueError("qty must be a whole number") from None
            if not math.isfinite(qf) or qf != int(qf) or qf <= 0 or qf > 1_000_000:
                raise ValueError("qty must be a positive whole number")
            sold_at = e.get("sold_at") or db.now_iso()
            try:
                datetime.fromisoformat(str(sold_at))
            except ValueError:
                raise ValueError("sold_at must be an ISO date-time") from None
            cur = db.execute(
                """INSERT INTO compliance_register (store_id, invoice_no, medicine_id, schedule, batch_no, qty, patient_name,
                   patient_address, prescriber_name, prescriber_reg_no, rx_ref, sold_by, sold_at, prescriber_address)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (vals["store_id"], vals["invoice_no"], mid, schedule_of(mid), vals["batch_no"], int(qf),
                 vals["patient_name"], vals["patient_address"], vals["prescriber_name"], vals["prescriber_reg_no"],
                 vals["rx_ref"], e.get("sold_by"), str(sold_at), vals["prescriber_address"]),
            )
            ids.append(cur.lastrowid)
    return ids


REGISTER_COLUMNS = [  # conventional column order of a manual H1 / psychotropic register
    ("sold_at_ist", "Date (IST)"), ("patient_name", "Patient name"), ("patient_address", "Patient address"),
    ("prescriber_name", "Prescriber name"), ("prescriber_address", "Prescriber address"),
    ("prescriber_reg_no", "Prescriber reg. no."), ("medicine_name", "Drug name"), ("qty", "Quantity"), ("batch_no", "Batch no."), ("invoice_no", "Invoice no."),
    ("sold_by_name", "Sold by"), ("schedule", "Schedule"), ("rx_ref", "Rx ref."), ("store_id", "Store"),
]


def ist_day_start(d: str) -> str:
    """UTC ISO (db.now_iso() format) of 00:00 IST on calendar day d ('YYYY-MM-DD')."""
    return datetime.combine(date.fromisoformat(d), datetime.min.time(), IST).astimezone(timezone.utc).isoformat(
        timespec="seconds")


def ist_day_end(d: str) -> str:
    """Exclusive upper bound: 00:00 IST of the day after d, as UTC ISO."""
    return ist_day_start((date.fromisoformat(d) + timedelta(days=1)).isoformat())


def to_ist(iso: str | None) -> str | None:
    """'YYYY-MM-DD HH:MM' in IST for a stored UTC ISO timestamp (unparseable values pass through)."""
    if not iso:
        return iso
    try:
        dt = datetime.fromisoformat(str(iso))
    except ValueError:
        return str(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%Y-%m-%d %H:%M")


def _register_where(store_id: str | None, schedule: str | None, date_from: str | None, date_to: str | None,
                    q: str | None, search_patient: bool = True) -> tuple[str, list]:
    where, params = ["1=1"], []
    if store_id:
        where.append("r.store_id = ?"); params.append(store_id)
    if schedule and schedule != "all":
        where.append("r.schedule = ?"); params.append(schedule)
    if date_from:                       # IST calendar days; sold_at is stored in UTC
        where.append("r.sold_at >= ?"); params.append(ist_day_start(date_from))
    if date_to:
        where.append("r.sold_at < ?"); params.append(ist_day_end(date_to))
    if q:
        like = "%" + re.sub(r"([%_!])", r"!", q) + "%"
        fields = ["r.invoice_no", "r.medicine_id", "r.prescriber_name"] + (["r.patient_name"] if search_patient else [])
        where.append("(" + " OR ".join(f"{f} LIKE ? ESCAPE '!'" for f in fields) + ")")
        params += [like] * len(fields)
    return " AND ".join(where), params


def register_rows(store_id: str | None, schedule: str | None = None, date_from: str | None = None,
                  date_to: str | None = None, q: str | None = None, limit: int | None = 100,
                  offset: int = 0, search_patient: bool = True) -> tuple[list[dict], int]:
    """search_patient=False for roles that see masked rows: a patient-name search would let them probe identity."""
    w, p = _register_where(store_id, schedule, date_from, date_to, q, search_patient)
    total = int(db.scalar(f"SELECT COUNT(*) FROM compliance_register r WHERE {w}", p, 0))
    sql = f"""SELECT r.*, u.full_name AS sold_by_name, u.username AS sold_by_username FROM compliance_register r
              LEFT JOIN users u ON u.id = r.sold_by WHERE {w} ORDER BY r.sold_at DESC, r.id DESC"""
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        p = p + [limit, offset]
    rows = db.query(sql, p)
    for r in rows:
        mid = r["medicine_id"]
        r["medicine_name"] = S.meds.at[mid, "medicine_name"] if mid in S.meds.index else mid
        r["sold_by_name"] = r.get("sold_by_name") or r.get("sold_by_username") or (
            f"user #{r['sold_by']}" if r.get("sold_by") else "")
        r["sold_at_ist"] = to_ist(r.get("sold_at"))
    return rows, total


def mask_name(s: str | None) -> str | None:
    if not s:
        return s
    return " ".join(w[0] + "*" * max(len(w) - 1, 1) for w in str(s).split())


def mask_row(r: dict) -> dict:
    r = dict(r)
    r["patient_name"] = mask_name(r.get("patient_name"))
    r["patient_address"] = "(hidden)" if r.get("patient_address") else None
    r["masked"] = True
    return r


def register_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([label for _, label in REGISTER_COLUMNS])
    for r in rows:
        w.writerow([_csv_safe(r.get(k)) for k, _ in REGISTER_COLUMNS])
    return buf.getvalue()


def _csv_safe(v: Any) -> Any:
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v                     # spreadsheet formula injection guard
    return "" if v is None else v


def _pos_lines_table() -> dict | None:
    """Find a POS line table (built by another feature) with store/invoice/medicine/qty columns."""
    try:
        names = [r["name"] for r in db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'pos%' OR name LIKE 'billing%')")]
    except Exception:
        return None
    for n in names:
        try:
            cols = {r["name"] for r in db.query(f'PRAGMA table_info("{n}")')}
        except Exception:
            continue
        if {"medicine_id", "qty"} <= cols and ("invoice_no" in cols or "invoice_id" in cols):
            return {"table": n, "cols": cols}
    return None


def _pos_invoice_join(t: dict) -> tuple[str, str, str, str] | None:
    """(FROM clause, invoice expr, store expr, date expr) for the POS line table, if resolvable."""
    cols, n = t["cols"], t["table"]
    if "invoice_no" in cols and "store_id" in cols:
        dt = next((c for c in ("sold_at", "created_at", "invoice_date", "date") if c in cols), None)
        if dt:
            return f'"{n}" l', "l.invoice_no", "l.store_id", f"l.{dt}"
    # lines reference a header table via invoice_id
    try:
        heads = [r["name"] for r in db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'pos%' OR name LIKE 'billing%')")]
    except Exception:
        return None
    for h in heads:
        if h == n:
            continue
        hc = {r["name"] for r in db.query(f'PRAGMA table_info("{h}")')}
        if {"id", "store_id"} <= hc and ("invoice_no" in hc) and "invoice_id" in cols:
            dt = next((c for c in ("sold_at", "created_at", "invoice_date", "date") if c in hc), None)
            if dt:
                return f'"{n}" l JOIN "{h}" h ON h.id = l.invoice_id', "h.invoice_no", "h.store_id", f"h.{dt}"
    return None


def register_gaps(store_id: str | None, day_from: str, day_to: str) -> dict:
    """POS lines of register-schedule medicines that have no register entry (same store/invoice/medicine)."""
    t = _pos_lines_table()
    if not t:
        return {"pos_available": False, "gaps": [], "checked_lines": 0,
                "message": "No point-of-sale tables found yet, so completeness cannot be checked automatically. "
                           "Register entries recorded manually are listed in the register."}
    j = _pos_invoice_join(t)
    if not j:
        return {"pos_available": False, "gaps": [], "checked_lines": 0,
                "message": f"POS table '{t['table']}' found but its invoice/store/date columns were not recognised."}
    frm, inv_e, st_e, dt_e = j
    # POS timestamps are UTC ISO; the check runs over IST calendar days
    params: list = [ist_day_start(day_from), ist_day_end(day_to)]
    sw = ""
    if store_id:
        sw = f" AND {st_e} = ?"
        params.append(store_id)
    # the schedule recorded on the line at billing time wins (a later override must not create/hide gaps)
    sch_e = "l.schedule" if "schedule" in t["cols"] else "NULL"
    try:
        lines = db.query(f"""SELECT {inv_e} AS invoice_no, {st_e} AS store_id, {dt_e} AS sold_at, l.medicine_id,
                                    l.qty, {sch_e} AS line_schedule FROM {frm} WHERE {dt_e} >= ? AND {dt_e} < ?{sw}""",
                         params)
    except Exception as e:  # schema drift in another feature's table: report, never 500
        return {"pos_available": False, "gaps": [], "checked_lines": 0, "message": f"POS query failed: {e}"}
    reg = {(r["store_id"], r["invoice_no"], r["medicine_id"]) for r in db.query(
        "SELECT store_id, invoice_no, medicine_id FROM compliance_register WHERE sold_at >= ? AND sold_at < ?",
        (ist_day_start((date.fromisoformat(day_from) - timedelta(days=1)).isoformat()),
         ist_day_end((date.fromisoformat(day_to) + timedelta(days=1)).isoformat())))}
    checked, gaps = 0, []
    for ln in lines:
        mid = ln.pop("medicine_id")
        line_sch = ln.pop("line_schedule", None)
        if mid not in S.meds.index:
            continue
        sch = line_sch if line_sch in SCHEDULES else schedule_of(mid)
        if sch not in REGISTER_SCHEDULES:
            continue
        if (ln.get("qty") or 0) <= 0:          # returns are not register sales
            continue
        checked += 1
        if (ln["store_id"], ln["invoice_no"], mid) not in reg:
            gaps.append({**ln, "medicine_id": mid, "medicine_name": S.meds.at[mid, "medicine_name"], "schedule": sch,
                         "sold_at_ist": to_ist(ln.get("sold_at"))})
    return {"pos_available": True, "pos_table": t["table"], "checked_lines": checked, "gaps": gaps,
            "message": "Every register-schedule POS line has a register entry." if not gaps else
            f"{len(gaps)} register-schedule POS line(s) have no register entry."}


# ---------------------------------------------------------------------------------------------
# GST setting
# ---------------------------------------------------------------------------------------------
GST_DEFAULT = {"default": 0.05, "by_category": {}, "note": (
    "Most medicines moved to 5% GST from 22-Sep-2025 (some life-saving drugs 0%). Ceiling prices exclude GST; "
    "allowed MRP = ceiling x (1 + GST). Verify the applicable rate per HSN with your CA.")}


def gst_settings() -> dict:
    s = db.get_setting("compliance.gst", None) or {}
    out = dict(GST_DEFAULT)
    out.update({k: v for k, v in s.items() if k in ("default", "by_category")})
    return out


def gst_rate(medicine_id: str, settings: dict | None = None) -> float:
    s = settings or gst_settings()
    cat = str(S.meds.at[medicine_id, "category"]) if medicine_id in S.meds.index else ""
    return float(s.get("by_category", {}).get(cat, s.get("default", 0.05)))


# ---------------------------------------------------------------------------------------------
# Ceiling prices
# ---------------------------------------------------------------------------------------------
CEILING_COLS = ["formulation", "strength", "dosage_form", "unit", "ceiling_price_per_unit", "notification_ref",
                "effective_date"]
CEILING_MAX_ROWS = 5000
_SYN = {"acetaminophen": "paracetamol", "aspirin": "acetylsalicylic acid", "albuterol": "salbutamol",
        "lidocaine": "lignocaine", "epinephrine": "adrenaline", "norepinephrine": "noradrenaline",
        "rifampin": "rifampicin", "phenobarbital": "phenobarbitone", "cyclosporin": "cyclosporine",
        "ciclosporin": "cyclosporine", "frusemide": "furosemide", "acyclovir": "aciclovir"}
_FORMS = {"tablet": "tablet", "tab": "tablet", "tablets": "tablet", "capsule": "capsule", "cap": "capsule",
          "capsules": "capsule", "injection": "injection", "inj": "injection", "vial": "injection",
          "ampoule": "injection", "syrup": "liquid", "suspension": "liquid", "solution": "liquid",
          "oral liquid": "liquid", "drops": "drops", "eye drop": "drops", "eye drops": "drops", "cream": "topical",
          "ointment": "topical", "gel": "topical", "lotion": "topical", "sachet": "powder", "powder": "powder",
          "inhaler": "inhalation", "inhalation": "inhalation"}


def norm_molecule(s: str) -> str:
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", str(s).lower())
    s = s.replace("sulph", "sulf")
    s = re.sub(r"\b(hydrochloride|hcl|sodium|potassium|ip|bp|usp)\b", " ", s)
    parts = [re.sub(r"[^a-z0-9 ]", " ", p) for p in re.split(r"\+|/| and |,", s)]
    parts = [re.sub(r"\s+", " ", p).strip() for p in parts]
    parts = [_SYN.get(p, p) for p in parts if p]
    return " + ".join(sorted(set(parts)))


def norm_strength(s: str | None) -> str | None:
    if not s:
        return None
    m = re.findall(r"(\d+(?:\.\d+)?)\s*(mg|mcg|µg|g|iu|ml|%)", str(s).lower())
    if not m:
        return None
    out = []
    for v, u in m:
        v = float(v)
        if u == "g":
            v, u = v * 1000, "mg"
        if u in ("µg",):
            u = "mcg"
        out.append(f"{v:g}{u}")
    return "/".join(out)


def norm_form(s: str | None) -> str | None:
    if not s:
        return None
    t = str(s).lower().strip()
    if t in _FORMS:
        return _FORMS[t]
    for k, v in _FORMS.items():
        if re.search(rf"\b{k}\b", t):
            return v
    return t


def _med_strength(mid: str) -> str | None:
    name = str(S.meds.at[mid, "medicine_name"])
    gen = str(S.meds.at[mid, "generic_name"])
    return norm_strength(name.replace(gen, "", 1) if name.startswith(gen) else name)


def parse_ceiling_csv(text: str) -> tuple[list[dict], list[dict]]:
    """Validate a ceiling-price CSV. Returns (rows, errors[{line, error}])."""
    if text.startswith("﻿"):
        text = text[1:]
    reader = csv.DictReader(io.StringIO(text))
    hdr = [h.strip().lower() for h in (reader.fieldnames or [])]
    missing = [c for c in ("formulation", "ceiling_price_per_unit") if c not in hdr]
    if missing:
        return [], [{"line": 1, "error": f"Missing column(s): {', '.join(missing)}. Expected: {', '.join(CEILING_COLS)}"}]
    rows, errors = [], []
    for i, raw in enumerate(reader, start=2):
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        if not any(r.values()):
            continue
        if len(rows) >= CEILING_MAX_ROWS:
            errors.append({"line": i, "error": f"More than {CEILING_MAX_ROWS} rows; split the file"})
            break
        err = None
        try:
            price = float(r.get("ceiling_price_per_unit", "").replace(",", ""))
            if not math.isfinite(price) or price <= 0 or price > 1e7:
                err = "ceiling_price_per_unit must be a positive number"
        except ValueError:
            err = "ceiling_price_per_unit is not a number"
            price = 0
        if not r.get("formulation") or len(r["formulation"]) > 200:
            err = err or "formulation is required (max 200 chars)"
        eff = r.get("effective_date") or None
        if eff:
            try:
                eff = date.fromisoformat(eff).isoformat()
            except ValueError:
                err = err or "effective_date must be YYYY-MM-DD"
        for k in ("strength", "dosage_form", "unit", "notification_ref"):
            if len(r.get(k, "")) > 120:
                err = err or f"{k} is longer than 120 characters"
        if err:
            errors.append({"line": i, "error": err})
            continue
        rows.append({"formulation": r["formulation"], "strength": r.get("strength") or None,
                     "dosage_form": r.get("dosage_form") or None, "unit": r.get("unit") or None,
                     "ceiling_price": price, "notification_ref": r.get("notification_ref") or None,
                     "effective_date": eff})
    return rows, errors


def store_ceilings(rows: list[dict], source: str, user_id: int | None, mode: str = "replace") -> int:
    now = db.now_iso()
    with db.tx():
        if mode == "replace":
            # Confirmations pointed at rows that no longer exist: drop them so the medicine falls back to the
            # auto/review match against the NEW list. (Turning them into 'rejected' would silently hide every
            # previously confirmed medicine from the violation check after a list refresh.)
            dropped = db.execute("DELETE FROM compliance_ceiling_matches WHERE status = 'confirmed'").rowcount
            db.execute("DELETE FROM compliance_ceilings")
            if dropped:
                audit(user_id, "ceilings.match.reset", f"{dropped} confirmed match(es) reset by a list replace")
        db.executemany("""INSERT INTO compliance_ceilings (formulation, strength, dosage_form, unit, ceiling_price,
                          notification_ref, effective_date, source, uploaded_by, uploaded_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?)""",
                       [(r["formulation"], r["strength"], r["dosage_form"], r["unit"], r["ceiling_price"],
                         r["notification_ref"], r["effective_date"], source, user_id, now) for r in rows])
        audit(user_id, "ceilings.upload", f"{mode} {len(rows)} rows from {source}")
    return len(rows)


def _ceiling_rows() -> list[dict]:
    return db.query("SELECT * FROM compliance_ceilings ORDER BY id")


def auto_matches(ceilings: list[dict] | None = None) -> dict[str, list[dict]]:
    """Candidate ceiling rows per medicine: molecule must match; strength and form add confidence."""
    ceilings = ceilings if ceilings is not None else _ceiling_rows()
    by_mol: dict[str, list[dict]] = {}
    for c in ceilings:
        by_mol.setdefault(norm_molecule(c["formulation"]), []).append(c)
    out: dict[str, list[dict]] = {}
    if not by_mol:
        return out
    for mid, m in S.meds.iterrows():
        cands = by_mol.get(norm_molecule(m["generic_name"]))
        if not cands:
            continue
        ms, mf = _med_strength(mid), norm_form(m["form"])
        scored = []
        for c in cands:
            cs, cf = norm_strength(c["strength"] or c["formulation"]), norm_form(c["dosage_form"] or c["formulation"])
            score = 0.6
            reasons = ["molecule"]
            if ms and cs and ms == cs:
                score += 0.25; reasons.append("strength")
            elif ms and cs:
                score -= 0.2; reasons.append("strength differs")
            if mf and cf and mf == cf:
                score += 0.15; reasons.append("form")
            elif mf and cf:
                score -= 0.2; reasons.append("form differs")
            scored.append({"ceiling_id": c["id"], "confidence": round(max(score, 0.05), 2), "reasons": reasons,
                           "formulation": c["formulation"], "strength": c["strength"], "dosage_form": c["dosage_form"],
                           "unit": c["unit"], "ceiling_price": c["ceiling_price"],
                           "notification_ref": c["notification_ref"], "effective_date": c["effective_date"]})
        scored.sort(key=lambda r: -r["confidence"])
        out[mid] = scored[:5]
    return out


AUTO_ACCEPT = 0.85


def match_table() -> list[dict]:
    """Effective match per medicine (manual decision beats auto >= AUTO_ACCEPT)."""
    ceilings = _ceiling_rows()
    cmap = {c["id"]: c for c in ceilings}
    cands = auto_matches(ceilings)
    manual = {r["medicine_id"]: r for r in db.query("SELECT * FROM compliance_ceiling_matches")}
    out = []
    for mid in sorted(set(cands) | set(manual)):
        if mid not in S.meds.index:
            continue
        m = S.meds.loc[mid]
        man = manual.get(mid)
        best = (cands.get(mid) or [None])[0]
        row = {"medicine_id": mid, "medicine_name": m["medicine_name"], "generic_name": m["generic_name"],
               "form": m["form"], "candidates": cands.get(mid, []), "units_per_sale": 1.0}
        if man and man["status"] == "confirmed" and man["ceiling_id"] in cmap:
            c = cmap[man["ceiling_id"]]
            row.update(status="confirmed", ceiling_id=c["id"], confidence=1.0, units_per_sale=man["units_per_sale"],
                       ceiling=c, note=man["note"])
        elif man and man["status"] == "rejected":
            row.update(status="rejected", ceiling_id=None, confidence=None, ceiling=None, note=man["note"])
        elif best and best["confidence"] >= AUTO_ACCEPT:
            row.update(status="auto", ceiling_id=best["ceiling_id"], confidence=best["confidence"],
                       ceiling=cmap.get(best["ceiling_id"]), note=None)
        elif best:
            row.update(status="review", ceiling_id=best["ceiling_id"], confidence=best["confidence"],
                       ceiling=cmap.get(best["ceiling_id"]), note=None)
        else:
            continue
        out.append(row)
    return out


def set_match(medicine_id: str, status: str, ceiling_id: int | None, units_per_sale: float, note: str | None,
              user_id: int | None) -> None:
    if medicine_id not in S.meds.index:
        raise KeyError(medicine_id)
    if status == "confirmed":
        if ceiling_id is None or not db.query_one("SELECT 1 FROM compliance_ceilings WHERE id = ?", (ceiling_id,)):
            raise LookupError("Unknown ceiling row")
    else:
        ceiling_id = None
    with db.tx():
        db.execute("""INSERT INTO compliance_ceiling_matches (medicine_id, ceiling_id, status, units_per_sale, note,
                      user_id, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(medicine_id) DO UPDATE SET
                      ceiling_id=excluded.ceiling_id, status=excluded.status, units_per_sale=excluded.units_per_sale,
                      note=excluded.note, user_id=excluded.user_id, updated_at=excluded.updated_at""",
                   (medicine_id, ceiling_id, status, units_per_sale, note, user_id, db.now_iso()))
        audit(user_id, "ceilings.match", f"{medicine_id} {status} {ceiling_id} x{units_per_sale}")


def clear_match(medicine_id: str, user_id: int | None) -> None:
    with db.tx():
        db.execute("DELETE FROM compliance_ceiling_matches WHERE medicine_id = ?", (medicine_id,))
        audit(user_id, "ceilings.match.clear", medicine_id)


def units_last_52w(scale: float = 1.0) -> pd.Series:
    h = S.hist_wide.iloc[:, -52:]
    return (h.sum(1) * scale).reindex(S.meds.index).fillna(0)


def violations(scale: float = 1.0) -> dict:
    gst = gst_settings()
    units = units_last_52w(scale)
    rows, checked = [], 0
    for mt in match_table():
        if mt["status"] not in ("confirmed", "auto") or not mt.get("ceiling"):
            continue
        checked += 1
        mid = mt["medicine_id"]
        g = gst_rate(mid, gst)
        ceiling_unit = float(mt["ceiling"]["ceiling_price"]) * float(mt["units_per_sale"] or 1)
        allowed = ceiling_unit * (1 + g)
        mrp = float(S.meds.at[mid, "median_price"])
        if mrp > allowed * 1.0005:
            excess = mrp - allowed
            rows.append({"medicine_id": mid, "medicine_name": mt["medicine_name"], "match_status": mt["status"],
                         "confidence": mt["confidence"], "formulation": mt["ceiling"]["formulation"],
                         "notification_ref": mt["ceiling"]["notification_ref"],
                         "ceiling_per_unit": mt["ceiling"]["ceiling_price"], "units_per_sale": mt["units_per_sale"],
                         "gst": g, "allowed_mrp": allowed, "mrp": mrp, "excess": excess,
                         "excess_pct": excess / allowed, "units_52w": float(units.get(mid, 0)),
                         "exposure": excess * float(units.get(mid, 0))})
    rows.sort(key=lambda r: -r["exposure"])
    return {"checked": checked, "violations": rows, "total_exposure": sum(r["exposure"] for r in rows),
            "rule": "allowed MRP = ceiling price per unit x units per sale x (1 + GST). MRP = dataset median selling "
                    "price per unit (synthetic). Exposure = excess per unit x units sold in the last 52 weeks "
                    "(store-scaled): an estimate of overcharged amount NPPA could seek to recover (plus interest).",
            "price_note": PRICE_NOTE}


def price_increases(threshold: float = 0.10) -> dict:
    """Informational: non-scheduled (no ceiling match) items whose price rose > 10%/year (annualised)."""
    from backend import core
    from backend.core import get_sales
    if getattr(core, "_load_sales", get_sales).cache_info().currsize == 0:  # core now caches in _load_sales
        return {"available": False, "rows": [], "message": "Sales history is still loading; try again in a minute."}
    s = get_sales()
    last = s["sale_date"].max()
    a = s[s["sale_date"] < s["sale_date"].min() + pd.Timedelta(days=90)].groupby("medicine_id")["unit_price"].median()
    b = s[s["sale_date"] > last - pd.Timedelta(days=90)].groupby("medicine_id")["unit_price"].median()
    span_years = max((last - s["sale_date"].min()).days - 90, 30) / 365.0
    scheduled = {m["medicine_id"] for m in match_table() if m["status"] in ("confirmed", "auto")}
    rows = []
    for mid in a.index.intersection(b.index):
        if mid in scheduled or mid not in S.meds.index or a[mid] <= 0:
            continue
        ch = b[mid] / a[mid] - 1
        ann = (1 + ch) ** (1 / span_years) - 1 if ch > -1 else ch
        if ann > threshold:
            rows.append({"medicine_id": mid, "medicine_name": S.meds.at[mid, "medicine_name"],
                         "price_start": float(a[mid]), "price_end": float(b[mid]), "change": float(ch),
                         "annualised": float(ann)})
    rows.sort(key=lambda r: -r["annualised"])
    return {"available": True, "rows": rows, "window": [str(s["sale_date"].min().date()), str(last.date())],
            "message": ("DPCO 2013 para 20: MRP of a non-scheduled formulation may not rise more than 10% in 12 "
                        "months. Compared: median selling price in the first vs last 90 days of history, "
                        "annualised. Selling price is not MRP and dataset prices are synthetic - informational only.")}


NPPA_HOSTS = ("nppa.gov.in", "www.nppa.gov.in")
NPPA_DEFAULT_URL = "https://www.nppa.gov.in/en/ceiling-prices"


def fetch_nppa(url: str | None, user_id: int | None, timeout: float = 10.0) -> dict:
    """Try to download a machine-readable ceiling list from NPPA (10 s timeout). Never fabricates rows."""
    import urllib.request
    from urllib.parse import urlparse
    url = url or db.get_setting("compliance.nppa_url", NPPA_DEFAULT_URL)
    p = urlparse(url)
    if p.scheme != "https" or (p.hostname or "").lower() not in NPPA_HOSTS:
        raise ValueError("Only https URLs on nppa.gov.in are allowed")
    started = db.now_iso()
    result: dict = {"url": url, "attempted_at": started, "imported": 0}
    try:
        class _SameHost(urllib.request.HTTPRedirectHandler):   # redirects must stay on https nppa.gov.in
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                q = urlparse(newurl)
                if q.scheme != "https" or (q.hostname or "").lower() not in NPPA_HOSTS:
                    raise ValueError(f"redirect to a non-NPPA address refused ({q.scheme}://{q.hostname})")
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        opener = urllib.request.build_opener(_SameHost)
        req = urllib.request.Request(url, headers={"User-Agent": "MedForecast/1.0 (ceiling-price check)"})
        with opener.open(req, timeout=timeout) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            body = r.read(8_000_001)
        if len(body) > 8_000_000:
            result.update(ok=False, status="too_large", message="Download larger than 8 MB; use the CSV template.")
        elif "csv" in ctype or url.lower().endswith(".csv"):
            rows, errors = parse_ceiling_csv(body.decode("utf-8", "replace"))
            if rows and not errors:
                result.update(ok=True, status="imported", imported=store_ceilings(rows, "nppa:" + url, user_id))
            else:
                result.update(ok=False, status="not_template", message="CSV did not match the template columns.",
                              errors=errors[:10])
        elif "sheet" in ctype or "excel" in ctype or url.lower().endswith((".xlsx", ".xls")):
            result.update(ok=False, status="needs_mapping", message=(
                "NPPA returned a spreadsheet. Its columns vary between notifications, so it is not imported "
                "automatically: map it to the CSV template and upload it."))
        else:
            result.update(ok=False, status="not_machine_readable", message=(
                f"NPPA answered with '{ctype or 'unknown'}' (a web page or PDF), which cannot be imported reliably. "
                "Download the current ceiling-price list from nppa.gov.in, convert it to the CSV template and upload it."))
    except Exception as e:  # network, TLS, HTTP errors -> honest status
        result.update(ok=False, status="unreachable", message=f"Could not reach NPPA: {type(e).__name__}: {str(e)[:160]}")
    db.set_setting("compliance.nppa_last_fetch", result)
    with db.tx():
        audit(user_id, "ceilings.fetch", f"{result.get('status')} {url}")
    return result


# ---------------------------------------------------------------------------------------------
# Margins
# ---------------------------------------------------------------------------------------------
MARGIN_BANDS = [("Negative", -math.inf, 0.0), ("0-10%", 0.0, 0.10), ("10-20%", 0.10, 0.20), ("20-30%", 0.20, 0.30),
                ("30%+", 0.30, math.inf)]
LOW_MARGIN = 0.05


def _pos_prices(store_id: str) -> dict[str, float]:
    """Average ex-GST selling price per unit from POS lines (if a POS feature exists)."""
    t = _pos_lines_table()
    if not t:
        return {}
    cols = t["cols"]
    amt = next((c for c in ("line_total_ex_gst", "taxable_value", "line_total", "amount") if c in cols), None)
    if not amt:
        return {}
    j = _pos_invoice_join(t)
    if not j:
        return {}
    frm, _, st_e, _ = j
    try:
        rows = db.query(f"""SELECT l.medicine_id, SUM(l.{amt}) AS amt, SUM(l.qty) AS q FROM {frm}
                            WHERE {st_e} = ? AND l.qty > 0 GROUP BY l.medicine_id""", (store_id,))
    except Exception:
        return {}
    ex = amt in ("line_total_ex_gst", "taxable_value")
    gst = gst_settings()
    return {r["medicine_id"]: (r["amt"] / r["q"]) / (1 if ex else 1 + gst_rate(r["medicine_id"], gst))
            for r in rows if r["q"] and r["amt"] is not None and r["medicine_id"] in S.meds.index}


def _supplier_map() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        from backend import suppliers as sup  # optional feature
        for mid in S.meds.index:
            try:
                v = sup.preferred_supplier(mid)
                if v:
                    out[mid] = str(v)
            except Exception:
                pass
    except ImportError:
        pass
    return out


def margins(store_id: str, as_of: str | None = None) -> dict:
    from backend import inventory as inv
    as_of = as_of or date.today().isoformat()
    scale = inv.store_scale(store_id)
    gst = gst_settings()
    stock = pd.DataFrame(db.query(
        """SELECT medicine_id, SUM(qty_on_hand) AS qty, SUM(qty_on_hand * unit_cost) AS cost_value,
                  COALESCE(supplier_id, 'Unknown') AS supplier_id
           FROM batches WHERE store_id = ? AND qty_on_hand > 0 AND expiry_date > ?
           GROUP BY medicine_id, COALESCE(supplier_id, 'Unknown')""", (store_id, as_of)))
    if stock.empty:
        stock = pd.DataFrame(columns=["medicine_id", "qty", "cost_value", "supplier_id"])
    stock["qty"] = stock["qty"].astype(float)
    stock["cost_value"] = stock["cost_value"].astype(float)
    by_med = stock.groupby("medicine_id")[["qty", "cost_value"]].sum()
    top_sup = (stock.sort_values("qty", ascending=False).drop_duplicates("medicine_id")
               .set_index("medicine_id")["supplier_id"]) if len(stock) else pd.Series(dtype=str)
    pref = _supplier_map()
    pos = _pos_prices(store_id)
    units = units_last_52w(scale)
    rows = []
    for mid, m in S.meds.iterrows():
        g = gst_rate(mid, gst)
        price_src = "pos" if mid in pos else "median_price"
        sell_ex = pos.get(mid, float(m["median_price"]) / (1 + g))
        q = float(by_med["qty"].get(mid, 0)) if mid in by_med.index else 0.0
        cv = float(by_med["cost_value"].get(mid, 0)) if mid in by_med.index else 0.0
        if q > 0:
            cost, cost_src = cv / q, "batches"
        else:
            cost, cost_src = float(m["median_price"]) * 0.8, "default (median price x 0.8)"
        gm_unit = sell_ex - cost
        u = float(units.get(mid, 0))
        gm = gm_unit * u
        rows.append({"medicine_id": mid, "medicine_name": m["medicine_name"], "category": m["category"],
                     "abc": m["abc"], "supplier_id": pref.get(mid) or (top_sup.get(mid) if mid in top_sup.index else None)
                     or "Unknown", "price_source": price_src, "cost_source": cost_src, "gst": g,
                     "sell_ex_gst": sell_ex, "unit_cost": cost, "margin_unit": gm_unit,
                     "margin_pct": gm_unit / sell_ex if sell_ex > 0 else None, "units_52w": u,
                     "revenue_ex_gst": sell_ex * u, "gross_margin": gm, "inventory_cost": cv,
                     "gmroi": gm / cv if cv > 0 else None})
    df = pd.DataFrame(rows)
    df["margin_pct"] = pd.to_numeric(df["margin_pct"], errors="coerce")

    def agg(key: str) -> list[dict]:
        g = df.groupby(key).agg(n=("medicine_id", "count"), revenue=("revenue_ex_gst", "sum"),
                                gross_margin=("gross_margin", "sum"), inventory_cost=("inventory_cost", "sum"))
        g["margin_pct"] = np.where(g["revenue"] > 0, g["gross_margin"] / g["revenue"], np.nan)
        g["gmroi"] = np.where(g["inventory_cost"] > 0, g["gross_margin"] / g["inventory_cost"], np.nan)
        g["share"] = g["gross_margin"] / max(df["gross_margin"].clip(lower=0).sum(), 1e-9)
        return g.reset_index().sort_values("gross_margin", ascending=False).to_dict("records")

    def band(p):
        if p is None or (isinstance(p, float) and math.isnan(p)):
            return None
        return next(b for b, lo, hi in MARGIN_BANDS if lo <= p < hi)
    df["band"] = df["margin_pct"].map(band)
    matrix = []
    for abc in ("A", "B", "C"):
        for b, _, _ in MARGIN_BANDS:
            sub = df[(df["abc"] == abc) & (df["band"] == b)]
            matrix.append({"abc": abc, "band": b, "n": int(len(sub)), "gross_margin": float(sub["gross_margin"].sum()),
                           "revenue": float(sub["revenue_ex_gst"].sum())})
    alerts = df[(df["margin_pct"] < LOW_MARGIN) & (df["units_52w"] > 0)].sort_values("margin_pct")
    tot_rev, tot_gm, tot_inv = df["revenue_ex_gst"].sum(), df["gross_margin"].sum(), df["inventory_cost"].sum()
    return {
        "store_id": store_id, "scale": scale,
        "totals": {"revenue_ex_gst": tot_rev, "gross_margin": tot_gm, "margin_pct": tot_gm / tot_rev if tot_rev else None,
                   "inventory_cost": tot_inv, "gmroi": tot_gm / tot_inv if tot_inv else None,
                   "pos_priced": int((df["price_source"] == "pos").sum()),
                   "default_cost": int((df["cost_source"] != "batches").sum())},
        "by_category": agg("category"), "by_supplier": agg("supplier_id"),
        "matrix": matrix, "bands": [b for b, _, _ in MARGIN_BANDS],
        "alerts": alerts.head(50).to_dict("records"),
        "medicines": df.sort_values("gross_margin", ascending=False).to_dict("records"),
        "definitions": {
            "selling_price": "POS average line total per unit ex-GST where POS data exists; otherwise dataset median "
                             "selling price / (1 + GST). Dataset prices are synthetic.",
            "unit_cost": "Quantity-weighted unit cost of sellable (non-expired) on-hand batches; opening batches were "
                         "seeded at median price x 0.8, so margins look uniform until real purchase costs are received. "
                         "No stock -> median price x 0.8.",
            "gross_margin": "(selling price ex-GST - unit cost) x units sold in the last 52 weeks (store-scaled).",
            "gmroi": "Annual gross margin / inventory at cost. Average inventory is approximated by today's on-hand "
                     "stock at cost (no inventory history yet).",
            "low_margin": f"Margin below {LOW_MARGIN:.0%} on a medicine that sold in the last 52 weeks.",
        },
    }
