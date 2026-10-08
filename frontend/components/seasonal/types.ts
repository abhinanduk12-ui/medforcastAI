/** Types for /api/seasonal/* (backend/routers/seasonal.py). Shared by every Seasonal Intelligence tab. */

export type SeasonalClass =
  | "Strongly seasonal"
  | "Seasonal"
  | "Seasonal (category evidence)"
  | "Possible pattern (weak evidence)"
  | "Steady";

/** Summary stats of one curve (category or medicine). Day labels are "D Mon" in a generic year. */
export type CurveSummary = {
  id: string; level: "category" | "medicine"; label: string; category: string; class: SeasonalClass;
  strength: number; p: number | null; q: number | null; tested: boolean; shrink_weight: number | null;
  amplitude: number; peak_mult: number; trough_mult: number; peak: string; trough: string;
  onset: string | null; end: string | null; duration_days: number; rain_corr: number | null;
  small_sample: boolean; units: number; transactions: number;
};

export type GridPoint = { doy: number; label: string; m: number; lo: number; hi: number };
export type ObservedPoint = { week: string; doy: number; ratio: number; year: number };

export type CurvePayload = CurveSummary & {
  grid: GridPoint[]; monthly: { month: string; m: number }[]; observed?: ObservedPoint[];
};

export type CurvesResp = { today_doy: number; series: CurvePayload[]; threshold: number };

export type TimingStatus = "Order now" | "Order within a month" | "Upcoming" | "In season now: keep stocked" | "No distinct season";

export type TimingRow = CurveSummary & {
  lead_days: number; lead_source: string; today_mult: number; in_season: boolean; status: TimingStatus;
  next_onset: string | null; next_peak: string | null; order_by: string | null; days_to_order: number | null;
  next_onset_iso?: string; order_by_iso?: string;
  base_weekly?: number; abc?: string;               // medicine level only
};

export type TimingResp = { today: string; level: "category" | "medicine"; count: number; rows: TimingRow[] };

export type OverviewResp = {
  today: string; current_season: string; next_season: string;
  summary: {
    medicines_tested: number; medicines_significant: number; medicines_insufficient: number;
    categories_significant: number; categories: number; weeks: number; first_week: string; last_week: string;
  };
  classes: Partial<Record<SeasonalClass, number>>;
  kpi: {
    seasonal_medicines: number; significant_medicines: number; significant_categories: number; categories: number;
    forecast_seasonal_units: number; forecast_seasonal_value: number; forecast_units: number; archetypes: number;
  };
  upcoming: TimingRow[]; in_season: TimingRow[];
  today_by_category: { category: string; m: number }[];
  method: string[]; limits: string[];
};

export type CalendarResp = {
  columns: string[]; month_ticks: { col: number; month: string }[]; today_col: number;
  rows: (CurveSummary & { values: number[] })[];
  seasons: Record<string, number[]>;
};

export type Archetype = {
  id: number; name: string; size: number; amplitude: number; peak_month: string;
  profile: number[]; months: string[]; rain_corr: number | null;
  top_categories: { category: string; n: number }[];
  members: { id: string; name: string; category: string; units: number; class: SeasonalClass }[];
};
export type ArchetypesResp = { k: number; silhouette: number | null; clustered?: number; clusters: Archetype[]; rain: number[]; months: string[] };

export type ImpactRow = { category: string; forecast: number; season_curve: number; season_shap: number | null; value_curve: number; value_shap: number | null; share_curve: number | null };
export type ImpactMed = { medicine_id: string; medicine_name: string; category: string; forecast: number; season_curve: number; season_shap: number | null; value_curve: number };
export type ForecastImpactResp = {
  has_shap: boolean; weeks: string[];
  totals: { forecast: number; season_curve: number; season_shap: number | null; value_curve: number; value_shap: number | null; agreement_corr: number | null };
  weekly: { week: string; forecast: number; season_curve: number; season_shap: number | null; without_curve: number; without_shap: number | null }[];
  categories: ImpactRow[]; top_up: ImpactMed[]; top_down: ImpactMed[]; note: string;
};

export type ReadinessCat = { category: string; target: number; available: number; gap: number; gap_value: number; items: number; short_items: number; coverage: number; season_mult: number };
export type ReadinessGap = {
  medicine_id: string; medicine_name: string; category: string; abc: string; median_price: number;
  expected_season: number; target: number; on_hand: number; on_order: number; available: number; gap: number; gap_value: number;
  class: SeasonalClass; season_mult: number;
};
export type ReadinessResp = {
  season: string; start: string; end: string; in_progress: boolean; starts_in_days: number; store_id: string | null;
  demand_scale: number; target_weeks: number;
  summary: { items: number; short_items: number; coverage: number; gap_units: number; gap_value: number; expected_season_units: number };
  categories: ReadinessCat[]; top_gaps: ReadinessGap[]; note: string;
};

export type MedicineSeasonalResp = {
  curve: CurvePayload; category_curve: CurvePayload | null; timing: TimingRow; archetype: string | null;
  forecast: { week: string; forecast: number; curve_mult: number; shap_mult: number | null }[];
  method: string[]; limits: string[];
};

export type EvidenceResp = {
  summary: OverviewResp["summary"]; fdr_q: number; p_histogram: number[]; expected_null_per_bin: number;
  yoy_august: { category: string; aug_2025: number; aug_2026: number; ratio: number }[]; yoy_store_ratio: number | null;
  rain: { months: string[]; mm: number[]; source: string; categories: { category: string; rain_corr: number | null; class: SeasonalClass; monthly: number[] }[] };
  categories: CurveSummary[]; method: string[]; limits: string[];
};

/** Visual treatment per class: status-like chips always pair a glyph with the label (never colour alone). */
export const CLASS_STYLE: Record<SeasonalClass, { short: string; tone: string; glyph: string }> = {
  "Strongly seasonal": { short: "Strong", tone: "bg-[#fdecea] text-[#a8302f] border-[#f4c7c3]", glyph: "▲▲" },
  "Seasonal": { short: "Seasonal", tone: "bg-[#fff2ea] text-[#a14a1f] border-[#f6d2bd]", glyph: "▲" },
  "Seasonal (category evidence)": { short: "Via category", tone: "bg-brand-wash text-brand-ink border-brand-soft", glyph: "◆" },
  "Possible pattern (weak evidence)": { short: "Weak", tone: "bg-sunken text-ink-2 border-hairline", glyph: "◇" },
  "Steady": { short: "Steady", tone: "bg-surface text-ink-3 border-hairline", glyph: "—" },
};

/** Multiplier (1.0 = an average week) as a signed % change. */
export const multPct = (m: number | null | undefined) => (m == null ? null : m - 1);
