/** Shapes returned by backend/routers/stores.py (/api/stores/*). */
import { C } from "@/components/charts";

/** Fixed colour per branch by its position in the full store directory (main first), never by rank or by
 *  the viewer's scope, so a branch keeps the same colour in every chart and for every role. */
export const STORE_COLORS = [C.s1, C.s2, C.s3, C.s4, C.s5];
export const storeColor = (id: string, order: string[]) =>
  STORE_COLORS[Math.max(0, order.indexOf(id)) % STORE_COLORS.length];

export type BranchCard = {
  id: string; name: string; city: string; demand_scale: number; is_main: boolean; simulated: boolean;
  stock_value: number; units: number; skus_in_stock: number; skus_total: number;
  stockouts: number; stockouts_ab: number; below_target: number;
  median_cover_weeks: number | null; excess_value: number; near_expiry_value: number; near_expiry_batches: number;
  expired_value: number; forecast_weekly_units: number; forecast_weekly_value: number;
  forecast_weeks: string[]; forecast_series: number[]; forecast_current_index: number | null;
};

export type CoverCell = {
  store_id: string; qty: number; value: number; weekly_rate: number; weeks_cover: number | null;
  target: number; target_cover_weeks: number | null; near_expiry_value: number;
};
export type MatrixRow = { medicine_id: string; medicine_name: string; category: string; abc: string; total_value: number; cells: CoverCell[] };

export type CategoryStore = {
  store_id: string; value: number; units: number; stockouts: number; near_expiry_value: number;
  excess_value: number; weekly_rate: number; weeks_cover: number | null;
};
export type CategoryRow = { category: string; total_value: number; stores: CategoryStore[] };

export type CompareResp = {
  as_of: string; scope: "all" | "own"; stores: BranchCard[];
  directory: { id: string; name: string; city: string; demand_scale: number; is_main: boolean; simulated: boolean }[];
  totals: Record<"stock_value" | "units" | "stockouts" | "excess_value" | "near_expiry_value" | "forecast_weekly_units" | "expired_value", number>;
  matrix: MatrixRow[]; categories: CategoryRow[];
  params: { cover_weeks: number; excess_cover_weeks: number; near_expiry_days: number; lead_time: number; review: number; service: number; matrix_top: number };
  notes: Record<string, string>;
};

export type Kind = "stockout" | "expiry" | "rebalance";
export type Side = {
  qty_before: number | null; qty_after: number | null; target: number | null; weekly_rate: number | null;
  cover_before: number | null; cover_after: number | null; projected_writeoff_units?: number | null;
};
export type Suggestion = {
  id: string; kind: Kind; priority: number;
  medicine_id: string; medicine_name: string; category: string; abc: string; median_price: number;
  from_store: string; from_name: string; to_store: string; to_name: string;
  qty: number; value: number;
  batches: { batch_no: string; expiry_date: string; days_left: number; qty: number }[];
  soonest_expiry: string; days_to_expiry: number;
  writeoff_saved_units: number; writeoff_saved_value: number;
  shortfall_units_avoided: number; revenue_protected: number;
  from: Side; to: Side; rationale: string | null;
};
export type NetworkMetrics = { waste_units: number; waste_value: number; stockouts: number; at_risk: number; shortfall_units: number };
export type SuggestResp = {
  as_of: string; suggestions: Suggestion[];
  summary: { qty: number; value: number; writeoff_saved_value: number; revenue_protected: number; count: number; by_kind: Record<Kind, number> };
  network: { before: NetworkMetrics; after: NetworkMetrics } | null;
  can_apply: boolean; can_request: boolean;
  params: { min_value: number; medicine_id?: string | null; min_qty: number; transit_days: number; expiry_horizon_days: number; lead_time: number; review: number; service: number };
  assumptions: string[];
};

export type ApplyResp = {
  applied: { id: string; ref: string; transfer_id: number; moved: number; medicine_name: string; from_store: string; to_store: string }[];
  failed: { id: string; medicine_id: string; error: string; status: number }[];
  stale_ids: string[]; moved_units: number;
};

export type TransferRow = {
  id: number; from_store: string; to_store: string; medicine_id: string; medicine_name: string | null; qty: number;
  status: string; reason: string | null; created_by: number | null; created_by_username: string | null; created_at: string; est_value: number;
};
export type HistoryResp = { transfers: TransferRow[]; total: number; store_id: string | null; limit: number; offset: number; last30: { count: number; units: number } };

export type RequestRow = {
  id: number; from_store: string; to_store: string; from_name: string | null; to_name: string | null;
  medicine_id: string; medicine_name: string | null; qty: number; reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled"; requested_by: number | null; requested_by_username: string | null;
  created_at: string; decided_by_username: string | null; decided_at: string | null; decision_note: string | null; transfer_id: number | null;
  /** this user may approve/reject it (transfers.create + access to both branches) */
  can_approve?: boolean;
};
export type RequestsResp = { requests: RequestRow[]; pending: number; can_approve: boolean };

export const KIND_LABEL: Record<Kind, string> = { stockout: "Prevent stockout", expiry: "Save expiring stock", rebalance: "Rebalance" };

export const cover = (w: number | null | undefined) => (w == null ? "—" : w >= 99 ? "99+ wk" : `${w.toFixed(1)} wk`);

/** 'YYYY-MM-DD' -> "13 Apr 2027" (en-IN); falls back to the raw text. */
export function day(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Short relative-ish timestamp for UTC ISO strings. */
export function when(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" });
}
