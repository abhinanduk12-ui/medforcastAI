"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
  usePlotArea, useXAxisScale,
} from "recharts";
import { AlertTriangle, ArrowUpRight, Check, CheckCircle2, CircleDashed, Info, LineChart as LineChartIcon, Plus, Search, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Card, CardHeader, ErrorState, Skeleton } from "@/components/ui";
import type { CalendarResp, CurvePayload, CurvesResp, GridPoint, SeasonalClass } from "./types";
import { ClassChip, MON, MONTH_START_DOY, SEASON_SPANS, SEASON_TINT, multText, qText, strengthWord } from "./a-bits";

/* Fixed categorical order; a series keeps its colour slot while it stays selected (colour follows the entity). */
const COLORS = [C.s1, C.s2, C.s3, C.s4];
const MAX = 4;
const FDR = 0.1;
const OBS_TONES = ["#aeaca3", "#55544f"]; // older year: light circle · newer year: dark diamond
const Y_W = 48;        // y-axis width (px)
const M_RIGHT = 16;
const STRIP_TOP = 48;  // the season strip sits this far above the plot; the "Today" pill sits between it and the plot

type Med = { id: string; name: string; generic: string; category: string };
type MedsResp = { count: number; items: Med[] };
type Opt = { key: string; kind: "cat" | "med"; label: string; sub: string; cls?: SeasonalClass };
type Shown = { key: string; slot: number; color: string; s: CurvePayload };
type ObsPlot = { doy: number; v: number; actual: number; year: number; week: string; clipped: number; tone: number };

const keyOf = (s: CurvePayload) => `${s.level === "category" ? "cat" : "med"}:${s.id}`;
const parseIds = (raw: string) => {
  const out: string[] = [];
  for (const x of raw.split(",").map((s) => s.trim())) if (/^(cat|med):.+/.test(x) && !out.includes(x)) out.push(x);
  return out.slice(0, MAX);
};

/** Multiplier at any day of the year by circular linear interpolation of the weekly grid. */
function multAt(grid: GridPoint[], doy: number): number {
  const n = grid.length;
  if (!n) return 1;
  const i = grid.findIndex((g) => g.doy > doy);
  const a = i <= 0 ? grid[n - 1] : grid[i - 1];
  const b = i === -1 ? grid[0] : grid[i];
  const ad = a.doy, bd = i === -1 || i === 0 ? b.doy + 365 : b.doy;
  const d = i === 0 ? doy + 365 : doy;
  const t = bd === ad ? 0 : (d - ad) / (bd - ad);
  return a.m + t * (b.m - a.m);
}

/* ───────────────────────── picker ───────────────────────── */

function Picker({ cats, meds, medsLoading, selected, onToggle }: {
  cats: Opt[]; meds: Opt[]; medsLoading: boolean; selected: string[]; onToggle: (key: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const full = selected.length >= MAX;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const needle = q.trim().toLowerCase();
  const catOpts = useMemo(() => cats.filter((c) => !needle || c.label.toLowerCase().includes(needle)), [cats, needle]);
  const medOpts = useMemo(() => (needle
    ? meds.filter((m) => m.label.toLowerCase().startsWith(needle))
    : []), [meds, needle]);
  const flat = useMemo(() => [...catOpts, ...medOpts], [catOpts, medOpts]);
  const optId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => { setActive(0); }, [needle]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const choose = (o: Opt) => {
    const isSel = selected.includes(o.key);
    if (!isSel && full) return;
    onToggle(o.key);
    setQ("");
    if (!isSel) setOpen(false);
    inputRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { if (open && flat[active]) { e.preventDefault(); choose(flat[active]); } }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const renderOpt = (o: Opt, i: number) => {
    const isSel = selected.includes(o.key);
    const disabled = !isSel && full;
    return (
      <li key={o.key} id={optId(i)} role="option" aria-selected={i === active} aria-disabled={disabled}
        onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseMove={() => setActive(i)}
        className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px] ${i === active ? "bg-sunken" : ""} ${disabled ? "cursor-not-allowed opacity-45" : ""}`}>
        <span className="grid h-4 w-4 shrink-0 place-items-center">
          {isSel ? <Check className="h-4 w-4 text-brand" strokeWidth={2.4} aria-hidden /> : <Plus className="h-3.5 w-3.5 text-ink-3" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-ink">{o.label}</span>
          {o.kind === "med" && <span className="block truncate text-[12px] text-ink-3">{o.sub}</span>}
        </span>
        {o.cls && <ClassChip c={o.cls} compact />}
      </li>
    );
  };

  return (
    <div ref={boxRef} className="relative w-full lg:w-[400px] lg:shrink-0">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && flat[active] ? optId(active) : undefined}
          aria-label="Add a category or medicine to compare"
          placeholder={full ? "Four series selected: remove one to add another" : "Add a category or medicine…"}
          className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-4 text-[14px] placeholder:text-muted" />
      </label>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-hairline bg-surface shadow-[0_18px_40px_-16px_rgba(11,11,11,0.28)]">
          <ul id={listId} role="listbox" aria-label="Categories and medicines" className="max-h-[360px] overflow-y-auto p-1.5">
            {catOpts.length > 0 && <li role="presentation" className="eyebrow px-3 pb-1 pt-2">Categories</li>}
            {catOpts.map((o, i) => renderOpt(o, i))}
            {needle && <li role="presentation" className="eyebrow px-3 pb-1 pt-3">Medicines</li>}
            {medOpts.map((o, i) => renderOpt(o, catOpts.length + i))}
            {needle && !medOpts.length && (
              <li role="presentation" className="px-3 py-2 text-[12.5px] text-ink-3">{medsLoading ? "Loading medicines…" : `No medicine matches “${q.trim()}”.`}</li>
            )}
            {!needle && (
              <li role="presentation" className="px-3 pb-2 pt-3 text-[12px] text-ink-3">Type to search {meds.length ? fmt.int(meds.length) : "all"} medicines by name, generic or ID.</li>
            )}
          </ul>
          {full && <p className="border-t border-hairline bg-surface-2 px-4 py-2 text-[12px] text-ink-3">Up to four series at a time. Remove one to add another.</p>}
        </div>
      )}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <svg width="18" height="10" aria-hidden className="shrink-0">
      <rect x="0" y="1" width="18" height="8" rx="2" fill={color} opacity={0.16} />
      <line x1="1" y1="5" x2="17" y2="5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ───────────────────────── chart ───────────────────────── */

function niceStep(range: number) {
  for (const s of [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2]) if (range / s <= 8) return s;
  return 5;
}

/** y-domain: curves and bands first; observed weeks may widen it, but by at most 40% of the curves' span
 *  (more extreme single weeks are pinned to the edge, so one noisy week cannot flatten every curve). */
function yDomain(shown: Shown[], threshold: number, obsVals: number[]): [number, number] {
  let lo = Math.min(0, ...shown.flatMap((it) => it.s.grid.map((p) => p.lo - 1)));
  let hi = Math.max(threshold - 1, ...shown.flatMap((it) => it.s.grid.map((p) => p.hi - 1)));
  if (obsVals.length) {
    const span = hi - lo;
    lo = Math.max(Math.min(lo, ...obsVals), lo - span * 0.4, -1);
    hi = Math.min(Math.max(hi, ...obsVals), hi + span * 0.4);
  }
  const pad = (hi - lo) * 0.04;
  return [lo - pad, hi + pad];
}

/** Season strip drawn inside the chart, above the plot, from the chart's own x scale (always aligned). */
function SeasonStrip() {
  const area = usePlotArea();
  const xs = useXAxisScale();
  if (!area || !xs) return null;
  const y = area.y - STRIP_TOP;
  return (
    <g aria-hidden>
      {SEASON_SPANS.map((sp) => {
        const x0 = xs(sp.from), x1 = xs(Math.min(sp.to + 1, 365));
        if (x0 == null || x1 == null) return null;
        const t = SEASON_TINT[sp.season];
        const w = x1 - x0 - 2;
        const showName = w > sp.season.length * 6.1 + 30;
        return (
          <g key={`${sp.season}-${sp.from}`}>
            <rect x={x0 + 1} y={y} width={Math.max(w, 0)} height={20} rx={6} fill={t.bg} />
            {w > 18 && <t.Icon x={x0 + 7} y={y + 4} size={12} color={t.ink} strokeWidth={1.8} />}
            {showName && <text x={x0 + 24} y={y + 14} fontSize={10.5} fontWeight={500} fill={t.ink}>{sp.season}</text>}
          </g>
        );
      })}
    </g>
  );
}

function TodayLabel(props: { viewBox?: { x?: number; y?: number } }) {
  const x = props.viewBox?.x ?? 0, y = props.viewBox?.y ?? 0;
  return (
    <g>
      <rect x={x - 21} y={y - 19} width={42} height={16} rx={8} fill={C.ink} />
      <text x={x} y={y - 8} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#ffffff">Today</text>
    </g>
  );
}

function ThresholdLabel(props: { viewBox?: { x?: number; y?: number; width?: number }; value?: string }) {
  const x = (props.viewBox?.x ?? 0) + (props.viewBox?.width ?? 0) - 4, y = props.viewBox?.y ?? 0;
  return (
    <text x={x} y={y - 5} textAnchor="end" fontSize={10.5} fill="#6b6a65" stroke="#ffffff" strokeWidth={3} paintOrder="stroke">
      {props.value}
    </text>
  );
}

function obsShape(props: unknown): ReactElement {
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload?: ObsPlot };
  if (cx == null || cy == null || !payload) return <g />;
  const fill = OBS_TONES[payload.tone];
  if (payload.clipped) {
    const up = payload.clipped > 0;
    const tip = up ? cy - 1 : cy + 1, base = up ? cy + 6 : cy - 6;
    return <path d={`M${cx},${tip} L${cx - 4.5},${base} L${cx + 4.5},${base} Z`} fill={fill} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />;
  }
  if (payload.tone === 1) {
    return <rect x={cx - 3.4} y={cy - 3.4} width={6.8} height={6.8} transform={`rotate(45 ${cx} ${cy})`} fill={fill} stroke="#ffffff" strokeWidth={1.5} />;
  }
  return <circle cx={cx} cy={cy} r={3.8} fill={fill} stroke="#ffffff" strokeWidth={1.5} />;
}

type ChartRow = { doy: number; label: string } & Record<string, number | string | [number, number]>;

function CurveChart({ shown, today, threshold, showObs, years }: {
  shown: Shown[]; today: number; threshold: number; showObs: boolean; years: number[];
}) {
  const first = shown[0];
  const { rows, domain, ticks, obs } = useMemo(() => {
    const g0 = first.s.grid;
    const rows: ChartRow[] = g0.map((g, i) => {
      const r: ChartRow = { doy: g.doy, label: g.label };
      for (const it of shown) {
        const p = it.s.grid[i];
        if (!p) continue;
        r[`m${it.slot}`] = p.m - 1;
        r[`b${it.slot}`] = [p.lo - 1, p.hi - 1];
      }
      return r;
    });
    // Close the circle: a point on 31 Dec interpolated between the last grid week and 1 Jan.
    const last = g0[g0.length - 1];
    if (last && last.doy < 365) {
      const t = (365 - last.doy) / (g0[0].doy + 365 - last.doy);
      const r: ChartRow = { doy: 365, label: "31 Dec" };
      for (const it of shown) {
        const a = it.s.grid[it.s.grid.length - 1], b = it.s.grid[0];
        if (!a || !b) continue;
        const lerp = (x: number, y: number) => x + t * (y - x);
        r[`m${it.slot}`] = lerp(a.m, b.m) - 1;
        r[`b${it.slot}`] = [lerp(a.lo, b.lo) - 1, lerp(a.hi, b.hi) - 1];
      }
      rows.push(r);
    }
    const raw = showObs ? (first.s.observed ?? []) : [];
    const [lo, hi] = yDomain(shown, threshold, raw.map((o) => o.ratio - 1));
    const step = niceStep(hi - lo);
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
    const obs: ObsPlot[] = raw.map((o) => {
      const v = o.ratio - 1;
      const clipped = v > hi ? 1 : v < lo ? -1 : 0;
      return { doy: o.doy, v: clipped > 0 ? hi : clipped < 0 ? lo : v, actual: v, year: o.year, week: o.week, clipped, tone: Math.min(years.indexOf(o.year), 1) };
    });
    return { rows, domain: [lo, hi] as [number, number], ticks, obs };
  }, [shown, first, threshold, showObs, years]);

  const nearest = useCallback((doy: number) => {
    let best = rows[0], bd = Infinity;
    for (const r of rows) { const d = Math.abs(r.doy - doy); if (d < bd) { bd = d; best = r; } }
    return best;
  }, [rows]);

  return (
    <div>
      <ResponsiveContainer width="100%" height={390}>
        <ComposedChart data={rows} margin={{ top: STRIP_TOP + 4, right: M_RIGHT, bottom: 0, left: 0 }}>
          <SeasonStrip />
          {SEASON_SPANS.map((sp) => (
            <ReferenceArea key={`${sp.season}-${sp.from}`} x1={sp.from} x2={Math.min(sp.to + 1, 365)} fill={SEASON_TINT[sp.season].bg}
              fillOpacity={0.55} stroke="none" ifOverflow="hidden" />
          ))}
          <CartesianGrid vertical={false} />
          <XAxis type="number" dataKey="doy" domain={[1, 365]} ticks={MONTH_START_DOY} interval={0} allowDataOverflow
            tickFormatter={(d: number) => MON[MONTH_START_DOY.indexOf(d)] ?? ""} tickLine={false} axisLine={{ stroke: C.axis }} />
          <YAxis type="number" domain={domain} ticks={ticks} allowDataOverflow width={Y_W} tickLine={false} axisLine={false}
            tickFormatter={(v: number) => fmt.signedPct(v)} />
          <ReferenceLine y={0} stroke="#a9a79e" strokeWidth={1.25} />
          <ReferenceLine y={threshold - 1} stroke="#8d8b83" strokeDasharray="4 4" strokeWidth={1}
            label={<ThresholdLabel value={`Season threshold ${fmt.signedPct(threshold - 1)}`} />} />
          {shown.map((it) => (
            <Area key={`b-${it.key}`} dataKey={`b${it.slot}`} type="monotone" stroke="none" fill={it.color} fillOpacity={0.12}
              isAnimationActive={false} activeDot={false} legendType="none" />
          ))}
          {shown.map((it) => (
            <Line key={`m-${it.key}`} dataKey={`m${it.slot}`} type="monotone" stroke={it.color} strokeWidth={2} dot={false}
              strokeLinecap="round" strokeLinejoin="round" activeDot={{ r: 4.5, stroke: "#ffffff", strokeWidth: 2 }} isAnimationActive={false} />
          ))}
          {obs.length > 0 && (
            <Scatter data={obs} dataKey="v" shape={obsShape} isAnimationActive={false} legendType="none" />
          )}
          <ReferenceLine x={today} stroke={C.ink} strokeOpacity={0.55} strokeWidth={1} label={<TodayLabel />} />
          <Tooltip
            cursor={{ stroke: C.axis, strokeWidth: 1 }}
            content={(p) => {
              if (!p.active || p.label == null) return null;
              const row = nearest(Number(p.label));
              if (!row) return null;
              const near = obs.filter((o) => Math.abs(o.doy - row.doy) <= 3.5);
              return (
                <div className="min-w-[220px] max-w-[300px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
                  <p className="mb-2 font-medium text-ink">Week of {row.label}</p>
                  <div className="space-y-2">
                    {shown.map((it) => {
                      const m = row[`m${it.slot}`] as number | undefined;
                      const b = row[`b${it.slot}`] as [number, number] | undefined;
                      if (m == null) return null;
                      return (
                        <div key={it.key}>
                          <div className="flex items-center justify-between gap-4">
                            <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-2">
                              <svg width="12" height="4" aria-hidden className="shrink-0"><line x1="1" y1="2" x2="11" y2="2" stroke={it.color} strokeWidth="2" strokeLinecap="round" /></svg>
                              <span className="truncate">{it.s.label}</span>
                            </span>
                            <span className="tnum font-semibold text-ink">{fmt.signedPct(m)}</span>
                          </div>
                          {b && <p className="pl-[18px] text-[11px] text-ink-3 tnum">90% band {fmt.signedPct(b[0])} to {fmt.signedPct(b[1])}</p>}
                        </div>
                      );
                    })}
                  </div>
                  {near.length > 0 && (
                    <div className="mt-2.5 border-t border-hairline pt-2">
                      <p className="mb-1 text-[11px] text-ink-3">Observed · {first.s.label}</p>
                      {near.map((o) => (
                        <div key={o.week} className="flex items-center justify-between gap-4 text-ink-2">
                          <span>Week of {fmt.weekYear(o.week)}</span>
                          <span className="tnum font-medium text-ink">{fmt.signedPct(o.actual)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────────────────── stat cards ───────────────────────── */

function Item({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-semibold leading-snug tracking-tight text-ink">{value}</dd>
      {sub && <dd className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{sub}</dd>}
    </div>
  );
}

function StatCard({ it, today, single, delay }: { it: Shown; today: number; single: boolean; delay: number }) {
  const s = it.s;
  const isMed = s.level === "medicine";
  const sig = s.q != null && s.q < FDR;
  const now = multAt(s.grid, today) - 1;
  const sw = s.shrink_weight;
  const weeks = s.observed?.length ?? null;
  return (
    <Card className="flex flex-col p-5" delay={delay}>
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5"><Swatch color={it.color} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold tracking-tight" title={s.label}>{s.label}</h3>
          <p className="truncate text-[12px] text-ink-3">{isMed ? `${s.category} · ${s.id}` : "Category"}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ClassChip c={s.class} />
        {s.small_sample && (
          <span className="inline-flex items-center gap-1 rounded-md border border-[#f6e0a6] bg-[#fff6de] px-1.5 py-px text-[11px] font-medium text-[#7a5300]">
            <AlertTriangle className="h-3 w-3" aria-hidden />Small sample
          </span>
        )}
      </div>

      <dl className={`mt-4 grid gap-x-5 gap-y-3.5 ${single ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-2"}`}>
        <Item label="Peak" value={<>{s.peak} <span className="font-medium text-ink-2 tnum">{multText(s.peak_mult)}</span></>} sub="vs average week" />
        <Item label="Low point" value={<>{s.trough} <span className="font-medium text-ink-2 tnum">{fmt.signedPct(s.trough_mult - 1)}</span></>} sub="vs average week" />
        <Item label="Season window" value={s.onset && s.end ? `${s.onset} – ${s.end}` : "No distinct season"}
          sub={s.onset && s.end ? `${s.duration_days} days at +10% or more` : "never reaches +10%"} />
        <Item label="This week" value={<span className="tnum">{fmt.signedPct(now)}</span>} sub="on the curve" />
        <Item label="Amplitude" value={<span className="tnum">{s.amplitude.toFixed(2)}×</span>} sub="peak ÷ low week" />
        <Item label="Strength" title="Seasonality strength: the share of week-to-week variation (log scale) that the seasonal curve explains, 0 to 1."
          value={<span className="tnum">{s.strength.toFixed(2)} <span className="font-medium text-ink-2">· {strengthWord(s.strength)}</span></span>}
          sub="variation explained (0–1)" />
        <Item label="Evidence"
          title={s.p != null ? `F test vs a flat year: p = ${s.p < 0.001 ? "< 0.001" : s.p.toFixed(3)}; q is p adjusted for testing many series at once (Benjamini-Hochberg).` : "Fewer than 12 bills: not tested."}
          value={s.tested && s.q != null
            ? <span className="inline-flex items-center gap-1 tnum">{sig ? <CheckCircle2 className="h-3.5 w-3.5 text-good" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5 text-ink-3" aria-hidden />}{qText(s.q)}</span>
            : "Not tested"}
          sub={!s.tested || s.q == null ? "too few sales to test"
            : sig ? "significant (q < 0.10)"
              : s.class === "Seasonal (category evidence)" ? "not on its own sales" : "not significant"} />
        {sw != null && (
          <Item label="Shape from" title={isMed ? "Empirical-Bayes shrinkage: sparse medicines borrow their category's shape." : "Small categories are shrunk toward a flat year in proportion to their sampling error."}
            value={<span className="tnum">{fmt.pct(sw)} own data</span>}
            sub={isMed ? `${fmt.pct(1 - sw)} from category` : `${fmt.pct(1 - sw)} toward flat`} />
        )}
        <Item label="Rainfall link" title="Spearman rank correlation between the monthly profile and Kochi's monthly rainfall climatology."
          value={<span className="tnum">{s.rain_corr == null ? "—" : `${s.rain_corr >= 0 ? "+" : "−"}${Math.abs(s.rain_corr).toFixed(2)}`}</span>}
          sub="vs Kochi monthly rain" />
        <Item label="Sales behind it" value={<span className="tnum">{fmt.int(s.units)} units</span>}
          sub={`${fmt.int(s.transactions)} bills${weeks ? ` · ${weeks} wk` : ""}`} />
      </dl>

      {isMed && (
        <div className="mt-auto pt-4">
          <Link href={`/medicines/${s.id}`} className="focus-ring inline-flex items-center gap-1 rounded text-[13px] font-medium text-brand hover:underline">
            Open medicine <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      )}
    </Card>
  );
}

/* ───────────────────────── tab ───────────────────────── */

export default function CurvesTab() {
  const params = useSearchParams();
  const router = useRouter();
  const rawIds = params.get("ids");
  const urlIds = useMemo(() => (rawIds != null ? parseIds(rawIds) : null), [rawIds]);

  const { data: cal, error: calError } = useApi<CalendarResp>("/api/seasonal/calendar");
  const { data: medsResp, loading: medsLoading } = useApi<MedsResp>("/api/medicines?limit=500");

  const defaultIds = useMemo(() => (cal
    ? cal.rows.filter((r) => r.q != null && r.q < FDR && !r.small_sample).sort((a, b) => b.amplitude - a.amplitude).slice(0, 2).map((r) => `cat:${r.id}`)
    : null), [cal]);
  const ids = urlIds ?? defaultIds;

  // Colour slots: survivors keep their slot when a series is removed; a new series takes the lowest free slot.
  const slotRef = useRef<Map<string, number>>(new Map());
  const slots = useMemo(() => {
    const prev = slotRef.current, next = new Map<string, number>(), used = new Set<number>();
    for (const id of ids ?? []) { const s = prev.get(id); if (s != null && !used.has(s)) { next.set(id, s); used.add(s); } }
    for (const id of ids ?? []) if (!next.has(id)) { let s = 0; while (used.has(s)) s++; next.set(id, s); used.add(s); }
    return next;
  }, [ids]);
  useEffect(() => { slotRef.current = slots; }, [slots]);

  const path = ids && ids.length ? `/api/seasonal/curves?ids=${encodeURIComponent(ids.join(","))}` : null;
  const { data, error, status, loading } = useApi<CurvesResp>(path);
  // null = automatic: observed weeks are shown unless most of them would be pinned to the chart edge (very sparse sellers).
  const [obsPref, setObsPref] = useState<boolean | null>(null);

  const setIds = useCallback((next: string[]) => {
    router.replace(`/seasons?tab=curves&ids=${encodeURIComponent(next.join(","))}`, { scroll: false });
  }, [router]);
  const toggle = useCallback((key: string) => {
    const cur = ids ?? [];
    if (cur.includes(key)) setIds(cur.filter((x) => x !== key));
    else if (cur.length < MAX) setIds([...cur, key]);
  }, [ids, setIds]);

  const catOpts: Opt[] = useMemo(() => (cal?.rows ?? []).map((r) => ({ key: `cat:${r.id}`, kind: "cat", label: r.label, sub: "Category", cls: r.class })), [cal]);
  const medOpts: Opt[] = useMemo(() => (medsResp?.items ?? [])
    .map((m) => ({ key: `med:${m.id}`, kind: "med" as const, label: m.name, sub: `${m.generic ? `${m.generic} · ` : ""}${m.category}` }))
    .sort((a, b) => a.label.localeCompare(b.label)), [medsResp]);
  const medName = useMemo(() => new Map((medsResp?.items ?? []).map((m) => [m.id, m.name])), [medsResp]);

  const byKey = useMemo(() => new Map((data?.series ?? []).map((s) => [keyOf(s), s])), [data]);
  const shown: Shown[] = useMemo(() => (ids ?? []).flatMap((id) => {
    const s = byKey.get(id);
    const slot = slots.get(id) ?? 0;
    return s ? [{ key: id, slot, color: COLORS[slot], s }] : [];
  }), [ids, byKey, slots]);
  const nameOf = (id: string) => byKey.get(id)?.label ?? (id.startsWith("cat:") ? id.slice(4) : medName.get(id.slice(4)) ?? id.slice(4));
  const pending = (ids ?? []).some((id) => !byKey.has(id));

  const firstObs = shown[0]?.s.observed ?? [];
  const years = useMemo(() => [...new Set(firstObs.map((o) => o.year))].sort(), [firstObs]);
  const clippedAll = useMemo(() => {
    const vals = firstObs.map((o) => o.ratio - 1);
    if (!vals.length || !shown.length) return 0;
    const [lo, hi] = yDomain(shown, data?.threshold ?? 1.1, vals);
    return vals.filter((v) => v > hi || v < lo).length;
  }, [shown, firstObs, data]);
  const salesWeeks = firstObs.filter((o) => o.ratio > 0).length;
  const obsUseful = firstObs.length > 0 && clippedAll / firstObs.length < 0.3;
  const showObs = firstObs.length > 0 && (obsPref ?? obsUseful);
  const clippedCount = showObs ? clippedAll : 0;
  const firstKey = shown[0]?.key;
  useEffect(() => { setObsPref(null); }, [firstKey]);

  if (calError) return <ErrorState error={calError} />;
  if (!ids) return <div className="space-y-6"><Skeleton className="h-[76px]" /><Skeleton className="h-[480px]" /></div>;

  const badRequest = error && (status === 404 || status === 422);

  return (
    <>
      {/* picker */}
      <Card className="relative z-20 p-5" delay={20}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <Picker cats={catOpts} meds={medOpts} medsLoading={medsLoading && !medsResp} selected={ids} onToggle={toggle} />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {ids.map((id) => {
              const color = COLORS[slots.get(id) ?? 0];
              const name = nameOf(id);
              return (
                <span key={id} className="inline-flex max-w-full items-center gap-2 rounded-full border border-hairline bg-surface-2 py-1 pl-3 pr-1 text-[13px]">
                  <Swatch color={color} />
                  <span className="min-w-0 truncate font-medium text-ink" title={name}>{name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{id.startsWith("cat:") ? "category" : "medicine"}</span>
                  <button onClick={() => toggle(id)} aria-label={`Remove ${name}`}
                    className="focus-ring grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-3 transition hover:bg-sunken hover:text-ink">
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </span>
              );
            })}
            {ids.length > 0 && (
              <>
                <span className="text-[12px] text-ink-3 tnum">{ids.length} of {MAX}</span>
                <button onClick={() => setIds([])} className="focus-ring rounded px-1 text-[12px] font-medium text-ink-3 hover:text-ink hover:underline">Clear</button>
              </>
            )}
            {!ids.length && <span className="text-[13px] text-ink-3">Compare up to four categories or medicines.</span>}
          </div>
        </div>
      </Card>

      {ids.length === 0 ? (
        <Card className="mt-6 px-6 py-14 text-center" delay={60}>
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-wash text-brand"><LineChartIcon className="h-6 w-6" aria-hidden /></span>
          <p className="mt-4 text-[15px] font-semibold">Pick something to compare</p>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">
            Search above for a category or a medicine. Or start with the clearest seasonal patterns in the data:
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {(cal?.rows ?? []).filter((r) => r.q != null && r.q < FDR && !r.small_sample).slice(0, 6).map((r) => (
              <button key={r.id} onClick={() => toggle(`cat:${r.id}`)}
                className="focus-ring inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-[13px] text-ink-2 transition hover:bg-sunken hover:text-ink">
                <Plus className="h-3.5 w-3.5" aria-hidden />{r.label}<ClassChip c={r.class} compact />
              </button>
            ))}
          </div>
        </Card>
      ) : badRequest ? (
        <Card className="mt-6 px-6 py-12 text-center" delay={60}>
          <p className="text-[15px] font-semibold">One of the selected series could not be found</p>
          <p className="mt-1.5 text-[13px] text-ink-3">{error}</p>
          <button onClick={() => router.replace("/seasons?tab=curves", { scroll: false })}
            className="focus-ring mt-5 inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white hover:bg-[#262624]">
            Reset the selection
          </button>
        </Card>
      ) : error && !data ? (
        <div className="mt-6"><ErrorState error={error} /></div>
      ) : !shown.length || !data ? (
        <div className="mt-6 space-y-6"><Skeleton className="h-[470px]" /><div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-[300px]" /><Skeleton className="h-[300px]" /></div></div>
      ) : (
        <>
          <Card className="mt-6" delay={60}>
            <CardHeader title="How demand moves through the year"
              sub="Change in weekly demand vs an average week, through a generic January–December year. Shaded: 90% uncertainty band."
              right={firstObs.length > 0 ? (
                <button onClick={() => setObsPref(!showObs)} aria-pressed={showObs}
                  className={`focus-ring inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition ${showObs ? "border-hairline bg-sunken text-ink" : "border-hairline bg-surface text-ink-3 hover:text-ink"}`}>
                  <span className={`grid h-3.5 w-3.5 place-items-center rounded-[4px] border ${showObs ? "border-ink bg-ink text-white" : "border-[#c3c2b7]"}`}>
                    {showObs && <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />}
                  </span>
                  Observed weeks
                </button>
              ) : undefined} />
            <div className={`px-3 pb-5 pt-4 transition-opacity sm:px-5 ${loading && pending ? "opacity-60" : ""}`}>
              <CurveChart shown={shown} today={data.today_doy} threshold={data.threshold} showObs={showObs} years={years} />

              {/* legend */}
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 pl-1 text-[12px] text-ink-2 sm:pl-[48px]">
                {shown.map((it) => (
                  <span key={it.key} className="inline-flex min-w-0 items-center gap-1.5"><Swatch color={it.color} /><span className="truncate">{it.s.label}</span></span>
                ))}
                {showObs && firstObs.length > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-ink-3">Actual weeks of {shown[0].s.label}:</span>
                    {years.map((y, i) => (
                      <span key={y} className="inline-flex items-center gap-1">
                        <svg width="10" height="10" aria-hidden>
                          {i === 0
                            ? <circle cx="5" cy="5" r="3.8" fill={OBS_TONES[0]} />
                            : <rect x="1.6" y="1.6" width="6.8" height="6.8" transform="rotate(45 5 5)" fill={OBS_TONES[1]} />}
                        </svg>
                        {y}
                      </span>
                    ))}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="#8d8b83" strokeWidth="1.25" strokeDasharray="4 3" /></svg>
                  Season threshold (+{Math.round((data.threshold - 1) * 100)}%)
                </span>
              </div>

              <p className="mt-3 flex items-start gap-2 pl-1 text-[12px] leading-relaxed text-ink-3 sm:pl-[48px]">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Read it like a forecast of a typical year: 0% is an average week and +20% means a fifth more demand than usual; where a line
                  stays above the dashed threshold is that series&apos; season. Curves are fitted to about one year of (synthetic) sales,
                  so the bands are wide where that one year was noisy.
                  {showObs && <> Dots are single real weeks, far noisier than the curve{clippedCount > 0 && <>; {clippedCount} extreme week{clippedCount === 1 ? " is" : "s are"} pinned to the chart edge as ▲/▼ (hover for the value)</>}.</>}
                  {!showObs && obsPref == null && firstObs.length > 0 && <> Single weeks are hidden: {shown[0].s.label} {salesWeeks < firstObs.length * 0.6 ? `sold in only ${salesWeeks} of ${firstObs.length} weeks` : "swings far from its curve week to week"}, so weekly dots would mostly sit at the chart edges. Tick “Observed weeks” to show them anyway.</>}
                </span>
              </p>
            </div>
          </Card>

          <div className={`mt-6 grid gap-4 ${shown.length === 1 ? "grid-cols-1" : shown.length === 2 ? "md:grid-cols-2" : shown.length === 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2 xl:grid-cols-4"}`}>
            {shown.map((it, i) => <StatCard key={it.key} it={it} today={data.today_doy} single={shown.length === 1} delay={90 + i * 30} />)}
          </div>
        </>
      )}
    </>
  );
}
