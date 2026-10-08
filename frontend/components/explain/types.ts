/* Response shapes of /api/explain/* (backend/routers/explain.py). */

export type Unavailable = { available: false; message: string };

export type Factor = {
  group: string; contrib: number; factor: number; pct: number; direction: "up" | "down" | "neutral"; features: string[];
};

export type MedicineExplanation = {
  available: true; id: string; name: string; weeks: number; week_range: [string, string]; seasons: string[];
  stale: boolean; stale_message: string | null;
  baseline_rate: number; geometric_prediction: number; averaging_factor: number; prediction: number;
  ensemble_prediction: number | null; gbm_weight: number | null;
  factors: Factor[]; sentences: string[];
  season_breakdown: { season: string; weeks: number; factor: number }[];
  top_features: { feature: string; label: string; group: string | null; contrib: number; factor: number }[];
  per_horizon: { h: number; week: string; season: string; prediction: number; season_factor: number; factors: Record<string, number> }[];
};

export type GroupTable = { name: string; rows: number | null; importance: Record<string, number>; share: Record<string, number>; typical_factor: Record<string, number> };

export type GlobalExplanation = {
  available: true; generated_at: string; method: string; baseline_rate: number; groups: string[];
  stale: boolean; stale_message: string | null;
  overall: { group: string; mean_abs: number; typical_factor: number; training_mean_abs: number; features: string[] }[];
  by_season: GroupTable[]; by_category: GroupTable[];
  top_features: { feature: string; group: string; mean_abs: number; label: string }[];
  /** Unrounded (not passed through clean()); null only if a check produced NaN/inf. */
  checks: {
    additivity_max_err: number | null; predict_max_err: number | null;
    agreement_with_forecast_csv: { rows: number | null; max_abs_diff: number | null; corr: number | null; total_ratio?: number | null };
  };
  sample_rows: number; forecast_rows: number; gbm_weight: number | null;
};

/** "+18%" for modest effects, "×3.2" / "×0.10" for large multiplicative ones. */
export function factorLabel(f: number) {
  if (f >= 2 || f <= 0.5) return `×${f < 1 ? f.toFixed(2) : f.toFixed(1)}`;
  const p = (f - 1) * 100;
  if (Math.abs(p) < 0.05) return "0%";
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(Math.abs(p) < 1 ? 1 : 0)}%`;
}

/** Short names for the eight driver groups (tight table columns / bar rows). */
export const SHORT: Record<string, string> = {
  "Long-run demand level": "Long-run level",
  "Recent sales (lags & averages)": "Recent sales",
  "Momentum & trend": "Momentum",
  "Season effect": "Season",
  Festivals: "Festivals",
  "Product traits": "Product traits",
  "Forecast horizon": "Horizon",
  "Store & category activity": "Store & category",
};

/** "1.2e-5" for the tiny additivity errors; "—" when a check is missing. */
export const sci = (n: number | null | undefined) => (n == null ? "—" : n === 0 ? "0" : n.toExponential(1).replace("e-", "e−"));
