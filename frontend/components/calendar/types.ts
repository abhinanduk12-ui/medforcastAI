/* Response shape of GET /api/calendar (backend/routers/calendar.py). */

export type CalFestival = {
  name: string; days_in_month: number; start: string; end: string;
  effects: { category: string; uplift: number; per_day_uplift: number | null }[];
};

export type CalRising = {
  medicine_id: string; medicine_name: string; category: string; abc: string;
  expected_units: number; typical_units: number; uplift: number; extra_units: number;
};

export type CalPreOrder = { category: string; change: number; extra_units: number; for_month: string; for_label: string };

export type CalMonth = {
  month: string; label: string; short: string; season: string; days: number;
  festivals: CalFestival[];
  units: number; units_lo: number; units_hi: number;
  value: number; value_lo: number; value_hi: number;
  typical_units: number; seasonal_units: number;
  ml_weight: number; ml_days: number; ml_horizon: [number, number] | null;
  source: "ML blend" | "Seasonal projection";
  months_ahead: number; index: number | null;
  rising: CalRising[];
  pre_order: CalPreOrder[];
  rising_categories: { category: string; uplift: number; extra_units: number }[];
  top_categories: { category: string; expected: number; value: number }[];
};

export type CalHeatRow = {
  category: string; base_weekly: number; units: number; low_volume: boolean;
  cells: { month: string; index: number; units: number; uplift: number | null }[];
};

export type CalendarResp = {
  category: string | null; start: string; today: string;
  months: CalMonth[];
  summary: {
    units: number; value: number; units_lo: number; units_hi: number; value_lo: number; value_hi: number;
    peak_month: string; peak_label: string; peak_index: number;
    low_month: string; low_label: string; low_index: number;
    ml_months: string[]; pre_order_months: number; medicines: number;
  };
  heatmap: { months: string[]; rows: CalHeatRow[] };
  categories: { category: string; base_weekly: number }[];
  method: {
    data_end: string; forecast_span: [string, string] | null; festival_dates_until: string;
    ml_w0: number; ml_decay_weeks: number; z: number;
    drift_per_month: number; drift_estimated: number | null; drift_floor: number;
    month_shock_sd: number; level_se: number; ml_shared_error: number;
    min_uplift: number; min_cat_weekly: number;
    significant_festivals: {
      festival: string; category: string; uplift: number; per_day_uplift: number | null;
      index_share_removed: Record<string, number>;
    }[];
    notes: string[];
  };
};
