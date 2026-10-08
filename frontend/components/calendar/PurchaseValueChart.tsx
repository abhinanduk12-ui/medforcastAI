"use client";

import { Bar, BarChart, CartesianGrid, ErrorBar, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Legend } from "@/components/ui";
import type { CalMonth } from "./types";

/* One measure, one series colour. Months that lean on the ML forecast are marked by a neutral background band with
   a text label (not a second bar colour), so provenance never competes with the value encoding. */
const BAR = C.s1;
const ML_BAND = C.brand;

type Row = { month: string; short: string; label: string; value: number; err: [number, number]; lo: number; hi: number; ml: boolean; weight: number };

export function PurchaseValueChart({ months, height = 300 }: { months: CalMonth[]; height?: number }) {
  const rows: Row[] = months.map((m) => ({
    month: m.month, short: m.short, label: m.label, value: m.value, lo: m.value_lo, hi: m.value_hi,
    err: [m.value - m.value_lo, m.value_hi - m.value], ml: m.ml_days > 0, weight: m.ml_weight,
  }));
  const short = Object.fromEntries(rows.map((r) => [r.month, r.short]));
  const ml = rows.filter((r) => r.ml);
  return (
    <div>
      <div className="mb-3">
        <Legend items={[
          { label: "Purchase value", color: BAR, kind: "dot" },
          { label: "90% range (whisker)", color: C.ink, kind: "line" },
          ...(ml.length ? [{ label: "Months blending the ML forecast", color: ML_BAND, kind: "band" as const }] : []),
        ]} />
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ top: 22, right: 8, bottom: 0, left: 0 }} barCategoryGap="24%">
          <CartesianGrid vertical={false} />
          {ml.length > 0 && (
            <ReferenceArea x1={ml[0].month} x2={ml[ml.length - 1].month} fill={ML_BAND} fillOpacity={0.08} stroke="none"
              label={{ value: "ML blend", position: "top", fill: C.muted, fontSize: 11 }} />
          )}
          {/* Keyed by YYYY-MM so plans longer than 12 months never collapse two "Oct" ticks into one category. */}
          <XAxis dataKey="month" tickFormatter={(v: string) => short[v] ?? v} tickLine={false} axisLine={{ stroke: C.axis }} interval={0} />
          <YAxis tickFormatter={(v) => fmt.inr(v)} tickLine={false} axisLine={false} width={52} />
          <Tooltip
            cursor={{ fill: "rgba(11,11,11,0.04)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Row;
              return (
                <div className="min-w-[200px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
                  <p className="mb-2 font-medium text-ink">{r.label}</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: BAR }} />Purchase value</span>
                      <span className="font-medium text-ink tnum">{fmt.inrFull(r.value)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-ink-2">90% range</span>
                      <span className="font-medium text-ink tnum">{fmt.inr(r.lo)} – {fmt.inr(r.hi)}</span>
                    </div>
                    <p className="pt-1 text-[11px] text-ink-3">{r.ml ? `ML blend, weight ${Math.round(r.weight * 100)}%` : "Seasonal projection"}</p>
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" fill={BAR} radius={[4, 4, 0, 0]} maxBarSize={34} isAnimationActive={false}>
            <ErrorBar dataKey="err" width={6} strokeWidth={1.5} stroke={C.ink} direction="y" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
