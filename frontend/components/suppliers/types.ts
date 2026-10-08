export type Policy = { accepts_returns: boolean; min_days_before_expiry: number; credit_pct: number; source?: "supplier" | "default" };

export type Lead = {
  mean_days: number; p90_days: number; sd_days: number; n: number; sample_mean_days: number | null; sample_p90_days: number | null;
  default_days: number; weight_on_data: number; status: "default" | "learning" | "learned"; mean_weeks: number; p90_weeks: number;
  scope?: string | null;
};

export type Scorecard = {
  lead: Lead;
  lead_history: { po_no: string; received_on: string; days: number; on_time: boolean | null }[];
  on_time_pct: number | null; on_time_n: number;
  fill_rate: number | null; fill_n: number;
  price_index: number | null; price_n: number;
  open_pos: number; open_value: number; received_value: number;
};

export type Supplier = {
  id: string; name: string; gstin: string | null; contact: string | null; phone: string | null; email: string | null;
  default_lead_days: number; payment_terms: string | null; notes: string | null; active: boolean;
  return_policy: Policy; return_policy_override: Partial<Policy> | null; created_at: string; updated_at: string | null;
  scorecard?: Scorecard; preferred_medicines?: number;
};

export type SuppliersResp = {
  suppliers: Supplier[]; policy_default: Policy; notes: Record<string, string>; scope: string; history_ready: boolean;
  can: { edit: boolean; policy_default: boolean };
};

export type SupplierDetail = {
  supplier: Supplier; scorecard: Scorecard; medicines: { medicine_id: string; medicine_name: string; category: string; source: string; share: number | null; next4: number | null }[];
  medicine_count: number; pos: POSummary[]; po_counts: Record<POStatus, number>; notes: Record<string, string>; history_ready: boolean;
  can: { edit: boolean; policy_default: boolean };
};

export type POStatus = "draft" | "sent" | "partially_received" | "received" | "cancelled";

export type POSummary = {
  id: number; po_no: string; store_id: string; supplier_id: string; supplier_name: string | null; status: POStatus; source: string;
  created_at: string; sent_at: string | null; expected_at: string | null; closed_at: string | null; notes: string | null;
  total_value: number; n_lines: number; units_ordered: number; units_received: number; overdue: boolean;
};

export type POListResp = { counts: Record<POStatus, number>; items: POSummary[]; store_ids: string[] | null; can: { plan: boolean; receive: boolean } };

export type POLine = {
  id: number; po_id: number; medicine_id: string; medicine_name: string; generic_name: string | null; form: string | null;
  median_price: number | null; qty_ordered: number; qty_received: number; unit_cost: number; gst_rate: number; amount: number; outstanding: number;
};

/** PO detail (GET /po/{id}, create/edit/send/receive responses): no n_lines / supplier_name. */
export type PO = Omit<POSummary, "n_lines" | "supplier_name"> & {
  lines: POLine[]; subtotal: number; gst: number; grand_total: number;
  receipts: { id: number; line_id: number; medicine_id: string; batch_no: string; expiry_date: string; qty: number; unit_cost: number; received_at: string }[];
  events: { kind: string; detail: string | null; user_id: number | null; created_at: string }[];
};

export type PODetailResp = {
  po: PO; supplier: Supplier; store: { id: string; name: string; city: string | null; is_main: number | boolean };
  share_text: string; wa_link: string; lead: Lead & { supplier_id: string }; short_expiry_days: number;
  can: { plan: boolean; receive: boolean };
};

export type ImportGroup = { supplier_id: string; lines: { medicine_id: string; medicine_name: string; qty_ordered: number; unit_cost: number }[]; units: number; value: number };
export type ImportResp = {
  preview: boolean; groups?: ImportGroup[]; created?: { id: number; po_no: string; supplier_id: string; lines: number; total_value: number }[];
  skipped?: { supplier_id: string; lines: number; reason: string; existing?: string }[]; source: string; store_id: string; demand_scale: number; note: string;
};

export const STATUS_ORDER: POStatus[] = ["draft", "sent", "partially_received", "received", "cancelled"];
export const STATUS_LABEL: Record<POStatus, string> = {
  draft: "Draft", sent: "Sent", partially_received: "Partly received", received: "Received", cancelled: "Cancelled",
};
