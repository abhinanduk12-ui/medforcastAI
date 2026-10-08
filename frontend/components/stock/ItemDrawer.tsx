"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowUpRight, PackagePlus, ShoppingCart, SlidersHorizontal, Store, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Skeleton } from "@/components/ui";
import { BatchTimeline, ExpiringChip, SimulatedNote, StatusChip, useReloadOnVersion } from "./bits";
import { MOVEMENT_LABEL, coverText, dateFmt, dateTimeFmt, type ItemDetail } from "./types";

export type DrawerActions = {
  canSell: boolean; canReceive: boolean; canAdjust: boolean;
  onSell: (id: string) => void; onReceive: (id: string) => void; onAdjust: (d: ItemDetail, batchId?: number) => void;
};

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-surface-2 px-3.5 py-3">
      <p className="text-[11.5px] text-ink-3">{label}</p>
      <p className="mt-1 text-[18px] font-semibold leading-none tracking-tight tnum">{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-ink-3">{sub}</p>}
    </div>
  );
}

/** Right-hand panel with one medicine's batches (FEFO), cover, other stores and recent movements. */
export function ItemDrawer({ id, onClose, actions, version }: { id: string | null; onClose: () => void; actions: DrawerActions; version: number }) {
  const { data, error, loading, reload } = useApi<ItemDetail>(id ? `/api/stock/items/${encodeURIComponent(id)}` : null);
  const panel = useRef<HTMLDivElement>(null);
  useReloadOnVersion(version, reload);
  useEffect(() => {
    if (!id) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("button")?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-drawer])')) return; // a dialog on top owns the keyboard
      if (e.key === "Escape") { onClose(); return; }
      // Keep Tab focus inside the panel while it is open (aria-modal).
      const root = panel.current;
      if (e.key !== "Tab" || !root) return;
      const f = Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => el.getClientRects().length > 0);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [id, onClose]);
  if (!id) return null;
  const it = data?.item;
  const stale = data && data.item.medicine_id !== id;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-[rgba(11,11,11,0.18)]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" data-drawer aria-labelledby="drawer-title"
        className="rise relative flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l border-hairline bg-surface shadow-[-24px_0_60px_-30px_rgba(11,11,11,0.35)]">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-hairline bg-surface/95 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            {it && !stale ? (
              <>
                <div className="flex items-center gap-2">
                  <AbcBadge abc={it.abc} />
                  <h2 id="drawer-title" className="truncate text-[17px] font-semibold tracking-tight">{it.medicine_name}</h2>
                </div>
                <p className="mt-1 truncate text-[12.5px] text-ink-3">{it.medicine_id} · {it.generic_name} · {it.form} · {it.category}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <StatusChip status={it.status} />
                  {it.expiring && <ExpiringChip expired={it.expired_qty > 0} />}
                  {it.rx_share != null && it.rx_share >= 0.5 && <span className="rounded-full border border-hairline px-2 py-0.5 text-[11.5px] text-ink-2">Mostly Rx ({fmt.pct(it.rx_share)})</span>}
                </div>
              </>
            ) : <><h2 id="drawer-title" className="sr-only">Medicine stock</h2><Skeleton className="h-6 w-56" /><Skeleton className="mt-2 h-4 w-72" /></>}
          </div>
          <button onClick={onClose} aria-label="Close panel" className="focus-ring -mr-2 rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink"><X className="h-4 w-4" /></button>
        </div>

        {error && <p className="px-6 py-6 text-[13px] text-critical">{error}</p>}
        {(!data || stale) && !error && <div className="space-y-3 px-6 py-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>}

        {data && it && !stale && (
          <div className={`space-y-6 px-6 py-5 ${loading ? "opacity-70" : ""}`}>
            <div className="flex flex-wrap gap-2">
              {actions.canSell && <button onClick={() => actions.onSell(it.medicine_id)} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-white hover:bg-[#262624]"><ShoppingCart className="h-4 w-4" aria-hidden /> Sell</button>}
              {actions.canReceive && <button onClick={() => actions.onReceive(it.medicine_id)} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-sunken"><PackagePlus className="h-4 w-4" aria-hidden /> Receive</button>}
              {actions.canAdjust && data.batches.length > 0 && <button onClick={() => actions.onAdjust(data)} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-sunken"><SlidersHorizontal className="h-4 w-4" aria-hidden /> Adjust</button>}
              <Link href={`/medicines/${it.medicine_id}`} className="focus-ring ml-auto inline-flex items-center gap-1 rounded-xl px-2 py-2 text-[13px] font-medium text-brand hover:underline">Forecast <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
            </div>

            <SimulatedNote store={data.store} />

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Fact label="On hand" value={fmt.int(it.on_hand)} sub={`${it.n_batches} batch${it.n_batches === 1 ? "" : "es"}`} />
              <Fact label="Forecast / wk" value={fmt.one(it.weekly_rate)} sub="avg, forecast wks 1–4" />
              <Fact label="Cover" value={coverText(it.weeks_of_cover, it.on_hand)} sub={it.policy} />
              <Fact label="Suggested order" value={fmt.int(it.suggested_order)} sub={`up to ${fmt.int(it.order_up_to)}`} />
            </div>
            {it.expired_qty > 0 && (
              <p className="rounded-xl bg-[#fbeaea] px-3.5 py-2.5 text-[12.5px] text-critical"><b className="font-semibold">{it.expired_qty} expired units</b> ({fmt.inrFull(it.expired_value)} at cost) are still on the shelf. They are excluded from on-hand and cannot be sold; quarantine and write them off.</p>
            )}

            <section>
              <h3 className="mb-1 text-[14px] font-semibold">Batches, first-expiry-first-out</h3>
              <p className="mb-3 text-[12px] text-ink-3">Bars run from today to each expiry date. The projection sells batches in FEFO order at the forecast rate; real sales will vary.</p>
              <BatchTimeline batches={data.batches} />
              {data.batches.length > 0 && (
                <div className="mt-4 overflow-x-auto rounded-xl border border-hairline">
                  <table className="w-full min-w-[480px] text-[12px]">
                    <thead><tr className="bg-surface-2 text-left text-[10.5px] uppercase tracking-wider text-ink-3">
                      <th className="px-3 py-2 font-medium">Batch</th><th className="px-3 py-2 font-medium">Expiry</th><th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Unit cost</th><th className="px-3 py-2 text-right font-medium" title="Expected units left at expiry (cautious scenario in brackets)">Left at expiry</th>
                      {actions.canAdjust && <th className="px-2 py-2"><span className="sr-only">Adjust</span></th>}
                    </tr></thead>
                    <tbody>{data.batches.map((b) => (
                      <tr key={b.batch_id} className="border-t border-hairline">
                        <td className="px-3 py-1.5"><span className="font-medium">{b.batch_no}</span>{b.supplier_id && <span className="block text-[10.5px] text-ink-3">{b.supplier_id}</span>}</td>
                        <td className={`px-3 py-1.5 tnum ${b.expired ? "font-semibold text-critical" : ""}`}>{dateFmt(b.expiry_date)}{b.expired && " · expired"}</td>
                        <td className="px-3 py-1.5 text-right tnum">{b.qty}</td>
                        <td className="px-3 py-1.5 text-right tnum">{fmt.inrFull(b.unit_cost)}</td>
                        <td className="px-3 py-1.5 text-right tnum">{b.proj_unsold < 0.5 ? <span className="text-ink-3">0</span> : <b className="font-semibold">{fmt.int(b.proj_unsold)}</b>}{!b.expired && b.proj_unsold_slow >= 0.5 && Math.round(b.proj_unsold_slow) !== Math.round(b.proj_unsold) && <span className="text-ink-3"> ({fmt.int(b.proj_unsold_slow)})</span>}</td>
                        {actions.canAdjust && <td className="px-2 py-1.5 text-right"><button onClick={() => actions.onAdjust(data, b.batch_id)} aria-label={`Adjust batch ${b.batch_no}`} className="focus-ring rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink"><SlidersHorizontal className="h-3.5 w-3.5" /></button></td>}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>

            {data.other_stores.length > 0 && (
              <section>
                <h3 className="mb-2 text-[14px] font-semibold">Other stores</h3>
                <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-hairline">
                  {data.other_stores.map((s) => (
                    <li key={s.store_id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-[12.5px]">
                      <span className="inline-flex min-w-0 items-center gap-2"><Store className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden /><span className="truncate font-medium">{s.name}</span>{s.simulated && <span className="text-[11px] text-ink-3">simulated</span>}</span>
                      <span className="flex items-center gap-3 tnum text-ink-2">
                        <span><b className="font-semibold text-ink">{fmt.int(s.on_hand)}</b> on hand</span>
                        <span className="text-ink-3">{coverText(s.weeks_of_cover, s.on_hand)} cover</span>
                        {s.spare > 0 && <span className="rounded-md bg-brand-wash px-1.5 py-0.5 text-[11px] font-medium text-brand-ink">~{s.spare} spare</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-ink-3">“Spare” = stock above that store&apos;s own forecast demand over the lead time + review period. A transfer candidate, not a promise.</p>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-[14px] font-semibold">Recent movements <span className="font-normal text-ink-3">({fmt.int(data.movements_total)})</span></h3>
              {data.movements.length === 0 ? <p className="text-[12.5px] text-ink-3">No movements yet.</p> : (
                <ul className="space-y-1.5 text-[12.5px]">
                  {data.movements.slice(0, 15).map((m) => (
                    <li key={m.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="font-medium">{MOVEMENT_LABEL[m.kind] ?? m.kind}</span>
                        <span className="text-ink-3"> · {m.batch_no ?? "—"}{m.ref ? ` · ${m.ref}` : ""}{m.username ? ` · ${m.username}` : ""}</span>
                        {m.note && <span className="block truncate text-[11.5px] text-ink-3">{m.note}</span>}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block font-semibold tnum ${m.qty < 0 ? "text-ink" : "text-good"}`}>{m.qty > 0 ? "+" : "−"}{Math.abs(m.qty)}</span>
                        <span className="block text-[10.5px] text-ink-3">{dateTimeFmt(m.created_at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
