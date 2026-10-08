"use client";

import Link from "next/link";
import { ArrowUpRight, Boxes } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, Skeleton } from "@/components/ui";
import { BatchTimeline, ExpiringChip, StatusChip } from "./bits";
import { coverText, type ItemDetail } from "./types";

/**
 * Compact live-stock card for one medicine (selected store): on hand, cover, suggested order, FEFO batches
 * and other stores. Drop-in for the medicine page: <StockCard id={medicineId} />.
 */
export function StockCard({ id, delay = 0 }: { id: string; delay?: number }) {
  const { data, error } = useApi<ItemDetail>(`/api/stock/items/${encodeURIComponent(id)}`);
  const it = data?.item;
  return (
    <Card delay={delay} className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight"><Boxes className="h-4 w-4 text-ink-3" aria-hidden /> Live stock</h2>
          <p className="mt-1 text-[13px] text-ink-3">
            {data ? <>{data.store.name}{data.store.simulated ? ` · simulated branch (demand × ${data.store.demand_scale.toFixed(2)})` : ""}</> : "Selected store"}
          </p>
        </div>
        <Link href={`/stock?focus=${encodeURIComponent(id)}`} className="focus-ring inline-flex items-center gap-1 rounded-lg text-[13px] font-medium text-brand hover:underline">
          Open in stock ledger <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      {error && <p className="mt-4 text-[13px] text-ink-3">Stock is unavailable: {error}</p>}
      {!data && !error && <div className="mt-4 space-y-3"><Skeleton className="h-14" /><Skeleton className="h-20" /></div>}
      {data && it && (
        <>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <StatusChip status={it.status} />
            {it.expiring && <ExpiringChip expired={it.expired_qty > 0} />}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            {[
              ["On hand", fmt.int(it.on_hand), `${it.n_batches} batch${it.n_batches === 1 ? "" : "es"}`],
              ["Cover", coverText(it.weeks_of_cover, it.on_hand), `${fmt.one(it.weekly_rate)}/wk forecast`],
              ["Order-up-to", fmt.int(it.order_up_to), it.policy],
              ["Suggested order", fmt.int(it.suggested_order), it.suggested_order ? fmt.inr(it.order_value) + " retail" : "nothing needed"],
            ].map(([k, v, s]) => (
              <div key={k}>
                <dt className="text-[12px] text-ink-3">{k}</dt>
                <dd className="mt-0.5 text-[20px] font-semibold leading-tight tracking-tight tnum">{v}</dd>
                <dd className="text-[11px] text-ink-3">{s}</dd>
              </div>
            ))}
          </dl>
          {it.expired_qty > 0 && <p className="mt-3 text-[12.5px] font-medium text-critical">{it.expired_qty} expired units on the shelf (not sellable).</p>}
          <div className="mt-5">
            <BatchTimeline batches={data.batches.slice(0, 5)} compact />
            {data.batches.length > 5 && <p className="mt-2 text-[12px] text-ink-3">+{data.batches.length - 5} more batches in the ledger</p>}
          </div>
          {data.other_stores.length > 0 && (
            <p className="mt-4 border-t border-hairline pt-3 text-[12.5px] text-ink-2">
              Other stores: {data.other_stores.map((s, i) => (
                <span key={s.store_id}>{i > 0 && " · "}{s.name} <b className="font-semibold tnum">{fmt.int(s.on_hand)}</b>{s.simulated ? "*" : ""}</span>
              ))}
              {data.other_stores.some((s) => s.simulated) && <span className="block text-[11px] text-ink-3">* simulated branch</span>}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default StockCard;
