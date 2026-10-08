"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, CheckCircle2, ChevronDown, ChevronRight, Percent, RotateCcw, SlidersHorizontal, Tag, Undo2 } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Skeleton } from "@/components/ui";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { OptionBars } from "./Charts";
import { CLASS_META, OPTION_LABEL, type Assumptions, type BatchOptions, type DsClass, type DsItem, type OptionKey } from "./types";

export const OPTION_ICON: Record<OptionKey, typeof Undo2> = { hold: CheckCircle2, rtv: Undo2, transfer: ArrowLeftRight, markdown: Tag, writeoff: RotateCcw };

export function ClassBadge({ cls }: { cls: DsClass }) {
  const m = CLASS_META[cls];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11.5px] font-medium text-ink-2" title={m.blurb}>
      <span className="h-2 w-2 rounded-full" style={{ background: m.color }} aria-hidden />{m.label}
    </span>
  );
}

export function BestChip({ k, label }: { k: OptionKey | null; label?: string | null }) {
  if (!k) return <span className="text-ink-3">—</span>;
  const Icon = OPTION_ICON[k];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium ${k === "writeoff" ? "bg-sunken text-ink-2" : "bg-brand-wash text-brand-ink"}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{label ?? OPTION_LABEL[k]}
    </span>
  );
}

/* ───────────────── Assumption controls ───────────────── */
/** Same bounds as the API (AssumptionQuery / AssumptionsBody), so a typo cannot turn the whole page into a 422. */
const BOUNDS: Record<keyof Assumptions, [number, number]> = {
  credit_pct: [0, 1], elasticity_otc: [0, 6], elasticity_rx: [0, 6], transfer_cost: [0, 100_000], holding_cost_pct: [0, 1],
};

export function AssumptionControls({ value, onApply, onSave, canSave, saving, onReset }: {
  value: Assumptions; onApply: (a: Assumptions) => void; onSave: (a: Assumptions) => void; canSave: boolean; saving: boolean;
  onReset?: () => void;
}) {
  const [a, setA] = useState(value);
  const [useCredit, setUseCredit] = useState(value.credit_pct != null);
  useEffect(() => { setA(value); setUseCredit(value.credit_pct != null); }, [value]);
  const cur: Assumptions = { ...a, credit_pct: useCredit ? (a.credit_pct ?? 0.8) : null };
  const num = (k: keyof Assumptions, scale = 1) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    const [lo, hi] = BOUNDS[k];
    if (Number.isFinite(v)) setA((p) => ({ ...p, [k]: Math.min(hi, Math.max(lo, v / scale)) }));
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <div>
        <label className={labelCls} htmlFor="as-credit">Supplier credit %</label>
        <div className="flex items-center gap-2">
          <input type="checkbox" aria-label="Override supplier credit %" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} className="h-4 w-4 accent-[var(--brand)]" />
          <input id="as-credit" type="number" min={0} max={100} step={5} disabled={!useCredit} value={Math.round((a.credit_pct ?? 0.8) * 100)} onChange={num("credit_pct", 100)} className={inputCls} />
        </div>
        <p className="mt-1 text-[11px] text-ink-3">{useCredit ? "Same for all suppliers" : "Each supplier's policy"}</p>
      </div>
      <div>
        <label className={labelCls} htmlFor="as-otc">Elasticity OTC</label>
        <input id="as-otc" type="number" min={0} max={6} step={0.1} value={a.elasticity_otc} onChange={num("elasticity_otc")} className={inputCls} />
        <p className="mt-1 text-[11px] text-ink-3">10% off → ×{Math.pow(0.9, -a.elasticity_otc).toFixed(2)} demand</p>
      </div>
      <div>
        <label className={labelCls} htmlFor="as-rx">Elasticity Rx</label>
        <input id="as-rx" type="number" min={0} max={6} step={0.1} value={a.elasticity_rx} onChange={num("elasticity_rx")} className={inputCls} />
        <p className="mt-1 text-[11px] text-ink-3">Prescription demand barely reacts</p>
      </div>
      <div>
        <label className={labelCls} htmlFor="as-tc">Transfer cost ₹</label>
        <input id="as-tc" type="number" min={0} max={100000} step={10} value={a.transfer_cost} onChange={num("transfer_cost")} className={inputCls} />
        <p className="mt-1 text-[11px] text-ink-3">Per transfer</p>
      </div>
      <div>
        <label className={labelCls} htmlFor="as-hc">Holding cost %/yr</label>
        <input id="as-hc" type="number" min={0} max={100} step={1} value={Math.round(a.holding_cost_pct * 100)} onChange={num("holding_cost_pct", 100)} className={inputCls} />
        <p className="mt-1 text-[11px] text-ink-3">Capital + shelf + handling</p>
      </div>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
        <button className={primaryBtn} onClick={() => onApply(cur)}><SlidersHorizontal className="h-4 w-4" aria-hidden /> Recalculate</button>
        {canSave && <button className={ghostBtn} disabled={saving} onClick={() => onSave(cur)}>{saving ? "Saving…" : "Save as default"}</button>}
        {onReset && <button className={ghostBtn} onClick={onReset}>Reset to saved</button>}
      </div>
    </div>
  );
}

/* ───────────────── One batch: every option ───────────────── */
export type BatchActions = {
  canRtv: boolean; canMarkdown: boolean; canTransfer: boolean; transferExecutes: boolean;
  onRtv: (b: BatchOptions) => void; onMarkdown: (b: BatchOptions) => void; onTransfer: (b: BatchOptions) => void;
};

export function BatchOptionsPanel({ batchId, qs, actions, version }: { batchId: number; qs: string; actions: BatchActions; version: number }) {
  const { data, error, loading, reload } = useApi<BatchOptions>(`/api/deadstock/batches/${batchId}/options${qs}`);
  useEffect(() => { if (version) reload(); }, [version, reload]);
  if (loading && !data) return <Skeleton className="h-40" />;
  if (error) return <p className="text-[12.5px] text-critical">Could not load options: {error}</p>;
  if (!data) return null;
  const opt = (k: OptionKey) => data.options.find((o) => o.key === k)!;
  const rtv = opt("rtv"), tr = opt("transfer"), md = opt("markdown");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink-2">
        <span>Batch <b className="font-mono">{data.batch_no}</b></span>
        <span>{data.qty} u · cost ₹{data.unit_cost.toFixed(2)} · price ₹{data.price.toFixed(2)}</span>
        <span>{data.expired ? "Expired" : `${data.days_left} d to expiry`} ({data.expiry_date})</span>
        <span>Projected sold {fmt.one(data.projected_sold)} · unsold {fmt.one(data.projected_unsold)}</span>
        <span>Supplier {data.supplier_id ?? "—"}</span>
      </div>
      <OptionBars options={data.options} />
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <caption className="sr-only">All options for batch {data.batch_no} with arithmetic</caption>
          <thead><tr className="text-left text-ink-3">
            <th className="py-1.5 pr-3 font-medium">Option</th><th className="py-1.5 pr-3 text-right font-medium">Recovery</th>
            <th className="py-1.5 pr-3 text-right font-medium">vs hold</th><th className="py-1.5 font-medium">How it's computed</th>
          </tr></thead>
          <tbody>
            {data.options.map((o) => {
              const Icon = OPTION_ICON[o.key];
              return (
                <tr key={o.key} className={`border-t border-hairline align-top ${o.best ? "bg-brand-wash/60" : ""}`}>
                  <td className="py-2 pr-3">
                    <span className={`inline-flex items-center gap-1.5 ${o.best ? "font-semibold" : ""}`}><Icon className="h-3.5 w-3.5" aria-hidden />{o.label}</span>
                    {o.best && <span className="ml-1.5 rounded bg-brand px-1.5 py-0.5 text-[10.5px] font-semibold text-white">BEST</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tnum">{o.eligible ? fmt.inrFull(o.recovery) : "—"}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-3">{o.vs_hold == null ? "—" : `${o.vs_hold >= 0 ? "+" : "−"}${fmt.inrFull(Math.abs(o.vs_hold))}`}</td>
                  <td className="py-2 text-ink-2">{o.eligible ? o.formula : <span className="text-ink-3">Not available: {o.why_not}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {md.grid && md.grid.length > 0 && !data.expired && (
        <details className="text-[12px] text-ink-3">
          <summary className="focus-ring cursor-pointer rounded">Markdown grid (discount → expected recovery)</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {md.grid.map((g) => (
              <span key={g.discount} className={`rounded-md border border-hairline px-2 py-1 tnum ${g.discount === md.discount ? "bg-sunken font-medium text-ink" : ""}`}>
                <Percent className="mr-0.5 inline h-3 w-3" aria-hidden />{Math.round(g.discount * 100)} → {fmt.inrFull(g.recovery)}
              </span>
            ))}
          </div>
        </details>
      )}
      {data.active_markdown && (
        <p className="text-[12px] text-ink-2"><Tag className="mr-1 inline h-3.5 w-3.5" aria-hidden />Active markdown {fmt.pct(data.active_markdown.discount_pct)} (₹{data.active_markdown.markdown_price.toFixed(2)}) until {data.active_markdown.valid_until}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.canRtv && rtv.eligible && (
          <button className={data.best === "rtv" ? primaryBtn : ghostBtn} onClick={() => actions.onRtv(data)}><Undo2 className="h-4 w-4" aria-hidden /> Create return note</button>
        )}
        {actions.canTransfer && tr.eligible && (
          <button className={data.best === "transfer" ? primaryBtn : ghostBtn} onClick={() => actions.onTransfer(data)}>
            <ArrowLeftRight className="h-4 w-4" aria-hidden /> {actions.transferExecutes ? "Transfer" : "Request transfer"} to {tr.to_store_name?.replace(/ branch$/i, "")}
          </button>
        )}
        {actions.canMarkdown && !data.expired && (
          <button className={data.best === "markdown" ? primaryBtn : ghostBtn} onClick={() => actions.onMarkdown(data)}><Tag className="h-4 w-4" aria-hidden /> Mark down</button>
        )}
        {data.expired && <Link href={`/stock?tab=expiring&focus=${encodeURIComponent(data.medicine_id)}`} className={ghostBtn}><RotateCcw className="h-4 w-4" aria-hidden /> Write off on Stock page</Link>}
        {!actions.canRtv && !actions.canTransfer && !actions.canMarkdown && <p className="text-[12px] text-ink-3">Your role can view these options; actions need an owner, buyer or pharmacist.</p>}
      </div>
    </div>
  );
}

/* ───────────────── Items table with expandable comparison ───────────────── */
export function ItemsTable({ items, qs, actions, version, focusBatch }: {
  items: DsItem[]; qs: string; actions: BatchActions; version: number; focusBatch: { id: number; n: number } | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [batch, setBatch] = useState<number | null>(null);
  const applied = useRef<number | null>(null);
  useEffect(() => {
    // Apply each deadline click once (focusBatch.n), as soon as the (possibly refetched) items contain the batch,
    // so a later refetch does not re-open a row the user has since collapsed.
    if (focusBatch == null || applied.current === focusBatch.n) return;
    const it = items.find((i) => i.batches.some((b) => b.batch_id === focusBatch.id));
    if (it) { applied.current = focusBatch.n; setOpen(it.medicine_id); setBatch(focusBatch.id); }
  }, [focusBatch, items]);
  const toggle = (it: DsItem) => {
    if (open === it.medicine_id) { setOpen(null); return; }
    setOpen(it.medicine_id); setBatch(it.batches[0]?.batch_id ?? null);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-left text-[12px] text-ink-3">
            <th className="w-8 py-2.5 pl-6" aria-label="Expand" />
            <th className="py-2.5 pr-3 font-medium">Medicine</th>
            <th className="py-2.5 pr-3 font-medium">Class</th>
            <th className="py-2.5 pr-3 text-right font-medium">On hand</th>
            <th className="py-2.5 pr-3 text-right font-medium">Value at risk</th>
            <th className="py-2.5 pr-3 font-medium">Best option</th>
            <th className="py-2.5 pr-3 text-right font-medium">Recovery</th>
            <th className="py-2.5 pr-6 text-right font-medium">vs hold</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const isOpen = open === it.medicine_id;
            return (
              <Fragment key={it.medicine_id}>
                <tr className={`border-b border-hairline ${isOpen ? "bg-surface-2" : "hover:bg-surface-2"}`}>
                  <td className="py-2.5 pl-6">
                    <button onClick={() => toggle(it)} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Compare"} options for ${it.medicine_name}`}
                      className="focus-ring rounded-md p-0.5 text-ink-3 hover:bg-sunken hover:text-ink">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </td>
                  <td className="py-2.5 pr-3">
                    <button onClick={() => toggle(it)} className="focus-ring flex items-center gap-2 rounded text-left">
                      <AbcBadge abc={it.abc} />
                      <span className="min-w-0">
                        <span className="block max-w-[260px] truncate font-medium">{it.medicine_name}</span>
                        <span className="block max-w-[260px] truncate text-[11.5px] text-ink-3">
                          {it.weeks_cover == null ? "no forecast demand" : `${fmt.one(it.weeks_cover)} wk cover`} · {Number.isInteger(it.sold_last_12w) ? fmt.int(it.sold_last_12w) : fmt.one(it.sold_last_12w)} sold in 12 wk · {it.n_batches} batch{it.n_batches === 1 ? "" : "es"}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="py-2.5 pr-3"><ClassBadge cls={it.class} /></td>
                  <td className="py-2.5 pr-3 text-right tnum">{fmt.int(it.qty + it.expired_qty)}<span className="block text-[11.5px] text-ink-3">{(it.value + it.expired_value) < 1000 ? fmt.inrFull(it.value + it.expired_value) : fmt.inr(it.value + it.expired_value)}</span></td>
                  <td className="py-2.5 pr-3 text-right font-medium tnum">{fmt.inrFull(it.value_at_risk)}</td>
                  <td className="py-2.5 pr-3"><BestChip k={it.best} label={it.best_label} /></td>
                  <td className="py-2.5 pr-3 text-right tnum">{fmt.inrFull(it.best_recovery)}</td>
                  <td className="py-2.5 pr-6 text-right tnum text-ink-2">{it.uplift_vs_hold > 0.5 ? `+${fmt.inrFull(it.uplift_vs_hold)}` : "—"}</td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-hairline bg-surface-2">
                    <td colSpan={8} className="px-6 pb-5 pt-2">
                      {it.batches.length > 1 && (
                        <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Batches">
                          {it.batches.map((b) => (
                            <button key={b.batch_id} role="tab" aria-selected={batch === b.batch_id} onClick={() => setBatch(b.batch_id)}
                              className={`focus-ring rounded-lg border px-2.5 py-1 text-[12px] ${batch === b.batch_id ? "border-ink bg-surface font-medium" : "border-hairline text-ink-2 hover:bg-surface"}`}>
                              {b.batch_no} · {b.qty} u · {b.expired ? "expired" : `${b.days_left} d`} · {OPTION_LABEL[b.best]}
                            </button>
                          ))}
                        </div>
                      )}
                      {batch != null && <BatchOptionsPanel batchId={batch} qs={qs} actions={actions} version={version} />}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
