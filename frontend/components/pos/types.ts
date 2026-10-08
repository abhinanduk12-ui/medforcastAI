export type Schedule = "OTC" | "H" | "H1" | "X" | "NDPS";
export type PaymentMode = "cash" | "upi" | "card" | "credit";
export const PAYMENT_MODES: PaymentMode[] = ["cash", "upi", "card", "credit"];
export const PAYMENT_LABEL: Record<PaymentMode, string> = { cash: "Cash", upi: "UPI", card: "Card", credit: "Credit" };

export type CatalogItem = {
  medicine_id: string; medicine_name: string; generic_name: string; category: string; form: string;
  mrp: number | null; gst_rate: number; hsn: string; schedule: Schedule; needs_prescription: boolean; needs_register: boolean;
  on_hand: number; earliest_expiry: string | null; n_batches: number; expired_qty: number; barcode: string | null;
};
export type CatalogResp = { items: CatalogItem[]; total: number; matched_by: "search" | "barcode"; notes: Record<string, string> };

export type CartLine = { item: CatalogItem; qty: number; discount_pct: number };

export type Allocation = { batch_id: number; batch_no: string; expiry_date: string; days_left: number; qty: number };
export type QuoteLine = {
  index: number; medicine_id: string; medicine_name: string; qty: number; mrp: number; discount_pct: number; gst_rate: number;
  hsn: string; allocation: Allocation[]; available: number; short: boolean;
  gross: number; discount: number; line_total: number; taxable: number; cgst: number; sgst: number;
};
export type Totals = { gross_total: number; discount_total: number; net_before_round: number; subtotal_taxable: number; cgst: number; sgst: number; round_off: number; total: number };
export type GstRow = { rate: number; taxable: number; cgst: number; sgst: number; total: number };
export type ComplianceLine = { index: number; medicine_id: string; medicine_name: string; schedule: Schedule; needs_register: boolean; missing: string[] };
export type QuoteResp = { lines: QuoteLine[]; totals: Totals; gst_breakup: GstRow[]; compliance: ComplianceLine[]; shortages: ({ index: number; medicine_id: string; requested: number; available: number } & SubsHint)[]; notes: Record<string, string> };

export type InvoiceLine = {
  id: number; line_no: number; medicine_id: string; medicine_name: string; schedule: Schedule; hsn: string; batch_id: number; batch_no: string;
  expiry_date: string; qty: number; qty_returned: number; returnable_qty: number; mrp: number; discount_pct: number; discount: number;
  gst_rate: number; taxable_value: number; cgst: number; sgst: number; line_total: number;
};
export type ReturnRec = {
  id: number; credit_note_no: string; reason: string; refund_total: number; amount: number; round_off: number; created_at: string; by: string | null;
  taxable?: number; cgst?: number; sgst?: number;
  lines: { id: number; line_id: number; qty: number; amount: number; disposition: "restocked" | "quarantined"; medicine_name: string; batch_no: string;
    gst_rate?: number; taxable?: number; cgst?: number; sgst?: number }[];
};
export type InvoiceStatus = "paid" | "void" | "partially_returned" | "returned";
export type Invoice = {
  id: number; store_id: string; invoice_no: string; fy: string; client_uuid: string; customer_name: string | null; customer_phone_masked: string | null;
  patient_id: number | null; prescriber_name: string | null; prescriber_reg_no: string | null; rx_ref: string | null;
  subtotal_taxable: number; cgst: number; sgst: number; gross_total: number; discount_total: number; round_off: number; total: number;
  payment_mode: PaymentMode; status: InvoiceStatus; user_id: number | null; created_at: string; created_at_ist: string; offline_created_at: string | null;
  void_reason: string | null; voided_at: string | null; voided_by_name: string | null; billed_by: string | null;
  lines: InvoiceLine[]; returns: ReturnRec[]; gst_breakup: GstRow[]; items: number; units: number; can_void_today: boolean;
  store: { id: string; name: string; city: string; simulated: boolean };
  shop: { legal_name: string | null; gstin: string | null; dl_numbers: string | null; address: string | null; phone: string | null; footer: string | null };
  notes: Record<string, string>; replayed?: boolean; warnings?: string[];
  /** set when the viewer's role cannot see customer / patient details (buyers) */
  pii_redacted?: boolean;
};
export type InvoiceListItem = {
  id: number; store_id: string; invoice_no: string; customer_name: string | null; customer_phone_masked: string | null; total: number;
  payment_mode: PaymentMode; status: InvoiceStatus; created_at: string; offline_created_at: string | null; items: number; units: number; billed_by: string | null;
  pii_redacted?: boolean;
};
export type InvoiceList = { items: InvoiceListItem[]; total: number; limit: number; offset: number };

export type DaySummary = {
  store: { id: string; name: string; simulated: boolean }; date: string; invoice_count: number; paid_count: number; void_count: number;
  first_invoice_no: string | null; last_invoice_no: string | null; gross_total: number; discount_total: number; round_off_total: number;
  sales_total: number; returns_total: number; net_total: number;
  by_payment_mode: { mode: PaymentMode; count: number; total: number; refunds: number; net: number }[];
  gst_sales: GstRow[]; gst_returns: GstRow[];
  returns: { credit_note_no: string; refund_total: number; reason: string; created_at: string }[];
  voids: { invoice_no: string; total: number; reason: string | null }[];
  notes: { gst: string; simulated: string | null };
};

export type RegisterDetails = { patient_name: string; patient_address: string; prescriber_name: string; prescriber_reg_no: string; rx_ref: string };

export type InvoicePayload = {
  client_uuid: string; store_id?: string | null; payment_mode: PaymentMode;
  lines: { medicine_id: string; qty: number; discount_pct: number }[];
  customer?: { name?: string | null; phone?: string | null } | null;
  prescriber?: { name?: string | null; reg_no?: string | null; rx_ref?: string | null } | null;
  register_details?: Partial<RegisterDetails> | null;
  offline_created_at?: string | null;
};

export type SubsHint = {
  substitutes: { medicine_id: string; medicine_name: string; tier: string; on_hand: number | null; price: number | null }[];
  transfer_hint: string | null; note: string | null;
};
export type OosDetail = SubsHint & {
  message: string; code: "insufficient_stock"; line_index: number; medicine_id: string; medicine_name: string; requested: number; available: number;
};
