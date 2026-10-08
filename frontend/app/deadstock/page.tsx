"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Info, Printer, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { ApiError, apiSend, errorMessage, useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { Card, CardHeader, PageHeader, Segmented, Skeleton } from "@/components/ui";
import { inputCls } from "@/components/auth/Modal";
import { AgeingChart, DeadlineTimeline } from "@/components/deadstock/Charts";
import { MarkdownDialog, RtvDialog, RtvNoteDialog, TransferDialog } from "@/components/deadstock/Dialogs";
import { AssumptionControls, BestChip, ItemsTable, type BatchActions } from "@/components/deadstock/Panels";
import {
  CLASS_META, CLASS_ORDER, type Assumptions, type BatchOptions, type DsClass, type DsItems, type DsSummary,
  type Markdown, type OptionKey, type RtvNote,
} from "@/components/deadstock/types";

const FILTERS = ["all", ...CLASS_ORDER] as const;
type Filter = (typeof FILTERS)[number];
const SORTS = [["risk", "Value at risk"], ["uplift", "Gain vs hold"], ["value", "Stock value"], ["deadline", "Return deadline"]] as const;
type Sort = (typeof SORTS)[number][0];

function qsFor(a: Assumptions | null): string {
  if (!a) return "";
  const p = new URLSearchParams();
  if (a.credit_pct != null) p.set("credit_pct", String(a.credit_pct));
  p.set("elasticity_otc", String(a.elasticity_otc));
  p.set("elasticity_rx", String(a.elasticity_rx));
  p.set("transfer_cost", String(a.transfer_cost));
  p.set("holding_cost_pct", String(a.holding_cost_pct));
  return "?" + p.toString();
}

export default function DeadstockPage() {
  const { can } = useMe();
  const saved = useApi<{ saved: Assumptions; can_edit: boolean }>("/api/deadstock/assumptions", { refetchOnStoreChange: false });
  const [assump, setAssump] = useState<Assumptions | null>(null);
  const [showAssump, setShowAssump] = useState(false);
  const [savingA, setSavingA] = useState(false);
  useEffect(() => { if (saved.data && !assump) setAssump(saved.data.saved); }, [saved.data, assump]);

  const qs = qsFor(assump);
  const ready = assump != null || saved.error != null;
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("risk");
  const [q, setQ] = useState("");
  const sep = qs ? "&" : "?";
  const summary = useApi<DsSummary>(ready ? `/api/deadstock/summary${qs}` : null);
  const items = useApi<DsItems>(ready ? `/api/deadstock/items${qs}${sep}limit=500&sort=${sort}${filter !== "all" ? `&class=${filter}` : ""}` : null);
  const rtvs = useApi<{ notes: RtvNote[]; total: number; totals: { cost: number; credit: number } }>("/api/deadstock/rtv?limit=20");
  const mds = useApi<{ markdowns: Markdown[] }>("/api/deadstock/markdowns");

  const [toast, setToastState] = useState<{ msg: string; ok: boolean } | null>(null);
  const setToast = useCallback((msg: string | null, ok = true) => setToastState(msg ? { msg, ok } : null), []);
  const [version, setVersion] = useState(0);
  const [focusBatch, setFocusBatch] = useState<{ id: number; n: number } | null>(null);
  const [dlg, setDlg] = useState<null | { kind: "rtv" | "markdown" | "transfer"; batch: BatchOptions }>(null);
  const [noteId, setNoteId] = useState<number | null>(null);
  useEffect(() => { if (!toast?.ok) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast, setToast]);
  // Stable close handlers: the shared Modal re-runs its focus effect whenever onClose changes identity,
  // which would pull focus back to the first field on every page re-render (e.g. when a toast times out).
  const closeDlg = useCallback(() => setDlg(null), []);
  const closeNote = useCallback(() => setNoteId(null), []);

  const refresh = useCallback((msg?: string) => {
    summary.reload(); items.reload(); rtvs.reload(); mds.reload(); setVersion((v) => v + 1); setDlg(null);
    if (msg) setToast(msg);
  }, [summary, items, rtvs, mds, setToast]);

  const actions: BatchActions = useMemo(() => ({
    canRtv: can("stock.writeoff"), canMarkdown: can("purchase.plan"),
    canTransfer: can("transfers.create") || can("transfers.request"), transferExecutes: can("transfers.create"),
    onRtv: (b) => setDlg({ kind: "rtv", batch: b }), onMarkdown: (b) => setDlg({ kind: "markdown", batch: b }),
    onTransfer: (b) => setDlg({ kind: "transfer", batch: b }),
  }), [can]);
  const rtvLimit = can("stock.adjust.large") || can("stores.all") ? null : 10;

  const saveAssumptions = async (a: Assumptions) => {
    setSavingA(true);
    try {
      await apiSend("PUT", "/api/deadstock/assumptions", a);
      setAssump(a); setToast("Assumptions saved as the default for everyone");
    } catch (e) {
      setToast(`Could not save assumptions: ${e instanceof ApiError ? errorMessage(e.detail, e.message) : "request failed"}`, false);
    } finally { setSavingA(false); }
  };

  const rows = useMemo(() => {
    const all = items.data?.items ?? [];
    const ql = q.trim().toLowerCase();
    return ql ? all.filter((i) => i.medicine_name.toLowerCase().includes(ql) || (i.generic_name ?? "").toLowerCase().includes(ql)) : all;
  }, [items.data, q]);

  const s = summary.data;
  const resetAssumptions = () => { if (saved.data) { setAssump(saved.data.saved); setToast("Assumptions reset to the saved defaults"); } };

  const openBatch = (id: number) => {
    setFilter("all"); setQ(""); setFocusBatch((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    setTimeout(() => document.getElementById("ds-table")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const mix = s ? (Object.entries(s.best_mix) as [OptionKey, { batches: number; recovery: number }][]).sort((a, b) => b[1].recovery - a[1].recovery) : [];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Operations" title="Slow stock & returns"
        actions={<button onClick={() => setShowAssump((v) => !v)} aria-expanded={showAssump}
          className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-sunken hover:text-ink">
          <SlidersHorizontal className="h-4 w-4" aria-hidden /> Assumptions</button>}>
        Stock that will not sell in time, and the best way to turn it back into cash: return it to the supplier, move it to a branch,
        mark it down, hold it, or write it off. Every number is shown with its arithmetic.
      </PageHeader>

      {toast && (
        <div role={toast.ok ? "status" : "alert"} className={`rise flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-[13px] ${toast.ok ? "border-brand-soft bg-brand-wash text-brand-ink" : "border-[#f3c6c2] bg-[#fdecea] text-[#a8302f]"}`}>
          <span className="inline-flex items-center gap-2">{toast.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> : <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />}{toast.msg}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="focus-ring rounded p-0.5"><X className="h-4 w-4" /></button>
        </div>
      )}

      {showAssump && assump && (
        <Card className="p-6">
          <h2 className="mb-4 text-[15px] font-semibold tracking-tight">Assumptions</h2>
          <AssumptionControls value={assump} onApply={(a) => { setAssump(a); setToast("Recalculated with your assumptions (not saved)"); }} onReset={resetAssumptions}
            onSave={saveAssumptions} canSave={!!saved.data?.can_edit} saving={savingA} />
        </Card>
      )}

      {summary.error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#f3c6c2] bg-[#fdecea] px-4 py-3 text-[13px] text-[#a8302f]">
          <span className="inline-flex items-center gap-2"><AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            Could not load the analysis{s ? " (figures below are from the previous load)" : ""}: {summary.error}</span>
          <span className="flex gap-2">
            {saved.data && <button onClick={resetAssumptions} className="focus-ring rounded-lg border border-[#f3c6c2] bg-white px-2.5 py-1 text-[12px] font-medium">Reset assumptions</button>}
            <button onClick={() => { summary.reload(); items.reload(); }} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-[#f3c6c2] bg-white px-2.5 py-1 text-[12px] font-medium"><RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry</button>
          </span>
        </div>
      )}

      {/* hero */}
      {!s ? (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">{summary.error ? <><div className="card h-[188px]" /><div className="card h-[188px]" /></> : <><Skeleton className="h-[188px]" /><Skeleton className="h-[188px]" /></>}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card className="p-6">
            <p className="text-[13px] text-ink-3">Value at risk · {s.store.name}</p>
            <p className="mt-2 text-[44px] font-semibold leading-none tracking-[-0.03em] tnum">{fmt.inrFull(s.value_at_risk)}</p>
            <p className="mt-2 text-[13px] text-ink-2">
              at cost: stock projected unsold at expiry plus expired stock on the shelf, out of {fmt.inr(s.total_stock_value)} total stock.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {CLASS_ORDER.map((c) => (
                <button key={c} onClick={() => setFilter(c)} aria-pressed={filter === c} title={`Show ${CLASS_META[c].label.toLowerCase()} items in the table`}
                  className={`focus-ring rounded-xl border px-3 py-2.5 text-left hover:bg-sunken ${filter === c ? "border-ink" : "border-hairline"}`}>
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-3"><span className="h-2 w-2 rounded-full" style={{ background: CLASS_META[c].color }} aria-hidden />{CLASS_META[c].label}</span>
                  <span className="mt-1 block text-[17px] font-semibold tnum">{s.by_class[c].value_at_risk < 1000 ? fmt.inrFull(s.by_class[c].value_at_risk) : fmt.inr(s.by_class[c].value_at_risk)}</span>
                  <span className="block text-[11.5px] text-ink-3">{s.by_class[c].items} item{s.by_class[c].items === 1 ? "" : "s"}</span>
                  <span className="block text-[11.5px] text-ink-3">{c === "expired" ? "on the shelf" : `of ${fmt.inr(s.by_class[c].value)} held`}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card className="p-6" delay={60}>
            <p className="text-[13px] text-ink-3">Expected recovery with the best option per batch</p>
            <p className="mt-2 text-[32px] font-semibold leading-none tracking-[-0.02em] tnum">{fmt.inrFull(s.best_recovery)}</p>
            <p className="mt-2 text-[13px] text-ink-2">
              <span className="font-medium text-good">+{fmt.inrFull(s.uplift_vs_hold)}</span> vs just holding ({fmt.inrFull(s.hold_recovery)}).
              Value tied up in dead + slow stock: <b className="tnum">{fmt.inrFull(s.value_tied_up)}</b>.
            </p>
            <div className="mt-4 space-y-1.5">
              {mix.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <BestChip k={k} /><span className="text-ink-2 tnum">{v.batches} batch{v.batches === 1 ? "" : "es"} · {fmt.inrFull(v.recovery)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card delay={90}>
          <CardHeader title="Ageing of problem stock" sub="Cost value by days since received" />
          <div className="px-6 pb-5 pt-3">{s ? <AgeingChart rows={s.ageing} /> : <Skeleton className="h-[220px]" />}</div>
        </Card>
        <Card delay={120}>
          <CardHeader title="Return-before deadlines" sub={s ? `${s.n_deadlines} returnable batch${s.n_deadlines === 1 ? "" : "es"}, soonest first` : "Supplier return windows"} />
          <div className="max-h-[300px] overflow-y-auto px-3 pb-4 pt-2">
            {s ? <DeadlineTimeline items={s.deadlines} onOpen={openBatch} /> : <Skeleton className="mx-3 h-[220px]" />}
          </div>
        </Card>
      </div>

      <Card delay={150} className="overflow-hidden">
        <div id="ds-table" className="scroll-mt-20" />
        <CardHeader title="Items to act on" sub={items.data ? `${rows.length} of ${items.data.total} items · expand a row to compare every option` : "Loading…"}
          right={<div className="-mx-1 max-w-full overflow-x-auto px-1"><Segmented options={FILTERS} value={filter} onChange={setFilter}
            render={(f) => f === "all" ? "All" : <><span className="h-2 w-2 rounded-full" style={{ background: CLASS_META[f as DsClass].color }} aria-hidden />{CLASS_META[f as DsClass].label}{items.data ? <span className="text-ink-3 tnum">{items.data.counts[f as DsClass]}</span> : null}</>} /></div>} />
        <div className="flex flex-wrap items-center gap-3 px-6 pb-3 pt-4">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicine…" aria-label="Search medicine" className={`${inputCls} pl-9`} />
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-ink-3">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="focus-ring h-9 rounded-xl border border-hairline bg-surface px-2 text-[13px] text-ink">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        {items.error ? <p className="px-6 pb-6 text-[13px] text-critical">{items.error}</p>
          : !items.data ? <div className="space-y-2 px-6 pb-6">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          : rows.length === 0 ? (
            <div className="px-6 pb-10 pt-6 text-center">
              <CheckCircle2 className="mx-auto h-6 w-6 text-good" aria-hidden />
              <p className="mt-2 text-[14px] font-medium">Nothing here</p>
              <p className="mt-1 text-[12.5px] text-ink-3">No items match this filter at this store.</p>
            </div>
          ) : <ItemsTable key={items.data.store.id} items={rows} qs={qs} actions={actions} version={version} focusBatch={focusBatch} />}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Return-to-vendor history" sub={rtvs.data ? `${rtvs.data.total} note${rtvs.data.total === 1 ? "" : "s"} · ${fmt.inrFull(rtvs.data.totals.credit)} expected credit` : undefined} />
          <div className="px-3 pb-4 pt-2">
            {!rtvs.data ? <Skeleton className="mx-3 h-24" /> : rtvs.data.notes.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-ink-3">No return notes yet. Create one from a batch's options.</p>
            ) : (
              <ul>
                {rtvs.data.notes.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => setNoteId(n.id)} className="focus-ring flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-sunken" aria-label={`Open return note ${n.ref}`}>
                      <span className="min-w-0">
                        <span className="block font-mono text-[12.5px] font-medium">{n.ref}</span>
                        <span className="block truncate text-[12px] text-ink-3">{n.supplier_id ?? "supplier not recorded"} · {n.n_lines} line{n.n_lines === 1 ? "" : "s"} · {n.total_units} u · {new Date(n.created_at).toLocaleDateString("en-IN")}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[12.5px] tnum">{fmt.inrFull(n.expected_credit)}<Printer className="h-3.5 w-3.5 text-ink-3" aria-hidden /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Active markdowns" sub="Price notes for the counter / POS" />
          <div className="px-6 pb-5 pt-3">
            {!mds.data ? <Skeleton className="h-20" /> : mds.data.markdowns.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-ink-3">No active markdowns.</p>
            ) : (
              <ul className="space-y-2 text-[12.5px]">
                {mds.data.markdowns.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0"><span className="block truncate font-medium">{m.medicine_name ?? m.medicine_id}</span><span className="text-ink-3">batch {m.batch_no} · until {m.valid_until}</span></span>
                    <span className="shrink-0 text-right tnum"><b>{fmt.pct(m.discount_pct)} off</b><span className="block text-ink-3">₹{m.markdown_price.toFixed(2)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {s && (
        <details className="card p-5 text-[12.5px] text-ink-2">
          <summary className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded font-medium text-ink"><Info className="h-4 w-4" aria-hidden /> How this is calculated</summary>
          <ul className="mt-3 space-y-1.5 leading-relaxed">
            {CLASS_ORDER.map((c) => <li key={c}><b>{CLASS_META[c].label}:</b> {s.definitions[c]}</li>)}
            <li><b>Recovery:</b> {s.definitions.recovery} Holding cost: a unit that takes t weeks to sell is worth price × (1 − h × t/52) today.</li>
            <li><b>Return policy:</b> {s.definitions.policy_source}</li>
            <li><b>Branches:</b> {s.definitions.simulated_branches}</li>
            <li className="text-ink-3">{s.definitions.legal}</li>
          </ul>
        </details>
      )}

      <RtvDialog batch={dlg?.kind === "rtv" ? dlg.batch : null} open={dlg?.kind === "rtv"} onClose={closeDlg} limit={rtvLimit}
        onDone={(id, ref) => { refresh(`Return note ${ref} created; stock reduced`); setNoteId(id); }} />
      <MarkdownDialog batch={dlg?.kind === "markdown" ? dlg.batch : null} open={dlg?.kind === "markdown"} onClose={closeDlg} onDone={(m) => refresh(m)} />
      <TransferDialog batch={dlg?.kind === "transfer" ? dlg.batch : null} open={dlg?.kind === "transfer"} onClose={closeDlg}
        execute={actions.transferExecutes} onDone={(m) => refresh(m)} />
      <RtvNoteDialog id={noteId} onClose={closeNote} onPrintBlocked={() => setToast("The print window was blocked. Allow pop-ups for this site and try again.", false)} />
    </div>
  );
}
