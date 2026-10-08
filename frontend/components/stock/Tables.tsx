"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, Download, Hourglass, OctagonAlert, PackageSearch } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Segmented, Skeleton } from "@/components/ui";
import { downloadCsv } from "@/components/purchase/types";
import { ExpiringChip, StatusChip, useReloadOnVersion } from "./bits";
import { MOVEMENT_LABEL, coverText, dateFmt, dateTimeFmt, daysText, type ExpiringResp, type MovementsResp, type StockItem } from "./types";

export function EmptyRow({ cols, title, sub }: { cols: number; title: string; sub?: string }) {
  return (
    <tr><td colSpan={cols} className="px-6 py-14 text-center">
      <PackageSearch className="mx-auto h-6 w-6 text-ink-3" strokeWidth={1.8} aria-hidden />
      <p className="mt-3 text-[14px] font-semibold">{title}</p>
      {sub && <p className="mt-1 text-[13px] text-ink-3">{sub}</p>}
    </td></tr>
  );
}

/* ───────────────────────── stock table ───────────────────────── */

export function StockTable({ rows, loading, onOpen, emptyHint }: { rows: StockItem[] | null; loading: boolean; onOpen: (id: string) => void; emptyHint: string }) {
  const [limit, setLimit] = useState(60);
  useEffect(() => setLimit(60), [rows]);
  const shown = rows?.slice(0, limit) ?? [];
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-6 py-3 font-medium">Medicine</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 text-right font-medium">On hand</th>
              <th className="px-3 py-3 text-right font-medium" title="Mean of the first 4 forecast weeks, scaled to this store">Forecast /wk</th>
              <th className="px-3 py-3 text-right font-medium">Cover</th>
              <th className="px-3 py-3 font-medium">Earliest expiry</th>
              <th className="px-3 py-3 text-right font-medium">Order-up-to</th>
              <th className="px-3 py-3 text-right font-medium">Suggested order</th>
              <th className="px-6 py-3 text-right font-medium">Value (cost)</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows && [...Array(8)].map((_, i) => <tr key={i}><td colSpan={9} className="px-6 py-2"><Skeleton className="h-9" /></td></tr>)}
            {rows && rows.length === 0 && <EmptyRow cols={9} title="Nothing here" sub={emptyHint} />}
            {shown.map((r) => (
              <tr key={r.medicine_id} onClick={() => onOpen(r.medicine_id)} className="cursor-pointer border-t border-hairline transition-colors hover:bg-surface-2">
                <td className="px-6 py-2.5">
                  <button onClick={(e) => { e.stopPropagation(); onOpen(r.medicine_id); }} className="focus-ring flex items-center gap-2.5 rounded text-left">
                    <AbcBadge abc={r.abc} />
                    <span className="min-w-0"><span className="block max-w-[260px] truncate font-medium hover:underline">{r.medicine_name}</span>
                      <span className="block max-w-[260px] truncate text-[12px] text-ink-3">{r.category} · {r.form}</span></span>
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1"><StatusChip status={r.status} compact />{r.expiring && <ExpiringChip expired={r.expired_qty > 0} />}</div>
                </td>
                <td className="px-3 py-2.5 text-right font-semibold tnum">{fmt.int(r.on_hand)}{r.expired_qty > 0 && <span className="block text-[11px] font-normal text-critical">+{r.expired_qty} expired</span>}</td>
                <td className="px-3 py-2.5 text-right tnum text-ink-2">{fmt.one(r.weekly_rate)}</td>
                <td className="px-3 py-2.5 text-right tnum text-ink-2">{coverText(r.weeks_of_cover, r.on_hand)}</td>
                <td className="px-3 py-2.5 tnum">
                  {r.earliest_expiry ? <><span className={r.days_to_expiry != null && r.days_to_expiry <= 90 ? "font-medium text-ink" : "text-ink-2"}>{dateFmt(r.earliest_expiry)}</span>
                    <span className="block text-[11px] text-ink-3">{daysText(r.days_to_expiry)} · {r.n_batches} batch{r.n_batches === 1 ? "" : "es"}</span></> : <span className="text-ink-3">—</span>}
                </td>
                <td className="px-3 py-2.5 text-right tnum text-ink-2">{fmt.int(r.order_up_to)}</td>
                <td className="px-3 py-2.5 text-right">
                  {r.suggested_order > 0 ? <span className="inline-block min-w-[44px] rounded-lg bg-brand-wash px-2 py-1 text-center font-semibold tnum text-brand-ink">{fmt.int(r.suggested_order)}</span> : <span className="text-ink-3">0</span>}
                </td>
                <td className="px-6 py-2.5 text-right tnum">{fmt.inrFull(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows && rows.length > limit && (
        <div className="border-t border-hairline px-6 py-3 text-center">
          <button onClick={() => setLimit(limit + 120)} className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-brand hover:bg-brand-wash">Show more ({fmt.int(rows.length - limit)} remaining)</button>
        </div>
      )}
    </>
  );
}

/* ───────────────────────── expiring (FEFO projection) ───────────────────────── */

const WINDOWS = ["30", "60", "90", "180"] as const;

export function ExpiringPanel({ onOpen, version }: { onOpen: (id: string) => void; version: number }) {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>("90");
  const [riskOnly, setRiskOnly] = useState(false);
  const { data, error, loading, reload } = useApi<ExpiringResp>(`/api/stock/expiring?days=${days}`);
  useReloadOnVersion(version, reload);
  const rows = data ? data.rows.filter((r) => !riskOnly || !r.will_sell_out) : null;
  const t = data?.totals;
  const exportCsv = () => data && downloadCsv(`expiring_${data.store.id}_${data.as_of}_${days}d.csv`, [
    ["store_id", "medicine_id", "medicine_name", "batch_no", "expiry_date", "days_left", "expired", "qty", "unit_cost", "value", "proj_sold", "proj_unsold", "proj_unsold_slow", "loss_value", "loss_value_slow"],
    ...data.rows.map((r) => [data.store.id, r.medicine_id, r.medicine_name, r.batch_no, r.expiry_date, r.days_left, r.expired ? "yes" : "no", r.qty, r.unit_cost.toFixed(2), r.value.toFixed(2),
      r.proj_sold, r.proj_unsold, r.proj_unsold_slow, r.loss_value.toFixed(2), r.loss_value_slow.toFixed(2)]),
  ]);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={WINDOWS} value={days} onChange={setDays} render={(d) => `${d} days`} />
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
            Only batches that won&apos;t sell out
          </label>
        </div>
        <button onClick={exportCsv} disabled={!data} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-sunken disabled:opacity-40"><Download className="h-3.5 w-3.5" aria-hidden /> CSV</button>
      </div>
      {t && (
        <div className="grid gap-3 px-6 pt-4 sm:grid-cols-3">
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <p className="text-[12px] text-ink-3">Expiring within {days} days</p>
            <p className="mt-1 text-[20px] font-semibold tnum">{fmt.int(t.units - t.expired_units)} units</p>
            <p className="text-[11.5px] text-ink-3 tnum">{t.batches - t.expired_batches} batches · {fmt.inrFull(t.value - t.expired_value)} at cost</p>
          </div>
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <p className="text-[12px] text-ink-3">Projected to expire unsold</p>
            <p className="mt-1 text-[20px] font-semibold tnum">{fmt.inrFull(t.proj_loss_value - t.expired_value)}</p>
            <p className="text-[11.5px] text-ink-3 tnum">{fmt.int(t.proj_unsold_units - t.expired_units)} units expected · up to {fmt.inrFull(t.proj_loss_value_slow - t.expired_value)} if demand runs low</p>
          </div>
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <p className="flex items-center gap-1 text-[12px] text-ink-3"><OctagonAlert className="h-3.5 w-3.5 text-critical" aria-hidden /> Already expired on shelf</p>
            <p className="mt-1 text-[20px] font-semibold tnum">{fmt.int(t.expired_units)} units</p>
            <p className="text-[11.5px] text-ink-3 tnum">{t.expired_batches} batches · {fmt.inrFull(t.expired_value)} at cost</p>
          </div>
        </div>
      )}
      {error && <p className="px-6 pt-4 text-[13px] text-critical">{error}</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[920px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-6 py-3 font-medium">Medicine · batch</th>
              <th className="px-3 py-3 font-medium">Expiry</th>
              <th className="px-3 py-3 text-right font-medium">Qty</th>
              <th className="px-3 py-3 font-medium" title="Expected share of the batch that sells before expiry, earliest-expiry first">Projected sell-through</th>
              <th className="px-3 py-3 text-right font-medium" title="Expected units left at expiry (cautious: demand at a 95% lower bound)">Left at expiry</th>
              <th className="px-6 py-3 text-right font-medium">₹ at risk (cost)</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows && [...Array(6)].map((_, i) => <tr key={i}><td colSpan={6} className="px-6 py-2"><Skeleton className="h-9" /></td></tr>)}
            {rows && rows.length === 0 && <EmptyRow cols={6} title={riskOnly ? "Every batch in this window is projected to sell out" : "No batches expire in this window"} sub="Projection at the forecast rate; check again after big demand changes." />}
            {rows?.map((r) => (
              <tr key={r.batch_id} onClick={() => onOpen(r.medicine_id)} className="cursor-pointer border-t border-hairline transition-colors hover:bg-surface-2">
                <td className="px-6 py-2.5">
                  <button onClick={(e) => { e.stopPropagation(); onOpen(r.medicine_id); }} className="focus-ring flex items-center gap-2.5 rounded text-left">
                    {r.abc && <AbcBadge abc={r.abc} />}
                    <span className="min-w-0"><span className="block max-w-[260px] truncate font-medium hover:underline">{r.medicine_name}</span>
                      <span className="block truncate text-[12px] text-ink-3">Batch {r.batch_no}{r.supplier_id ? ` · ${r.supplier_id}` : ""}</span></span>
                  </button>
                </td>
                <td className="px-3 py-2.5 tnum">
                  {r.expired ? <ExpiringChip expired /> : <><span className={r.days_left <= 30 ? "font-semibold" : ""}>{dateFmt(r.expiry_date)}</span><span className="block text-[11px] text-ink-3">in {daysText(r.days_left)}</span></>}
                </td>
                <td className="px-3 py-2.5 text-right tnum">{fmt.int(r.qty)}</td>
                <td className="px-3 py-2.5">
                  {r.expired ? <span className="text-[12px] text-ink-3">not sellable</span> : (
                    <div className="flex items-center gap-2">
                      <span className="h-1.5 w-24 rounded-full bg-sunken" aria-hidden><span className="block h-1.5 rounded-full bg-[var(--s1)]" style={{ width: `${Math.max(2, r.sellout_share * 100)}%` }} /></span>
                      {r.will_sell_out ? <span className="inline-flex items-center gap-1 text-[12px] font-medium text-good"><CircleCheck className="h-3.5 w-3.5" aria-hidden /> sells out</span>
                        : <span className="inline-flex items-center gap-1 text-[12px] font-medium text-[#8a5a00]"><Hourglass className="h-3.5 w-3.5" aria-hidden /> {fmt.pct(r.sellout_share)}</span>}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tnum">
                  {r.proj_unsold < 0.5 ? <span className="text-ink-3">0</span> : <b className="font-semibold">{fmt.int(r.proj_unsold)}</b>}
                  {!r.expired && Math.round(r.proj_unsold_slow) > Math.round(r.proj_unsold) && <span className="block text-[11px] text-ink-3">up to {fmt.int(r.proj_unsold_slow)}</span>}
                </td>
                <td className="px-6 py-2.5 text-right tnum">{r.loss_value >= 0.5 ? fmt.inrFull(r.loss_value) : <span className="text-ink-3">₹0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && <p className="px-6 py-4 text-[12px] leading-relaxed text-ink-3">{data.method}</p>}
    </>
  );
}

/* ───────────────────────── movements ───────────────────────── */

const KINDS = ["all", "receive", "sale", "adjust", "transfer_in", "transfer_out", "expire_writeoff"] as const;
const PAGE = 50;

export function MovementsPanel({ version }: { version: number }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const [page, setPage] = useState(0);
  const { data, error, loading, reload } = useApi<MovementsResp>(`/api/stock/movements?limit=${PAGE}&offset=${page * PAGE}${kind !== "all" ? `&kind=${kind}` : ""}`);
  useReloadOnVersion(version, reload);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  // A store switch or a filter change can leave us past the last page.
  useEffect(() => { if (data && page > 0 && page >= pages) setPage(pages - 1); }, [data, page, pages]);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <span>Type</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as (typeof KINDS)[number]); setPage(0); }} className="focus-ring h-9 rounded-xl border border-hairline bg-surface px-3 text-[13px]">
            {KINDS.map((k) => <option key={k} value={k}>{k === "all" ? "All movements" : MOVEMENT_LABEL[k]}</option>)}
          </select>
        </label>
        {data && (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3 tnum">
            <span>{fmt.int(data.total)} movements · page {page + 1} of {pages}</span>
            <button onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Previous page" className="focus-ring rounded-lg border border-hairline p-1.5 hover:bg-sunken disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <button onClick={() => setPage(page + 1)} disabled={page + 1 >= pages} aria-label="Next page" className="focus-ring rounded-lg border border-hairline p-1.5 hover:bg-sunken disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
      </div>
      {error && <p className="px-6 pt-4 text-[13px] text-critical">{error}</p>}
      <div className={`mt-4 overflow-x-auto ${loading && data ? "opacity-70" : ""}`}>
        <table className="w-full min-w-[860px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-6 py-3 font-medium">When</th>
              <th className="px-3 py-3 font-medium">Type</th>
              <th className="px-3 py-3 font-medium">Medicine · batch</th>
              <th className="px-3 py-3 text-right font-medium">Qty</th>
              <th className="px-3 py-3 font-medium">Ref · note</th>
              <th className="px-6 py-3 font-medium">By</th>
            </tr>
          </thead>
          <tbody>
            {!data && loading && [...Array(8)].map((_, i) => <tr key={i}><td colSpan={6} className="px-6 py-2"><Skeleton className="h-8" /></td></tr>)}
            {data && data.items.length === 0 && <EmptyRow cols={6} title="No movements yet" sub="Receipts, sales, adjustments, transfers and write-offs appear here." />}
            {data?.items.map((m) => (
              <tr key={m.id} className="border-t border-hairline">
                <td className="whitespace-nowrap px-6 py-2.5 tnum text-ink-2">{dateTimeFmt(m.created_at)}</td>
                <td className="px-3 py-2.5"><span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11.5px] font-medium text-ink-2">{MOVEMENT_LABEL[m.kind] ?? m.kind}</span></td>
                <td className="px-3 py-2.5"><span className="block max-w-[260px] truncate font-medium">{m.medicine_name ?? m.medicine_id}</span><span className="block text-[11.5px] text-ink-3">{m.batch_no ?? "—"}{m.expiry_date ? ` · exp ${dateFmt(m.expiry_date)}` : ""}</span></td>
                <td className={`px-3 py-2.5 text-right font-semibold tnum ${m.qty > 0 ? "text-good" : ""}`}>{m.qty > 0 ? "+" : "−"}{fmt.int(Math.abs(m.qty))}</td>
                <td className="px-3 py-2.5 text-[12.5px] text-ink-2"><span className="block max-w-[240px] truncate">{[m.ref, m.note].filter(Boolean).join(" · ") || "—"}</span></td>
                <td className="px-6 py-2.5 text-[12.5px] text-ink-2">{m.username ?? <span className="text-ink-3">system</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
