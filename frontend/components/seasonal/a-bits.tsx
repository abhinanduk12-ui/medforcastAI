"use client";

/**
 * Small shared pieces for the Curves, Timing and Readiness tabs of Seasonal intelligence:
 * class chips, timing-status badges, status tones and meters, date helpers and CSV export.
 * Status meaning always ships as icon + label (never colour alone).
 */

import { AlertTriangle, CalendarClock, CheckCircle2, Clock, CloudRain, CloudSun, Minus, Snowflake, Sun, type LucideIcon } from "lucide-react";
import { fmt } from "@/lib/format";
import { CLASS_STYLE, type SeasonalClass, type TimingStatus } from "./types";

/* ───────────────────────── seasonal class chip ───────────────────────── */

export function ClassChip({ c, compact = false, className = "" }: { c: SeasonalClass; compact?: boolean; className?: string }) {
  const s = CLASS_STYLE[c] ?? CLASS_STYLE.Steady;
  return (
    <span title={c} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-px text-[11px] font-medium ${s.tone} ${className}`}>
      <span aria-hidden className="text-[9px] leading-none">{s.glyph}</span>{compact ? s.short : c}
    </span>
  );
}

/* ───────────────────────── status tones ───────────────────────── */

export type Tone = "good" | "warning" | "serious" | "neutral" | "muted";

export const TONE: Record<Tone, { fill: string; track: string; bg: string; ink: string; border: string }> = {
  good: { fill: "#0ca30c", track: "#dcefdc", bg: "#eaf6ea", ink: "#006300", border: "#cbe7cb" },
  warning: { fill: "#fab219", track: "#fcefcc", bg: "#fff6de", ink: "#7a5300", border: "#f6e0a6" },
  serious: { fill: "#ec835a", track: "#fae0d5", bg: "#fdefe8", ink: "#9a3f17", border: "#f6cdbb" },
  neutral: { fill: "#6b6a65", track: "#e9e8e2", bg: "#f1f0eb", ink: "#3d3c39", border: "rgba(11,11,11,0.08)" },
  muted: { fill: "#c3c2b7", track: "#f1f0eb", bg: "transparent", ink: "#6b6a65", border: "transparent" },
};

export const STATUS_META: Record<TimingStatus, { short: string; tone: Tone; Icon: LucideIcon }> = {
  "Order now": { short: "Order now", tone: "serious", Icon: AlertTriangle },
  "Order within a month": { short: "Within a month", tone: "warning", Icon: Clock },
  "Upcoming": { short: "Upcoming", tone: "neutral", Icon: CalendarClock },
  "In season now: keep stocked": { short: "In season now", tone: "good", Icon: CheckCircle2 },
  "No distinct season": { short: "No distinct season", tone: "muted", Icon: Minus },
};

export function StatusBadge({ status, compact = false }: { status: TimingStatus; compact?: boolean }) {
  const m = STATUS_META[status] ?? STATUS_META["No distinct season"];
  const t = TONE[m.tone];
  return (
    <span title={status} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium"
      style={{ background: t.bg, color: t.ink, borderColor: t.border }}>
      <m.Icon className="h-3.5 w-3.5" strokeWidth={2.1} aria-hidden />
      {compact ? m.short : status === "In season now: keep stocked" ? "In season: keep stocked" : status}
    </span>
  );
}

/** Coverage → tone (≥90% good, 70–90% warning, <70% serious). */
export function coverageTone(raw: number): { tone: Tone; label: string; Icon: LucideIcon } {
  const c = Math.round(raw * 100) / 100; // judge the percentage the reader sees, so "70%" is never labelled below 70%
  if (c >= 0.9) return { tone: "good", label: "Ready", Icon: CheckCircle2 };
  if (c >= 0.7) return { tone: "warning", label: "Partly ready", Icon: Clock };
  return { tone: "serious", label: "Not ready", Icon: AlertTriangle };
}

/** Horizontal meter. `value` 0..1 (clipped); the track is a lighter step of the fill's tone. */
export function Meter({ value, tone, height = 8, label }: { value: number; tone: Tone; height?: number; label: string }) {
  const t = TONE[tone];
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
      className="w-full overflow-hidden rounded-full" style={{ height, background: t.track }}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(pct, pct > 0 ? 1.5 : 0)}%`, background: t.fill }} />
    </div>
  );
}

/* ───────────────────────── seasons ───────────────────────── */

export const SEASON_TINT: Record<string, { bg: string; ink: string; Icon: LucideIcon }> = {
  Winter: { bg: "#e8f0fa", ink: "#1c5cab", Icon: Snowflake },
  Summer: { bg: "#fdf1dc", ink: "#8a5a00", Icon: Sun },
  Monsoon: { bg: "#e3f2ec", ink: "#0e5c4f", Icon: CloudRain },
  "Post-Monsoon": { bg: "#efeef3", ink: "#4a3aa7", Icon: CloudSun },
};

/** Kerala seasons as day-of-year spans in a generic (non-leap) year. Winter wraps the year end. */
export const SEASON_SPANS: { season: string; from: number; to: number }[] = [
  { season: "Winter", from: 1, to: 59 },
  { season: "Summer", from: 60, to: 151 },
  { season: "Monsoon", from: 152, to: 273 },
  { season: "Post-Monsoon", from: 274, to: 334 },
  { season: "Winter", from: 335, to: 365 },
];

/* ───────────────────────── dates & text ───────────────────────── */

export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
/** Day of year (1..365) of each month's first day in a generic year. */
export const MONTH_START_DOY = CUM.map((c) => c + 1);

/** "2 Jun" (generic-year label from the API) → day of year 1..365, or null. */
export function labelDoy(label: string | null | undefined): number | null {
  if (!label) return null;
  const [d, m] = label.trim().split(/\s+/);
  const mi = MON.indexOf(m);
  const day = Number(d);
  if (mi < 0 || !Number.isFinite(day)) return null;
  return CUM[mi] + day;
}

/** ISO date (YYYY-MM-DD) → local Date at midnight. */
export const isoDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const DAY_MS = 86_400_000;
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY_MS);
export const dateLabel = (d: Date, year = true) => `${d.getDate()} ${MON[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ""}`;

/** "in 12 days" / "today" / "3 days ago". */
export function daysText(d: number | null | undefined) {
  if (d == null) return "";
  if (d === 0) return "today";
  return d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} ago`;
}

/** Multiplier as a signed %; one decimal when whole-number rounding would cross the +10% season threshold
 *  (so a 1.098 peak reads "+9.8%", never "+10%" next to "never reaches +10%"). */
export function multText(m: number, threshold = 1.1) {
  const whole = Math.round((m - 1) * 100);
  const crosses = (whole >= Math.round((threshold - 1) * 100)) !== (m >= threshold);
  return fmt.signedPct(m - 1, crosses ? 1 : 0);
}

/** FDR-adjusted q as text: "q < 0.001" or "q = 0.046". */
export function qText(q: number | null | undefined) {
  if (q == null) return "not tested";
  if (q < 0.001) return "q < 0.001";
  return `q = ${q < 0.01 ? q.toFixed(3) : q.toFixed(2)}`;
}

/** Seasonality strength (Hyndman, 0..1) as a word. */
export function strengthWord(s: number) {
  return s >= 0.3 ? "strong" : s >= 0.1 ? "moderate" : "weak";
}

/** Lead-time source in plain words. */
export function leadSourceText(src: string) {
  if (src === "median of members") return "median of items";
  if (src === "default") return "default";
  return src;
}

/* ───────────────────────── CSV ───────────────────────── */

export function downloadCsv(filename: string, head: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [head.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
