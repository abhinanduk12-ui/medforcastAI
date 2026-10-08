"""POS billing API (/api/pos). Service logic lives in backend/pos.py.

Permission mapping (no new permissions exist, so POS actions map onto the shared matrix):
    catalog, barcode lookup, quote, invoice list/detail, day summary  -> view   (+ store scope)
    bill an invoice, customer return (credit note)                    -> sales.record (+ store scope)
    void (same day only)                                              -> sales.record AND (owner OR the billing user)
    map a barcode, edit GST presets/overrides and the shop profile    -> settings.edit (owner)

Personal data: users WITHOUT sales.record (buyers) see invoices with the customer's name, masked phone,
refill-patient id and Rx reference removed, and cannot search invoices by customer name.
"""
from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from backend import pos
from backend.auth import current_user, has_perm, require_perm, resolve_store, store_scope, store_scope_all
from backend.core import clean

router = APIRouter(prefix="/api/pos", tags=["pos"])


def _http(e: pos.PosError) -> HTTPException:
    return HTTPException(e.status, clean(e.detail) if isinstance(e.detail, dict) else e.detail)


class LineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    medicine_id: str = Field(min_length=1, max_length=32)
    qty: int = Field(ge=1, le=pos.MAX_LINE_QTY, strict=True)
    discount_pct: float = Field(0, ge=0, le=100, allow_inf_nan=False)


class CustomerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=20, description="Stored masked (last 4 digits only)")
    patient_id: int | None = Field(None, ge=1, description="Consented refill patient (refills feature)")


class PrescriberIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, max_length=120)
    reg_no: str | None = Field(None, max_length=60)
    rx_ref: str | None = Field(None, max_length=100)


class RegisterIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    patient_name: str | None = Field(None, max_length=120)
    patient_address: str | None = Field(None, max_length=300)
    prescriber_name: str | None = Field(None, max_length=120)
    prescriber_reg_no: str | None = Field(None, max_length=60)
    rx_ref: str | None = Field(None, max_length=100)


class QuoteBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    store_id: str | None = Field(None, max_length=32)
    lines: list[LineIn] = Field(min_length=1, max_length=pos.MAX_LINES)
    customer: CustomerIn | None = None
    prescriber: PrescriberIn | None = None
    register_details: RegisterIn | None = None


class InvoiceBody(QuoteBody):
    model_config = ConfigDict(extra="forbid")
    client_uuid: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    payment_mode: Literal["cash", "upi", "card", "credit"]
    offline_created_at: str | None = Field(None, max_length=40, description="When the bill was queued offline (client clock)")


class ReturnLine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line_id: int = Field(ge=1)
    qty: int = Field(ge=1, le=pos.MAX_LINE_QTY, strict=True)


class ReturnBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lines: list[ReturnLine] = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=3, max_length=300)


class VoidBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=3, max_length=300)


class BarcodeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    barcode: str = Field(min_length=8, max_length=14)
    medicine_id: str = Field(min_length=1, max_length=32)


class ShopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    legal_name: str | None = Field(None, max_length=200)
    gstin: str | None = Field(None, max_length=15)
    dl_numbers: str | None = Field(None, max_length=200)
    address: str | None = Field(None, max_length=300)
    phone: str | None = Field(None, max_length=40)
    footer: str | None = Field(None, max_length=300)


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preset: str | None = Field(None, max_length=32)
    overrides: dict[str, int | None] | None = Field(None, max_length=500)
    shop: ShopIn | None = None


PII_FIELDS = ("customer_name", "customer_phone_masked", "patient_id", "rx_ref")


def _sees_customers(user: dict) -> bool:
    return has_perm(user, "sales.record")


def _redact(row: dict, user: dict) -> dict:
    """Strip customer/patient identifiers for roles that do not bill (data minimisation)."""
    if not _sees_customers(user):
        for k in PII_FIELDS:
            if row.get(k) is not None:
                row[k] = None
                row["pii_redacted"] = True
    return row


def _body(b: BaseModel) -> dict:
    return b.model_dump(exclude_none=False)


def _invoice_for(user: dict, inv_id: int) -> dict:
    """Invoice row the user may see (404 for another store's invoice, to avoid leaking existence)."""
    try:
        r = pos.get_invoice_row(inv_id)
    except pos.PosError as e:
        raise _http(e)
    try:
        resolve_store(user, r["store_id"])
    except HTTPException as e:
        if e.status_code == 403:
            raise HTTPException(404, f"Invoice {inv_id} not found")
        raise
    return r


# ---------------------------------------------------------------------------------------------
# reads
# ---------------------------------------------------------------------------------------------
@router.get("/catalog")
def catalog(q: str = Query("", max_length=80), limit: int = Query(20, ge=1, le=60),
            in_stock: bool = Query(False), store_id: str = Depends(store_scope)):
    try:
        return clean({**pos.catalog(store_id, q, limit, in_stock), "store_id": store_id})
    except pos.PosError as e:
        raise _http(e)


@router.get("/barcode/{code}")
def barcode(code: str, store_id: str = Depends(store_scope)):
    if len(code) > 32:
        raise HTTPException(422, "Barcode too long")
    try:
        return clean(pos.item_by_barcode(store_id, code))
    except pos.PosError as e:
        raise _http(e)


@router.post("/quote")
def quote(body: QuoteBody, user: dict = Depends(current_user)):
    sid = resolve_store(user, body.store_id)
    try:
        return clean({**pos.quote(sid, _body(body), user), "store_id": sid})
    except pos.PosError as e:
        raise _http(e)


@router.get("/invoices")
def invoices(store_id: str | None = Depends(store_scope_all), user: dict = Depends(current_user),
             date_from: date | None = Query(None), date_to: date | None = Query(None),
             status: Literal["paid", "void", "partially_returned", "returned"] | None = Query(None),
             payment_mode: Literal["cash", "upi", "card", "credit"] | None = Query(None),
             q: str | None = Query(None, max_length=60),
             limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=1_000_000)):
    out = pos.list_invoices(store_id, date_from=date_from, date_to=date_to, status=status, q=q,
                            payment_mode=payment_mode, limit=limit, offset=offset,
                            search_customer=_sees_customers(user))
    out["items"] = [_redact(r, user) for r in out["items"]]
    return clean(out)


@router.get("/invoices/{inv_id}")
def invoice(inv_id: int, user: dict = Depends(current_user)):
    _invoice_for(user, inv_id)
    return clean(_redact(pos.get_invoice(inv_id), user))


@router.get("/day-summary")
def day_summary(day: date | None = Query(None, alias="date"), store_id: str = Depends(store_scope)):
    return clean(pos.day_summary(store_id, day))


@router.get("/settings")
def get_settings(user: dict = Depends(current_user)):
    return clean(pos.settings_payload())


# ---------------------------------------------------------------------------------------------
# writes
# ---------------------------------------------------------------------------------------------
@router.post("/invoices", status_code=201)
def create_invoice(body: InvoiceBody, response: Response, user: dict = Depends(require_perm("sales.record"))):
    sid = resolve_store(user, body.store_id)
    try:
        out, created = pos.create_invoice(user, sid, _body(body))
    except pos.PosError as e:
        raise _http(e)
    if not created:
        response.status_code = 200
    out["replayed"] = not created
    return clean(out)


@router.post("/invoices/{inv_id}/return", status_code=201)
def create_return(inv_id: int, body: ReturnBody, user: dict = Depends(require_perm("sales.record"))):
    _invoice_for(user, inv_id)
    try:
        return clean(pos.create_return(user, inv_id, [x.model_dump() for x in body.lines], body.reason))
    except pos.PosError as e:
        raise _http(e)


@router.post("/invoices/{inv_id}/void")
def void(inv_id: int, body: VoidBody, user: dict = Depends(require_perm("sales.record"))):
    _invoice_for(user, inv_id)
    try:
        return clean(pos.void_invoice(user, inv_id, body.reason))
    except pos.PosError as e:
        raise _http(e)


@router.post("/barcodes", status_code=201)
def map_barcode(body: BarcodeBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        return pos.map_barcode(body.barcode, body.medicine_id)
    except pos.PosError as e:
        raise _http(e)


@router.put("/settings")
def put_settings(body: SettingsBody, user: dict = Depends(require_perm("settings.edit"))):
    try:
        return clean(pos.update_settings(body.preset, body.overrides,
                                         body.shop.model_dump(exclude_unset=True) if body.shop else None))
    except pos.PosError as e:
        raise _http(e)
