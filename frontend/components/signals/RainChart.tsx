"use client";

import { Area, Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C } from "@/components/charts";
import { Legend } from "@/components/ui";
import { dayFmt, mm, monthFmt, type ChartWeek, type SeasonalMonth } from "./model";

const CLIM = "#a9a79c";

/** Weekly rain (mm, one axis): observed bars, forecast bars stacked on observed days of the same week, climatology mean + p10–p90 band. */
export function RainChart({ data, height = 300 }: { data: ChartWeek[]; height?: number }) {
  const rows = data.map((d) => ({ ...d, band: d.clim_p10 != null && d.clim_p90 != null ? [d.clim_p10, d.clim_p90] : null }));
  const firstFc = data.find((d) => d.kind === "forecast")?.week;
  const isPartial = (d: ChartWeek) => d.kind === "forecast" && d.days_observed + d.days_forecast < 7;
  const anyPartial = data.some(isPartial);
  return (
    <div>
      <Legend items={[
        { label: "Observed (NASA POWER)", color: C.s1, kind: "dot" },
        { label: "Forecast (Open-Meteo)", color: C.s2, kind: "dot" },
        { label: "Normal (1991–2020 mean)", color: CLIM, kind: "dash" },
        { label: "Normal range (10th–90th pct)", color: CLIM, kind: "band" },
      ]} />
      {anyPartial && <p className="mt-1.5 text-[11.5px] text-ink-3">Paler bars are partial weeks (fewer than 7 days of data), so they sit lower than a full week would.</p>}
      <div className="mt-3" role="img" aria-label="Weekly rainfall in Kochi: observed and forecast against the 1991–2020 normal range">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 12, right: 8, bottom: 4, left: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="week" tickFormatter={dayFmt} tickLine={false} axisLine={{ stroke: C.axis }} minTickGap={22} />
            <YAxis tickLine={false} axisLine={false} width={40} label={{ value: "mm / week", angle: -90, position: "insideLeft", offset: 12, fill: C.muted, fontSize: 11 }} />
            {firstFc && <ReferenceLine x={firstFc} stroke={C.axis} label={{ value: "Forecast →", position: "insideTopRight", fill: C.muted, fontSize: 11 }} />}
            <Area dataKey="band" stroke="none" fill={CLIM} fillOpacity={0.18} isAnimationActive={false} />
            <Bar dataKey="observed" stackId="r" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={18} stroke="#fff" strokeWidth={1} isAnimationActive={false}>
              {rows.map((d) => <Cell key={d.week} fillOpacity={isPartial(d) ? 0.45 : 1} />)}
            </Bar>
            <Bar dataKey="forecast" stackId="r" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={18} stroke="#fff" strokeWidth={1} isAnimationActive={false}>
              {rows.map((d) => <Cell key={d.week} fillOpacity={isPartial(d) ? 0.45 : 1} />)}
            </Bar>
            <Line dataKey="clim_mean" stroke={CLIM} strokeWidth={2} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
            <Tooltip cursor={{ fill: "rgba(11,11,11,0.04)" }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as ChartWeek;
              const total = (p.observed ?? 0) + (p.forecast ?? 0);
              const partial = isPartial(p);
              return (
                <div className="min-w-[200px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]">
                  <p className="mb-2 font-medium text-ink">Week of {dayFmt(p.week)}</p>
                  <div className="space-y-1 text-ink-2">
                    {p.observed != null && <Row c={C.s1} l={`Observed${p.kind === "forecast" ? ` (${p.days_observed} d)` : ""}`} v={mm(p.observed)} />}
                    {p.forecast != null && <Row c={C.s2} l={`Forecast (${p.days_forecast} d)`} v={mm(p.forecast)} />}
                    {p.kind === "forecast" && <Row l="Total" v={mm(total)} />}
                    <Row c={CLIM} l="Normal" v={mm(p.clim_mean)} />
                    <Row l="Normal range" v={`${mm(p.clim_p10)} – ${mm(p.clim_p90)}`} />
                  </div>
                  {partial && <p className="mt-2 max-w-[220px] text-[11px] text-ink-3">Only {p.days_observed + p.days_forecast} of 7 days have data (observation lag or end of forecast), so this bar is not comparable to the normal.</p>}
                </div>
              );
            }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Row({ c, l, v }: { c?: string; l: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5">{c && <span className="h-2 w-2 rounded-full" style={{ background: c }} />}{l}</span>
      <span className="tnum font-medium text-ink">{v}</span>
    </div>
  );
}

/** Seasonal outlook as % of normal on one shared axis: ensemble 10–90 % whisker + median dot vs the normal range band. */
export function SeasonalOutlook({ months }: { months: SeasonalMonth[] }) {
  const MAX = 2.5;
  const members = Math.max(0, ...months.map((m) => m.members || 0));
  const anyPartial = months.some((m) => m.partial);
  const anyClipped = months.some((m) => m.clim_mean > 0 && m.p90 / m.clim_mean > MAX);
  const anyFallback = months.some((m) => m.clim_fallback);
  const x = (r: number) => `${(Math.min(Math.max(r, 0), MAX) / MAX) * 100}%`;
  return (
    <div>
      <Legend items={[
        { label: "Ensemble median", color: C.s1, kind: "dot" },
        { label: `Ensemble 10th–90th pct${members ? ` (${members} members)` : ""}`, color: C.s1, kind: "line" },
        { label: "Normal range", color: CLIM, kind: "band" },
      ]} />
      <div className="@container mt-4 space-y-2.5">
        {months.map((m) => {
          const r = (v: number | null) => (v == null || !m.clim_mean ? null : v / m.clim_mean);
          const lo = r(m.p10), hi = r(m.p90), med = r(m.median);
          const cl = r(m.clim_p10), ch = r(m.clim_p90);
          return (
            <div key={m.month} className="grid grid-cols-[52px_1fr] items-center gap-3 @lg:grid-cols-[60px_1fr_150px]"
              title={`${monthFmt(m.month)}: median ${Math.round(m.median)} mm (10–90%: ${Math.round(m.p10)}–${Math.round(m.p90)} mm) vs normal ${Math.round(m.clim_mean)} mm`}>
              <span className="text-[13px] text-ink-2">{monthFmt(m.month)}{m.partial ? <span aria-label="partial month">*</span> : ""}</span>
              <div className="relative h-7 rounded-lg bg-sunken">
                {cl != null && ch != null && <div className="absolute inset-y-1 rounded" style={{ left: x(cl), width: `calc(${x(ch)} - ${x(cl)})`, background: CLIM, opacity: 0.28 }} />}
                <div className="absolute inset-y-0 w-px" style={{ left: x(1), background: "#6b6a65" }} aria-hidden />
                {lo != null && hi != null && <div className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})`, background: C.s1 }} />}
                {med != null && <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style={{ left: x(med), background: C.s1 }} />}
              </div>
              <div className="col-span-2 -mt-1 flex justify-between gap-2 text-[12px] @lg:col-span-1 @lg:mt-0 @lg:block @lg:text-right">
                <span className="tnum font-medium">{Math.round(m.median)} mm <span className="font-normal text-ink-3">vs {Math.round(m.clim_mean)} normal</span></span>
                <span className="block text-[11px] text-ink-3">{Math.round(m.prob_above_normal * 100)}% of members above normal</span>
              </div>
            </div>
          );
        })}
        <div className="grid grid-cols-[52px_1fr] gap-3 text-[11px] text-muted @lg:grid-cols-[60px_1fr_150px]">
          <span />
          <div className="relative h-4">
            {[0, 0.5, 1, 1.5, 2, 2.5].map((t) => (
              <span key={t} className={`absolute whitespace-nowrap ${t === 0 ? "" : t === MAX ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: x(t) }}>{t === 1 ? "normal" : `${t * 100}%`}</span>
            ))}
          </div>
        </div>
        {(anyPartial || anyClipped || anyFallback) && (
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            {anyPartial && "* Partial month: only the days inside the outlook window. "}
            {anyClipped && `Ranges above ${MAX * 100}% of normal are cut at the edge. `}
            {anyFallback && "Some months use a built-in monthly normal because the ERA5 climatology is not cached."}
          </p>
        )}
      </div>
    </div>
  );
}
