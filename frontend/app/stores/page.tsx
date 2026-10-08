"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, FlaskConical, Info, Minus, Plus, Send, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe, type StoreInfo } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, Segmented, Skeleton, StatTile } from "@/components/ui";
import { BranchCards } from "@/components/stores/BranchCards";
import { CompareTable } from "@/components/stores/CompareTable";
import { CoverHeatmap } from "@/components/stores/CoverHeatmap";
import { CategoryCompare } from "@/components/stores/CategoryCompare";
import { Suggestions } from "@/components/stores/Suggestions";
import { TransferHistory, TransferRequests } from "@/components/stores/History";
import { NewTransfer } from "@/components/stores/NewTransfer";
import { primaryBtn, ghostBtn } from "@/components/auth/Modal";
import type { CompareResp, NetworkMetrics, SuggestResp } from "@/components/stores/types";

const MIN_VALUES = ["100", "300", "1000", "5000"] as const;

function Impact({ before, after }: { before: NetworkMetrics; after: NetworkMetrics }) {
  const rows: { label: string; b: number; a: number; show: (n: number) => string; hint: string }[] = [
    { label: "Projected expiry write-off", b: before.waste_value, a: after.waste_value, show: fmt.inrFull, hint: "Cost value of units forecast to expire unsold within 180 days" },
    { label: "Stockouts (branch × medicine)", b: before.stockouts, a: after.stockouts, show: fmt.int, hint: "No sellable stock while demand is forecast" },
    { label: "Short before next delivery", b: before.at_risk, a: after.at_risk, show: fmt.int, hint: "Stock below expected lead + review demand (3 weeks)" },
    { label: "Expected units short", b: before.shortfall_units, a: after.shortfall_units, show: fmt.int, hint: "Sum of expected demand over 3 weeks not covered by stock" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {rows.map((r) => {
        const d = r.b > 0 ? (r.a - r.b) / r.b : r.a > 0 ? 1 : 0;
        const better = d < -0.005, worse = d > 0.005;
        const Icon = better ? ArrowDownRight : worse ? ArrowUpRight : Minus;
        return (
          <div key={r.label} className="rounded-2xl border border-hairline bg-surface-2 p-4" title={r.hint}>
            <p className="text-[12px] text-ink-3">{r.label}</p>
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-3 tnum">
              <span className="line-through decoration-[var(--axis)]">{r.show(r.b)}</span>
              <ArrowRight className="h-3 w-3 self-center" aria-label="becomes" />
              <span className="text-[20px] font-semibold tracking-tight text-ink">{r.show(r.a)}</span>
            </p>
            <p className={`mt-1 inline-flex items-center gap-1 text-[12px] font-medium ${better ? "text-good" : "text-ink-3"}`}>
              <Icon className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              {better || worse ? `${r.b > 0 ? fmt.signedPct(d) : `+${r.show(r.a)}`} if all approved` : "no change"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export default function StoresPage() {
  const { me, can } = useMe();
  const [minValue, setMinValue] = useState<(typeof MIN_VALUES)[number]>("300");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const cmp = useApi<CompareResp>(`/api/stores/compare?v=${version}`);
  const sug = useApi<SuggestResp>(`/api/stores/transfers/suggest?min_value=${minValue}&v=${version}`);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const closeDialog = useCallback(() => setDialog(false), []);

  // Status line after a manual transfer/request: dismissable, and clears itself after a while.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 10000);
    return () => clearTimeout(t);
  }, [flash]);

  const names = useMemo(() => Object.fromEntries((cmp.data?.directory ?? []).map((s) => [s.id, s.name])), [cmp.data]);
  const directory: StoreInfo[] = useMemo(() => (cmp.data?.directory ?? []).map((s) => ({ ...s })), [cmp.data]);
  /** Fixed branch order (main first) so a branch keeps its colour whatever the viewer's scope. */
  const order = useMemo(() => directory.map((s) => s.id), [directory]);
  // Executing a transfer needs access to both branches: a single-store approver files requests instead.
  const canExecute = can("transfers.create") && !!me?.all_stores && (me?.stores.length ?? 0) > 1;
  const canRequest = can("transfers.request");
  const execStores = useMemo(() => (me?.stores?.length ? me.stores : directory), [me, directory]);

  if (cmp.error && !cmp.data) return <ErrorState error={cmp.error} />;
  if (!cmp.data) return <PageSkeleton />;
  const d = cmp.data;
  const own = d.scope === "own";
  const sims = d.directory.filter((s) => s.simulated);

  return (
    <>
      <PageHeader eyebrow="Network · Branches" title={own ? `${d.stores[0]?.name ?? "Your branch"}` : "Branches"}
        actions={(canExecute || canRequest) && d.directory.length > 1 ? (
          <button onClick={() => setDialog(true)} className={canExecute ? primaryBtn : ghostBtn}>
            {canExecute ? <Plus className="h-4 w-4" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            {canExecute ? "New transfer" : "Request transfer"}
          </button>
        ) : undefined}>
        {own
          ? "Your branch’s stock against its forecast, and the transfers that involve it. Other branches’ stock is visible to owners and buyers only."
          : "Compare stock, cover and expiry risk across branches, then move stock to where it will sell before it expires."}
      </PageHeader>

      {sims.length > 0 && (
        <div className="rise mb-6 flex gap-3 rounded-2xl border border-[#f3d9a6] bg-[#fff9ed] px-4 py-3.5 text-[13px] leading-relaxed text-[#5c3d00]">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <b className="font-semibold">Branch demand is simulated.</b> The sales history comes from one shop ({d.directory.find((s) => s.is_main)?.name}).
            Until real branch sales are loaded, {sims.map((s) => `${s.name} uses ×${s.demand_scale.toFixed(2)}`).join(" and ")} of the
            main store’s forecast, with the same seasonal pattern. Stock levels are real records in the inventory ledger (demo seed).
          </p>
        </div>
      )}

      {flash && (
        <div role="status" className="mb-6 flex items-start justify-between gap-3 rounded-xl bg-brand-wash px-3.5 py-2.5 text-[13px] text-brand-ink">
          <p>{flash}</p>
          <button onClick={() => setFlash(null)} aria-label="Dismiss message" className="focus-ring -my-1 rounded-md p-1 hover:bg-white/60">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
      {cmp.error && (
        <p role="alert" className="mb-6 rounded-xl bg-[#fdf0f0] px-3.5 py-2.5 text-[13px] text-[#9c2b2b]">
          Could not refresh the branch comparison ({cmp.error}). Showing the last figures loaded.
        </p>
      )}

      {!own && (
        <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatTile label="Network stock value (cost)" value={fmt.inr(d.totals.stock_value)} hint={`${fmt.int(d.totals.units)} units`} />
          <StatTile label="Stockouts across branches" value={fmt.int(d.totals.stockouts)} hint="branch × medicine pairs" />
          <StatTile label="Expiring within 90 days" value={fmt.inr(d.totals.near_expiry_value)} hint={`${fmt.inr(d.totals.expired_value)} already expired`} />
          <StatTile label="Excess (>8 weeks cover)" value={fmt.inr(d.totals.excess_value)} hint={`${fmt.int(d.totals.forecast_weekly_units)} units/wk demand`} />
        </div>
      )}

      <BranchCards stores={d.stores} order={order} />

      {d.stores.length > 1 && (
        <Card className="mt-6 overflow-hidden" delay={60}>
          <CardHeader title="Side by side" sub={`Snapshot as of ${fmt.weekYear(d.as_of)}. Cover = units ÷ average weekly demand over the first ${d.params.cover_weeks} forecast weeks, as elsewhere in the app.`} />
          <div className="mt-4"><CompareTable stores={d.stores} /></div>
        </Card>
      )}

      <div className="mt-6 grid gap-6 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden" delay={90}>
          <CardHeader title="Cover by medicine and branch"
            sub={`Top ${d.matrix.length} medicines by stock value. Weeks of cover, coloured against each branch’s target cover.`} />
          <CoverHeatmap rows={d.matrix} stores={d.stores} />
        </Card>
        <Card delay={120}>
          <CardHeader title="Categories" sub="Where each branch holds its money, cover and expiry risk." />
          <CategoryCompare rows={d.categories} stores={d.stores} order={order} />
        </Card>
      </div>

      <section className="mt-10" aria-labelledby="sugg-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-2xl">
            <p className="eyebrow mb-1.5">Expiry-aware rebalancing</p>
            <h2 id="sugg-title" className="text-[22px] font-semibold tracking-tight">Suggested transfers</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
              Ranked by priority: first keep A/B medicines in stock, then move stock that would expire unsold to the branch that sells it fastest,
              then even out the rest. A branch never gives away stock it needs, unless those units would expire there anyway.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <span className="text-[12px] text-ink-3">Skip moves worth less than</span>
            <Segmented options={MIN_VALUES} value={minValue} onChange={setMinValue} render={(v) => `₹${Number(v).toLocaleString("en-IN")}`} />
          </div>
        </div>

        {sug.error && !sug.data ? (
          <Card className="p-6"><p className="text-[13px] text-ink-3">Could not compute suggestions: {sug.error}</p></Card>
        ) : !sug.data ? (
          <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>
        ) : (
          <div className={`transition-opacity ${sug.loading ? "opacity-60" : ""}`} aria-busy={sug.loading}>
            {sug.error && (
              <p role="alert" className="mb-4 rounded-xl bg-[#fdf0f0] px-3.5 py-2.5 text-[13px] text-[#9c2b2b]">
                Could not refresh suggestions ({sug.error}). The list below may be out of date.
              </p>
            )}
            {sug.data.network && sug.data.suggestions.length > 0 && (
              <Card className="mb-4 p-5" delay={30}>
                <p className="mb-3 text-[13px] font-medium">If every suggestion is approved</p>
                <Impact before={sug.data.network.before} after={sug.data.network.after} />
                <p className="mt-3 text-[12px] text-ink-3">
                  {sug.data.summary.count} transfers · {fmt.int(sug.data.summary.qty)} units · {fmt.inr(sug.data.summary.value)} of stock moved.
                  Write-off and shortage figures are expected values from the forecast, not guarantees.
                </p>
              </Card>
            )}
            <Suggestions data={sug.data} minValue={Number(minValue)} onChanged={bump} />
          </div>
        )}
      </section>

      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card className="overflow-hidden" delay={40}>
          <CardHeader title="Transfer requests" sub={canExecute ? "Requests from pharmacists waiting for approval." : "Your requests and their status."} />
          <div className="mt-2"><TransferRequests version={version} myUserId={me?.user.id ?? null} onChanged={bump} /></div>
        </Card>
        <Card className="overflow-hidden" delay={60}>
          <CardHeader title="Transfer history" sub={own ? "Transfers into or out of your branch." : "Every transfer between branches, newest first."} />
          <TransferHistory names={names} version={version} />
        </Card>
      </div>

      {sug.data && (
        <Card className="mt-8 p-6" delay={80}>
          <p className="eyebrow mb-3 inline-flex items-center gap-1.5"><Info className="h-3.5 w-3.5" aria-hidden />How suggestions are worked out</p>
          <ul className="grid gap-x-8 gap-y-2.5 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2">
            <li><b className="font-semibold text-ink">Target stock</b> is the order-up-to level for {sug.data.params.lead_time} week lead time + {sug.data.params.review} week review at {fmt.pct(sug.data.params.service)} service, scaled to each branch.</li>
            <li><b className="font-semibold text-ink">Expiry risk</b> follows first-expiry-first-out sell-through at each branch’s forecast pace. Units left at expiry count as write-off.</li>
            {sug.data.assumptions.map((a) => <li key={a}>{a}</li>)}
            <li>Check storage needs (cold chain, Schedule H/X registers) before moving stock. A pharmacist confirms receipt at the destination.</li>
          </ul>
        </Card>
      )}

      <NewTransfer open={dialog} onClose={closeDialog} stores={canExecute ? execStores : directory}
        mode={canExecute ? "execute" : "request"} homeStore={me?.user.store_id ?? null}
        onDone={(m) => { setFlash(m); bump(); }} />
    </>
  );
}
