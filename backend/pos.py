"""POS billing service: GST-inclusive invoices that write real FEFO sales into the stock ledger.

Money rules (documented, verify with your CA)
--------------------------------------------
* Indian retail medicine prices are MRP *inclusive* of GST. Per line (one line per FEFO batch allocation):
      gross       = MRP x qty
      discount    = round(gross x discount_pct / 100, 2)        (discount applies BEFORE tax extraction)
      line_total  = gross - discount                            (what the customer pays for the line)
      taxable     = round(line_total / (1 + rate/100), 2)
      cgst        = round((line_total - taxable) / 2, 2);  sgst = (line_total - taxable) - cgst
  CGST = SGST because sales are intra-state (Kerala). Inter-state (IGST) is out of scope.
* Invoice total = sum(line_total) rounded half-up to the nearest rupee; the difference is `round_off`.
* MRP: the catalogue has no printed-MRP field, so MRP is ASSUMED = the shop's median selling price
  per unit (S.meds.median_price), rounded to 2 decimals. Labelled in every API response.
* GST rates: a documented default table by category, with two presets and per-medicine overrides
  (settings key 'pos.gst'). India rationalised GST from 22 Sep 2025 (most medicines 12% -> 5%, some
  life-saving drugs -> nil); the default preset follows that, the pre-2025 table is available.
  Both are defaults only - verify every rate and HSN code with your CA.

Ledger rules
------------
* A sale calls inventory.sell (FEFO, never expired, never negative) inside one db.tx() together with
  the invoice, its lines, the statutory register entries and the optional refill dispense record.
* Customer return of non-expired stock: movement kind 'sale' with POSITIVE qty, ref 'RET-<invoice_no>',
  batches.qty_on_hand increased by the same amount (ledger invariant kept). Expired returned units are
  NOT put back into stock: they are recorded as quarantined on the credit note for destruction.
* Same-day void: kind 'sale', positive qty, ref 'VOID-<invoice_no>', back to the same batches.
* Numbers: <STORE>/<FY>/<000001> and CN/<STORE>/<FY>/<000001>; FY = Indian financial year (Apr-Mar,
  IST). The counter row is incremented inside the sale transaction, so a failed sale rolls it back
  (gap-free) and concurrent sales serialise on SQLite's write lock (unique).
"""
from __future__ import annotations

import logging
import re
import threading
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from backend import db
from backend import inventory as inv
from backend.core import S

log = logging.getLogger("medforecast.pos")

IST = timezone(timedelta(hours=5, minutes=30))
PAYMENT_MODES = ("cash", "upi", "card", "credit")
ALLOWED_RATES = (0, 5, 12, 18, 28)
MAX_LINES = 60
MAX_LINE_QTY = 10_000
CENT = Decimal("0.01")
ONE = Decimal("1")

MRP_NOTE = ("MRP is assumed to be the shop's median selling price per unit (the catalogue has no printed-MRP field). "
            "Check the pack MRP before billing.")
GST_NOTE = ("GST rates and HSN codes are defaults by category - verify every rate with your CA. "
            "Prices are treated as MRP inclusive of GST; CGST = SGST (intra-state, Kerala).")
REGISTER_NOTE = ("Schedule H1 / X / NDPS sales need a register entry (patient, address, prescriber, registration no.). "
                 "Classification is a conservative seed list - verify with your State Drugs Control authority.")
BARCODE_NOTE = ("Demo barcodes are generated EAN-13 codes with the India prefix 890; they are NOT GS1-registered. "
                "Map real pack barcodes in POS settings.")

# --------------------------------------------------------------------------------------------
# GST defaults
# --------------------------------------------------------------------------------------------
GST_PRESETS: dict[str, dict] = {
    "gst2025": {
        "label": "GST rationalisation from 22 Sep 2025 (default)",
        "default": 5,
        "categories": {"Antiseptic/Disinfectant": 18},
        "note": "Most medicines 5%. Specific life-saving drugs are nil-rated: set those per medicine (0%).",
    },
    "legacy2017": {
        "label": "Pre-Sep-2025 schedule (12% / 5% / 18%)",
        "default": 12,
        "categories": {
            "Vaccine/Immunological": 5, "Antiretroviral (ART Program)": 5, "Antineoplastic (Oncology)": 5,
            "Antitubercular": 5, "Antimalarial": 5, "Blood Product/Coagulation": 5, "Antidote/Emergency": 5,
            "Antiseptic/Disinfectant": 18,
        },
        "note": "Most medicines 12%, listed life-saving categories 5%, disinfectants 18%.",
    },
}
DEFAULT_PRESET = "gst2025"
HSN_BY_CATEGORY = {"Vaccine/Immunological": "3002", "Blood Product/Coagulation": "3002",
                   "Diagnostic/Contrast Agent": "3006", "Antiseptic/Disinfectant": "3808"}
DEFAULT_HSN = "3004"

SHOP_FIELDS = ("legal_name", "gstin", "dl_numbers", "address", "phone", "footer")

# --------------------------------------------------------------------------------------------
# Schema
# --------------------------------------------------------------------------------------------
db.register_schema("pos", [
    """
    CREATE TABLE IF NOT EXISTS pos_invoices (
        id INTEGER PRIMARY KEY,
        store_id TEXT NOT NULL REFERENCES stores(id),
        invoice_no TEXT NOT NULL,
        fy TEXT NOT NULL,
        client_uuid TEXT NOT NULL UNIQUE,
        customer_name TEXT,
        customer_phone_masked TEXT,
        patient_id INTEGER,
        prescriber_name TEXT,
        prescriber_reg_no TEXT,
        rx_ref TEXT,
        subtotal_taxable REAL NOT NULL,
        cgst REAL NOT NULL,
        sgst REAL NOT NULL,
        gross_total REAL NOT NULL,
        discount_total REAL NOT NULL,
        round_off REAL NOT NULL,
        total REAL NOT NULL,
        payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash','upi','card','credit')),
        status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void','partially_returned','returned')),
        user_id INTEGER,
        created_at TEXT NOT NULL,
        offline_created_at TEXT,
        void_reason TEXT,
        voided_by INTEGER,
        voided_at TEXT,
        UNIQUE (store_id, invoice_no)
    );
    CREATE INDEX IF NOT EXISTS ix_pos_invoices_store_date ON pos_invoices(store_id, created_at);
    CREATE TABLE IF NOT EXISTS pos_invoice_lines (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES pos_invoices(id),
        line_no INTEGER NOT NULL,
        medicine_id TEXT NOT NULL,
        medicine_name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        hsn TEXT NOT NULL,
        batch_id INTEGER NOT NULL REFERENCES batches(id),
        batch_no TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        qty INTEGER NOT NULL CHECK (qty > 0),
        qty_returned INTEGER NOT NULL DEFAULT 0 CHECK (qty_returned >= 0 AND qty_returned <= qty),
        mrp REAL NOT NULL,
        discount_pct REAL NOT NULL,
        discount REAL NOT NULL,
        gst_rate REAL NOT NULL,
        taxable_value REAL NOT NULL,
        cgst REAL NOT NULL,
        sgst REAL NOT NULL,
        line_total REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_pos_lines_invoice ON pos_invoice_lines(invoice_id);
    CREATE TABLE IF NOT EXISTS pos_barcodes (
        barcode TEXT PRIMARY KEY,
        medicine_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'demo',
        created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_pos_barcodes_med ON pos_barcodes(medicine_id);
    CREATE TABLE IF NOT EXISTS pos_sequences (
        store_id TEXT NOT NULL,
        fy TEXT NOT NULL,
        kind TEXT NOT NULL,
        last_no INTEGER NOT NULL,
        PRIMARY KEY (store_id, fy, kind)
    );
    CREATE TABLE IF NOT EXISTS pos_returns (
        id INTEGER PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES pos_invoices(id),
        store_id TEXT NOT NULL,
        credit_note_no TEXT NOT NULL,
        reason TEXT NOT NULL,
        taxable REAL NOT NULL,
        cgst REAL NOT NULL,
        sgst REAL NOT NULL,
        amount REAL NOT NULL,
        round_off REAL NOT NULL,
        refund_total REAL NOT NULL,
        user_id INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (store_id, credit_note_no)
    );
    CREATE INDEX IF NOT EXISTS ix_pos_returns_store_date ON pos_returns(store_id, created_at);
    CREATE TABLE IF NOT EXISTS pos_return_lines (
        id INTEGER PRIMARY KEY,
        return_id INTEGER NOT NULL REFERENCES pos_returns(id),
        line_id INTEGER NOT NULL REFERENCES pos_invoice_lines(id),
        qty INTEGER NOT NULL CHECK (qty > 0),
        gst_rate REAL NOT NULL,
        taxable REAL NOT NULL,
        cgst REAL NOT NULL,
        sgst REAL NOT NULL,
        amount REAL NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('restocked','quarantined'))
    );
    """,
])


class PosError(Exception):
    """Service error carrying an HTTP status and a JSON-able detail."""

    def __init__(self, status: int, detail: Any):
        super().__init__(detail if isinstance(detail, str) else detail.get("message", "POS error"))
        self.status = status
        self.detail = detail


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------
def D(x) -> Decimal:
    return Decimal(str(x))


def money(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def now_ist() -> datetime:
    return datetime.now(IST)


def ist_date(iso_utc: str) -> date:
    return datetime.fromisoformat(iso_utc).astimezone(IST).date()


def fy_of(d: date) -> str:
    """Indian financial year label (Apr-Mar): 2026-10-01 -> '2026-27', 2027-02-01 -> '2026-27'."""
    y = d.year if d.month >= 4 else d.year - 1
    return f"{y}-{(y + 1) % 100:02d}"


def day_bounds_utc(d: date) -> tuple[str, str]:
    """[start, end) of an IST calendar day as UTC ISO strings in db.now_iso() format."""
    start = datetime.combine(d, time(0, 0), IST).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    return start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")


def mask_phone(phone: str | None) -> str | None:
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if len(digits) < 6:
        return None
    return "X" * (len(digits) - 4) + digits[-4:]


def _next_no(store_id: str, fy: str, kind: str) -> int:
    """Next number of a per-store, per-FY sequence. Must run inside db.tx() (rolls back with it)."""
    assert db.in_tx(), "sequence numbers are only allocated inside the billing transaction"
    db.execute("INSERT INTO pos_sequences(store_id, fy, kind, last_no) VALUES (?,?,?,1) "
               "ON CONFLICT(store_id, fy, kind) DO UPDATE SET last_no = last_no + 1", (store_id, fy, kind))
    return int(db.scalar("SELECT last_no FROM pos_sequences WHERE store_id=? AND fy=? AND kind=?", (store_id, fy, kind)))


def invoice_number(store_id: str, fy: str, seq: int) -> str:
    return f"{store_id}/{fy}/{seq:06d}"


def credit_note_number(store_id: str, fy: str, seq: int) -> str:
    return f"CN/{store_id}/{fy}/{seq:06d}"


# --------------------------------------------------------------------------------------------
# catalogue facts: MRP, GST, HSN, schedule, barcodes
# --------------------------------------------------------------------------------------------
def med_row(mid: str):
    if mid not in S.meds.index:
        raise PosError(404, f"Unknown medicine '{mid}'")
    return S.meds.loc[mid]


def mrp_of(mid: str) -> Decimal:
    p = float(S.meds.at[mid, "median_price"])
    if not p == p or p <= 0:  # NaN or non-positive
        raise PosError(422, f"No price on record for {mid}; cannot bill it")
    return money(D(p))


def gst_config() -> dict:
    cfg = db.get_setting("pos.gst", None) or {}
    preset = cfg.get("preset") if cfg.get("preset") in GST_PRESETS else DEFAULT_PRESET
    overrides = {k: int(v) for k, v in (cfg.get("overrides") or {}).items()
                 if k in S.meds.index and isinstance(v, (int, float)) and int(v) in ALLOWED_RATES}
    return {"preset": preset, "overrides": overrides}


def gst_rate(mid: str, cfg: dict | None = None) -> int:
    cfg = cfg or gst_config()
    if mid in cfg["overrides"]:
        return cfg["overrides"][mid]
    p = GST_PRESETS[cfg["preset"]]
    return int(p["categories"].get(str(S.meds.at[mid, "category"]), p["default"]))


def hsn_of(mid: str) -> str:
    return HSN_BY_CATEGORY.get(str(S.meds.at[mid, "category"]), DEFAULT_HSN)


def schedule(mid: str) -> str:
    from backend import compliance
    return compliance.schedule_of(mid)


def shop_profile() -> dict:
    p = db.get_setting("pos.shop", None) or {}
    return {k: (str(p.get(k)) if p.get(k) else None) for k in SHOP_FIELDS}


def ean13_check(d12: str) -> int:
    s = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(d12))
    return (10 - s % 10) % 10


def valid_gtin(code: str) -> bool:
    """GS1 check digit for EAN-8 / UPC-A / EAN-13 / GTIN-14."""
    if not re.fullmatch(r"\d{8}|\d{12,14}", code):
        return False
    body, check = code[:-1], int(code[-1])
    s = sum(int(c) * (3 if i % 2 == 0 else 1) for i, c in enumerate(reversed(body)))
    return (10 - s % 10) % 10 == check


def demo_barcode(mid: str) -> str:
    """Deterministic EAN-13: 890 (India) + 4-digit demo company prefix + 5-digit item + check digit."""
    n = int(re.sub(r"\D", "", mid) or 0) % 100_000
    d12 = f"8907700{n:05d}"
    return d12 + str(ean13_check(d12))


_bc_lock = threading.Lock()
_bc_ready: set[str] = set()


def ensure_barcodes() -> None:
    """Seed demo barcodes for every catalogue medicine (idempotent, once per DB per process)."""
    key = str(db.db_path())
    if key in _bc_ready:
        return
    with _bc_lock:
        if key in _bc_ready:
            return
        have = int(db.scalar("SELECT COUNT(*) FROM pos_barcodes WHERE source='demo'", default=0) or 0)
        if have < len(S.meds):
            rows = [(demo_barcode(m), m, db.now_iso()) for m in S.meds.index]
            with db.tx():
                db.executemany("INSERT OR IGNORE INTO pos_barcodes(barcode, medicine_id, source, created_at) "
                               "VALUES (?,?,'demo',?)", rows)
        _bc_ready.add(key)


def barcode_lookup(code: str) -> str | None:
    ensure_barcodes()
    code = (code or "").strip()
    if not code or len(code) > 32:
        return None
    return db.scalar("SELECT medicine_id FROM pos_barcodes WHERE barcode = ?", (code,))


def barcodes_for(mids: list[str]) -> dict[str, str]:
    ensure_barcodes()
    if not mids:
        return {}
    out: dict[str, str] = {}
    for i in range(0, len(mids), 400):
        chunk = mids[i:i + 400]
        rows = db.query(f"SELECT barcode, medicine_id, source FROM pos_barcodes WHERE medicine_id IN "
                        f"({','.join('?' * len(chunk))}) ORDER BY CASE source WHEN 'demo' THEN 1 ELSE 0 END, barcode",
                        chunk)
        for r in rows:
            out.setdefault(r["medicine_id"], r["barcode"])
    return out


def map_barcode(code: str, mid: str) -> dict:
    code = (code or "").strip()
    if not valid_gtin(code):
        raise PosError(422, "Barcode must be a valid EAN-8 / UPC-A / EAN-13 / GTIN-14 (check digit verified)")
    med_row(mid)
    ensure_barcodes()
    with db.tx():
        db.execute("INSERT INTO pos_barcodes(barcode, medicine_id, source, created_at) VALUES (?,?,'manual',?) "
                   "ON CONFLICT(barcode) DO UPDATE SET medicine_id=excluded.medicine_id, source='manual', "
                   "created_at=excluded.created_at", (code, mid, db.now_iso()))
    return {"barcode": code, "medicine_id": mid}


# --------------------------------------------------------------------------------------------
# catalogue search
# --------------------------------------------------------------------------------------------
_search_cache: dict[str, Any] = {}


def _search_index() -> list[tuple[str, str, str, float]]:
    key = id(S.meds)
    if _search_cache.get("key") != key:
        rows = []
        for mid, r in S.meds.iterrows():
            rows.append((mid, str(r["medicine_name"]).lower(), str(r["generic_name"] or "").lower(),
                         float(r.get("total_units", 0) or 0)))
        _search_cache.update(key=key, rows=rows)
    return _search_cache["rows"]


def _item(mid: str, stock: dict, cfg: dict, barcode: str | None) -> dict:
    r = S.meds.loc[mid]
    st = stock.get(mid, {})
    sch = schedule(mid)
    return {
        "medicine_id": mid, "medicine_name": r["medicine_name"], "generic_name": r["generic_name"],
        "category": r["category"], "form": r["form"], "mrp": float(mrp_of(mid)) if float(r["median_price"]) > 0 else None,
        "gst_rate": gst_rate(mid, cfg), "hsn": hsn_of(mid), "schedule": sch,
        "needs_prescription": sch != "OTC", "needs_register": sch in ("H1", "X", "NDPS"),
        "on_hand": int(st.get("qty", 0)), "earliest_expiry": st.get("earliest_expiry"),
        "n_batches": int(st.get("n_batches", 0)), "expired_qty": int(st.get("expired_qty", 0)),
        "barcode": barcode,
    }


def _stock_map(store_id: str) -> dict:
    # Same rule as inventory.on_hand (sellable = expiry_date > today) but straight SQL on the IST business day:
    # this runs on every keystroke of the POS search, and the DataFrame round-trip cost 0.2-2 s under load.
    rows = db.query(
        "SELECT medicine_id, SUM(CASE WHEN expiry_date > :d THEN qty_on_hand ELSE 0 END) AS qty, "
        "MIN(CASE WHEN expiry_date > :d THEN expiry_date END) AS earliest_expiry, "
        "SUM(CASE WHEN expiry_date > :d THEN 1 ELSE 0 END) AS n_batches, "
        "SUM(CASE WHEN expiry_date <= :d THEN qty_on_hand ELSE 0 END) AS expired_qty "
        "FROM batches WHERE qty_on_hand > 0 AND store_id = :s GROUP BY medicine_id",
        {"d": now_ist().date().isoformat(), "s": store_id})
    return {r["medicine_id"]: {"qty": int(r["qty"] or 0), "earliest_expiry": r["earliest_expiry"],
                               "n_batches": int(r["n_batches"] or 0), "expired_qty": int(r["expired_qty"] or 0)}
            for r in rows}


def catalog(store_id: str, q: str = "", limit: int = 20, in_stock_only: bool = False) -> dict:
    q = (q or "").strip()
    stock = _stock_map(store_id)
    cfg = gst_config()
    matched_by = "search"
    mids: list[str] = []
    if q and re.fullmatch(r"\d{6,14}", q):
        m = barcode_lookup(q)
        if m:
            mids, matched_by = [m], "barcode"
    if not mids:
        toks = [t for t in re.split(r"\s+", q.lower()) if t][:6]
        scored = []
        for mid, name, gen, units in _search_index():
            hay = f"{name} {gen} {mid.lower()}"
            if toks and not all(t in hay for t in toks):
                continue
            qty = stock.get(mid, {}).get("qty", 0)
            if in_stock_only and qty <= 0:
                continue
            starts = 0 if (toks and (name.startswith(toks[0]) or gen.startswith(toks[0]))) else 1
            scored.append((starts, 0 if qty > 0 else 1, -units, name, mid))
        scored.sort()
        mids = [s[-1] for s in scored[:limit]]
        total = len(scored)
    else:
        total = 1
    bcs = barcodes_for(mids)
    return {"items": [_item(m, stock, cfg, bcs.get(m)) for m in mids], "total": total, "matched_by": matched_by,
            "notes": {"mrp": MRP_NOTE, "gst": GST_NOTE, "barcode": BARCODE_NOTE}}


def item_by_barcode(store_id: str, code: str) -> dict:
    mid = barcode_lookup(code)
    if not mid:
        raise PosError(404, f"Barcode {code} is not mapped to a medicine")
    return _item(mid, _stock_map(store_id), gst_config(), code)


# --------------------------------------------------------------------------------------------
# pricing
# --------------------------------------------------------------------------------------------
def price_part(mrp: Decimal, qty: int, discount_pct: Decimal, rate: int) -> dict:
    gross = money(mrp * qty)
    discount = money(gross * discount_pct / 100)
    line_total = gross - discount
    taxable = money(line_total / (ONE + D(rate) / 100))
    tax = line_total - taxable
    cgst = money(tax / 2)
    sgst = tax - cgst
    return {"gross": gross, "discount": discount, "line_total": line_total, "taxable": taxable,
            "cgst": cgst, "sgst": sgst}


def totals_of(parts: list[dict]) -> dict:
    gross = sum((p["gross"] for p in parts), Decimal("0"))
    disc = sum((p["discount"] for p in parts), Decimal("0"))
    lt = sum((p["line_total"] for p in parts), Decimal("0"))
    taxable = sum((p["taxable"] for p in parts), Decimal("0"))
    cgst = sum((p["cgst"] for p in parts), Decimal("0"))
    sgst = sum((p["sgst"] for p in parts), Decimal("0"))
    total = lt.quantize(ONE, rounding=ROUND_HALF_UP)
    return {"gross_total": gross, "discount_total": disc, "net_before_round": lt, "subtotal_taxable": taxable,
            "cgst": cgst, "sgst": sgst, "round_off": total - lt, "total": total}


def gst_breakup(parts: list[dict]) -> list[dict]:
    by: dict[float, dict] = {}
    for p in parts:
        b = by.setdefault(float(p["gst_rate"]), {"rate": float(p["gst_rate"]), "taxable": Decimal("0"),
                                                 "cgst": Decimal("0"), "sgst": Decimal("0"), "total": Decimal("0")})
        b["taxable"] += D(p["taxable"])
        b["cgst"] += D(p["cgst"])
        b["sgst"] += D(p["sgst"])
        b["total"] += D(p["line_total"])
    return [{k: (float(v) if isinstance(v, Decimal) else v) for k, v in b.items()} for _, b in sorted(by.items())]


def _f(d: dict) -> dict:
    return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in d.items()}


# --------------------------------------------------------------------------------------------
# compliance checks
# --------------------------------------------------------------------------------------------
REGISTER_REQUIRED = ("patient_name", "patient_address", "prescriber_name", "prescriber_reg_no")


def _clean_text(v, n: int) -> str | None:
    if v is None:
        return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    return s[:n] or None


def merged_register(body: dict) -> dict:
    """Register details, falling back to the invoice-level prescriber/customer fields."""
    reg = dict(body.get("register_details") or {})
    pres = body.get("prescriber") or {}
    cust = body.get("customer") or {}
    out = {
        "patient_name": _clean_text(reg.get("patient_name") or cust.get("name"), 120),
        "patient_address": _clean_text(reg.get("patient_address"), 300),
        "prescriber_name": _clean_text(reg.get("prescriber_name") or pres.get("name"), 120),
        "prescriber_reg_no": _clean_text(reg.get("prescriber_reg_no") or pres.get("reg_no"), 60),
        "rx_ref": _clean_text(reg.get("rx_ref") or pres.get("rx_ref"), 100),
    }
    return out


def compliance_needs(lines: list[dict], body: dict) -> list[dict]:
    """Per input line: schedule and which required fields are missing (empty list = OK)."""
    reg = merged_register(body)
    out = []
    for i, ln in enumerate(lines):
        sch = schedule(ln["medicine_id"])
        need: list[str] = []
        if sch in ("H1", "X", "NDPS"):
            need = [f for f in REGISTER_REQUIRED if not reg.get(f)]
        elif sch == "H" and not reg.get("prescriber_name"):
            need = ["prescriber_name"]
        out.append({"index": i, "medicine_id": ln["medicine_id"],
                    "medicine_name": str(S.meds.at[ln["medicine_id"], "medicine_name"]),
                    "schedule": sch, "needs_register": sch in ("H1", "X", "NDPS"), "missing": need})
    return out


# --------------------------------------------------------------------------------------------
# substitutes hint for out-of-stock lines
# --------------------------------------------------------------------------------------------
def substitutes_hint(store_id: str, mid: str, qty: int, user: dict | None) -> dict:
    try:
        from backend.routers.substitutes import substitutes_for
        r = substitutes_for(mid, store_id, max(1, qty), redact=bool(user and user.get("store_id")))
        cands = []
        for tier in ("exact", "same_molecule"):
            for c in r.get(tier, []):
                if (c.get("on_hand_here") or 0) > 0:
                    cands.append({"medicine_id": c.get("id"), "medicine_name": c.get("name"),
                                  "tier": tier, "on_hand": c.get("on_hand_here"), "price": c.get("price")})
        avail = (r.get("medicine") or {})
        return {"substitutes": cands[:4], "transfer_hint": avail.get("transfer_hint"),
                "note": "Exact = same molecule, strength and form. Same-molecule items need a pharmacist's dose review; "
                        "prescription items need the prescriber's agreement."}
    except Exception as e:  # pragma: no cover - feature module missing or failed: degrade gracefully
        log.info("substitutes unavailable: %s", e)
        try:
            from backend.routers.stock import substitutes_hint as sh
            return {"substitutes": [{"medicine_id": s["medicine_id"], "medicine_name": s["medicine_name"],
                                     "tier": "same_generic", "on_hand": s["on_hand"], "price": s.get("median_price")}
                                    for s in sh(store_id, mid, 4)],
                    "transfer_hint": None, "note": "Same generic name; a pharmacist must confirm equivalence."}
        except Exception:
            return {"substitutes": [], "transfer_hint": None, "note": None}


# --------------------------------------------------------------------------------------------
# quote (no writes)
# --------------------------------------------------------------------------------------------
def _validate_lines(lines: list[dict]) -> list[dict]:
    if not lines:
        raise PosError(422, "Add at least one item")
    if len(lines) > MAX_LINES:
        raise PosError(422, f"At most {MAX_LINES} items per invoice")
    out = []
    for i, ln in enumerate(lines):
        mid = str(ln.get("medicine_id") or "")
        if mid not in S.meds.index:
            raise PosError(422, {"message": f"Line {i + 1}: unknown medicine '{mid}'", "code": "unknown_medicine",
                                 "line_index": i})
        qty = ln.get("qty")
        if isinstance(qty, bool) or not isinstance(qty, int) or not 1 <= qty <= MAX_LINE_QTY:
            raise PosError(422, f"Line {i + 1}: qty must be a whole number 1..{MAX_LINE_QTY}")
        disc = D(ln.get("discount_pct") or 0)
        if not (Decimal("0") <= disc <= Decimal("100")):
            raise PosError(422, f"Line {i + 1}: discount_pct must be 0..100")
        out.append({"medicine_id": mid, "qty": qty, "discount_pct": money(disc)})
    return out


def quote(store_id: str, body: dict, user: dict | None = None) -> dict:
    """Price a cart with the FEFO batches it WOULD take, without writing anything."""
    lines = _validate_lines(body.get("lines") or [])
    cfg = gst_config()
    as_of = now_ist().date()  # IST business day: same 'expired' rule as returns/voids
    used: dict[int, int] = {}
    out_lines, parts, shortages = [], [], []
    for i, ln in enumerate(lines):
        mid = ln["medicine_id"]
        mrp, rate = mrp_of(mid), gst_rate(mid, cfg)
        sellable = [b for b in inv.batches(store_id, mid, as_of=as_of) if not b["expired"]]
        avail = sum(b["qty_on_hand"] - used.get(b["id"], 0) for b in sellable)
        alloc, need = [], ln["qty"]
        for b in sellable:
            free = b["qty_on_hand"] - used.get(b["id"], 0)
            if need <= 0 or free <= 0:
                continue
            t = min(need, free)
            used[b["id"]] = used.get(b["id"], 0) + t
            alloc.append({"batch_id": b["id"], "batch_no": b["batch_no"], "expiry_date": b["expiry_date"],
                          "days_left": b["days_left"], "qty": t})
            need -= t
        p = price_part(mrp, ln["qty"], ln["discount_pct"], rate)
        parts.append({**p, "gst_rate": rate})
        if need > 0:
            shortages.append({"index": i, "medicine_id": mid, "requested": ln["qty"], "available": max(0, avail),
                              **substitutes_hint(store_id, mid, ln["qty"], user)})
        out_lines.append({"index": i, "medicine_id": mid, "medicine_name": str(S.meds.at[mid, "medicine_name"]),
                          "qty": ln["qty"], "mrp": float(mrp), "discount_pct": float(ln["discount_pct"]),
                          "gst_rate": rate, "hsn": hsn_of(mid), "allocation": alloc, "available": max(0, avail),
                          "short": need > 0, **_f(p)})
    return {"lines": out_lines, "totals": _f(totals_of(parts)), "gst_breakup": gst_breakup(parts),
            "compliance": compliance_needs(lines, body), "shortages": shortages,
            "notes": {"mrp": MRP_NOTE, "gst": GST_NOTE, "register": REGISTER_NOTE}}


# --------------------------------------------------------------------------------------------
# create invoice
# --------------------------------------------------------------------------------------------
def _existing(client_uuid: str) -> dict | None:
    return db.query_one("SELECT id, store_id FROM pos_invoices WHERE client_uuid = ?", (client_uuid,))


def create_invoice(user: dict, store_id: str, body: dict) -> tuple[dict, bool]:
    """Bill a cart. Returns (invoice, created). Same client_uuid -> (existing invoice, False), no re-sale."""
    cu = str(body.get("client_uuid") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", cu):
        raise PosError(422, "client_uuid must be 8-64 letters, digits or dashes (generate one per sale)")
    prev = _existing(cu)
    if prev:
        if prev["store_id"] != store_id:
            raise PosError(409, "This client_uuid was already used for an invoice in another store")
        return get_invoice(prev["id"]), False
    mode = body.get("payment_mode")
    if mode not in PAYMENT_MODES:
        raise PosError(422, f"payment_mode must be one of {', '.join(PAYMENT_MODES)}")
    lines = _validate_lines(body.get("lines") or [])
    needs = compliance_needs(lines, body)
    missing = [n for n in needs if n["missing"]]
    if missing:
        raise PosError(422, {"message": "Prescription / register details are required for some items",
                             "code": "compliance", "lines": missing,
                             "register_fields": list(REGISTER_REQUIRED) + ["rx_ref"], "note": REGISTER_NOTE})
    reg = merged_register(body)
    cust = body.get("customer") or {}
    cust_name = _clean_text(cust.get("name"), 120)
    phone_masked = mask_phone(cust.get("phone"))
    patient_id = cust.get("patient_id")
    offline_at = _clean_text(body.get("offline_created_at"), 40)
    if offline_at:
        try:
            datetime.fromisoformat(offline_at.replace("Z", "+00:00"))
        except ValueError:
            raise PosError(422, "offline_created_at must be an ISO date-time")
    warnings: list[str] = []
    cfg = gst_config()
    uid = user.get("id")
    today = now_ist().date()
    fy = fy_of(today)
    try:
        with db.tx():
            prev = _existing(cu)  # re-check under the write lock (two tabs / an offline resync racing)
            if prev:
                if prev["store_id"] != store_id:
                    raise PosError(409, "This client_uuid was already used for an invoice in another store")
                inv_id, created = prev["id"], False
            else:
                inv_no = invoice_number(store_id, fy, _next_no(store_id, fy, "INV"))
                ts = db.now_iso()
                rows, parts = [], []
                for i, ln in enumerate(lines):
                    mid = ln["medicine_id"]
                    try:
                        alloc = inv.sell(store_id, mid, ln["qty"], uid, ref=inv_no, as_of=today)
                    except inv.InsufficientStock as e:
                        raise PosError(409, {"message": str(e), "code": "insufficient_stock", "line_index": i,
                                             "medicine_id": mid, "medicine_name": str(S.meds.at[mid, "medicine_name"]),
                                             "requested": ln["qty"], "available": e.available})
                    mrp, rate = mrp_of(mid), gst_rate(mid, cfg)
                    for a in alloc:
                        p = price_part(mrp, a.qty, ln["discount_pct"], rate)
                        parts.append({**p, "gst_rate": rate})
                        rows.append((mid, a, mrp, ln["discount_pct"], rate, p))
                t = totals_of(parts)
                inv_id = db.execute(
                    "INSERT INTO pos_invoices(store_id, invoice_no, fy, client_uuid, customer_name, customer_phone_masked, "
                    "patient_id, prescriber_name, prescriber_reg_no, rx_ref, subtotal_taxable, cgst, sgst, gross_total, "
                    "discount_total, round_off, total, payment_mode, status, user_id, created_at, offline_created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'paid',?,?,?)",
                    (store_id, inv_no, fy, cu, cust_name, phone_masked, None, reg["prescriber_name"],
                     reg["prescriber_reg_no"], reg["rx_ref"], float(t["subtotal_taxable"]), float(t["cgst"]),
                     float(t["sgst"]), float(t["gross_total"]), float(t["discount_total"]), float(t["round_off"]),
                     float(t["total"]), mode, uid, ts, offline_at)).lastrowid
                reg_entries = []
                for n, (mid, a, mrp, disc, rate, p) in enumerate(rows, start=1):
                    sch = schedule(mid)
                    db.execute(
                        "INSERT INTO pos_invoice_lines(invoice_id, line_no, medicine_id, medicine_name, schedule, hsn, "
                        "batch_id, batch_no, expiry_date, qty, mrp, discount_pct, discount, gst_rate, taxable_value, cgst, "
                        "sgst, line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (inv_id, n, mid, str(S.meds.at[mid, "medicine_name"]), sch, hsn_of(mid), a.batch_id, a.batch_no,
                         a.expiry, a.qty, float(mrp), float(disc), float(p["discount"]), rate, float(p["taxable"]),
                         float(p["cgst"]), float(p["sgst"]), float(p["line_total"])))
                    if sch in ("H1", "X", "NDPS"):
                        reg_entries.append({"store_id": store_id, "invoice_no": inv_no, "medicine_id": mid,
                                            "batch_no": a.batch_no, "qty": a.qty, **reg, "sold_by": uid, "sold_at": ts})
                if reg_entries:
                    from backend import compliance
                    try:
                        compliance.record_register_entries(reg_entries)
                    except ValueError as e:
                        raise PosError(422, {"message": str(e), "code": "compliance"})
                if patient_id is not None:
                    _attach_patient(inv_id, patient_id, lines, store_id, inv_no, uid, warnings)
                created = True
    except inv.InventoryError as e:
        raise PosError(getattr(e, "status", 400), str(e))
    except PosError as e:
        if isinstance(e.detail, dict) and e.detail.get("code") == "insufficient_stock":
            e.detail.update(substitutes_hint(store_id, e.detail["medicine_id"], e.detail["requested"], user))
        raise
    out = get_invoice(inv_id)
    if warnings:
        out["warnings"] = warnings
    return out, created


def _attach_patient(inv_id: int, patient_id, lines: list[dict], store_id: str, inv_no: str, uid, warnings: list[str]) -> None:
    """Record refill dispenses for a consented patient (refills module optional)."""
    try:
        pid = int(patient_id)
    except (TypeError, ValueError):
        raise PosError(422, "patient_id must be a number")
    try:
        from backend import patients  # type: ignore[attr-defined]
    except ImportError:
        warnings.append("Refill tracking is not installed yet: the patient was not linked to this invoice.")
        return
    qty_by: dict[str, int] = {}
    for ln in lines:
        qty_by[ln["medicine_id"]] = qty_by.get(ln["medicine_id"], 0) + ln["qty"]
    try:
        with db.tx():  # savepoint: an unexpected refill failure must not leave half-written rows
            for mid, q in qty_by.items():
                patients.record_dispense(pid, mid, q, store_id, inv_no, user_id=uid)
            db.execute("UPDATE pos_invoices SET patient_id = ? WHERE id = ?", (pid, inv_id))
    except ValueError as e:
        raise PosError(422, {"message": f"Patient not linked: {e}", "code": "consent"})
    except Exception as e:  # pragma: no cover - never block a sale on the refills feature
        log.warning("refill dispense failed for invoice %s: %s", inv_no, e)
        warnings.append("Refill tracking failed for this invoice; the sale itself is recorded.")


# --------------------------------------------------------------------------------------------
# reads
# --------------------------------------------------------------------------------------------
def _user_names(ids: set) -> dict:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = db.query(f"SELECT id, username, full_name FROM users WHERE id IN ({','.join('?' * len(ids))})", list(ids))
    return {r["id"]: (r["full_name"] or r["username"]) for r in rows}


def get_invoice_row(inv_id: int) -> dict:
    r = db.query_one("SELECT * FROM pos_invoices WHERE id = ?", (inv_id,))
    if r is None:
        raise PosError(404, f"Invoice {inv_id} not found")
    return r


def get_invoice(inv_id: int) -> dict:
    r = get_invoice_row(inv_id)
    lines = db.query("SELECT * FROM pos_invoice_lines WHERE invoice_id = ? ORDER BY line_no", (inv_id,))
    rets = db.query("SELECT * FROM pos_returns WHERE invoice_id = ? ORDER BY id", (inv_id,))
    for rt in rets:
        rt["lines"] = db.query("SELECT rl.*, l.medicine_name, l.batch_no FROM pos_return_lines rl "
                               "JOIN pos_invoice_lines l ON l.id = rl.line_id WHERE rl.return_id = ? ORDER BY rl.id",
                               (rt["id"],))
    names = _user_names({r["user_id"], r["voided_by"], *[x["user_id"] for x in rets]})
    for ln in lines:
        ln["returnable_qty"] = ln["qty"] - ln["qty_returned"]
    store = inv.get_store(r["store_id"])
    created_ist = datetime.fromisoformat(r["created_at"]).astimezone(IST)
    r.update({
        "lines": lines, "returns": rets, "billed_by": names.get(r["user_id"]), "voided_by_name": names.get(r["voided_by"]),
        "gst_breakup": gst_breakup([{"gst_rate": ln["gst_rate"], "taxable": ln["taxable_value"], "cgst": ln["cgst"],
                                     "sgst": ln["sgst"], "line_total": ln["line_total"]} for ln in lines]),
        "items": len({ln["medicine_id"] for ln in lines}), "units": sum(ln["qty"] for ln in lines),
        "created_at_ist": created_ist.isoformat(timespec="seconds"),
        "can_void_today": r["status"] == "paid" and created_ist.date() == now_ist().date(),
        "store": {"id": store["id"], "name": store["name"], "city": store["city"], "simulated": store["simulated"]},
        "shop": shop_profile(),
        "notes": {"mrp": MRP_NOTE, "gst": GST_NOTE},
    })
    for rt in rets:
        rt["by"] = names.get(rt["user_id"])
    return r


def list_invoices(store_id: str | None, *, date_from: date | None = None, date_to: date | None = None,
                  status: str | None = None, q: str | None = None, payment_mode: str | None = None,
                  limit: int = 50, offset: int = 0, search_customer: bool = True) -> dict:
    where, params = [], []
    if store_id:
        where.append("i.store_id = ?")
        params.append(store_id)
    if date_from:
        where.append("i.created_at >= ?")
        params.append(day_bounds_utc(date_from)[0])
    if date_to:
        where.append("i.created_at < ?")
        params.append(day_bounds_utc(date_to)[1])
    if status:
        where.append("i.status = ?")
        params.append(status)
    if payment_mode:
        where.append("i.payment_mode = ?")
        params.append(payment_mode)
    if q:
        like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        if search_customer:
            where.append("(i.invoice_no LIKE ? ESCAPE '\\' OR i.customer_name LIKE ? ESCAPE '\\')")
            params += [like, like]
        else:  # roles without billing rights may not look customers up by name
            where.append("i.invoice_no LIKE ? ESCAPE '\\'")
            params.append(like)
    w = (" WHERE " + " AND ".join(where)) if where else ""
    total = int(db.scalar(f"SELECT COUNT(*) FROM pos_invoices i{w}", params, 0))
    rows = db.query(
        f"SELECT i.id, i.store_id, i.invoice_no, i.customer_name, i.customer_phone_masked, i.total, i.payment_mode, "
        f"i.status, i.user_id, i.created_at, i.offline_created_at, "
        f"(SELECT COUNT(DISTINCT medicine_id) FROM pos_invoice_lines l WHERE l.invoice_id = i.id) AS items, "
        f"(SELECT COALESCE(SUM(qty),0) FROM pos_invoice_lines l WHERE l.invoice_id = i.id) AS units "
        f"FROM pos_invoices i{w} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?", params + [limit, offset])
    names = _user_names({r["user_id"] for r in rows})
    for r in rows:
        r["billed_by"] = names.get(r["user_id"])
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


# --------------------------------------------------------------------------------------------
# returns & void
# --------------------------------------------------------------------------------------------
def create_return(user: dict, inv_id: int, req_lines: list[dict], reason: str) -> dict:
    reason = _clean_text(reason, 300) or ""
    if len(reason) < 3:
        raise PosError(422, "A reason is required for a return (min 3 characters)")
    if not req_lines:
        raise PosError(422, "Select at least one line to return")
    uid = user.get("id")
    today = now_ist().date()
    with db.tx():
        r = get_invoice_row(inv_id)
        if r["status"] in ("void", "returned"):
            raise PosError(409, f"Invoice {r['invoice_no']} is {r['status']}; nothing can be returned")
        store_id = r["store_id"]
        lines = {ln["id"]: ln for ln in db.query("SELECT * FROM pos_invoice_lines WHERE invoice_id = ?", (inv_id,))}
        want: dict[int, int] = {}
        for x in req_lines:
            lid, q = x.get("line_id"), x.get("qty")
            if lid not in lines:
                raise PosError(422, f"Line {lid} is not part of invoice {r['invoice_no']}")
            if isinstance(q, bool) or not isinstance(q, int) or q < 1:
                raise PosError(422, "Return qty must be a whole number >= 1")
            want[lid] = want.get(lid, 0) + q
        for lid, q in want.items():
            left = lines[lid]["qty"] - lines[lid]["qty_returned"]
            if q > left:
                raise PosError(409, f"Only {left} unit(s) of {lines[lid]['medicine_name']} (batch {lines[lid]['batch_no']}) "
                                    f"can still be returned")
        cn_no = credit_note_number(store_id, fy_of(today), _next_no(store_id, fy_of(today), "CN"))
        ts = db.now_iso()
        parts, out_lines = [], []
        for lid, q in want.items():
            ln = lines[lid]
            p = price_part(D(ln["mrp"]), q, D(ln["discount_pct"]), int(ln["gst_rate"]))
            if q == ln["qty"] - ln["qty_returned"]:
                # last units of the line: credit exactly what was charged minus earlier credits (no paisa drift)
                done = db.query_one("SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(taxable),0) t, COALESCE(SUM(cgst),0) c, "
                                    "COALESCE(SUM(sgst),0) s FROM pos_return_lines WHERE line_id = ?", (lid,))
                p = {**p, "line_total": money(D(ln["line_total"]) - D(done["a"])),
                     "taxable": money(D(ln["taxable_value"]) - D(done["t"])),
                     "cgst": money(D(ln["cgst"]) - D(done["c"])), "sgst": money(D(ln["sgst"]) - D(done["s"]))}
            b = db.query_one("SELECT * FROM batches WHERE id = ?", (ln["batch_id"],))
            expired = b is None or b["expiry_date"] <= today.isoformat()
            disposition = "quarantined" if expired else "restocked"
            if not expired:
                db.execute("UPDATE batches SET qty_on_hand = qty_on_hand + ? WHERE id = ?", (q, b["id"]))
                db.execute("INSERT INTO movements(store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, "
                           "created_at) VALUES (?,?,?,'sale',?,?,?,?,?,?)",
                           (store_id, ln["medicine_id"], b["id"], q, b["unit_cost"], f"RET-{r['invoice_no']}"[:100],
                            f"Customer return {cn_no}: {reason}"[:500], uid, ts))
            db.execute("UPDATE pos_invoice_lines SET qty_returned = qty_returned + ? WHERE id = ?", (q, lid))
            parts.append({**p, "gst_rate": ln["gst_rate"]})
            out_lines.append((lid, q, ln["gst_rate"], p, disposition))
        t = totals_of(parts)
        left = db.scalar("SELECT COALESCE(SUM(qty - qty_returned), 0) FROM pos_invoice_lines WHERE invoice_id = ?", (inv_id,), 0)
        # Round the CUMULATIVE credited amount, not each credit note on its own: rounding every note half-up
        # let unit-by-unit returns refund more than the customer paid (3 x 39.67 -> 40+40+40 = 120 vs 119 paid).
        prev = db.query_one("SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(refund_total),0) r FROM pos_returns "
                            "WHERE invoice_id = ?", (inv_id,))
        prev_amt, prev_ref, paid = money(D(prev["a"])), money(D(prev["r"])), money(D(r["total"]))
        if left == 0:
            refund = paid - prev_ref  # fully returned: exactly what was paid, in total
        else:
            refund = min((prev_amt + t["net_before_round"]).quantize(ONE, rounding=ROUND_HALF_UP) - prev_ref,
                         paid - prev_ref)
        refund = max(refund, Decimal("0"))
        t = {**t, "total": refund, "round_off": refund - t["net_before_round"]}
        rid = db.execute("INSERT INTO pos_returns(invoice_id, store_id, credit_note_no, reason, taxable, cgst, sgst, amount, "
                         "round_off, refund_total, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (inv_id, store_id, cn_no, reason, float(t["subtotal_taxable"]), float(t["cgst"]), float(t["sgst"]),
                          float(t["net_before_round"]), float(t["round_off"]), float(t["total"]), uid, ts)).lastrowid
        for lid, q, rate, p, disp in out_lines:
            db.execute("INSERT INTO pos_return_lines(return_id, line_id, qty, gst_rate, taxable, cgst, sgst, amount, disposition) "
                       "VALUES (?,?,?,?,?,?,?,?,?)", (rid, lid, q, rate, float(p["taxable"]), float(p["cgst"]),
                                                      float(p["sgst"]), float(p["line_total"]), disp))
        db.execute("UPDATE pos_invoices SET status = ? WHERE id = ?", ("returned" if left == 0 else "partially_returned", inv_id))
    quarantined = sum(q for _, q, _, _, d in out_lines if d == "quarantined")
    return {"credit_note_no": cn_no, "return_id": rid, "refund_total": float(t["total"]),
            "amount": float(t["net_before_round"]), "round_off": float(t["round_off"]),
            "quarantined_units": quarantined,
            "note": ("Expired units were NOT returned to stock: keep them in quarantine for destruction / write-off."
                     if quarantined else None),
            "invoice": get_invoice(inv_id)}


def void_invoice(user: dict, inv_id: int, reason: str) -> dict:
    reason = _clean_text(reason, 300) or ""
    if len(reason) < 3:
        raise PosError(422, "A reason is required to void an invoice (min 3 characters)")
    uid = user.get("id")
    with db.tx():
        r = get_invoice_row(inv_id)
        if user.get("role") != "owner" and (uid is None or r["user_id"] != uid):
            raise PosError(403, "Only the owner or the pharmacist who billed it can void this invoice")
        if r["status"] != "paid":
            raise PosError(409, f"Invoice {r['invoice_no']} is {r['status']}; only an unreturned, paid invoice can be voided "
                                "(use a return instead)")
        if ist_date(r["created_at"]) != now_ist().date():
            raise PosError(409, "Only same-day invoices can be voided; use a customer return (credit note) instead")
        ts = db.now_iso()
        for ln in db.query("SELECT * FROM pos_invoice_lines WHERE invoice_id = ?", (inv_id,)):
            b = db.query_one("SELECT * FROM batches WHERE id = ?", (ln["batch_id"],))
            if b is None:  # pragma: no cover - batches are never deleted
                raise PosError(409, f"Batch {ln['batch_no']} no longer exists; cannot void")
            db.execute("UPDATE batches SET qty_on_hand = qty_on_hand + ? WHERE id = ?", (ln["qty"], b["id"]))
            db.execute("INSERT INTO movements(store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, "
                       "created_at) VALUES (?,?,?,'sale',?,?,?,?,?,?)",
                       (r["store_id"], ln["medicine_id"], b["id"], ln["qty"], b["unit_cost"], f"VOID-{r['invoice_no']}"[:100],
                        f"Invoice void: {reason}"[:500], uid, ts))
        db.execute("UPDATE pos_invoices SET status='void', void_reason=?, voided_by=?, voided_at=? WHERE id=?",
                   (reason, uid, ts, inv_id))
    return get_invoice(inv_id)


# --------------------------------------------------------------------------------------------
# day summary (Z report)
# --------------------------------------------------------------------------------------------
def day_summary(store_id: str, day: date | None = None) -> dict:
    day = day or now_ist().date()
    lo, hi = day_bounds_utc(day)
    invs = db.query("SELECT * FROM pos_invoices WHERE store_id = ? AND created_at >= ? AND created_at < ? "
                    "ORDER BY id", (store_id, lo, hi))
    live = [i for i in invs if i["status"] != "void"]
    by_mode = {m: {"mode": m, "count": 0, "total": 0.0} for m in PAYMENT_MODES}
    for i in live:
        by_mode[i["payment_mode"]]["count"] += 1
        by_mode[i["payment_mode"]]["total"] += i["total"]
    ids = [i["id"] for i in live]
    lines = db.query(f"SELECT gst_rate, taxable_value AS taxable, cgst, sgst, line_total FROM pos_invoice_lines "
                     f"WHERE invoice_id IN ({','.join('?' * len(ids))})", ids) if ids else []
    rets = db.query("SELECT * FROM pos_returns WHERE store_id = ? AND created_at >= ? AND created_at < ? ORDER BY id",
                    (store_id, lo, hi))
    rids = [x["id"] for x in rets]
    rlines = db.query(f"SELECT gst_rate, taxable, cgst, sgst, amount AS line_total FROM pos_return_lines "
                      f"WHERE return_id IN ({','.join('?' * len(rids))})", rids) if rids else []
    sales_total = round(sum(i["total"] for i in live), 2)
    refunds = round(sum(x["refund_total"] for x in rets), 2)
    # refunds by original payment mode (cash drawer reconciliation)
    if rets:
        modes = {r["id"]: r["payment_mode"] for r in db.query(
            f"SELECT id, payment_mode FROM pos_invoices WHERE id IN ({','.join('?' * len(rets))})",
            [x["invoice_id"] for x in rets])}
        for x in rets:
            by_mode[modes[x["invoice_id"]]].setdefault("refunds", 0.0)
            by_mode[modes[x["invoice_id"]]]["refunds"] += x["refund_total"]
    for m in by_mode.values():
        m.setdefault("refunds", 0.0)
        m["total"] = round(m["total"], 2)
        m["refunds"] = round(m["refunds"], 2)
        m["net"] = round(m["total"] - m["refunds"], 2)
    st = inv.get_store(store_id)
    return {
        "store": {"id": st["id"], "name": st["name"], "simulated": st["simulated"]}, "date": day.isoformat(),
        "invoice_count": len(invs), "paid_count": len(live), "void_count": len(invs) - len(live),
        "first_invoice_no": invs[0]["invoice_no"] if invs else None,
        "last_invoice_no": invs[-1]["invoice_no"] if invs else None,
        "gross_total": round(sum(i["gross_total"] for i in live), 2),
        "discount_total": round(sum(i["discount_total"] for i in live), 2),
        "round_off_total": round(sum(i["round_off"] for i in live), 2),
        "sales_total": sales_total, "returns_total": refunds, "net_total": round(sales_total - refunds, 2),
        "by_payment_mode": list(by_mode.values()),
        "gst_sales": gst_breakup(lines), "gst_returns": gst_breakup(rlines),
        "returns": [{"credit_note_no": x["credit_note_no"], "refund_total": x["refund_total"], "reason": x["reason"],
                     "created_at": x["created_at"]} for x in rets],
        "voids": [{"invoice_no": i["invoice_no"], "total": i["total"], "reason": i["void_reason"]}
                  for i in invs if i["status"] == "void"],
        "notes": {"gst": GST_NOTE, "simulated": "Simulated branch: its stock is simulated, but bills here are real records."
                  if st["simulated"] else None},
    }


# --------------------------------------------------------------------------------------------
# settings
# --------------------------------------------------------------------------------------------
def settings_payload() -> dict:
    cfg = gst_config()
    return {"gst": {"preset": cfg["preset"], "overrides": cfg["overrides"],
                    "presets": {k: {"label": v["label"], "default": v["default"], "categories": v["categories"],
                                    "note": v["note"]} for k, v in GST_PRESETS.items()},
                    "allowed_rates": list(ALLOWED_RATES), "hsn_by_category": HSN_BY_CATEGORY, "default_hsn": DEFAULT_HSN},
            "shop": shop_profile(), "payment_modes": list(PAYMENT_MODES),
            "notes": {"gst": GST_NOTE, "mrp": MRP_NOTE, "register": REGISTER_NOTE, "barcode": BARCODE_NOTE}}


def update_settings(preset: str | None, overrides: dict | None, shop: dict | None) -> dict:
    with db.tx():
        if preset is not None or overrides is not None:
            cfg = gst_config()
            if preset is not None:
                if preset not in GST_PRESETS:
                    raise PosError(422, f"Unknown GST preset '{preset}'")
                cfg["preset"] = preset
            if overrides is not None:
                clean_o = {}
                for k, v in overrides.items():
                    if k not in S.meds.index:
                        raise PosError(422, f"Unknown medicine '{k}' in overrides")
                    if v is None:
                        continue
                    if int(v) not in ALLOWED_RATES or int(v) != v:
                        raise PosError(422, f"GST rate for {k} must be one of {ALLOWED_RATES}")
                    clean_o[k] = int(v)
                cfg["overrides"] = clean_o
            db.set_setting("pos.gst", cfg)
        if shop is not None:
            cur = shop_profile()
            for k in SHOP_FIELDS:
                if k in shop:
                    cur[k] = _clean_text(shop[k], 300)
            if cur.get("gstin") and not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", cur["gstin"].upper()):
                raise PosError(422, "GSTIN must be 15 characters (e.g. 32ABCDE1234F1Z5)")
            if cur.get("gstin"):
                cur["gstin"] = cur["gstin"].upper()
            db.set_setting("pos.shop", cur)
    return settings_payload()
