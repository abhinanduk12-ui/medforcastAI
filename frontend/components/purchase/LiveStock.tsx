"use client";

import { useMemo } from "react";
import { AlertCircle, Boxes, FlaskConical, Loader2 } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import type { StoreRef } from "@/components/stock/types";

type LiveItems = { store: StoreRef; as_of: string; items: { medicine_id: string; on_hand: number }[] };

/** Sellable on-hand stock of the selected store from the live ledger (null while off / loading). */
export function useLiveStock(enabled: boolean) {
  const { data, error, loading } = useApi<LiveItems>(enabled ? "/api/stock/items?limit=1000&sort=name" : null);
  const stock = useMemo(() => {
    if (!enabled || !data) return null;
    const m: Record<string, number> = {};
    for (const i of data.items) if (i.on_hand > 0) m[i.medicine_id] = i.on_hand;
    return m;
  }, [enabled, data]);
  return { stock, store: data?.store ?? null, asOf: data?.as_of ?? null, error: enabled ? error : null, loading: enabled && loading };
}

/** "Use live stock (store X)" switch. The CSV upload stays available as the alternative. */
export function LiveStockToggle({ on, onChange, live }: {
  on: boolean; onChange: (v: boolean) => void; live: ReturnType<typeof useLiveStock>;
}) {
  const units = live.stock ? Object.values(live.stock).reduce((a, b) => a + b, 0) : 0;
  const items = live.stock ? Object.keys(live.stock).length : 0;
  return (
    <div className={`rounded-2xl border p-4 transition ${on ? "border-brand-soft bg-brand-wash" : "border-hairline bg-surface-2"}`}>
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13px] font-medium"><Boxes className="h-4 w-4 text-ink-3" aria-hidden />
            Use live stock{live.store ? ` (${live.store.name})` : " (selected store)"}</span>
          <span className="mt-0.5 block text-[12px] text-ink-3">Nets sellable on-hand units from the stock ledger off the order. Expired stock is excluded.</span>
        </span>
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} aria-label="Use live stock from the ledger" className="peer sr-only" />
          <span className="h-6 w-10 rounded-full bg-[#d6d5cf] transition peer-checked:bg-brand peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand)]" />
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
        </span>
      </label>
      {on && (
        <div className="mt-3 space-y-2 text-[12px]">
          {live.loading && !live.stock && <p className="flex items-center gap-1.5 text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading stock…</p>}
          {live.error && <p role="alert" className="flex items-start gap-1.5 font-medium text-critical"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>Live stock could not be loaded ({live.error}). The plan shown was not recalculated with live stock; turn this off or try again.</span></p>}
          {live.stock && <p className="text-ink-2 tnum">{fmt.int(items)} medicines · {fmt.int(units)} units on hand{live.asOf ? ` as of ${fmt.weekYear(live.asOf)}` : ""}</p>}
          {live.store?.simulated && (
            <p className="flex items-start gap-1.5 leading-relaxed text-ink-2">
              <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
              <span>{live.store.name} is a simulated branch. The optimizer&apos;s demand is the main-shop forecast (not scaled by {live.store.demand_scale.toFixed(2)}), so
                this plan over-buys for the branch. Use it to compare, or switch to the main store.</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
