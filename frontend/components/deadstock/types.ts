export type DsClass = "dead" | "slow" | "at_risk" | "expired";
export type OptionKey = "hold" | "rtv" | "transfer" | "markdown" | "writeoff";

export type Assumptions = {
  credit_pct: number | null; elasticity_otc: number; elasticity_rx: number; transfer_cost: number; holding_cost_pct: number;
};

export type StoreLite = { id: string; name: string; city?: string; demand_scale: number; is_main: boolean; simulated: boolean };

export type Definitions = Record<string, string> & { assumptions?: Assumptions };

export type Deadline = {
  batch_id: number; medicine_id: string; medicine_name: string; batch_no: string; qty: number; deadline: string;
  days_to_deadline: number; expected_credit: number; supplier_id: string | null; best: OptionKey;
};

export type AgeRow = { bucket: string; dead: number; slow: number; at_risk: number; expired: number; healthy: number };

export type DsSummary = {
  store: StoreLite; as_of: string; total_stock_value: number; value_tied_up: number; value_at_risk: number;
  best_recovery: number; hold_recovery: number; uplift_vs_hold: number;
  by_class: Record<DsClass, { items: number; value: number; value_at_risk: number }>;
  best_mix: Partial<Record<OptionKey, { batches: number; recovery: number }>>;
  ageing: AgeRow[]; expiry_buckets: { bucket: string; value: number; units: number }[];
  deadlines: Deadline[]; n_deadlines: number; definitions: Definitions;
};

export type BatchLite = {
  batch_id: number; batch_no: string; expiry_date: string; days_left: number; expired: boolean; qty: number; value: number;
  best: OptionKey; best_label: string; best_recovery: number; uplift_vs_hold: number; projected_unsold: number;
  rtv_deadline: string | null; supplier_id: string | null;
};

export type DsItem = {
  medicine_id: string; medicine_name: string; generic_name: string | null; category: string; form: string; abc: string;
  class: DsClass; qty: number; value: number; expired_qty: number; expired_value: number; weekly_rate: number;
  weeks_cover: number | null; sold_last_12w: number; unsold_units: number; value_at_risk: number; n_batches: number;
  earliest_expiry: string; oldest_age_days: number; best: OptionKey | null; best_label: string | null;
  best_recovery: number; hold_recovery: number; uplift_vs_hold: number; rtv_deadline: string | null;
  batches: BatchLite[];
};

export type DsItems = { store: StoreLite; as_of: string; items: DsItem[]; total: number; counts: Record<DsClass, number>; definitions: Definitions };

export type Option = {
  key: OptionKey; label: string; eligible: boolean; recovery: number; best: boolean; vs_hold: number | null;
  formula?: string; why_not?: string | null; units_sold?: number; units_written_off?: number; units_returned?: number;
  units_moved?: number; to_store?: string; to_store_name?: string; deadline?: string; days_to_deadline?: number;
  credit_pct?: number; discount?: number; markdown_price?: number; elasticity?: number; supplier_id?: string | null;
  grid?: { discount: number; units_sold: number; recovery: number }[] | null; loss?: number;
};

export type BatchOptions = {
  store: StoreLite; as_of: string; batch_id: number; store_id: string; medicine_id: string; medicine_name: string;
  generic_name: string | null; batch_no: string; expiry_date: string; days_left: number; expired: boolean; age_days: number;
  qty: number; unit_cost: number; price: number; value: number; supplier_id: string | null; projected_sold: number;
  projected_unsold: number; value_at_risk: number; best: OptionKey; best_label: string; best_recovery: number;
  uplift_vs_hold: number; options: Option[]; active_markdown: Markdown | null; definitions: Definitions;
};

export type RtvNote = {
  id: number; ref: string; store_id: string; fy: string; seq: number; supplier_id: string | null; status: string;
  note: string | null; total_units: number; total_cost: number; expected_credit: number; created_at: string; n_lines?: number;
};

export type RtvLine = {
  id: number; batch_id: number; medicine_id: string; medicine_name: string | null; generic_name: string | null; batch_no: string;
  expiry_date: string; qty: number; unit_cost: number; credit_pct: number; expected_credit: number; eligible: number; value: number;
};

export type RtvDetail = RtvNote & { store_name: string; store_city: string | null; created_by_name: string | null; lines: RtvLine[]; disclaimer: string };

export type Markdown = {
  id: number; store_id: string; medicine_id: string; batch_id: number; batch_no: string; discount_pct: number;
  list_price: number; markdown_price: number; valid_until: string; status: string; note: string | null; created_at: string;
  medicine_name?: string | null;
};

export const CLASS_META: Record<DsClass, { label: string; color: string; blurb: string }> = {
  dead: { label: "Dead", color: "#4a3aa7", blurb: "No sales in 12 weeks" },
  slow: { label: "Slow", color: "#eda100", blurb: "> 26 weeks of cover" },
  at_risk: { label: "At risk", color: "#2a78d6", blurb: "Unsold at expiry" },
  expired: { label: "Expired", color: "#eb6834", blurb: "On shelf, past expiry" },
};
export const CLASS_ORDER: DsClass[] = ["dead", "slow", "at_risk", "expired"];

export const OPTION_LABEL: Record<OptionKey, string> = {
  hold: "Hold & sell", rtv: "Return to vendor", transfer: "Transfer", markdown: "Markdown", writeoff: "Write off",
};
