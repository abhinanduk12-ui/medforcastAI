"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { divergingColor, inkOn } from "@/components/charts";
import { AbcBadge, Segmented } from "@/components/ui";
import { fmt } from "@/lib/format";
import type { BranchCard, CoverCell, MatrixRow } from "./types";
import { cover } from "./types";

/** Ratio of cover to target cover -> a step on the shared blue<->red diverging scale.
 *  Blue = below target (short), grey = on target, red = above target (excess). */
const BUCKETS: { max: number; d: number; label: string }[] = [
  { max: 0.25, d: -0.4, label: "< 25 %" },
  { max: 0.5, d: -0.25, label: "25–50 %" },
  { max: 0.8, d: -0.15, label: "50–80 %" },
  { max: 0.95, d: -0.06, label: "80–95 %" },
  { max: 1.3, d: 0, label: "On target" },
  { max: 1.8, d: 0.06, label: "1.3–1.8×" },
  { max: 2.5, d: 0.15, label: "1.8–2.5×" },
  { max: 4, d: 0.25, label: "2.5–4×" },
  { max: Infinity, d: 0.4, label: "> 4×" },
];
const bucket = (ratio: number) => BUCKETS.find((b) => ratio < b.max) ?? BUCKETS[BUCKETS.length - 1];
const colorFor = (c: CoverCell) => {
  if (!c.weekly_rate || c.target_cover_weeks == null || c.target_cover_weeks <= 0) return null;
  return divergingColor(1 + bucket((c.weeks_cover ?? 0) / c.target_cover_weeks).d);
};

const SORTS = ["Value", "Imbalance", "Name"] as const;

export function CoverHeatmap({ rows, stores }: { rows: MatrixRow[]; stores: BranchCard[] }) {
  const [sort, setSort] = useState<(typeof SORTS)[number]>("Value");
  const [hover, setHover] = useState<{ row: MatrixRow; cell: CoverCell } | null>(null);
  const sorted = useMemo(() => {
    const r = [...rows];
    if (sort === "Name") r.sort((a, b) => a.medicine_name.localeCompare(b.medicine_name));
    if (sort === "Imbalance") {
      const spread = (m: MatrixRow) => {
        const xs = m.cells.filter((c) => c.target_cover_weeks).map((c) => Math.log2(Math.max(0.05, (c.weeks_cover ?? 0) / (c.target_cover_weeks as number))));
        return xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;
      };
      r.sort((a, b) => spread(b) - spread(a));
    }
    return r;
  }, [rows, sort]);
  const name = (id: string) => stores.find((s) => s.id === id)?.name ?? id;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
        <Segmented options={SORTS} value={sort} onChange={setSort} render={(v) => (v === "Imbalance" ? "Most uneven" : v === "Value" ? "By value" : v)} />
        <HeatLegend />
      </div>

      <div className="mt-4 max-h-[560px] overflow-auto border-y border-hairline">
        <table className="w-full min-w-[520px] border-separate border-spacing-0 text-[12.5px]" aria-label="Weeks of cover per medicine and branch">
          <thead className="sticky top-0 z-[2]">
            <tr className="bg-surface-2 text-[11px] uppercase tracking-wider text-ink-3">
              <th scope="col" className="sticky left-0 z-[3] border-b border-hairline bg-surface-2 px-4 py-2.5 text-left font-medium">Medicine</th>
              {stores.map((s) => (
                <th key={s.id} scope="col" className="border-b border-hairline px-1 py-2.5 text-center font-medium">
                  {s.name.replace(" branch", "")}{s.simulated && <span className="ml-0.5 normal-case text-ink-3">*</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.medicine_id} className="group">
                <th scope="row" className="sticky left-0 z-[1] max-w-[240px] border-b border-hairline bg-surface px-4 py-1.5 text-left font-normal group-hover:bg-surface-2">
                  <Link href={`/medicines/${m.medicine_id}`} className="focus-ring flex items-center gap-2 rounded">
                    <AbcBadge abc={m.abc} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink hover:underline">{m.medicine_name}</span>
                      <span className="block truncate text-[11px] text-ink-3">{fmt.inr(m.total_value)} · {m.category}</span>
                    </span>
                  </Link>
                </th>
                {m.cells.map((c) => {
                  const bg = colorFor(c);
                  const stockout = c.qty === 0 && c.weekly_rate > 0;
                  const label = stockout ? "0" : c.weekly_rate > 0 ? (c.weeks_cover != null && c.weeks_cover >= 99 ? "99+" : (c.weeks_cover ?? 0).toFixed(1)) : "—";
                  const desc = `${m.medicine_name} at ${name(c.store_id)}: ${fmt.int(c.qty)} units, ${cover(c.weeks_cover)} cover vs target ${cover(c.target_cover_weeks)}`;
                  return (
                    <td key={c.store_id} className="border-b border-hairline p-[2px]">
                      <button
                        type="button"
                        aria-label={desc}
                        title={desc}
                        onMouseEnter={() => setHover({ row: m, cell: c })}
                        onFocus={() => setHover({ row: m, cell: c })}
                        onMouseLeave={() => setHover(null)}
                        className="focus-ring flex h-9 w-full min-w-[72px] items-center justify-center gap-1 rounded-md text-[12px] font-medium tnum transition hover:ring-2 hover:ring-ink/70"
                        style={bg ? { background: bg, color: inkOn(bg) } : { background: "var(--surface-sunken)", color: "var(--ink-3)" }}
                      >
                        {stockout && <span aria-hidden className="text-[10px]">⚠</span>}
                        {label}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="min-h-[64px] px-6 py-3 text-[12.5px]">
        {hover ? (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <span className="font-semibold text-ink">{hover.row.medicine_name} · {name(hover.cell.store_id)}</span>
            <span className="text-ink-2">On hand <b className="tnum font-semibold text-ink">{fmt.int(hover.cell.qty)}</b> ({fmt.inrFull(hover.cell.value)})</span>
            <span className="text-ink-2">Demand <b className="tnum font-semibold text-ink">{fmt.one(hover.cell.weekly_rate)}</b>/wk</span>
            <span className="text-ink-2">Cover <b className="tnum font-semibold text-ink">{cover(hover.cell.weeks_cover)}</b> vs target {cover(hover.cell.target_cover_weeks)} ({fmt.int(hover.cell.target)} units)</span>
            {hover.cell.near_expiry_value > 0 && <span className="text-ink-2">Expiring ≤90 d <b className="tnum font-semibold text-ink">{fmt.inrFull(hover.cell.near_expiry_value)}</b></span>}
          </div>
        ) : (
          <p className="text-ink-3">
            Numbers are weeks of cover (sellable units ÷ forecast weekly demand). Colour compares cover with the branch’s target cover
            (order-up-to ÷ weekly demand). ⚠ 0 = stockout. — = no forecast demand. * = simulated branch. Hover or focus a cell for details.
          </p>
        )}
      </div>
    </div>
  );
}

function HeatLegend() {
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end" aria-label="Colour legend: cover relative to target">
      <div className="flex overflow-hidden rounded-md border border-hairline">
        {BUCKETS.map((b) => (
          <span key={b.label} className="h-3 w-6" style={{ background: divergingColor(1 + b.d) }} title={b.label} />
        ))}
      </div>
      <div className="flex w-[216px] justify-between text-[11px] text-ink-3">
        <span>short</span><span>on target</span><span>excess</span>
      </div>
    </div>
  );
}
