"use client";

/* Early-warning signals: response types (mirrors backend/routers/signals.py + ml/signals.py) and shared helpers. */
import { CircleAlert, CircleCheck, CircleDashed, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

export type LicenseMode = "noncommercial" | "commercial-plan" | "off";
export type License = {
  mode: LicenseMode; locked: boolean; modes: LicenseMode[]; notice: string; open_meteo_enabled: boolean; api_key_set: boolean;
  attribution: Record<"open_meteo" | "nasa_power" | "dhs_kerala", { text: string; url: string; terms?: string }>;
};
export type Source = {
  id: string; name: string; provider: string; licence: string; url: string; enabled: boolean;
  last_success: string | null; last_attempt: string | null; status: string; message: string | null; stale: boolean; detail: string;
};
export type RefreshState = {
  running: boolean; started_at: string | null; finished_at: string | null; trigger: string | null; progress: string | null; error: string | null;
  results?: Record<string, unknown>;
};
export type StatusResp = {
  today: string; place: string; sources: Source[]; license: License; refresh: RefreshState; autofetch: boolean;
  can_refresh: boolean; can_edit_settings: boolean; can_upload: boolean; can_enter: boolean; simulated_branches_note: string;
};

export type ObservedWeek = {
  week: string; rain_mm: number; heavy_days: number; max_day_mm: number; roll14_mm: number | null; tmax: number | null; tmin: number | null; rh: number | null;
  clim_mean: number | null; clim_p10: number | null; clim_p90: number | null; anomaly_pct: number | null; anomaly_z: number | null; percentile: number | null;
};
export type ChartWeek = {
  week: string; observed: number | null; forecast: number | null; days_observed: number; days_forecast: number;
  clim_mean: number | null; clim_p10: number | null; clim_p90: number | null; kind: "observed" | "forecast";
};
export type Next16 = {
  start: string; end: string; days: number; total_mm: number; heavy_days: number; max_day_mm: number; wet_days: number; max_prob: number | null;
  clim_mean: number | null; clim_p10: number | null; clim_p90: number | null; anomaly_pct: number | null; anomaly_z: number | null;
  percentile: number | null; outlook: string | null; clim_source: string | null;
};
export type SeasonalMonth = {
  month: string; days: number; partial: boolean; members: number; median: number; p10: number; p90: number; min: number; max: number;
  clim_mean: number; clim_p10: number | null; clim_p90: number | null; clim_fallback: boolean; anomaly_pct: number | null; prob_above_normal: number;
};
export type WeatherResp = {
  place: string; today: string; license: License;
  observed: { source: string; weeks: ObservedWeek[]; last_date: string | null; lag_days: number | null; fetched_at: string | null; from_cache_file: boolean;
    stale: boolean; climatology: string | null; this_week: { week: string; observed_mm: number; days: number } | null; heavy_rain_mm: number };
  forecast: { available: boolean; source: string; fetched_at: string | null; stale: boolean; days: { date: string; precip_mm: number | null; tmax: number | null; tmin: number | null; rh: number | null; precip_prob: number | null }[];
    next16: Next16 | null; reason: string | null; error: string | null };
  seasonal: { available: boolean; months: SeasonalMonth[]; fetched_at?: string | null; caveat?: string; reason?: string };
  chart: ChartWeek[];
  climatology_monthly: { month: number; nasa_power: number | null; era5: number | null; fallback_nasa: number; fallback_era5: number }[];
  climatology_available: { nasa_power: boolean; era5: boolean };
};

export type Level = "high" | "elevated" | "watch" | "normal" | "insufficient";
export type Block = { start: string; end: string; cases: number | null; days: number; scaled: boolean; estimated: boolean; deaths: number | null };
export type DiseaseSeries = {
  disease: string; label: string; metric: string; about: string; last7: number | null; prev7: number | null; baseline_mean: number | null;
  baseline_sd: number | null; baseline_blocks: number; z: number | null; growth: number | null; growth_pct: number | null; trend: "rising" | "falling" | "stable" | null;
  level: Level; min_cases: number; blocks: Block[]; last_date: string; sources: string[];
  daily: { date: string; cases: number | null; suspected: number | null; confirmed: number | null; deaths: number | null; source: string; estimated: boolean }[];
};
export type ReportGap = { date: string; status: string; url: string | null; message: string | null; pending: boolean; attempts: number; last_attempt: string | null };
export type ManualRow = {
  id: number; date: string; period: string; district: string; disease: string; suspected: number | null; confirmed: number | null; deaths: number | null;
  source: string; source_url: string | null; notes: string | null;
  /** Added by GET /api/signals/disease for the calling user (the server still enforces the rule on DELETE). */
  entered_by?: number | null; entered_by_name?: string | null; can_delete?: boolean;
};
export type DiseaseResp = {
  as_of: string | null; today: string; regions: string[]; region_names: Record<string, string>; panel_diseases: string[];
  series: Record<string, Record<string, DiseaseSeries>>;
  reports: { ok: number; total: number; latest_ok: string | null; needs_manual: ReportGap[]; pending: ReportGap[] };
  fetched_at: string | null; stale: boolean; error: string | null; manual_entries: ManualRow[];
  method: { z: string; growth: string; levels: Record<string, string>; min_cases: string; block_days: number; baseline_blocks: number };
};

export type ImpactMed = { medicine_id: string; medicine_name: string; category: string; uplift_at_peak: number | null; base_weekly: number };
export type WatchItem = {
  id: string; kind: "disease" | "weather"; level: Level; disease: string; label: string; district: string; district_name: string; title: string; why: string;
  last7?: number | null; z?: number | null; growth_pct?: number | null; trend?: string | null; as_of?: string | null; spark?: (number | null)[]; rule?: boolean;
  preset: { type: string; label: string; href: string | null; intensity: number; start_week: number | null; duration_weeks: number; unavailable_reason: string | null } | null;
  note: string | null; caution: string | null; categories: string[]; falling?: string[]; medicines: ImpactMed[];
  rules: { target: string; uplift: number | null; why: string; medicines: number }[];
};
export type WatchResp = { as_of: string | null; items: WatchItem[]; rule_note: string; levels: Record<string, string> };

export type EvidenceTest = {
  category: string; lag_weeks: number; n_weeks: number; slope: number; ci_lo: number; ci_hi: number; p: number; q: number; r2: number;
  effect_per_sd_pct: number; effect_ci_pct: [number, number]; oos_gain: number | null; mean_units: number; supported: boolean;
};
export type EvidenceResp =
  | { available: false; reason: string }
  | { available: true; verdict: "none" | "partial"; headline: string; n_tests: number; n_raw_p05: number; expected_false_positives: number; fdr_q: number;
      lags: number[]; period: { start: string | null; end: string | null; weeks: number }; rows: EvidenceTest[]; supported: EvidenceTest[];
      adjustments: { category: string; lag_weeks: number; effect_per_sd_pct: number; effect_ci_pct: [number, number] }[];
      method: string[]; caveats: string[] };

/* Watch levels: status colours, always shown with an icon and a label. */
export const LEVEL: Record<Level, { label: string; color: string; wash: string; icon: LucideIcon }> = {
  high: { label: "High", color: "var(--critical)", wash: "#fbeaea", icon: OctagonAlert },
  elevated: { label: "Elevated", color: "var(--serious)", wash: "#fdf0ea", icon: TriangleAlert },
  watch: { label: "Watch", color: "var(--warn)", wash: "#fef6e3", icon: CircleAlert },
  normal: { label: "Normal", color: "var(--good)", wash: "#eaf6ea", icon: CircleCheck },
  insufficient: { label: "Not enough data", color: "var(--ink-3)", wash: "var(--surface-sunken)", icon: CircleDashed },
};

export function LevelBadge({ level }: { level: Level }) {
  const m = LEVEL[level];
  const Icon = m.icon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink" style={{ background: m.wash }}>
      <Icon className="h-3.5 w-3.5" strokeWidth={2.2} style={{ color: m.color }} aria-hidden />{m.label}
    </span>
  );
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "unknown";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const dayFmt = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });
export const monthFmt = (ym: string) => new Date(ym + "-01T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
export const dayYearFmt = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
export const mm = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)} mm`);

/** 1 -> "1st", 22 -> "22nd", 13 -> "13th". */
export function ordinal(n: number): string {
  const v = Math.round(n), t = v % 100;
  const suf = t >= 11 && t <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[v % 10] ?? "th";
  return `${v}${suf}`;
}

/** Disease codes used by manual entries and the API. */
export const DISEASE_LABEL: Record<string, string> = {
  dengue: "Dengue", fever: "Fever (OP)", lepto: "Leptospirosis", add: "Acute diarrhoeal disease", hepatitis_a: "Hepatitis A",
  influenza: "Influenza (confirmed)", chikungunya: "Chikungunya", ili: "Influenza-like illness", other: "Other",
};

/** Why a DHS report day still needs a manual entry. */
export const REPORT_STATUS: Record<string, string> = {
  missing: "not found on the DHS site", invalid: "could not be validated", error: "download failed", skipped: "skipped",
};
