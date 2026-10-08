"use client";

import { useState } from "react";
import { fmt } from "@/lib/format";
import { divergingColor, inkOn } from "@/components/charts";
import type { CalHeatRow, CalMonth } from "./types";

/** Category × month demand, each row relative to that category's own average month (per-day rates). */
export function CategoryMonthHeatmap({ rows, months }: { rows: CalHeatRow[]; months: CalMonth[] }) {
  const [showLow, setShowLow] = useState(false);
  const regular = rows.filter((r) => !r.low_volume);
  // When every row is low-volume (e.g. the page is filtered to one small category), show them rather than an empty table.
  const visible = showLow || !regular.length ? rows : regular;
  const hidden = regular.length ? rows.length - regular.length : 0;
  const byMonth = Object.fromEntries(months.map((m) => [m.month, m]));

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-[3px] text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface pb-2 pr-2 text-left font-medium text-ink-3">Category</th>
              {months.map((m) => (
                <th key={m.month} className="pb-2 text-center font-medium text-ink-2">
                  <span className="block">{m.short}</span>
                  <span className={`mx-auto mt-1 block h-1 w-6 rounded-full ${m.ml_days ? "bg-brand" : "bg-transparent"}`} title={m.ml_days ? "Uses the ML forecast blend" : undefined} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.category}>
                <td className="sticky left-0 z-10 max-w-[200px] truncate bg-surface pr-2 text-[13px] text-ink-2" title={`${r.category} · ${fmt.one(r.base_weekly)} units/week typical`}>
                  {r.category}
                </td>
                {r.cells.map((c) => {
                  const bg = divergingColor(c.index);
                  const m = byMonth[c.month];
                  return (
                    <td key={c.month} className="h-8 min-w-[44px] rounded-md text-center font-medium tnum"
                      style={{ background: bg, color: inkOn(bg) }}
                      title={`${r.category} · ${m?.label ?? c.month}: ${fmt.signedPct(c.index - 1)} vs its average month · ${fmt.int(c.units)} units expected${m?.ml_days ? " · ML blend" : ""}`}>
                      {fmt.signedPct(c.index - 1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] text-ink-3">
        <div className="flex items-center gap-2">
          <span>Below its average month</span>
          <div className="flex overflow-hidden rounded">
            {[0.6, 0.72, 0.84, 0.93, 1, 1.07, 1.16, 1.28, 1.4].map((v) => <span key={v} className="h-3 w-5" style={{ background: divergingColor(v) }} />)}
          </div>
          <span>Above</span>
        </div>
        {months.some((m) => m.ml_days > 0) && <span className="inline-flex items-center gap-1.5"><span className="h-1 w-5 rounded-full bg-brand" /> month uses the ML forecast blend</span>}
        {!regular.length && rows.length > 0 && <span>Low volume (&lt; 2 units/week): month-to-month swings are mostly noise.</span>}
        {hidden > 0 && (
          <button type="button" aria-pressed={showLow} onClick={() => setShowLow((v) => !v)} className="focus-ring rounded-md px-1.5 py-0.5 font-medium text-ink-2 underline-offset-2 hover:underline">
            {showLow ? "Hide" : "Show"} {hidden} low-volume {hidden === 1 ? "category" : "categories"} (&lt; 2 units/week)
          </button>
        )}
      </div>
    </div>
  );
}
