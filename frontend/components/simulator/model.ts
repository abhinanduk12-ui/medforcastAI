/* Scenario Lab: shared types, URL (de)serialisation and the epidemic-curve shape (mirrors backend/routers/scenarios.py). */

export type OutbreakType = "dengue" | "influenza" | "heatwave" | "conjunctivitis";
export type RankBy = "units" | "value" | "risk";

export type Outbreak = { type: OutbreakType; intensity: number; start_week: number; duration_weeks: number };
export type Params = {
  seasonal_intensity: number; outbreaks: Outbreak[]; price_change_pct: number;
  horizon: number; lead_time: number; review: number; service: number; rank_by: RankBy;
};

export type Preset = { id: string; name: string; icon: string; rationale: string; params: Pick<Params, "seasonal_intensity" | "outbreaks" | "price_change_pct"> };
export type OutbreakDef = { type: OutbreakType; label: string; summary: string; rules: { target: string; match: string; uplift: number; why: string }[] };
export type PresetsResp = {
  presets: Preset[]; outbreak_types: OutbreakDef[]; weeks: string[]; seasons: string[];
};

export type SeriesRow = { week: string; season: string; baseline: number; scenario: number; base_lo: number; base_hi: number; lo: number; hi: number };
export type CategoryRow = { category: string; base_units: number; scen_units: number; base_rev: number; scen_rev: number; delta_units: number; delta_rev: number; pct: number };
export type MedRow = {
  medicine_id: string; medicine_name: string; category: string; abc: string; price: number;
  base_units: number; scen_units: number; delta_units: number; pct: number; delta_value: number;
  base_order_up_to: number; scen_order_up_to: number; extra_units: number;
  risk_baseline: number; risk: number; risk_week: string; policy: string; elasticity: number;
};
export type AppliedRule = { target: string; match: string; uplift: number; peak_uplift: number; medicines: number; why: string; examples: string[] };
export type SimResp = {
  params: Params; horizon_weeks: string[]; cover_weeks: number; z: number; is_baseline: boolean;
  summary: {
    baseline_units: number; scenario_units: number; delta_units: number; pct: number;
    baseline_revenue: number; scenario_revenue: number;
    extra_stock_units: number; extra_stock_value: number; freed_stock_units: number; freed_stock_value: number;
    baseline_stock_value: number; scenario_stock_value: number;
    at_risk: number; at_risk_baseline: number; risk_threshold: number; medicines_changed: number;
  };
  series: SeriesRow[]; categories: CategoryRow[]; medicines: MedRow[];
  assumptions: {
    seasonal: { intensity: number; formula: string; seasons: { season: string; weeks: number; mean_index: number; mean_scenario_index: number }[] };
    outbreaks: { type: OutbreakType; label: string; intensity: number; start_week: number; duration_weeks: number; curve: number[]; rules: AppliedRule[] }[];
    price: { change_pct: number; formula: string; groups: { group: string; elasticity: number; medicines: number; volume_change: number; why: string }[] };
    uncertainty: string; inventory: string;
  };
};

export const OUTBREAK_TYPES: OutbreakType[] = ["dengue", "influenza", "heatwave", "conjunctivitis"];
export const OUTBREAK_LABEL: Record<OutbreakType, string> = {
  dengue: "Dengue", influenza: "Influenza", heatwave: "Heatwave", conjunctivitis: "Conjunctivitis",
};

export const DEFAULTS: Params = {
  seasonal_intensity: 1, outbreaks: [], price_change_pct: 0, horizon: 12, lead_time: 1, review: 2, service: 0.95, rank_by: "units",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (s: string | null, d: number, lo: number, hi: number) => {
  const v = s == null || s === "" ? NaN : Number(s);
  return Number.isFinite(v) ? clamp(v, lo, hi) : d;
};

/** URL query string <-> params. Outbreaks are packed as `ob=dengue:1.5:3:8,influenza:1:5:6`. */
export function fromQuery(q: URLSearchParams): Params {
  const outbreaks: Outbreak[] = (q.get("ob") ?? "").split(",").filter(Boolean).slice(0, 6).flatMap((tok) => {
    const [t, i, s, d] = tok.split(":");
    if (!OUTBREAK_TYPES.includes(t as OutbreakType)) return [];
    return [{ type: t as OutbreakType, intensity: num(i, 1, 0, 3), start_week: Math.round(num(s, 1, 1, 12)), duration_weeks: Math.round(num(d, 6, 1, 12)) }];
  });
  const rk = q.get("rank");
  return {
    seasonal_intensity: num(q.get("k"), 1, 0, 2.5),
    outbreaks,
    price_change_pct: Math.round(num(q.get("price"), 0, -30, 30)),
    horizon: Math.round(num(q.get("h"), 12, 4, 12)),
    lead_time: Math.round(num(q.get("lead"), 1, 0, 8)),
    review: Math.round(num(q.get("review"), 2, 1, 8)),
    service: num(q.get("sl"), 0.95, 0.8, 0.99),
    rank_by: rk === "value" || rk === "risk" ? rk : "units",
  };
}

export function toQuery(p: Params): string {
  const q = new URLSearchParams();
  if (p.seasonal_intensity !== 1) q.set("k", String(p.seasonal_intensity));
  if (p.outbreaks.length) q.set("ob", p.outbreaks.map((o) => `${o.type}:${o.intensity}:${o.start_week}:${o.duration_weeks}`).join(","));
  if (p.price_change_pct !== 0) q.set("price", String(p.price_change_pct));
  if (p.horizon !== 12) q.set("h", String(p.horizon));
  if (p.lead_time !== 1) q.set("lead", String(p.lead_time));
  if (p.review !== 2) q.set("review", String(p.review));
  if (p.service !== 0.95) q.set("sl", String(p.service));
  if (p.rank_by !== "units") q.set("rank", p.rank_by);
  return q.toString();
}

/** Same shape as the backend: gamma-like rise to a peak ~35 % into the window, then decay (peak = 1).
 *  The full curve is normalised before it is cut at the forecast window, so a late outbreak is not rescaled. */
export function epidemicCurve(nWeeks: number, start: number, duration: number): number[] {
  const p = 0.35, a = 2;
  const shape = Array.from({ length: duration }, (_, j) => {
    const x = (j + 0.5) / duration;
    return duration === 1 ? 1 : (x / p) ** a * Math.exp(a * (1 - x / p));
  });
  const mx = Math.max(...shape);
  return Array.from({ length: nWeeks }, (_, t) => {
    const j = t + 1 - start;
    return j >= 0 && j < duration && mx > 0 ? shape[j] / mx : 0;
  });
}

/** True when the scenario knobs (not the planning knobs) equal a preset. */
export function matchesPreset(p: Params, pr: Preset) {
  const a = pr.params;
  return a.seasonal_intensity === p.seasonal_intensity && a.price_change_pct === p.price_change_pct &&
    JSON.stringify(a.outbreaks) === JSON.stringify(p.outbreaks.map((o) => ({ type: o.type, intensity: o.intensity, start_week: o.start_week, duration_weeks: o.duration_weeks })));
}

/** Stockout-risk status bands. Status colours are always paired with an icon and a label. */
export function riskLevel(r: number): { label: string; tone: "good" | "warning" | "serious" | "critical" } {
  if (r < 0.1) return { label: "Low", tone: "good" };
  if (r < 0.2) return { label: "Watch", tone: "warning" };
  if (r < 0.5) return { label: "High", tone: "serious" };
  return { label: "Critical", tone: "critical" };
}
