"use client";

import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { C } from "@/components/charts";
import { fmt } from "@/lib/format";
import type { FrontierPoint } from "./types";

export type FrontierMetric = "Fill rate" | "Profit";

/** Efficient frontier: best achievable fill rate (or expected profit) at each budget. One series, one axis. */
export function FrontierChart({ points, current, metric, height = 300 }: {
  points: FrontierPoint[]; current: FrontierPoint; metric: FrontierMetric; height?: number;
}) {
  const key = metric === "Fill rate" ? "fill_rate" : "profit";
  const yFmt = metric === "Fill rate" ? (v: number) => fmt.pct(v) : (v: number) => fmt.inr(v);
  // The curve runs to 2x the spend that buys everything; past that it is flat. A typed budget far beyond it would
  // squash the curve into the left edge, so it is pinned to the right edge instead (the value is unchanged there).
  const lastX = points[points.length - 1]?.budget ?? 0;
  const beyond = current.budget > lastX + 1e-6;
  const markX = beyond ? lastX : current.budget;
  // Merge the user's budget into the curve so the line passes exactly through the marked point.
  const data = beyond ? points
    : [...points.filter((p) => Math.abs(p.budget - current.budget) > 1e-6), current].sort((a, b) => a.budget - b.budget);
  // Keep the label on the inside of the plot: right of the line in the left 60%, left of it beyond that.
  const labelRight = markX <= lastX * 0.6;
  const summary = `Line chart of best achievable ${metric === "Fill rate" ? "fill rate" : "expected profit"} by budget, from ₹0 to ${fmt.inr(lastX)}. `
    + `At your budget of ${fmt.inrFull(current.budget)}: ${metric === "Fill rate" ? fmt.pct(current.fill_rate, 1) : fmt.inrFull(current.profit)}.`;
  return (
    <div role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 22, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="budget" type="number" domain={[0, lastX || 1]} tickFormatter={(v) => fmt.inr(v)} tickLine={false} axisLine={{ stroke: C.axis }} minTickGap={24} />
          <YAxis tickFormatter={yFmt} tickLine={false} axisLine={false} width={52}
            domain={metric === "Fill rate" ? [0, 1] : [(lo: number) => Math.min(0, lo), "auto"]} />
          <ReferenceLine x={markX} stroke={C.ink} strokeDasharray="3 3" strokeOpacity={0.45}
            label={{ value: beyond ? `Your budget ${fmt.inr(current.budget)} →` : "Your budget", position: labelRight ? "insideTopLeft" : "insideTopRight",
              fill: C.ink, fontSize: 11, dx: labelRight ? 6 : -6, dy: -18 }} />
          <Line dataKey={key} stroke={C.s1} strokeWidth={2} dot={false} activeDot={{ r: 4.5, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} type="monotone" />
          <ReferenceDot x={markX} y={current[key]} r={6} fill={C.s1} stroke="#fff" strokeWidth={2} ifOverflow="visible" />
          <Tooltip
            cursor={{ stroke: C.axis }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as FrontierPoint;
              const isCur = Math.abs(p.budget - current.budget) < 1e-6;
              return (
                <div className="min-w-[200px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur">
                  <p className="mb-2 font-medium text-ink">Budget {fmt.inrFull(p.budget)}{isCur ? " · yours" : ""}</p>
                  <div className="space-y-1.5">
                    {[["Expected fill rate", fmt.pct(p.fill_rate, 1)], ["Expected profit", fmt.inrFull(p.profit)], ["Actually spent", fmt.inrFull(p.spend)]].map(([l, v], i) => (
                      <div key={l} className="flex items-center justify-between gap-4">
                        <span className="inline-flex items-center gap-1.5 text-ink-2">
                          {i === (metric === "Fill rate" ? 0 : 1) && <span className="h-2 w-2 rounded-full" style={{ background: C.s1 }} />}{l}
                        </span>
                        <span className="tnum font-medium text-ink">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
