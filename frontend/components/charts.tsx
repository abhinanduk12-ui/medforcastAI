"use client";

import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { fmt, MONTHS } from "@/lib/format";

export const C = {
  s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100", s5: "#e87ba4", s6: "#008300", s7: "#4a3aa7",
  ink: "#0b0b0b", muted: "#898781", grid: "#e9e8e2", axis: "#c3c2b7", surface: "#ffffff", brand: "#0e5c4f",
};

/* Diverging scale for seasonal index: blue (less demand) ← gray (no change) → red (more demand). */
const DIV_NEG = ["#f0efec", "#cde2fb", "#9ec5f4", "#5598e7", "#256abf"];
const DIV_POS = ["#f0efec", "#fbd9d6", "#f4aaa6", "#ea7471", "#c23b3a"];
export function divergingColor(index: number) {
  const d = index - 1;
  const steps = [0.04, 0.12, 0.22, 0.35];
  let k = 0;
  for (const s of steps) if (Math.abs(d) >= s) k++;
  return d >= 0 ? DIV_POS[k] : DIV_NEG[k];
}
export function inkOn(bg: string) {
  const n = parseInt(bg.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 150 ? "#ffffff" : "#0b0b0b";
}

/* ───────────────── Tooltip shell ───────────────── */
function TipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string; band?: boolean }[] }) {
  return (
    <div className="min-w-[180px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
      <p className="mb-2 font-medium text-ink">{title}</p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4">
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              {r.color && <span className="h-2 w-2 rounded-full" style={{ background: r.color, opacity: r.band ? 0.35 : 1 }} />}
              {r.label}
            </span>
            <span className="tnum font-medium text-ink">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Sparkline ───────────────── */
export function Sparkline({ data, width = 96, height = 28, color = C.s1 }: { data: number[]; width?: number; height?: number; color?: string }) {
  if (!data?.length) return null;
  const max = Math.max(...data, 1e-9), min = Math.min(...data, 0);
  const x = (i: number) => 2 + (i * (width - 6)) / Math.max(data.length - 1, 1);
  const y = (v: number) => height - 3 - ((v - min) / (max - min || 1)) * (height - 6);
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${d}L${x(data.length - 1)},${height}L${x(0)},${height}Z`;
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0 overflow-visible">
      <path d={area} fill={color} opacity={0.08} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2.5} fill={color} stroke="#fff" strokeWidth={1.5} />
    </svg>
  );
}

/* ───────────────── Forecast chart (history + holdout backtest + forecast band) ───────────────── */
export type SeriesPoint = { week: string; actual?: number | null; backtest?: number | null; forecast?: number | null; lo?: number | null; hi?: number | null };

export function ForecastChart({ data, height = 340, unit = "units" }: { data: SeriesPoint[]; height?: number; unit?: string }) {
  const rows = data.map((d) => ({ ...d, band: d.lo != null && d.hi != null ? [d.lo, d.hi] : null }));
  const lastActual = [...data].reverse().find((d) => d.actual != null)?.week;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 16, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="week" tickFormatter={fmt.week} tickLine={false} axisLine={{ stroke: C.axis }} minTickGap={28} />
        <YAxis tickFormatter={(v) => fmt.compact(v)} tickLine={false} axisLine={false} width={44} />
        {lastActual && (
          <ReferenceLine x={lastActual} stroke={C.axis} label={{ value: "Forecast →", position: "insideTopLeft", fill: C.muted, fontSize: 11, dx: 6 }} />
        )}
        <Area dataKey="band" stroke="none" fill={C.s2} fillOpacity={0.14} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="actual" stroke={C.s1} strokeWidth={2} dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
        <Line dataKey="backtest" stroke={C.s3} strokeWidth={2} dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} connectNulls={false} />
        <Line dataKey="forecast" stroke={C.s2} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
        <Tooltip
          cursor={{ stroke: C.axis, strokeWidth: 1 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as SeriesPoint;
            const rows = [];
            if (p.actual != null) rows.push({ label: "Actual", value: `${fmt.one(p.actual)} ${unit}`, color: C.s1 });
            if (p.backtest != null) rows.push({ label: "Backtest forecast", value: fmt.one(p.backtest), color: C.s3 });
            if (p.forecast != null && p.actual == null) rows.push({ label: "Forecast", value: `${fmt.one(p.forecast)} ${unit}`, color: C.s2 });
            if (p.lo != null && p.hi != null) rows.push({ label: "90% range", value: `${fmt.one(p.lo)} – ${fmt.one(p.hi)}`, color: C.s2, band: true });
            return <TipBox title={`Week of ${fmt.weekYear(String(label))}`} rows={rows} />;
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ───────────────── Seasonal index – diverging horizontal bars ───────────────── */
export function SeasonIndexBars({ items }: { items: { season: string; index: number; sub?: string; icon?: React.ReactNode }[] }) {
  const maxDev = Math.max(0.3, ...items.map((i) => Math.abs(i.index - 1)));
  return (
    <div className="space-y-3">
      {items.map((it) => {
        const d = it.index - 1;
        const w = (Math.abs(d) / maxDev) * 50;
        const col = d >= 0 ? "#ea7471" : "#5598e7";
        return (
          <div key={it.season} className="grid grid-cols-[120px_1fr_64px] items-center gap-3">
            <div className="flex items-center gap-2 text-[13px] text-ink-2">{it.icon}{it.season}</div>
            <div className="relative h-7 rounded-lg bg-sunken" title={`${it.season}: index ${it.index.toFixed(2)}`}>
              <div className="absolute inset-y-0 left-1/2 w-px bg-[#c3c2b7]" />
              <div
                className="absolute inset-y-1.5 transition-all duration-500"
                style={{ background: col, width: `${w}%`, left: d >= 0 ? "50%" : `${50 - w}%`, borderRadius: d >= 0 ? "0 4px 4px 0" : "4px 0 0 4px" }}
              />
            </div>
            <div className="text-right text-[13px] font-medium tnum">{`${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%`}</div>
          </div>
        );
      })}
      <div className="grid grid-cols-[120px_1fr_64px] gap-3 text-[11px] text-muted">
        <span />
        <div className="flex justify-between"><span>less demand</span><span>typical week</span><span>more demand</span></div>
        <span />
      </div>
    </div>
  );
}

/* ───────────────── Simple column chart (monthly / hourly profiles) ───────────────── */
export function Columns({ data, height = 200, color = C.s1, xFormatter, valueLabel = "units", highlight }: {
  data: { x: string | number; y: number | null }[]; height?: number; color?: string; xFormatter?: (v: any) => string; valueLabel?: string; highlight?: (x: any) => boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="x" tickFormatter={xFormatter} tickLine={false} axisLine={{ stroke: C.axis }} interval="preserveStartEnd" minTickGap={4} />
        <YAxis tickFormatter={(v) => fmt.compact(v)} tickLine={false} axisLine={false} width={38} />
        <Tooltip
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => active && payload?.length ? (
            <TipBox title={xFormatter ? xFormatter(payload[0].payload.x) : String(payload[0].payload.x)}
              rows={[{ label: valueLabel, value: fmt.one(payload[0].value as number), color }]} />
          ) : null}
        />
        <Bar dataKey="y" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={highlight ? (highlight(d.x) ? color : "#c9d9ee") : color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export const monthTick = (m: number) => MONTHS[m - 1];

/* ───────────────── Multi-line comparison (model lab) ───────────────── */
export function MultiLine({ data, x, series, height = 300, yFormatter = (v: number) => fmt.compact(v), xFormatter, valueFormatter = fmt.one }: {
  data: any[]; x: string; series: { key: string; label: string; color: string; dash?: boolean; width?: number }[];
  height?: number; yFormatter?: (v: number) => string; xFormatter?: (v: any) => string; valueFormatter?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey={x} tickFormatter={xFormatter} tickLine={false} axisLine={{ stroke: C.axis }} minTickGap={32} />
        <YAxis tickFormatter={yFormatter} tickLine={false} axisLine={false} width={44} domain={["auto", "auto"]} />
        <Tooltip
          cursor={{ stroke: C.axis }}
          content={({ active, payload, label }) => active && payload?.length ? (
            <TipBox title={xFormatter ? xFormatter(label) : String(label)}
              rows={series.map((s) => ({ label: s.label, value: valueFormatter(payload[0].payload[s.key]), color: s.color }))} />
          ) : null}
        />
        {series.map((s) => (
          <Line key={s.key} dataKey={s.key} stroke={s.color} strokeWidth={s.width ?? 2} strokeDasharray={s.dash ? "5 4" : undefined}
            dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ───────────────── Horizontal bar list (HTML – crisp labels, no clipping) ───────────────── */
export function BarList({ items, color = C.s1, format = fmt.compact, max }: {
  items: { label: string; value: number; sub?: string; href?: string }[]; color?: string; format?: (n: number) => string; max?: number;
}) {
  const m = max ?? Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.label} className="group" title={`${it.label}: ${format(it.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-ink-2">{it.label}</span>
            <span className="shrink-0 font-medium tnum">{format(it.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-sunken">
            <div className="h-2 rounded-full transition-all duration-500 group-hover:opacity-80" style={{ width: `${Math.max(1.5, (it.value / m) * 100)}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}
