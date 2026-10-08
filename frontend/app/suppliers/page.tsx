"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, Plus, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { ErrorState, PageHeader, Segmented, Skeleton, StatTile } from "@/components/ui";
import { SupplierDialog, SupplierDirectory, PolicyDialog } from "@/components/suppliers/Directory";
import { ImportDialog, POBoard, PODialog, POEditor } from "@/components/suppliers/Orders";
import { Notice } from "@/components/suppliers/bits";
import type { PO, POListResp, POStatus, SuppliersResp } from "@/components/suppliers/types";

const TABS = ["orders", "suppliers"] as const;
type Tab = (typeof TABS)[number];
const DEFAULT_POLICY = { accepts_returns: true, min_days_before_expiry: 90, credit_pct: 0.8 };

export default function SuppliersPage() {
  const { me, can, store } = useMe();
  const [tab, setTab] = useState<Tab>("orders");
  const [scope, setScope] = useState<"store" | "all">("store");
  const [filter, setFilter] = useState<POStatus | "open" | "all">("open");
  const [supId, setSupId] = useState<string | null>(null);
  const [poId, setPoId] = useState<number | null>(null);
  const [editPo, setEditPo] = useState<PO | null | undefined>(undefined);   // undefined = closed, null = new
  const [importOpen, setImportOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const multi = !!me && (me.all_stores || me.stores.length > 1);
  const sups = useApi<SuppliersResp>("/api/suppliers");
  const pos = useApi<POListResp>(`/api/suppliers/po?limit=500${scope === "all" ? "&store_id=all" : ""}`);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);
  const changed = useCallback((msg: string) => { setToast(msg); pos.reload(); sups.reload(); }, [pos, sups]);
  const closeSup = useCallback(() => setSupId(null), []);
  const closePo = useCallback(() => setPoId(null), []);
  const closeEditor = useCallback(() => setEditPo(undefined), []);
  const closeImport = useCallback(() => setImportOpen(false), []);
  const closePolicy = useCallback(() => setPolicyOpen(false), []);

  const stats = useMemo(() => {
    const items = pos.data?.items ?? [];
    const open = items.filter((p) => p.status === "sent" || p.status === "partially_received");
    const learned = (sups.data?.suppliers ?? []).filter((s) => s.scorecard && s.scorecard.lead.n > 0).length;
    return {
      drafts: pos.data?.counts.draft ?? items.filter((p) => p.status === "draft").length,
      open: open.length, openValue: open.reduce((a, p) => a + p.total_value, 0),
      overdue: open.filter((p) => p.overdue).length, learned, total: sups.data?.suppliers.length ?? 0,
    };
  }, [pos.data, sups.data]);

  if (sups.error && pos.error && !sups.data && !pos.data) return <ErrorState error={sups.error} />;
  const canPlan = can("purchase.plan");
  const suppliers = sups.data?.suppliers ?? [];
  const policy = sups.data?.policy_default ?? DEFAULT_POLICY;

  return (
    <>
      <PageHeader eyebrow="Operations · Purchasing" title="Suppliers & purchase orders"
        actions={canPlan ? (
          <>
            <button onClick={() => setImportOpen(true)} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3.5 py-2.5 text-[13px] font-medium text-ink-2 hover:bg-sunken"><Download className="h-4 w-4" aria-hidden /> Import from plan</button>
            <button onClick={() => setEditPo(null)} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-[#262624]"><Plus className="h-4 w-4" aria-hidden /> New PO</button>
          </>
        ) : null}>
        Raise purchase orders for {store ? <b className="font-semibold text-ink">{store.name}</b> : "the selected store"}, receive deliveries straight into the batch ledger,
        and let each supplier&apos;s real delivery times replace the default lead time used for planning.
      </PageHeader>

      <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[60] max-w-[92vw] -translate-x-1/2">
        {toast && (
          <div className="rise flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-[13px] text-white shadow-lg">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#7fd67f]" aria-hidden /> <span className="min-w-0">{toast}</span>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="focus-ring ml-1 rounded p-0.5 text-white/70 hover:text-white"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {pos.data && sups.data ? (
          <>
            <StatTile label="Awaiting delivery" value={fmt.int(stats.open)} hint={`${fmt.inr(stats.openValue)} on order (ex-GST)`} />
            <StatTile label="Overdue" value={fmt.int(stats.overdue)} hint={stats.overdue ? "past expected date" : "none past expected date"} />
            <StatTile label="Drafts" value={fmt.int(stats.drafts)} hint="not yet sent" />
            <StatTile label="Lead times learned" value={`${stats.learned} / ${stats.total}`} hint={stats.learned ? "suppliers with deliveries" : "defaults until deliveries arrive"} />
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
      </div>

      <div className="mt-8 mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented options={TABS} value={tab} onChange={setTab} render={(t) => (t === "orders" ? "Purchase orders" : "Supplier directory")} />
        {tab === "orders" && multi && (
          <Segmented options={["store", "all"] as const} value={scope} onChange={setScope} render={(s) => (s === "store" ? (store?.name ?? "This store") : "All my stores")} />
        )}
      </div>

      {tab === "orders" ? (
        <>
          {!canPlan && pos.data && <div className="mb-4"><Notice>You can view purchase orders{can("stock.receive") ? " and receive deliveries for your store" : ""}. Creating and sending POs needs the owner or buyer role.</Notice></div>}
          {scope === "all" && <p className="mb-3 text-[12.5px] text-ink-3">Showing every store you can access; the store code is the first part of each PO number. New POs are still raised for {store?.name ?? "the selected store"}.</p>}
          <POBoard data={pos.data} loading={pos.loading} error={pos.error} filter={filter} onFilter={setFilter} onOpen={setPoId} />
        </>
      ) : (
        <SupplierDirectory data={sups.data} loading={sups.loading} error={sups.error} onOpen={setSupId} onNew={() => setSupId("new")} onPolicy={() => setPolicyOpen(true)} />
      )}

      {sups.data && (
        <details className="rise mt-8 rounded-2xl border border-hairline bg-surface px-5 py-3 text-[12.5px] text-ink-2">
          <summary className="cursor-pointer font-medium text-ink">How the numbers are calculated</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {Object.entries(sups.data.notes).map(([k, v]) => <li key={k}>{v}</li>)}
          </ul>
        </details>
      )}

      <SupplierDialog id={supId} open={supId != null} onClose={closeSup} policyDefault={policy} onSaved={changed} onOpenPO={(id) => { setSupId(null); setPoId(id); }} />
      <PolicyDialog open={policyOpen} onClose={closePolicy} policy={policy} canEdit={can("settings.edit")} onSaved={changed} />
      <PODialog id={poId} open={poId != null} onClose={closePo} onChanged={changed} onEdit={(p) => { setPoId(null); setEditPo(p); }} />
      <POEditor open={editPo !== undefined} onClose={closeEditor} po={editPo ?? null} suppliers={suppliers} storeName={store?.name ?? "the selected store"}
        onSaved={(msg, id) => { changed(msg); setPoId(id); }} />
      <ImportDialog open={importOpen} onClose={closeImport} suppliers={suppliers} onDone={changed} />
    </>
  );
}
