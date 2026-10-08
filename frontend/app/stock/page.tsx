"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2, FileUp, PackagePlus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, Segmented, Skeleton, StatTile } from "@/components/ui";
import { Columns, C } from "@/components/charts";
import { SimulatedNote } from "@/components/stock/bits";
import { AdjustDialog, ImportDialog, ReceiveDialog, SellDialog, WriteOffDialog } from "@/components/stock/Dialogs";
import { ItemDrawer } from "@/components/stock/ItemDrawer";
import { ExpiringPanel, MovementsPanel, StockTable } from "@/components/stock/Tables";
import type { ItemDetail, ItemsResp, StockItem, SummaryResp } from "@/components/stock/types";

const TABS = ["all", "low", "expiring", "movements"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { all: "All stock", low: "Low / out", expiring: "Expiring", movements: "Movements" };
const FILTERS = ["all", "out", "low", "reorder", "excess", "ok", "stocked"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = { all: "All", out: "Out", low: "Low", reorder: "Needs order", excess: "Excess", ok: "OK", stocked: "In stock" };
const SORTS = [["risk", "Priority"], ["value", "Value"], ["order", "Order value"], ["cover", "Cover (lowest)"], ["expiry", "Earliest expiry"], ["name", "Name"]] as const;
type Sort = (typeof SORTS)[number][0];

function sortRows(rows: StockItem[], sort: Sort): StockItem[] {
  const r = [...rows];
  const rank: Record<string, number> = { out: 0, low: 1, excess: 3, ok: 4, none: 5 };
  const abcW: Record<string, number> = { A: 0.3, B: 0.2, C: 0.1 };
  switch (sort) {
    case "value": return r.sort((a, b) => b.value - a.value);
    case "order": return r.sort((a, b) => b.order_value - a.order_value);
    case "cover": return r.sort((a, b) => (a.weeks_of_cover ?? 1e9) - (b.weeks_of_cover ?? 1e9));
    case "expiry": return r.sort((a, b) => (a.earliest_expiry ?? "9999").localeCompare(b.earliest_expiry ?? "9999"));
    case "name": return r.sort((a, b) => a.medicine_name.localeCompare(b.medicine_name));
    default: {
      const k = (x: StockItem) => (rank[x.status] ?? 9) - (abcW[x.abc] ?? 0) - (x.expiring ? 0.5 : 0);
      return r.sort((a, b) => k(a) - k(b) || b.order_value - a.order_value);
    }
  }
}

/**
 * Applies ?tab= and ?focus= deep links. Lives in its own Suspense boundary (useSearchParams) and re-runs on
 * client-side navigation, so an alert link clicked while already on /stock still opens the right item.
 */
function DeepLink({ onTab, onFocus }: { onTab: (t: Tab) => void; onFocus: (id: string) => void }) {
  const sp = useSearchParams();
  const t = sp.get("tab"), f = sp.get("focus");
  useEffect(() => {
    if (t && (TABS as readonly string[]).includes(t)) onTab(t as Tab);
    if (f && /^[A-Za-z0-9_-]{1,32}$/.test(f)) onFocus(f);
  }, [t, f, onTab, onFocus]);
  return null;
}

/** Mirror tab/focus into the URL without a navigation, so reloads and shared links match what is on screen. */
function syncUrl(tab: Tab, focus: string | null) {
  try {
    const u = new URL(window.location.href);
    if (tab === "all") u.searchParams.delete("tab"); else u.searchParams.set("tab", tab);
    if (focus) u.searchParams.set("focus", focus); else u.searchParams.delete("focus");
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  } catch { /* no URL access */ }
}

/* Compact cover-bin ticks so every bin (incl. "> 26 wk") keeps a label at phone width. */
const coverTick = (b: string) => (b === "No forecast demand" ? "No demand" : b.replace(/\s*wk$/, "w").replace(/^([<>])\s+/, "$1"));

export default function StockPage() {
  const { me, can } = useMe();
  const [tab, setTab] = useState<Tab>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("risk");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | "receive" | "sell" | "adjust" | "writeoff" | "import">(null);
  const [dlgMed, setDlgMed] = useState<string | null>(null);
  const [adjust, setAdjust] = useState<{ detail: ItemDetail; batch?: number } | null>(null);

  const summary = useApi<SummaryResp>("/api/stock/summary");
  const items = useApi<ItemsResp>("/api/stock/items?limit=1000&sort=risk");
  const { data: cats } = useApi<{ category: string }[]>("/api/categories", { refetchOnStoreChange: false });

  // Deep links from alerts / the medicine page (/stock?tab=expiring&focus=MED00001) are applied by <DeepLink>;
  // afterwards the URL follows the screen.
  const [linked, setLinked] = useState(false);
  const onDeepTab = useCallback((t: Tab) => { setTab(t); setLinked(true); }, []);
  const onDeepFocus = useCallback((id: string) => { setFocus(id); setLinked(true); }, []);
  useEffect(() => { if (linked || tab !== "all" || focus) syncUrl(tab, focus); }, [tab, focus, linked]);

  const refresh = useCallback((msg?: string) => {
    summary.reload(); items.reload(); setVersion((v) => v + 1);
    if (msg) setToast(msg);
  }, [summary, items]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const s = summary.data;
  const store = s?.store ?? items.data?.store ?? null;
  const options = useMemo(() => (items.data?.items ?? []).map((i) => ({ medicine_id: i.medicine_id, medicine_name: i.medicine_name, generic_name: i.generic_name, form: i.form, on_hand: i.on_hand }))
    .sort((a, b) => a.medicine_name.localeCompare(b.medicine_name)), [items.data]);

  const rows = useMemo(() => {
    if (!items.data) return null;
    const ql = q.trim().toLowerCase();
    let r = items.data.items.filter((i) => (!ql || i.medicine_name.toLowerCase().includes(ql) || i.generic_name?.toLowerCase().includes(ql) || i.medicine_id.toLowerCase().includes(ql))
      && (!category || i.category === category));
    if (tab === "low") r = r.filter((i) => i.status === "out" || i.status === "low");
    else if (filter === "reorder") r = r.filter((i) => i.suggested_order > 0);
    else if (filter === "stocked") r = r.filter((i) => i.on_hand > 0);
    else if (filter !== "all") r = r.filter((i) => i.status === filter);
    return sortRows(r, tab === "low" && sort === "risk" ? "risk" : sort);
  }, [items.data, q, category, filter, sort, tab]);

  const canReceive = can("stock.receive"), canSell = can("sales.record"), canAdjust = can("stock.adjust"), canWrite = can("stock.writeoff");
  const openDlg = (d: typeof dlg, med: string | null = null) => { setDlgMed(med); setDlg(d); };
  const actions = useMemo(() => ({
    canSell, canReceive, canAdjust,
    onSell: (id: string) => openDlg("sell", id),
    onReceive: (id: string) => openDlg("receive", id),
    onAdjust: (detail: ItemDetail, batch?: number) => { setAdjust({ detail, batch }); setDlg("adjust"); },
  }), [canSell, canReceive, canAdjust]);
  const closeDrawer = useCallback(() => setFocus(null), []);
  const closeDlg = useCallback(() => setDlg(null), []);

  if (summary.error && items.error && !s && !items.data) return <ErrorState error={summary.error} />;

  const btn = "focus-ring inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-sunken";
  const anyAction = canWrite || canReceive || canSell;
  // In the header from xl up; below it (wrapping) on narrower screens so the title keeps its width.
  const headerActions = (inHeader: boolean) => !anyAction ? null : (
    <div className={inHeader ? "hidden flex-wrap items-center gap-2 xl:flex" : "rise -mt-4 mb-6 flex flex-wrap items-center gap-2 xl:hidden"}>
      {canWrite && <button onClick={() => openDlg("writeoff")} className={btn}><Trash2 className="h-4 w-4" aria-hidden /> Write off expired{s && s.expired_on_shelf.batches > 0 ? ` (${s.expired_on_shelf.batches})` : ""}</button>}
      {canReceive && <button onClick={() => openDlg("import")} className={btn}><FileUp className="h-4 w-4" aria-hidden /> Import CSV</button>}
      {canSell && <button onClick={() => openDlg("sell")} className={btn}><ShoppingCart className="h-4 w-4" aria-hidden /> Sell</button>}
      {canReceive && <button onClick={() => openDlg("receive")} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-[#262624]"><PackagePlus className="h-4 w-4" aria-hidden /> Receive stock</button>}
    </div>
  );

  const ne = s?.near_expiry;
  const loss = s?.projected_expiry_loss_90d;
  const counts = items.data?.counts;

  return (
    <>
      <PageHeader eyebrow="Inventory · Live ledger" title="Stock & expiry"
        actions={headerActions(true)}>
        Batch-level stock for {store ? <b className="font-semibold text-ink">{store.name}</b> : "the selected store"}, sold first-expiry-first-out. On-hand counts only sellable
        (unexpired) units; cover and order quantities use the demand forecast scaled to this store.
      </PageHeader>
      {headerActions(false)}

      <Suspense fallback={null}><DeepLink onTab={onDeepTab} onFocus={onDeepFocus} /></Suspense>
      <SimulatedNote store={store} className="rise -mt-4 mb-6" />
      {summary.error && !s && (
        <p role="alert" className="mb-6 flex items-start gap-2 rounded-xl border border-[rgba(208,59,59,0.3)] bg-[#fdf5f5] px-4 py-3 text-[13px] text-ink-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-critical" aria-hidden />
          <span><b className="font-semibold text-critical">Stock summary unavailable.</b> {summary.error}{" "}
            <button onClick={summary.reload} className="focus-ring rounded font-medium text-brand underline-offset-2 hover:underline">Retry</button></span>
        </p>
      )}

      {toast && (
        <div role="status" className="rise fixed bottom-6 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-lg">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[#7fd67f]" aria-hidden /> <span className="min-w-0">{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="focus-ring ml-1 rounded p-0.5 text-white/70 hover:text-white"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {s && ne && loss ? (
          <>
            <StatTile label="Stock value (at cost)" value={fmt.inr(s.stock.value_cost)} hint={`${fmt.inr(s.stock.value_retail)} at retail · ${fmt.compact(s.stock.units)} units`} />
            <StatTile label="SKUs in stock" value={`${fmt.int(s.stock.skus_in_stock)} / ${fmt.int(s.stock.skus_total)}`}
              hint={`${s.stockouts.count} out of stock${s.stockouts.a_class ? ` (${s.stockouts.a_class} A-class)` : ""} · ${s.status_counts.low} low`} />
            <div className="card rise flex flex-col justify-between p-5">
              <p className="text-[13px] text-ink-3">Near expiry (sellable)</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(["30", "60", "90"] as const).map((d) => (
                  <div key={d}>
                    <p className="text-[20px] font-semibold leading-none tracking-tight tnum">{fmt.int(ne[d].units)}</p>
                    <p className="mt-1 text-[11px] leading-snug text-ink-3 tnum"><span className="block">≤{d} d</span><span className="block whitespace-nowrap">{fmt.inr(ne[d].value)}</span></p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] text-ink-3">units, cumulative windows, at cost</p>
            </div>
            <div className="card rise flex flex-col justify-between p-5">
              <p className="text-[13px] text-ink-3">Projected expiry loss, 90 d</p>
              <p className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.02em]">{fmt.inr(loss.value)}</p>
              <p className="mt-3 text-[12px] text-ink-3">{fmt.int(loss.units)} units in {loss.batches} batches · up to {fmt.inr(loss.value_slow)} if demand runs low
                {s.expired_on_shelf.batches > 0 && <span className="mt-1 block font-medium text-critical">+ {fmt.inrFull(s.expired_on_shelf.value)} already expired on shelf ({fmt.int(s.expired_on_shelf.units)} u)</span>}
              </p>
            </div>
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card delay={40}>
          <CardHeader title="Weeks of cover" sub="Medicines by how long sellable stock lasts at this store's forecast rate. Short cover risks stockouts; long cover ties up cash and risks expiry." />
          <div className="px-3 pb-4 pt-3 sm:px-4">
            {s ? <Columns data={s.cover_distribution.map((d) => ({ x: d.bin, y: d.count }))} height={210} color={C.s1} valueLabel="medicines" xFormatter={coverTick} />
              : <Skeleton className="mx-2 h-[210px]" />}
          </div>
        </Card>
        <Card delay={60} className="p-6">
          <p className="eyebrow mb-3">Reorder against the plan</p>
          {s ? (
            <>
              <p className="text-[28px] font-semibold leading-none tracking-[-0.02em] tnum">{fmt.int(s.reorder.units)} <span className="text-[15px] font-medium text-ink-3">units</span></p>
              <p className="mt-2 text-[13px] text-ink-2">across {fmt.int(s.reorder.lines)} medicines (≈ {fmt.inr(s.reorder.value_retail)} at median selling price) to bring stock up to the planner&apos;s
                order-up-to level ({s.params.lead_time}-wk lead time, {s.params.review}-wk review, {fmt.pct(s.params.service)} service).</p>
              <ul className="mt-4 space-y-1.5 text-[12px] leading-relaxed text-ink-3">
                <li>{s.definitions.out}</li>
                <li>{s.definitions.low}</li>
                <li>{s.definitions.cost}</li>
              </ul>
            </>
          ) : <Skeleton className="h-40" />}
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden" delay={80}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
          <Segmented options={TABS} value={tab} onChange={setTab} render={(t) => (
            <>{TAB_LABEL[t]}{counts && t !== "movements" && <span className="rounded-full bg-sunken px-1.5 text-[11px] tnum text-ink-3">{t === "all" ? counts.stocked : t === "low" ? counts.out + counts.low : counts.expiring}</span>}</>
          )} />
          {(tab === "all" || tab === "low") && items.data && <p className="text-[12px] text-ink-3 tnum">{rows?.length ?? 0} of {items.data.total} medicines</p>}
        </div>

        {(tab === "all" || tab === "low") && (
          <>
            <div className="flex flex-col gap-3 px-6 pt-4 lg:flex-row lg:items-center">
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicine, generic or ID…" aria-label="Search stock"
                  className="focus-ring h-10 w-full rounded-xl border border-hairline bg-surface pl-10 pr-4 text-[14px] placeholder:text-muted" />
              </label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="focus-ring h-10 rounded-xl border border-hairline bg-surface px-3 text-[13px] lg:w-56">
                <option value="">All categories</option>
                {cats?.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
              </select>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by" className="focus-ring h-10 rounded-xl border border-hairline bg-surface px-3 text-[13px] lg:w-44">
                {SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
              </select>
            </div>
            {tab === "all" && (
              <div className="flex flex-wrap gap-1.5 px-6 pt-3" role="group" aria-label="Status filter">
                {FILTERS.map((f) => {
                  const n = counts ? (f === "all" ? counts.all : counts[f]) : null;
                  return (
                    <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                      className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition ${filter === f ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:bg-sunken"}`}>
                      {FILTER_LABEL[f]}{n != null && <span className={`tnum ${filter === f ? "text-white/70" : "text-ink-3"}`}>{n}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="pt-4">
              <StockTable rows={rows} loading={items.loading} onOpen={setFocus}
                emptyHint={tab === "low" ? "No medicine is out of stock or below its expected demand until the next delivery." : "No medicine matches these filters."} />
            </div>
            {items.error && <p className="px-6 pb-4 text-[13px] text-critical">{items.error}</p>}
          </>
        )}
        {tab === "expiring" && <ExpiringPanel onOpen={setFocus} version={version} />}
        {tab === "movements" && <div className="pb-2"><MovementsPanel version={version} /></div>}
      </Card>

      {s && (
        <p className="mt-6 text-[12px] leading-relaxed text-ink-3">
          Forecast from {fmt.weekYear(s.forecast_start)}; stock as of {fmt.weekYear(s.as_of)}. {s.definitions.simulated} Projections assume demand follows the forecast and are not guarantees.
        </p>
      )}

      <ItemDrawer id={focus} onClose={closeDrawer} actions={actions} version={version} />
      <ReceiveDialog open={dlg === "receive"} onClose={closeDlg} onDone={refresh} options={options} store={store} initialMed={dlgMed} />
      <SellDialog open={dlg === "sell"} onClose={closeDlg} onDone={refresh} options={options} store={store} initialMed={dlgMed} />
      <AdjustDialog open={dlg === "adjust" && !!adjust} onClose={closeDlg} onDone={refresh} batches={adjust?.detail.batches ?? []}
        medicineName={adjust?.detail.item.medicine_name ?? ""} store={adjust?.detail.store ?? store} limit={me?.limits.adjust_max ?? null} initialBatch={adjust?.batch ?? null} />
      <WriteOffDialog open={dlg === "writeoff"} onClose={closeDlg} onDone={refresh} store={store} expired={s?.expired_on_shelf ?? null} />
      <ImportDialog open={dlg === "import"} onClose={closeDlg} onDone={refresh} store={store} />
    </>
  );
}
