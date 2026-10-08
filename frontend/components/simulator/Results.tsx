"use client";

import Link from "next/link";
import { CircleCheck, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { AbcBadge, Legend, Segmented, UpliftBadge } from "@/components/ui";
import { riskLevel, type CategoryRow, type MedRow, type RankBy, type SeriesRow, type SimResp } from "./model";

function Tip({ title, rows }: { title: string; rows: { label: string; value: string; color?: string; band?: boolean }[] }) {
  return (
    <div className="min-w-[200px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
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

/* ───────────── Store-level weekly demand: baseline vs scenario ───────────── */
export function ScenarioChart({ series, height = 320 }: { series: SeriesRow[]; height?: number }) {
  const rows = series.map((d) => ({ ...d, band: [d.lo, d.hi] as [number, number] }));
  const boundaries = series.filter((d, i) => i > 0 && d.season !== series[i - 1].season);
  const tb = series.reduce((a, d) => a + d.baseline, 0), ts = series.reduce((a, d) => a + d.scenario, 0);
  const summary = `Weekly store demand over ${series.length} weeks: baseline forecast ${fmt.int(tb)} units, scenario ${fmt.int(ts)} units (${fmt.signedPct(tb > 0 ? ts / tb - 1 : 0, 1)}).`;
  return (
    <>
      <div role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 18, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="week" tickFormatter={fmt.week} tickLine={false} axisLine={{ stroke: C.axis }} interval={Math.max(0, Math.ceil(series.length / 7) - 1)} />
            <YAxis tickFormatter={(v) => fmt.compact(v)} tickLine={false} axisLine={false} width={44} domain={[0, "auto"]} />
            {boundaries.map((b) => (
              <ReferenceLine key={b.week} x={b.week} stroke={C.axis}
                label={{ value: `${b.season} →`, position: "insideTopLeft", fill: C.muted, fontSize: 11, dx: 4, dy: -14 }} />
            ))}
            <Area dataKey="band" stroke="none" fill={C.s2} fillOpacity={0.14} isAnimationActive={false} />
            <Line dataKey="baseline" stroke={C.s1} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
            <Line dataKey="scenario" stroke={C.s2} strokeWidth={2} dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
            <Tooltip
              cursor={{ stroke: C.axis, strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as SeriesRow;
                const d = p.baseline > 0 ? p.scenario / p.baseline - 1 : 0;
                return <Tip title={`Week of ${fmt.weekYear(String(label))} · ${p.season}`} rows={[
                  { label: "Baseline forecast", value: `${fmt.int(p.baseline)} units`, color: C.s1 },
                  { label: "Scenario", value: `${fmt.int(p.scenario)} units`, color: C.s2 },
                  { label: "Scenario 90% range", value: `${fmt.int(p.lo)} – ${fmt.int(p.hi)}`, color: C.s2, band: true },
                  { label: "Change", value: fmt.signedPct(d, 1) },
                ]} />;
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <Legend items={[{ label: "Baseline forecast", color: C.s1, kind: "dash" }, { label: "Scenario", color: C.s2 }, { label: "Scenario 90% range", color: C.s2, kind: "band" }]} />
      </div>
    </>
  );
}

/* ───────────── Category impact: diverging bars around "no change" ───────────── */
export function CategoryImpact({ rows, limit = 12 }: { rows: CategoryRow[]; limit?: number }) {
  const moved = rows.filter((r) => Math.abs(r.pct) >= 0.0005);
  if (!moved.length) return <p className="py-6 text-center text-[13px] text-ink-3">No category changes under this scenario.</p>;
  const shown = [...moved].sort((a, b) => Math.abs(b.delta_units) - Math.abs(a.delta_units)).slice(0, limit).sort((a, b) => b.pct - a.pct);
  const maxDev = Math.max(0.02, ...shown.map((r) => Math.abs(r.pct)));
  return (
    <div className="space-y-2.5">
      {shown.map((r) => {
        const w = (Math.abs(r.pct) / maxDev) * 50;
        const up = r.pct >= 0;
        return (
          <div key={r.category} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_104px] items-center gap-3 sm:grid-cols-[minmax(0,170px)_minmax(0,1fr)_118px]"
            title={`${r.category}: ${fmt.signedPct(r.pct, 1)} · ${r.delta_units >= 0 ? "+" : "−"}${fmt.int(Math.abs(r.delta_units))} units · ${r.delta_rev >= 0 ? "+" : "−"}${fmt.inrFull(Math.abs(r.delta_rev))}`}>
            <span className="truncate text-[13px] text-ink-2">{r.category}</span>
            <div className="relative h-6 rounded-md bg-sunken">
              <div className="absolute inset-y-0 left-1/2 w-px bg-[#c3c2b7]" />
              <div className="absolute inset-y-1 transition-all duration-500"
                style={{ background: up ? "#ea7471" : "#5598e7", width: `${Math.max(w, 0.8)}%`, left: up ? "50%" : `${50 - Math.max(w, 0.8)}%`, borderRadius: up ? "0 4px 4px 0" : "4px 0 0 4px" }} />
            </div>
            <div className="text-right leading-tight">
              <span className="block text-[13px] font-medium tnum">{fmt.signedPct(r.pct, 1)}</span>
              <span className="block text-[11px] tnum text-ink-3">{r.delta_units >= 0 ? "+" : "−"}{fmt.int(Math.abs(r.delta_units))} u · {r.delta_rev >= 0 ? "+" : "−"}{fmt.inr(Math.abs(r.delta_rev))}</span>
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_104px] gap-3 text-[11px] text-muted sm:grid-cols-[minmax(0,170px)_minmax(0,1fr)_118px]">
        <span />
        <div className="flex justify-between"><span>less demand</span><span>no change</span><span>more demand</span></div>
        <span />
      </div>
      {moved.length > shown.length && <p className="text-[11px] text-ink-3">Showing the {shown.length} categories with the largest unit change, out of {moved.length} that move.</p>}
    </div>
  );
}

/* ───────────── Risk badge (status colour + icon + label) ───────────── */
const TONE = {
  good: { Icon: CircleCheck, color: "var(--good)", bg: "#e8f6e8" },
  warning: { Icon: TriangleAlert, color: "#b37a00", bg: "#fff4d9" },
  serious: { Icon: ShieldAlert, color: "var(--serious)", bg: "#fdece4" },
  critical: { Icon: OctagonAlert, color: "var(--critical)", bg: "#fbe5e5" },
} as const;

export function RiskBadge({ risk }: { risk: number }) {
  const { label, tone } = riskLevel(risk);
  const t = TONE[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink" style={{ background: t.bg }}>
      <t.Icon className="h-3.5 w-3.5" style={{ color: t.color }} strokeWidth={2.2} />
      {label} <span className="tnum text-ink-2">{fmt.pct(risk)}</span>
    </span>
  );
}

/* ───────────── Most-impacted medicines ───────────── */
const RANKS = ["units", "value", "risk"] as const;
const RANK_LABEL: Record<RankBy, string> = { units: "Units", value: "₹ value", risk: "Risk" };

export function ImpactTable({ data, rankBy, setRankBy }: { data: SimResp; rankBy: RankBy; setRankBy: (r: RankBy) => void }) {
  // Ranked by units or ₹, rows that do not move are filler (fewer than 15 medicines changed), so drop them.
  // Ranked by risk they still matter: a change beyond the horizon can lift risk without moving horizon units.
  const byRisk = data.params.rank_by === "risk";
  const rows: MedRow[] = byRisk ? data.medicines : data.medicines.filter((r) => Math.abs(r.delta_units) > 1e-6 || Math.abs(r.delta_value) > 0.005);
  const noChange = data.is_baseline || rows.length === 0;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
        <p className="text-[12px] text-ink-3">Rank by</p>
        <Segmented options={RANKS} value={rankBy} onChange={setRankBy} render={(r) => RANK_LABEL[r]} />
      </div>
      {noChange ? (
        <p className="px-6 py-10 text-center text-[13px] text-ink-3">
          {data.is_baseline
            ? <>No medicine changes within these {data.horizon_weeks.length} weeks, so this matches the baseline. Pick a preset or move a control to see the impact.</>
            : <>No medicine&apos;s demand changes within the {data.horizon_weeks.length}-week horizon. The scenario only reaches the {data.cover_weeks}-week stock cover window, so rank by Risk to see its effect.</>}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[680px] text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-6 py-3 font-medium">Medicine</th>
                <th className="hidden px-3 py-3 text-right font-medium 2xl:table-cell">Baseline units</th>
                <th className="px-3 py-3 text-right font-medium">Scenario units</th>
                <th className="px-3 py-3 text-right font-medium">Change</th>
                <th className="px-3 py-3 text-right font-medium">₹ impact</th>
                <th className="px-3 py-3 text-right font-medium">Order-up-to now</th>
                <th className="px-6 py-3 font-medium" title="Stockout risk if you keep the baseline stock plan">Stockout risk<span className="block normal-case tracking-normal text-[10.5px]">on baseline plan</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.medicine_id} className="border-t border-hairline transition-colors hover:bg-surface-2">
                  <td className="px-6 py-2.5">
                    <Link href={`/medicines/${r.medicine_id}`} className="focus-ring flex items-center gap-2.5 rounded">
                      <AbcBadge abc={r.abc} />
                      <span className="min-w-0"><span className="block max-w-[190px] truncate font-medium hover:underline">{r.medicine_name}</span><span className="block truncate text-[12px] text-ink-3">{r.category}</span></span>
                    </Link>
                  </td>
                  <td className="hidden px-3 py-2.5 text-right tnum text-ink-3 2xl:table-cell">{fmt.one(r.base_units)}</td>
                  <td className="px-3 py-2.5 text-right font-medium tnum">{fmt.one(r.scen_units)}</td>
                  <td className="px-3 py-2.5 text-right" title={`Baseline ${fmt.one(r.base_units)} → scenario ${fmt.one(r.scen_units)} units`}><UpliftBadge value={r.pct} /></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tnum text-ink-2">{r.delta_value >= 0 ? "+" : "−"}{fmt.inrFull(Math.abs(r.delta_value))}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tnum">
                    <span className="text-ink-3">{fmt.int(r.base_order_up_to)}</span>
                    <span className="mx-1 text-muted">→</span>
                    <span className="inline-block min-w-[36px] rounded-lg bg-brand-wash px-1.5 py-0.5 text-center font-semibold text-brand-ink">{fmt.int(r.scen_order_up_to)}</span>
                  </td>
                  <td className="px-6 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RiskBadge risk={r.risk} />
                      {r.risk >= 0.1 && <span className="text-[11px] text-ink-3">wk of {fmt.week(r.risk_week)}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-6 pb-5 pt-3 text-[11px] leading-relaxed text-ink-3">
        Units and ₹ cover the next {data.horizon_weeks.length} weeks. ₹ impact uses the scenario price. Order-up-to covers the first {data.cover_weeks} forecast weeks.
        Stockout risk is the worst rolling {data.cover_weeks}-week window if you keep restocking to the baseline plan. At baseline it is at most {fmt.pct(1 - data.params.service)} by design.
      </p>
    </>
  );
}
