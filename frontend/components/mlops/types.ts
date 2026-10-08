export type Issue = {
  code: string; severity: "fatal" | "error" | "warning"; message: string; count: number;
  sample: Record<string, string | number | null>[];
};
export type Report = {
  status: "ok" | "warnings" | "errors" | "fatal"; rows_total: number; rows_accepted: number; rows_rejected: number;
  units?: number; date_range: [string, string] | null; issues: Issue[]; columns_found: string[];
  columns_missing_optional: string[]; unknown_medicines: { medicine_id: string; rows: number; in_upload_master: boolean; medicine_name: string | null }[];
  unknown_medicine_count?: number; medicines?: number; sheets?: string[]; has_master_sheet?: boolean;
};
export type Upload = {
  id: string; filename: string; created_at: string; uploaded_by: string | null; status: "pending" | "accepted" | "rejected";
  validation: Report["status"]; rows_total: number; rows: number; rows_rejected: number; units: number;
  date_range: [string, string] | null; new_medicines: number; add_new_medicines: boolean; bytes: number; sha256: string;
  accepted_at?: string; rejected_reason?: string;
};
export type Source = {
  key: string; kind: "base" | "upload" | "ledger"; label: string; rows_in: number; rows_used: number; units: number;
  weeks: number; start: string | null; end: string | null; dropped_duplicate_ids: number; dropped_overlap_rows: number;
  days_replaced_by_newer: number; sha256?: string | null;
};
export type Preview = {
  ready: boolean; message?: string; sources: Source[]; timeline: ({ week: string } & Record<string, number | string>)[];
  rows: number; units: number; start: string | null; end: string | null; weeks: number; medicines: number;
  new_medicines: number; rules: string[]; gap_weeks: string[]; warnings: string[]; ledger_store: string | null;
};
export type Gate = {
  verdict: "pass" | "fail" | "needs_override" | "champion" | "not_ready"; method?: string; explanation: string;
  tolerance: number; window?: [string, string] | Record<string, unknown>;
  candidate_scores?: { item_week_wape: number; category_week_wape: number };
  champion_scores?: { item_week_wape: number; category_week_wape: number };
  deltas?: { item_week_wape: number | null; category_week_wape: number | null };
};
export type Job = {
  id: string; version: string; status: "queued" | "preparing" | "training" | "explaining" | "succeeded" | "failed" | "cancelled" | "interrupted";
  progress: number; message: string; params: { uploads: string[]; include_ledger_sales: boolean }; user: string;
  created_at: string; started_at: string | null; finished_at: string | null; log_tail?: string[]; gate: Gate | null; error: string | null;
};
export type Summary = {
  item_week_wape: number | null; category_week_wape: number | null; store_week_wape: number | null; bias: number | null;
  coverage_90: number | null; direction_accuracy: number | null; holdout_window: [string, string] | null; train_until: string | null;
  training_seconds: number | null; skill_vs_ma8?: number | null;
};
export type Version = {
  version: string; active: boolean; status: string; created_at: string | null; finished_at: string | null; source: string | null;
  requested_by: string | null; promoted_at: string | null; promoted_by: string | null; code_hash: string | null; note: string | null;
  error: string | null; explain_ok: boolean | null; params: Job["params"] | null;
  dataset: { rows: number; date_range: [string, string] } | null;
  data_sources: { key: string; kind: string; label: string; rows_used: number | null; units: number | null; start: string | null; end: string | null; sha256: string | null }[];
  summary: Summary | null; gate: Gate | null;
};
export type HistoryEntry = { action: string; version: string; previous: string | null; at: string; user: string; reason: string; override: boolean };
export type VersionsResp = { versions: Version[]; active: string | null; serving: string | null; tolerance: number; rollback_target: string | null; history: HistoryEntry[] };
export type Status = {
  active_version: string | null; serving_version: string | null; generated_at: string; versions: number; base_ready: boolean;
  running_job: Job | null; can_manage: boolean; tolerance: number; max_upload_mb: number; rollback_target: string | null;
};
export type Drift = {
  status: "ok" | "no_data" | "no_overlap"; message?: string; store_id: string; version: string | null; demand_scale: number;
  forecast_weeks: [string, string] | null; overlap_weeks: string[]; ledger_sales: number; ledger_first_sale?: string;
  actual_units?: number; forecast_units?: number; item_week_wape?: number; store_week_wape?: number; bias?: number;
  psi_category_mix?: number; psi_level?: string; weekly?: { week: string; actual: number; forecast: number }[];
  category_mix?: { category: string; actual: number; forecast: number; diff: number }[]; notes?: string[]; method?: string;
};

export const shortDate = (iso?: string | null) =>
  iso ? new Date(iso.length <= 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
export const shortDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
