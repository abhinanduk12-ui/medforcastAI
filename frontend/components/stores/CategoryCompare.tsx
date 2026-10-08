"use client";

import { useState } from "react";
import { Legend, Segmented } from "@/components/ui";
import { fmt } from "@/lib/format";
import type { BranchCard, CategoryRow, CategoryStore } from "./types";
import { cover, storeColor } from "./types";

const METRICS = ["Stock value", "Weeks of cover", "Expiring ≤90 d", "Stockouts"] as const;
type Metric = (typeof METRICS)[number];
const GET: Record<Metric, (s: CategoryStore) => number | null> = {
  "Stock value": (s) => s.value,
  "Weeks of cover": (s) => s.weeks_cover,
  "Expiring ≤90 d": (s) => s.near_expiry_value,
  Stockouts: (s) => s.stockouts,
};
const SHOW: Record<Metric, (v: number | null) => string> = {
  "Stock value": fmt.inr, "Weeks of cover": cover, "Expiring ≤90 d": fmt.inr, Stockouts: (v) => fmt.int(v),
};
export { STORE_COLORS } from "./types";

export function CategoryCompare({ rows, stores, order }: { rows: CategoryRow[]; stores: BranchCard[]; order?: string[] }) {
  const [metric, setMetric] = useState<Metric>("Stock value");
  const [all, setAll] = useState(false);
  const list = all ? rows : rows.slice(0, 10);
  const max = Math.max(1e-9, ...list.flatMap((r) => r.stores.map((s) => Math.min(GET[metric](s) ?? 0, metric === "Weeks of cover" ? 30 : Infinity))));
  const ids = order ?? stores.map((s) => s.id);
  const colorOf = (id: string) => storeColor(id, ids);

  return (
    <div className="px-6 pb-5 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-1"><Segmented options={METRICS} value={metric} onChange={setMetric} /></div>
        {stores.length > 1 && <Legend items={stores.map((s) => ({ label: s.name + (s.simulated ? " (sim.)" : ""), color: colorOf(s.id), kind: "dot" as const }))} />}
      </div>
      <div className="mt-5 space-y-4">
        {list.map((r) => (
          <div key={r.category} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
            <p className="truncate text-[13px] text-ink-2 sm:pt-0.5" title={r.category}>{r.category}</p>
            <div className="space-y-[3px]">
              {stores.map((st) => {
                const s = r.stores.find((x) => x.store_id === st.id);
                const v = s ? GET[metric](s) : null;
                const w = v == null ? 0 : Math.min(v, metric === "Weeks of cover" ? 30 : Infinity) / max;
                return (
                  <div key={st.id} className="flex items-center gap-2" title={`${r.category} · ${st.name}: ${SHOW[metric](v)}`}>
                    <div className="h-[10px] flex-1 rounded-r-[4px] bg-transparent">
                      <div className="h-[10px] rounded-r-[4px] transition-all duration-500" style={{ width: `${Math.max(v ? 1 : 0, w * 100)}%`, background: colorOf(st.id) }} />
                    </div>
                    <span className="w-[64px] shrink-0 text-right text-[11.5px] tnum text-ink-2">{SHOW[metric](v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {rows.length > 10 && (
        <div className="mt-4 text-center">
          <button onClick={() => setAll(!all)} className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-brand hover:bg-brand-wash">
            {all ? "Show top 10 categories" : `Show all ${rows.length} categories`}
          </button>
        </div>
      )}
      {metric === "Weeks of cover" && <p className="mt-3 text-[11.5px] text-ink-3">Bars are capped at 30 weeks so one slow category does not flatten the rest.</p>}
    </div>
  );
}
