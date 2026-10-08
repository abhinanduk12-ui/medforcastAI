"use client";

/**
 * Small shared pieces for the Forecast impact, Archetypes and Evidence tabs.
 * Everything here follows the app's chart rules: text in ink tokens, colour only on marks,
 * meaning always glyph + label, one y-axis per chart.
 */

import type { ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { C } from "@/components/charts";
import { fmt } from "@/lib/format";
import { CLASS_STYLE, type SeasonalClass } from "./types";

/* Diverging poles (same steps as the app's seasonal index: blue = less demand, red = more). */
export const DIV = { pos: "#ea7471", neg: "#5598e7", posInk: "#c23b3a", negInk: "#256abf", mid: "#c3c2b7" } as const;
/** Rainfall is a reference series everywhere: muted warm grey so it never competes with demand. */
export const RAIN = { line: C.muted, fill: C.muted, col: "#bdbbb2" } as const;

const MINUS = "−";

/** Signed whole number with a true minus sign; the sign follows the rounded value (never "−0"). */
export function sInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return `${r > 0 ? "+" : r < 0 ? MINUS : ""}${fmt.int(Math.abs(r))}`;
}

/** Signed compact rupees (+₹16.1K / −₹32.2K). */
export function sInr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return `${r > 0 ? "+" : r < 0 ? MINUS : ""}${fmt.inr(Math.abs(n))}`;
}

/** Signed decimal (correlations): +0.73 / −0.46. */
export function sDec(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Number(n.toFixed(digits));
  return `${r > 0 ? "+" : r < 0 ? MINUS : ""}${Math.abs(r).toFixed(digits)}`;
}

/** q / p values: "< 0.001" below a thousandth, else three decimals. */
export function qText(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q)) return "—";
  return q < 0.001 ? "< 0.001" : q.toFixed(3);
}

/** "31 Aug – 16 Nov 2026" from a list of ISO week starts. */
export function weekSpan(weeks: string[]): string {
  if (!weeks.length) return "—";
  return `${fmt.week(weeks[0])} – ${fmt.weekYear(weeks[weeks.length - 1])}`;
}

/** Plain-words reading of a correlation: >0.6 strong, 0.3–0.6 moderate, 0–0.3 weak, below 0 opposite. */
export function corrReading(r: number | null | undefined): { level: 0 | 1 | 2 | 3; label: string } | null {
  if (r == null || !Number.isFinite(r)) return null;
  if (r > 0.6) return { level: 3, label: "Strong" };
  if (r >= 0.3) return { level: 2, label: "Moderate" };
  if (r >= 0) return { level: 1, label: "Weak" };
  return { level: 0, label: "Opposite" };
}

/** Nice axis step (1, 2, 2.5, 5 × 10^k) for roughly `span / target`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Domain + ticks that bracket [lo, hi] with a little air, on clean steps. */
export function niceDomain(lo: number, hi: number, target = 4, pad = 0.12): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const span = hi - lo;
  const step = niceStep((span * (1 + 2 * pad)) / target);
  const a = Math.floor((lo - span * pad) / step) * step;
  const b = Math.ceil((hi + span * pad) / step) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { domain: [a, b], ticks };
}

/* ───────────────── Tiles & chips ───────────────── */

export function Tile({ label, value, unit, icon, children, delay = 0 }: {
  label: string; value: ReactNode; unit?: string; icon?: ReactNode; children?: ReactNode; delay?: number;
}) {
  return (
    <div className="card rise flex min-w-0 flex-col p-5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] leading-snug text-ink-3">{label}</p>
        {icon}
      </div>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5 text-[28px] font-semibold leading-none tracking-[-0.02em]">
        {value}
        {unit && <span className="text-[13px] font-medium tracking-normal text-ink-3">{unit}</span>}
      </p>
      {children && <div className="mt-auto pt-3 text-[12px] leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

/** Seasonal class chip: glyph + short label (never colour alone); full class name on hover / for screen readers. */
export function ClassChip({ cls }: { cls: SeasonalClass }) {
  const s = CLASS_STYLE[cls] ?? CLASS_STYLE.Steady;
  return (
    <span title={cls} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-[3px] text-[11px] font-medium leading-none ${s.tone}`}>
      <span aria-hidden className="text-[8px] leading-none">{s.glyph}</span>
      <span aria-hidden>{s.short}</span>
      <span className="sr-only">{cls}</span>
    </span>
  );
}

/** Three-dot strength reading (●●○ Moderate). */
export function Reading({ level, label, title }: { level: 0 | 1 | 2 | 3; label: string; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12px] font-medium leading-none text-ink-2">
      <span aria-hidden className="inline-flex gap-[3px]">
        {[1, 2, 3].map((i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i <= level ? "bg-ink" : "bg-[#d9d7cf]"}`} />)}
      </span>
      {label}
    </span>
  );
}

/** Legend key that mirrors the mark: rect for bars, short stroke for lines, an upright tick for markers. */
export function Key({ kind, color, label }: { kind: "rect" | "line" | "dash" | "tick" | "area"; color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      {kind === "rect" && <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: color }} />}
      {kind === "area" && <span className="h-2.5 w-3.5 rounded-[3px] border-t-2" style={{ background: `${color}2e`, borderColor: color }} />}
      {kind === "tick" && <span className="h-3.5 w-[3px] rounded-full ring-2 ring-white" style={{ background: color }} />}
      {(kind === "line" || kind === "dash") && (
        <svg width="18" height="6" aria-hidden>
          <line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={kind === "dash" ? "4 3" : undefined} />
        </svg>
      )}
      {label}
    </span>
  );
}

export function Keys({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">{children}</div>;
}

/* ───────────────── Tooltip shell (values lead, labels follow; line keys, not boxes) ───────────────── */

export type TipRow = { label: string; value: string; note?: string; color?: string; dash?: boolean; rect?: boolean };

export function TipShell({ title, rows, foot }: { title: string; rows: TipRow[]; foot?: string }) {
  return (
    <div className="min-w-[200px] max-w-[300px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
      <p className="mb-2 font-medium text-ink">{title}</p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4">
            <span className="inline-flex min-w-0 items-center gap-1.5 pt-px text-ink-3">
              {r.color && (r.rect
                ? <span className="h-2 w-2.5 shrink-0 rounded-[2px]" style={{ background: r.color }} />
                : <svg width="12" height="4" aria-hidden className="shrink-0"><line x1="1" y1="2" x2="11" y2="2" stroke={r.color} strokeWidth="2" strokeLinecap="round" strokeDasharray={r.dash ? "3 2" : undefined} /></svg>)}
              {r.label}
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-semibold text-ink tnum">{r.value}</span>
              {r.note && <span className="block text-[11px] text-ink-3 tnum">{r.note}</span>}
            </span>
          </div>
        ))}
      </div>
      {foot && <p className="mt-2 border-t border-hairline pt-2 text-[11px] leading-snug text-ink-3">{foot}</p>}
    </div>
  );
}

/* ───────────────── Recharts bar shape: 4px rounded data-end, square at the baseline (works for negatives) ───────────────── */

type ShapeProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; value?: number | number[] | null };

export function DataEndBar(props: unknown) {
  const { x = 0, y = 0, width = 0, height = 0, fill, value } = props as ShapeProps;
  const v = Array.isArray(value) ? value[1] - value[0] : value ?? 0;
  const top = Math.min(y, y + height);
  const h = Math.abs(height);
  if (h < 0.5 || width <= 0) return null;
  const r = Math.min(3, h, width / 2);
  const L = x, R = x + width, T = top, B = top + h;
  const d = v >= 0
    ? `M${L},${B} L${L},${T + r} Q${L},${T} ${L + r},${T} L${R - r},${T} Q${R},${T} ${R},${T + r} L${R},${B} Z`
    : `M${L},${T} L${R},${T} L${R},${B - r} Q${R},${B} ${R - r},${B} L${L + r},${B} Q${L},${B} ${L},${B - r} Z`;
  return <path d={d} fill={fill} />;
}

/* ───────────────── Chart labels with a surface halo (legible where they cross a line or bar) ───────────────── */

type VB = { viewBox?: { x?: number; y?: number; width?: number; height?: number } };

/** Recharts `label` renderer: text centred above the mark (e.g. a ReferenceDot). */
export function haloAbove(text: string) {
  return function HaloAbove(props: unknown) {
    const vb = (props as VB).viewBox;
    if (!vb || vb.x == null || vb.y == null) return null;
    return (
      <text x={vb.x + (vb.width ?? 0) / 2} y={vb.y - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill={C.ink}
        stroke="#fff" strokeWidth={4} strokeLinejoin="round" paintOrder="stroke">{text}</text>
    );
  };
}

/** Recharts `label` renderer: text at the right end, just above a horizontal ReferenceLine. */
export function haloLineEnd(text: string) {
  return function HaloLineEnd(props: unknown) {
    const vb = (props as VB).viewBox;
    if (!vb || vb.x == null || vb.y == null || vb.width == null) return null;
    return (
      <text x={vb.x + vb.width - 2} y={vb.y - 7} textAnchor="end" fontSize={11} fill="#3d3c39"
        stroke="#fff" strokeWidth={4} strokeLinejoin="round" paintOrder="stroke">{text}</text>
    );
  };
}

/* ───────────────── Text blocks ───────────────── */

export function Footnote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex gap-2 text-[12px] leading-relaxed text-ink-3 ${className}`}>
      <Info className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-3.5">
      {items.map((t, i) => (
        <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 text-[13px] leading-relaxed text-ink-2">
          <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full border border-hairline bg-surface-2 text-[11px] font-semibold text-ink-2 tnum">{i + 1}</span>
          <span className="pt-[2px]">{t}</span>
        </li>
      ))}
    </ol>
  );
}

export function MoreButton({ open, onClick, more, less = "Show fewer", controls }: {
  open: boolean; onClick: () => void; more: string; less?: string; controls?: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open} aria-controls={controls}
      className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-sunken hover:text-ink">
      {open ? less : more}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
    </button>
  );
}

/** Empty state inside a card. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {children && <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">{children}</p>}
    </div>
  );
}
