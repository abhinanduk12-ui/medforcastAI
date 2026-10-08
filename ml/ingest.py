"""Data ingestion for retraining: validate uploaded sales files, version them, export the shop's own
POS/ledger sales, and assemble the training dataset a retraining run uses.

Upload format = the original workbook schema:
  * sheet "Sales Data" (or the first sheet / a .csv) with at least
        transaction_id, sale_date, medicine_id, quantity_sold, unit_price
    and optionally sale_time, medicine_name, generic_name, category, total_amount, batch_no,
    expiry_date, prescription_type, supplier_id;
  * optional sheet "Medicine Master" (medicine_id, medicine_name, generic_name, category, form,
    reference_unit_price) used to add medicines the model has not seen.

Storage (root = env MEDFORECAST_UPLOADS or data/uploads/):
    _base/            cached CSV copy of data/raw/pharma_dataset.xlsx (re-built when the xlsx changes)
    <upload id>/      original file, sales.csv (rows that passed validation), master_new.csv,
                      report.json, manifest.json {status pending|accepted|rejected, rows, date range, sha256}
    _training/<v>/    the dataset a training run used: training.xlsx (+ csv copies) and manifest.json

Training dataset = base history + selected ACCEPTED uploads + ledger sales.
  1. Rows are de-duplicated by transaction_id (ledger rows use "LEDGER-<movement id>"); when the same id
     appears in several sources the NEWER source's row wins.
  2. Overlapping days: if more than one source has sales on the same calendar day, only the newest
     source's rows for that day are kept (a re-export of a period replaces it rather than doubling it).
     Source age order: base history < uploads (by accept time) < ledger (live billing).
     Caveat: a day with only a few POS sales still replaces the base history for that day; the
     coverage preview reports every replaced day so this is visible before training.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

SALES_COLUMNS = ["transaction_id", "sale_date", "sale_time", "medicine_id", "medicine_name", "generic_name",
                 "category", "quantity_sold", "unit_price", "total_amount", "batch_no", "expiry_date",
                 "prescription_type", "supplier_id"]
REQUIRED = ["transaction_id", "sale_date", "medicine_id", "quantity_sold", "unit_price"]
MASTER_COLUMNS = ["medicine_id", "medicine_name", "generic_name", "category", "form", "reference_unit_price"]
MAX_ROWS = 500_000
SAMPLE = 8
OUTLIER_Z = 6.0
IST = timezone(timedelta(hours=5, minutes=30))
UPLOAD_ID_RE = re.compile(r"^u[0-9a-f]{12}$")
MED_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,32}$")
FORMULA_RE = r"^[=+@\t\r]+"
TEXT_COLUMNS = ["transaction_id", "medicine_name", "generic_name", "category", "batch_no", "expiry_date",
                "prescription_type", "supplier_id"]
_base_lock = threading.Lock()
_lock = threading.RLock()


class IngestError(ValueError):
    status = 400


class UploadNotFound(IngestError):
    status = 404


def uploads_dir() -> Path:
    return Path(os.environ.get("MEDFORECAST_UPLOADS") or (C.ROOT / "data" / "uploads"))


def today_ist() -> pd.Timestamp:
    return pd.Timestamp(datetime.now(IST).date())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


# --------------------------------------------------------------------------------------------------
# Base history (cached as CSV: reading the 32k-row workbook takes ~15 s)
# --------------------------------------------------------------------------------------------------

def _base_key(raw: Path) -> dict:
    st = raw.stat()
    return {"path": str(raw), "size": st.st_size, "mtime_ns": st.st_mtime_ns}


def base_ready() -> bool:
    d = uploads_dir() / "_base"
    raw = C.DEFAULT_RAW_XLSX
    meta = _read_json(d / "meta.json")
    return bool(meta and raw.exists() and meta.get("key") == _base_key(raw) and (d / "sales.csv").exists())


def ensure_base() -> dict:
    """Build (if stale) and return the cached base history meta {key, sha256, rows, start, end}."""
    d = uploads_dir() / "_base"
    raw = C.DEFAULT_RAW_XLSX
    with _base_lock:
        if base_ready():
            return _read_json(d / "meta.json")
        if not raw.exists():
            raise IngestError(f"Base workbook {raw} is missing")
        sheets = pd.read_excel(raw, sheet_name=["Sales Data", "Medicine Master"], dtype=str)
        sales, master = sheets["Sales Data"], sheets["Medicine Master"]
        d.mkdir(parents=True, exist_ok=True)
        sales.to_csv(d / "sales.csv.tmp", index=False)
        master.to_csv(d / "master.csv.tmp", index=False)
        os.replace(d / "sales.csv.tmp", d / "sales.csv")
        os.replace(d / "master.csv.tmp", d / "master.csv")
        dates = pd.to_datetime(sales["sale_date"], errors="coerce")
        meta = {"key": _base_key(raw), "sha256": sha256_file(raw), "rows": int(len(sales)),
                "start": str(dates.min().date()), "end": str(dates.max().date()), "built_at": now_iso()}
        _write_json(d / "meta.json", meta)
        return meta


def base_sales() -> pd.DataFrame:
    ensure_base()
    return pd.read_csv(uploads_dir() / "_base" / "sales.csv", dtype=str)


def base_master() -> pd.DataFrame:
    ensure_base()
    m = pd.read_csv(uploads_dir() / "_base" / "master.csv", dtype=str)
    m["reference_unit_price"] = pd.to_numeric(m["reference_unit_price"], errors="coerce")
    return m


def _price_reference(sales: pd.DataFrame) -> pd.DataFrame:
    """Per-medicine median and MAD of unit price from a sales frame (for robust-z outlier checks)."""
    p = pd.to_numeric(sales["unit_price"], errors="coerce")
    g = pd.DataFrame({"m": sales["medicine_id"], "p": p}).dropna()
    med = g.groupby("m")["p"].median()
    mad = (g["p"] - g["m"].map(med)).abs().groupby(g["m"]).median()
    return pd.DataFrame({"median": med, "mad": mad})


# --------------------------------------------------------------------------------------------------
# Reading + validation
# --------------------------------------------------------------------------------------------------

def _norm_cols(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [re.sub(r"[^a-z0-9]+", "_", str(c).strip().lower()).strip("_") for c in df.columns]
    return df


def read_file(content: bytes, filename: str) -> tuple[pd.DataFrame, pd.DataFrame | None, list[str]]:
    """Parse an uploaded .xlsx/.csv into (sales, master|None, sheet names). Raises IngestError."""
    name = (filename or "").lower()
    try:
        if name.endswith(".csv"):
            text = content.decode("utf-8-sig", errors="replace")
            return _norm_cols(pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)), None, ["(csv)"]
        if name.endswith((".xlsx", ".xlsm")):
            xl = pd.ExcelFile(io.BytesIO(content), engine="openpyxl")
            sheets = list(xl.sheet_names)
            low = {s.strip().lower(): s for s in sheets}
            sales_sheet = low.get("sales data") or sheets[0]
            sales = _norm_cols(xl.parse(sales_sheet, dtype=str, keep_default_na=False))
            master = None
            if "medicine master" in low:
                master = _norm_cols(xl.parse(low["medicine master"], dtype=str, keep_default_na=False))
            return sales, master, sheets
    except IngestError:
        raise
    except Exception as e:  # noqa: BLE001 - any parser failure is a user-file problem, not a 500
        raise IngestError(f"Could not read {filename}: {type(e).__name__}: {str(e)[:200]}")
    raise IngestError("Only .xlsx and .csv files are accepted")


def _issue(issues: list, code: str, severity: str, message: str, mask: pd.Series, df: pd.DataFrame,
           cols: list[str]) -> None:
    n = int(mask.sum())
    if not n:
        return
    sample = df.loc[mask, [c for c in cols if c in df.columns]].head(SAMPLE)
    rows = [{"row": int(i) + 2, **{k: (None if (isinstance(v, float) and np.isnan(v)) else str(v)[:80])
                                   for k, v in r.items()}} for i, r in sample.iterrows()]
    issues.append({"code": code, "severity": severity, "message": message, "count": n, "sample": rows})


def validate(sales: pd.DataFrame, master: pd.DataFrame | None, *, known_master: pd.DataFrame,
             known_tx: set[str] | None = None, price_ref: pd.DataFrame | None = None,
             today: pd.Timestamp | None = None) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    """Validate an upload. Returns (report, clean_sales in SALES_COLUMNS, new_medicines master rows)."""
    today = today or today_ist()
    issues: list[dict] = []
    cols = list(sales.columns)
    missing = [c for c in REQUIRED if c not in cols]
    report = {"rows_total": int(len(sales)), "columns_found": cols,
              "columns_missing_optional": [c for c in SALES_COLUMNS if c not in cols and c not in REQUIRED]}
    if missing:
        report.update(status="fatal", rows_accepted=0, rows_rejected=int(len(sales)), issues=[{
            "code": "missing_columns", "severity": "fatal", "count": len(missing), "sample": [],
            "message": f"Required column(s) missing: {', '.join(missing)}. Expected the 'Sales Data' schema "
                       f"({', '.join(REQUIRED)} at minimum)."}], unknown_medicines=[], date_range=None)
        return report, pd.DataFrame(columns=SALES_COLUMNS), pd.DataFrame(columns=MASTER_COLUMNS)
    if len(sales) == 0:
        report.update(status="fatal", rows_accepted=0, rows_rejected=0, unknown_medicines=[], date_range=None,
                      issues=[{"code": "empty", "severity": "fatal", "count": 0, "sample": [],
                               "message": "The file has no data rows."}])
        return report, pd.DataFrame(columns=SALES_COLUMNS), pd.DataFrame(columns=MASTER_COLUMNS)
    if len(sales) > MAX_ROWS:
        raise IngestError(f"Too many rows ({len(sales):,}); the limit is {MAX_ROWS:,} per upload")

    df = sales.copy().reset_index(drop=True)
    for c in SALES_COLUMNS:
        if c not in df.columns:
            df[c] = ""
    df = df[SALES_COLUMNS].astype(str).apply(lambda s: s.str.strip())
    df = df.replace({"nan": "", "NaT": "", "None": ""})
    show = ["transaction_id", "sale_date", "medicine_id", "quantity_sold", "unit_price"]
    bad = pd.Series(False, index=df.index)

    # Spreadsheet-formula text (=, +, @ prefixes): openpyxl would write it into training.xlsx as a formula
    # (read back as blank) and Excel would execute it when someone opens the stored csv/xlsx.
    m = df[TEXT_COLUMNS].apply(lambda s: s.str.match(FORMULA_RE)).any(axis=1)
    _issue(issues, "formula_text", "warning",
           "Text starting with =, + or @ (a spreadsheet formula) had those leading characters removed.", m, df, show)
    df[TEXT_COLUMNS] = df[TEXT_COLUMNS].apply(lambda s: s.str.replace(FORMULA_RE, "", regex=True).str.strip())

    m = df["transaction_id"].eq("") | (df["transaction_id"].str.len() > 64)
    _issue(issues, "bad_transaction_id", "error", "Blank or over-long transaction_id (row dropped).", m, df, show)
    bad |= m

    d1 = pd.to_datetime(df["sale_date"], errors="coerce", format="ISO8601")
    d2 = pd.to_datetime(df["sale_date"].where(d1.isna()), errors="coerce", dayfirst=True, format="mixed")
    dates = d1.fillna(d2).dt.normalize()
    m = dates.isna() & ~bad
    _issue(issues, "bad_date", "error", "sale_date could not be read as a date (row dropped).", m, df, show)
    bad |= m
    m = (dates > today) & ~bad
    _issue(issues, "future_date", "error", f"sale_date is after today ({today.date()}) (row dropped).", m, df, show)
    bad |= m
    m = (dates < pd.Timestamp("2000-01-01")) & ~bad
    _issue(issues, "ancient_date", "error", "sale_date is before 2000 (row dropped).", m, df, show)
    bad |= m

    qty = pd.to_numeric(df["quantity_sold"], errors="coerce")
    m = (qty.isna() | (qty != np.round(qty)) | ~np.isfinite(qty.fillna(0))) & ~bad
    _issue(issues, "bad_quantity", "error", "quantity_sold is not a whole number (row dropped).", m, df, show)
    bad |= m
    m = (qty <= 0) & ~bad
    _issue(issues, "non_positive_quantity", "error",
           "quantity_sold is zero or negative (returns are not sales; row dropped).", m, df, show)
    bad |= m
    m = (qty > 10_000) & ~bad
    _issue(issues, "huge_quantity", "error", "quantity_sold above 10,000 on one line (row dropped).", m, df, show)
    bad |= m

    price = pd.to_numeric(df["unit_price"], errors="coerce")
    m = (price.isna() | (price <= 0) | (price > 1e7)) & ~bad
    _issue(issues, "bad_price", "error", "unit_price is missing, zero/negative or absurd (row dropped).", m, df, show)
    bad |= m

    m = ~df["medicine_id"].str.match(MED_ID_RE) & ~bad
    _issue(issues, "bad_medicine_id", "error", "medicine_id is blank or malformed (row dropped).", m, df, show)
    bad |= m

    dup = df["transaction_id"].where(~bad).duplicated(keep="first") & ~bad  # a dropped row never shadows a good one
    _issue(issues, "duplicate_in_file", "error", "transaction_id repeated inside this file (later copies dropped).",
           dup, df, show)
    bad |= dup

    # Unknown medicines: addable when the upload's own Medicine Master describes them.
    known = set(known_master["medicine_id"].astype(str))
    up_master = pd.DataFrame(columns=MASTER_COLUMNS)
    if master is not None and "medicine_id" in master.columns:
        up_master = master.copy()
        for c in MASTER_COLUMNS:
            if c not in up_master.columns:
                up_master[c] = ""
        up_master = up_master[MASTER_COLUMNS].astype(str).apply(
            lambda s: s.str.strip().str.replace(FORMULA_RE, "", regex=True).str.strip())
        up_master = up_master[up_master["medicine_id"].str.match(MED_ID_RE)].drop_duplicates("medicine_id")
    describable = set(up_master.loc[(up_master["medicine_name"] != "") & (up_master["category"] != ""), "medicine_id"])
    unk_mask = ~df["medicine_id"].isin(known) & ~bad
    unknown = []
    if unk_mask.any():
        vc = df.loc[unk_mask, "medicine_id"].value_counts()
        for mid, n in vc.items():
            unknown.append({"medicine_id": mid, "rows": int(n), "in_upload_master": mid in describable,
                            "medicine_name": (up_master.set_index("medicine_id")["medicine_name"].get(mid)
                                              if mid in describable else None)})
        addable = unk_mask & df["medicine_id"].isin(describable)
        _issue(issues, "new_medicine", "warning",
               "medicine_id not in the model's master but described in this file's Medicine Master: can be added "
               "when you accept (choose 'add new medicines').", addable, df, show)
        undescribed = unk_mask & ~df["medicine_id"].isin(describable)
        _issue(issues, "unknown_medicine", "error",
               "medicine_id is not in the Medicine Master (add a 'Medicine Master' sheet describing it; row dropped).",
               undescribed, df, show)
        bad |= undescribed

    ok = ~bad
    # Warnings on kept rows.
    if known_tx:
        m = ok & df["transaction_id"].isin(known_tx)
        _issue(issues, "already_loaded", "warning",
               "transaction_id already exists in the base history or another accepted upload; this file's row will "
               "replace it in training (newer source wins).", m, df, show)
    ref = price_ref if price_ref is not None else pd.DataFrame(columns=["median", "mad"])
    med = df["medicine_id"].map(ref["median"]) if len(ref) else pd.Series(np.nan, index=df.index)
    mad = df["medicine_id"].map(ref["mad"]) if len(ref) else pd.Series(np.nan, index=df.index)
    own = _price_reference(df[ok].assign(unit_price=price[ok]))
    med = med.fillna(df["medicine_id"].map(own["median"]))
    mad = mad.fillna(df["medicine_id"].map(own["mad"]))
    scale = np.maximum(mad.fillna(0) / 0.6745, 0.05 * med.abs())
    z = (price - med) / scale.replace(0, np.nan)
    m = ok & (z.abs() > OUTLIER_Z)
    _issue(issues, "price_outlier", "warning",
           f"unit_price is far from this medicine's usual price (robust z > {OUTLIER_Z:g}); kept, please check.",
           m, df.assign(usual_price=med.round(2).astype(str), robust_z=z.round(1).astype(str)),
           show + ["usual_price", "robust_z"])
    tot = pd.to_numeric(df["total_amount"], errors="coerce")
    m = ok & tot.notna() & ((tot - qty * price).abs() > np.maximum(0.01 * qty * price, 1.0))
    _issue(issues, "total_mismatch", "warning", "total_amount differs from quantity x unit_price; recomputed.",
           m, df, show + ["total_amount"])
    times = pd.to_datetime(df["sale_time"], errors="coerce", format="%H:%M:%S")
    m = ok & times.isna() & (df["sale_time"] != "")
    _issue(issues, "bad_time", "warning", "sale_time is not HH:MM:SS; set to 12:00:00.", m, df, show + ["sale_time"])

    # Build the clean frame in the original schema.
    out = df[ok].copy()
    out["sale_date"] = dates[ok].dt.strftime("%Y-%m-%d")
    out["sale_time"] = times[ok].dt.strftime("%H:%M:%S").fillna("12:00:00")
    out["quantity_sold"] = qty[ok].astype(int)
    out["unit_price"] = price[ok].round(2)
    out["total_amount"] = (out["quantity_sold"] * out["unit_price"]).round(2)
    allm = pd.concat([known_master[MASTER_COLUMNS].astype(str), up_master[~up_master["medicine_id"].isin(known)]])
    allm = allm.drop_duplicates("medicine_id").set_index("medicine_id")
    for c in ("medicine_name", "generic_name", "category"):
        blank = out[c] == ""
        out.loc[blank, c] = out.loc[blank, "medicine_id"].map(allm[c]).fillna("")
    out.loc[~out["prescription_type"].isin(["Rx", "OTC"]), "prescription_type"] = "Unknown"
    out.loc[out["supplier_id"] == "", "supplier_id"] = "UNKNOWN"
    new_meds = up_master[up_master["medicine_id"].isin({u["medicine_id"] for u in unknown if u["in_upload_master"]})]
    new_meds = new_meds.assign(reference_unit_price=pd.to_numeric(new_meds["reference_unit_price"], errors="coerce"))
    if len(new_meds) and new_meds["reference_unit_price"].isna().any():
        mp = out.groupby("medicine_id")["unit_price"].median()
        new_meds["reference_unit_price"] = new_meds["reference_unit_price"].fillna(new_meds["medicine_id"].map(mp))
    new_meds.loc[new_meds["form"] == "", "form"] = "Other"

    n_err = sum(i["count"] for i in issues if i["severity"] == "error")
    n_warn = sum(i["count"] for i in issues if i["severity"] == "warning")
    rng = None
    if len(out):
        rng = [out["sale_date"].min(), out["sale_date"].max()]
    report.update(
        status="errors" if n_err else ("warnings" if n_warn else "ok"),
        rows_accepted=int(len(out)), rows_rejected=int(bad.sum()), units=int(out["quantity_sold"].sum()) if len(out) else 0,
        date_range=rng, issues=sorted(issues, key=lambda i: (i["severity"] != "error", -i["count"])),
        unknown_medicines=unknown[:200], unknown_medicine_count=len(unknown),
        medicines=int(out["medicine_id"].nunique()) if len(out) else 0,
    )
    if not len(out):
        report["status"] = "fatal"
    return report, out[SALES_COLUMNS].reset_index(drop=True), new_meds[MASTER_COLUMNS].reset_index(drop=True)


# --------------------------------------------------------------------------------------------------
# Upload store
# --------------------------------------------------------------------------------------------------

def _upload_dir(uid: str) -> Path:
    if not isinstance(uid, str) or not UPLOAD_ID_RE.match(uid):
        raise UploadNotFound("Unknown upload")
    return uploads_dir() / uid


def get_upload(uid: str) -> dict:
    m = _read_json(_upload_dir(uid) / "manifest.json")
    if not m:
        raise UploadNotFound("Unknown upload")
    return m


def get_report(uid: str) -> dict:
    get_upload(uid)
    return _read_json(_upload_dir(uid) / "report.json", {}) or {}


def list_uploads() -> list[dict]:
    root = uploads_dir()
    if not root.exists():
        return []
    out = []
    for p in root.iterdir():
        if p.is_dir() and UPLOAD_ID_RE.match(p.name):
            m = _read_json(p / "manifest.json")
            if m:
                out.append(m)
    return sorted(out, key=lambda m: m.get("created_at", ""), reverse=True)


def _known_tx(exclude: str | None = None) -> set[str]:
    tx = set(base_sales()["transaction_id"].astype(str))
    for u in list_uploads():
        if u.get("status") == "accepted" and u["id"] != exclude:
            try:
                tx |= set(pd.read_csv(_upload_dir(u["id"]) / "sales.csv", usecols=["transaction_id"],
                                      dtype=str)["transaction_id"])
            except (OSError, ValueError):
                pass
    return tx


def create_upload(content: bytes, filename: str, user: str | None = None) -> dict:
    """Validate and store an upload as 'pending'. Returns the manifest (report via get_report)."""
    safe_name = re.sub(r"[^A-Za-z0-9._\- ]+", "_", Path(filename or "upload").name)[:120] or "upload"
    ext = Path(safe_name).suffix.lower()
    if ext not in (".xlsx", ".xlsm", ".csv"):
        raise IngestError("Only .xlsx and .csv files are accepted")
    sales, master, sheets = read_file(content, safe_name)
    known_master = base_master()
    report, clean, new_meds = validate(sales, master, known_master=known_master, known_tx=_known_tx(),
                                       price_ref=_price_reference(base_sales()))
    report["sheets"] = sheets
    report["has_master_sheet"] = master is not None
    uid = "u" + secrets.token_hex(6)
    d = uploads_dir() / uid
    d.mkdir(parents=True, exist_ok=False)
    (d / f"original{ext}").write_bytes(content)
    clean.to_csv(d / "sales.csv", index=False)
    new_meds.to_csv(d / "master_new.csv", index=False)
    _write_json(d / "report.json", report)
    manifest = {
        "id": uid, "filename": safe_name, "created_at": now_iso(), "uploaded_by": user, "status": "pending",
        "validation": report["status"], "rows_total": report["rows_total"], "rows": report["rows_accepted"],
        "rows_rejected": report["rows_rejected"], "units": report.get("units", 0), "date_range": report["date_range"],
        "new_medicines": int(len(new_meds)), "add_new_medicines": False, "bytes": len(content),
        "sha256": sha256_bytes(content), "sales_sha256": sha256_file(d / "sales.csv"),
    }
    if report["status"] == "fatal":
        manifest["status"] = "rejected"
        manifest["rejected_reason"] = "validation failed"
    _write_json(d / "manifest.json", manifest)
    return manifest


def accept_upload(uid: str, *, add_new_medicines: bool = False, user: str | None = None) -> dict:
    with _lock:
        m = get_upload(uid)
        if m["status"] != "pending":
            raise IngestError(f"Upload is {m['status']}, only pending uploads can be accepted")
        if m.get("validation") == "fatal" or not m.get("rows"):
            raise IngestError("This upload has no valid rows")
        d = _upload_dir(uid)
        if not add_new_medicines and m.get("new_medicines"):
            sales = pd.read_csv(d / "sales.csv", dtype=str)
            new_ids = set(pd.read_csv(d / "master_new.csv", dtype=str)["medicine_id"])
            sales = sales[~sales["medicine_id"].isin(new_ids)]
            sales.to_csv(d / "sales.csv", index=False)
            m["rows"] = int(len(sales))
            m["units"] = int(pd.to_numeric(sales["quantity_sold"]).sum()) if len(sales) else 0
            m["date_range"] = [sales["sale_date"].min(), sales["sale_date"].max()] if len(sales) else None
            m["sales_sha256"] = sha256_file(d / "sales.csv")
            if not len(sales):
                raise IngestError("Every valid row is for a new medicine; accept with 'add new medicines' or reject")
        m.update(status="accepted", accepted_at=now_iso(), accepted_by=user, add_new_medicines=bool(add_new_medicines))
        _write_json(d / "manifest.json", m)
        return m


def reject_upload(uid: str, *, user: str | None = None, reason: str | None = None) -> dict:
    with _lock:
        m = get_upload(uid)
        if m["status"] == "rejected":
            return m
        m.update(status="rejected", rejected_at=now_iso(), rejected_by=user, rejected_reason=(reason or "")[:300])
        _write_json(_upload_dir(uid) / "manifest.json", m)
        return m


def delete_upload(uid: str) -> None:
    with _lock:
        get_upload(uid)
        shutil.rmtree(_upload_dir(uid), ignore_errors=False)


# --------------------------------------------------------------------------------------------------
# Ledger (POS) sales -> training rows
# --------------------------------------------------------------------------------------------------

def ledger_sales(db_file: str | Path, store_id: str | None) -> pd.DataFrame:
    """Sales recorded through the app's billing/ledger, in the original schema.

    movements kind='sale' with NEGATIVE qty (customer returns are positive 'sale' rows with ref RET-...
    and are excluded). transaction_id = "LEDGER-<movement id>". unit_price = the medicine's median
    selling price in the base history (the ledger stores cost, not the billed price) - an assumption.
    Dates are converted from UTC to India time (IST)."""
    p = Path(db_file)
    if not p.exists():
        return pd.DataFrame(columns=SALES_COLUMNS)
    con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True, timeout=10)
    try:
        sql = ("SELECT m.id, m.store_id, m.medicine_id, -m.qty AS qty, m.ref, m.created_at, b.batch_no, "
               "b.expiry_date, b.supplier_id FROM movements m LEFT JOIN batches b ON b.id = m.batch_id "
               "WHERE m.kind = 'sale' AND m.qty < 0 AND (m.ref IS NULL OR (m.ref NOT LIKE 'RET-%' AND m.ref NOT IN "
               "(SELECT substr(ref, 6) FROM movements WHERE kind = 'sale' AND ref LIKE 'VOID-%')))")  # voided bills are not demand
        params: list = []
        if store_id:
            sql += " AND m.store_id = ?"
            params.append(store_id)
        rows = pd.read_sql_query(sql, con, params=params)
    except (sqlite3.Error, pd.errors.DatabaseError):
        rows = pd.DataFrame()
    finally:
        con.close()
    if rows.empty:
        return pd.DataFrame(columns=SALES_COLUMNS)
    ts = pd.to_datetime(rows["created_at"], errors="coerce", utc=True).dt.tz_convert("Asia/Kolkata")
    master = base_master().set_index("medicine_id")
    base = base_sales()
    bp = pd.to_numeric(base["unit_price"], errors="coerce").groupby(base["medicine_id"]).median()
    rx = base.groupby("medicine_id")["prescription_type"].agg(lambda s: s.mode().iloc[0] if len(s.mode()) else "Unknown")
    price = rows["medicine_id"].map(bp).fillna(rows["medicine_id"].map(master["reference_unit_price"])).fillna(0.0)
    out = pd.DataFrame({
        "transaction_id": "LEDGER-" + rows["id"].astype(str),
        "sale_date": ts.dt.strftime("%Y-%m-%d"), "sale_time": ts.dt.strftime("%H:%M:%S"),
        "medicine_id": rows["medicine_id"],
        "medicine_name": rows["medicine_id"].map(master["medicine_name"]).fillna(""),
        "generic_name": rows["medicine_id"].map(master["generic_name"]).fillna(""),
        "category": rows["medicine_id"].map(master["category"]).fillna(""),
        "quantity_sold": rows["qty"].astype(int), "unit_price": price.round(2),
        "total_amount": (rows["qty"] * price).round(2), "batch_no": rows["batch_no"].fillna(""),
        "expiry_date": rows["expiry_date"].fillna(""),
        "prescription_type": rows["medicine_id"].map(rx).fillna("Unknown"),
        "supplier_id": rows["supplier_id"].fillna("UNKNOWN"),
    })
    out = out[ts.notna().to_numpy() & rows["medicine_id"].isin(master.index).to_numpy() & (out["unit_price"] > 0)]
    return out[SALES_COLUMNS].reset_index(drop=True)


# --------------------------------------------------------------------------------------------------
# Training dataset assembly
# --------------------------------------------------------------------------------------------------

def _week_start(d: pd.Series) -> pd.Series:
    d = pd.to_datetime(d)
    return (d - pd.to_timedelta(d.dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")


def assemble(upload_ids: list[str] | None = None, include_ledger: bool = False, *, db_file: str | Path | None = None,
             ledger_store: str | None = None) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """Combine base + accepted uploads + ledger into one sales frame. Returns (sales, master, coverage)."""
    upload_ids = list(dict.fromkeys(upload_ids or []))
    meta = ensure_base()
    parts, sources = [], []
    base = base_sales()
    sources.append({"key": "base", "kind": "base", "label": "Base history", "rows_in": int(len(base)),
                    "sha256": meta["sha256"], "priority": 0})
    parts.append(base.assign(_src="base", _prio=0))
    master = base_master()
    ups = []
    for uid in upload_ids:
        m = get_upload(uid)
        if m["status"] != "accepted":
            raise IngestError(f"Upload {uid} ({m['filename']}) is {m['status']}; only accepted uploads can be used")
        ups.append(m)
    ups.sort(key=lambda m: m.get("accepted_at") or m["created_at"])
    for i, m in enumerate(ups, start=1):
        d = _upload_dir(m["id"])
        s = pd.read_csv(d / "sales.csv", dtype=str, keep_default_na=False)
        parts.append(s.assign(_src=m["id"], _prio=i))
        sources.append({"key": m["id"], "kind": "upload", "label": m["filename"], "rows_in": int(len(s)),
                        "sha256": m.get("sales_sha256"), "file_sha256": m.get("sha256"), "priority": i})
        if m.get("add_new_medicines"):
            nm = pd.read_csv(d / "master_new.csv", dtype=str, keep_default_na=False)
            nm["reference_unit_price"] = pd.to_numeric(nm["reference_unit_price"], errors="coerce")
            master = pd.concat([master, nm[~nm["medicine_id"].isin(master["medicine_id"])]], ignore_index=True)
    if include_ledger:
        led = ledger_sales(db_file, ledger_store) if db_file else pd.DataFrame(columns=SALES_COLUMNS)
        prio = len(ups) + 1
        parts.append(led.astype(str).assign(_src="ledger", _prio=prio))
        sources.append({"key": "ledger", "kind": "ledger", "label": f"Billing ledger ({ledger_store or 'all stores'})",
                        "rows_in": int(len(led)), "priority": prio,
                        "sha256": sha256_bytes(led.to_csv(index=False).encode()) if len(led) else None})
    allrows = pd.concat(parts, ignore_index=True)
    for c in SALES_COLUMNS:
        if c not in allrows.columns:
            allrows[c] = ""
    allrows["transaction_id"] = allrows["transaction_id"].astype(str)
    allrows["_date"] = pd.to_datetime(allrows["sale_date"], errors="coerce").dt.strftime("%Y-%m-%d")
    allrows = allrows[allrows["_date"].notna()]
    n0 = allrows.groupby("_src").size()
    # 1) same transaction_id in several sources: newest source wins.
    allrows = allrows.sort_values("_prio", kind="stable").drop_duplicates("transaction_id", keep="last")
    n1 = allrows.groupby("_src").size()
    # 2) same day in several sources: only the newest source's rows for that day are kept.
    win = allrows.groupby("_date")["_prio"].transform("max")
    replaced = allrows.loc[allrows["_prio"] < win]
    replaced_days = replaced.groupby("_src")["_date"].nunique()
    allrows = allrows[allrows["_prio"] == win]
    n2 = allrows.groupby("_src").size()
    qty = pd.to_numeric(allrows["quantity_sold"], errors="coerce").fillna(0)
    allrows = allrows.assign(_qty=qty, _week=_week_start(allrows["_date"]))
    for s in sources:
        k = s["key"]
        g = allrows[allrows["_src"] == k]
        s.update(rows_after_dedup=int(n1.get(k, 0)), rows_used=int(n2.get(k, 0)),
                 dropped_duplicate_ids=int(n0.get(k, 0) - n1.get(k, 0)),
                 dropped_overlap_rows=int(n1.get(k, 0) - n2.get(k, 0)),
                 days_replaced_by_newer=int(replaced_days.get(k, 0)),
                 units=int(g["_qty"].sum()), weeks=int(g["_week"].nunique()),
                 start=(g["_date"].min() if len(g) else None), end=(g["_date"].max() if len(g) else None))
    tl = allrows.pivot_table(index="_week", columns="_src", values="_qty", aggfunc="sum", fill_value=0)
    timeline = [{"week": w, **{k: int(tl.at[w, k]) if k in tl.columns else 0 for k in [s["key"] for s in sources]}}
                for w in tl.index]
    coverage = {
        "sources": sources, "timeline": timeline, "rows": int(len(allrows)), "units": int(qty.sum()),
        "start": allrows["_date"].min() if len(allrows) else None, "end": allrows["_date"].max() if len(allrows) else None,
        "weeks": int(allrows["_week"].nunique()), "medicines": int(master["medicine_id"].nunique()),
        "new_medicines": int(len(master) - len(base_master())),
        "rules": ["Duplicate transaction_id across sources: the newer source's row is kept.",
                  "Days present in several sources: only the newest source's rows for that day are kept "
                  "(base history < uploads in accept order < billing ledger)."],
    }
    sales = allrows.sort_values(["_date", "sale_time", "transaction_id"])[SALES_COLUMNS].reset_index(drop=True)
    return sales, master[MASTER_COLUMNS].reset_index(drop=True), coverage


def write_training_set(sales: pd.DataFrame, master: pd.DataFrame, out_dir: Path, coverage: dict | None = None) -> Path:
    """Write training.xlsx (sheets 'Sales Data' + 'Medicine Master', read by ml.data.load_raw) plus csv copies
    and manifest.json. Returns the xlsx path."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    s = sales.copy()
    for c in ("quantity_sold",):
        s[c] = pd.to_numeric(s[c], errors="coerce").fillna(0).astype(int)
    for c in ("unit_price", "total_amount"):
        s[c] = pd.to_numeric(s[c], errors="coerce").fillna(0.0)
    mst = master.copy()
    mst["reference_unit_price"] = pd.to_numeric(mst["reference_unit_price"], errors="coerce")
    xlsx = out_dir / "training.xlsx"
    tmp = out_dir / "training.tmp.xlsx"
    with pd.ExcelWriter(tmp, engine="openpyxl") as w:
        s.to_excel(w, sheet_name="Sales Data", index=False)
        mst.to_excel(w, sheet_name="Medicine Master", index=False)
    os.replace(tmp, xlsx)
    s.to_csv(out_dir / "sales.csv", index=False)
    mst.to_csv(out_dir / "master.csv", index=False)
    manifest = {"created_at": now_iso(), "rows": int(len(s)),
                "date_range": [str(s["sale_date"].min()), str(s["sale_date"].max())] if len(s) else None,
                "sales_sha256": sha256_file(out_dir / "sales.csv"), "xlsx": xlsx.name, "coverage": coverage}
    _write_json(out_dir / "manifest.json", manifest)
    return xlsx


def build_training_dataset(out_dir: Path, upload_ids: list[str] | None = None, include_ledger: bool = False, *,
                           db_file: str | Path | None = None, ledger_store: str | None = None) -> tuple[Path, dict]:
    sales, master, cov = assemble(upload_ids, include_ledger, db_file=db_file, ledger_store=ledger_store)
    if len(sales) == 0:
        raise IngestError("The training dataset is empty")
    xlsx = write_training_set(sales, master, out_dir, cov)
    return xlsx, _read_json(Path(out_dir) / "manifest.json")


def resolve_training_input(data: str | None, extra_sales: list[str] | None, workdir: Path) -> Path:
    """CLI helper for `python -m ml.train --data ... --extra-sales ...` -> path of a workbook load_raw can read."""
    extra_sales = extra_sales or []
    if data:
        p = Path(data)
        if p.is_dir():
            p = p / "manifest.json"
        if p.name.endswith(".json"):
            man = _read_json(p)
            if not man or "xlsx" not in man:
                raise IngestError(f"{p} is not a dataset manifest")
            p = p.parent / man["xlsx"]
        if not p.exists():
            raise IngestError(f"{p} does not exist")
    else:
        p = C.DEFAULT_RAW_XLSX
    if p.suffix.lower() in (".xlsx", ".xlsm") and not extra_sales:
        return p
    if p.suffix.lower() == ".csv":
        sales, master = pd.read_csv(p, dtype=str, keep_default_na=False), base_master()
    else:
        sh = pd.read_excel(p, sheet_name=["Sales Data", "Medicine Master"], dtype=str)
        sales, master = sh["Sales Data"], sh["Medicine Master"]
    extras = [pd.read_csv(x, dtype=str, keep_default_na=False) for x in extra_sales]
    sales = pd.concat([sales, *extras], ignore_index=True).drop_duplicates("transaction_id", keep="last")
    return write_training_set(sales, master, workdir)
