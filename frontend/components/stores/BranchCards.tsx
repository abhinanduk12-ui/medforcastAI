"use client";

import { FlaskConical, MapPin, Store } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { fmt } from "@/lib/format";
import type { BranchCard } from "./types";
import { cover, storeColor } from "./types";

export function SimulatedBadge({ simulated, scale }: { simulated: boolean; scale?: number }) {
  return simulated ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#f3d9a6] bg-[#fff7e6] px-2 py-0.5 text-[11px] font-medium text-[#7a5200]"
      title="No real sales for this branch yet: demand = main store forecast × scale">
      <FlaskConical className="h-3 w-3" aria-hidden /> Simulated{scale != null ? ` · ×${scale.toFixed(2)}` : ""}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-soft bg-brand-wash px-2 py-0.5 text-[11px] font-medium text-brand-ink">
      <Store className="h-3 w-3" aria-hidden /> Main · real sales
    </span>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11.5px] text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-[17px] font-semibold tracking-tight tnum">{value}</p>
      {sub && <p className="truncate text-[11px] text-ink-3">{sub}</p>}
    </div>
  );
}

export function BranchCards({ stores, order }: { stores: BranchCard[]; order?: string[] }) {
  const ids = order ?? stores.map((s) => s.id);
  return (
    <div className={`grid gap-4 ${stores.length >= 3 ? "lg:grid-cols-3" : stores.length === 2 ? "md:grid-cols-2" : ""}`}>
      {stores.map((s, i) => {
        const cur = s.forecast_current_index;
        return (
          <article key={s.id} className="card rise flex flex-col p-5" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-[16px] font-semibold tracking-tight">{s.name}</h3>
                <p className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-ink-3"><MapPin className="h-3 w-3" aria-hidden />{s.city} · {s.id}</p>
              </div>
              <SimulatedBadge simulated={s.simulated} scale={s.simulated ? s.demand_scale : undefined} />
            </div>

            <div className="mt-4 flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11.5px] text-ink-3">Stock value at cost</p>
                <p className="text-[26px] font-semibold leading-tight tracking-[-0.02em] tnum">{fmt.inr(s.stock_value)}</p>
              </div>
              <div className="shrink-0 text-right" role="img" aria-label={`12-week demand forecast for ${s.name}: ${fmt.int(s.forecast_series[0])} to ${fmt.int(s.forecast_series[s.forecast_series.length - 1])} units a week${s.simulated ? " (simulated)" : ""}`}>
                <Sparkline data={s.forecast_series} width={120} height={34} color={storeColor(s.id, ids)} />
                <p className="mt-1 text-[11px] text-ink-3">
                  12-wk demand forecast{cur != null ? ` · now wk ${cur + 1}` : ""}
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-4">
              <Kpi label="SKUs in stock" value={`${s.skus_in_stock}`} sub={`of ${s.skus_total}`} />
              <Kpi label="Stockouts" value={`${s.stockouts}`} sub={`${s.stockouts_ab} A/B items`} />
              <Kpi label="Median cover" value={cover(s.median_cover_weeks)} sub={`${fmt.int(s.forecast_weekly_units)} units/wk`} />
              <Kpi label="Excess (>8 wk)" value={fmt.inr(s.excess_value)} />
              <Kpi label="Expiring ≤90 d" value={fmt.inr(s.near_expiry_value)} sub={`${s.near_expiry_batches} batches`} />
              <Kpi label="Expired, to write off" value={fmt.inr(s.expired_value)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
