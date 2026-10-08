"use client";

import { fmt } from "@/lib/format";
import type { BranchCard } from "./types";
import { cover } from "./types";
import { SimulatedBadge } from "./BranchCards";

type Row = { label: string; hint?: string; get: (s: BranchCard) => number | null; show: (v: number | null) => string; lowerIsBetter?: boolean; neutral?: boolean };

const ROWS: Row[] = [
  { label: "Stock value (cost)", get: (s) => s.stock_value, show: fmt.inrFull, neutral: true },
  { label: "Units on hand", get: (s) => s.units, show: fmt.int, neutral: true },
  { label: "SKUs in stock", get: (s) => s.skus_in_stock, show: fmt.int },
  { label: "Stockouts", hint: "No sellable stock while the forecast expects demand", get: (s) => s.stockouts, show: fmt.int, lowerIsBetter: true },
  { label: "  of which A/B class", get: (s) => s.stockouts_ab, show: fmt.int, lowerIsBetter: true },
  { label: "Below target", hint: "Order-up-to level: lead 1 wk + review 2 wk at 95 % service, scaled per branch", get: (s) => s.below_target, show: fmt.int, lowerIsBetter: true },
  { label: "Median weeks of cover", get: (s) => s.median_cover_weeks, show: (v) => cover(v), neutral: true },
  { label: "Excess value (>8 wk cover)", get: (s) => s.excess_value, show: fmt.inrFull, lowerIsBetter: true },
  { label: "Near-expiry value (≤90 d)", get: (s) => s.near_expiry_value, show: fmt.inrFull, lowerIsBetter: true },
  { label: "Expired, awaiting write-off", get: (s) => s.expired_value, show: fmt.inrFull, lowerIsBetter: true },
  { label: "Forecast demand / week", hint: "Branches: main-store forecast × demand scale (simulated)", get: (s) => s.forecast_weekly_units, show: (v) => `${fmt.int(v)} units`, neutral: true },
  { label: "Forecast sales / week", get: (s) => s.forecast_weekly_value, show: fmt.inrFull, neutral: true },
];

/** Side-by-side KPIs. Ratios per unit of demand matter more than raw totals (branches are smaller),
 *  so "best" marks are shown only for counts/values where lower is better, normalised by demand. */
export function CompareTable({ stores }: { stores: BranchCard[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-[13px]">
        <thead>
          <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
            <th scope="col" className="sticky left-0 z-[1] bg-surface-2 px-6 py-3 font-medium">Measure</th>
            {stores.map((s) => (
              <th key={s.id} scope="col" className="px-4 py-3 text-right font-medium">
                <span className="block normal-case tracking-normal text-[13px] font-semibold text-ink">{s.name}</span>
                <span className="mt-1 inline-block"><SimulatedBadge simulated={s.simulated} /></span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => {
            const norm = stores.map((s) => {
              const v = r.get(s);
              return v == null || !s.forecast_weekly_units ? null : v / s.forecast_weekly_units;
            });
            const valid = norm.filter((v): v is number => v != null);
            const best = !r.neutral && r.lowerIsBetter && valid.length > 1 ? Math.min(...valid) : null;
            return (
              <tr key={r.label} className="group border-t border-hairline hover:bg-surface-2">
                <th scope="row" className="sticky left-0 bg-surface px-6 py-2.5 text-left font-normal text-ink-2 group-hover:bg-surface-2" title={r.hint}>
                  <span className={r.label.startsWith("  ") ? "pl-3 text-ink-3" : ""}>{r.label.trim()}</span>
                  {r.hint && <><span className="ml-1 text-ink-3" aria-hidden>ⓘ</span><span className="sr-only">: {r.hint}</span></>}
                </th>
                {stores.map((s, i) => {
                  const v = r.get(s);
                  const isBest = best != null && norm[i] === best && valid.some((x) => x !== best);
                  return (
                    <td key={s.id} className="px-4 py-2.5 text-right tnum">
                      <span className={isBest ? "font-semibold text-ink" : "text-ink-2"}>{r.show(v)}</span>
                      {isBest && <span className="ml-1.5 rounded bg-brand-wash px-1 py-0.5 text-[10px] font-medium text-brand-ink" title="Lowest relative to this branch's demand">best</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-6 py-3 text-[11.5px] text-ink-3">
        “best” compares each figure relative to the branch’s forecast demand, because the branches are smaller than the main store.
      </p>
    </div>
  );
}
