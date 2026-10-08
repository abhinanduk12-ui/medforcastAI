"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Download, Loader2, SearchX, TrendingDown } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Card, CardHeader, ErrorState, PageHeader, Segmented, Skeleton, StatTile } from "@/components/ui";
import { BudgetInput, StockUpload, Stepper, type StockFile } from "@/components/purchase/Controls";
import { FrontierChart, type FrontierMetric } from "@/components/purchase/FrontierChart";
import { PurchaseOrders } from "@/components/purchase/PurchaseOrders";
import { LiveStockToggle, useLiveStock } from "@/components/purchase/LiveStock";
import { downloadCsv, usePlan, type Objective, type PlanRequest, type PlanResponse } from "@/components/purchase/types";

const EMPTY: Record<string, number> = {};
const OBJECTIVES = ["profit", "fill_rate"] as const;
const OBJ_LABEL: Record<Objective, string> = { profit: "Max profit", fill_rate: "Max fill rate" };
const ABC = ["All", "A", "B", "C"] as const;
const METRICS = ["Fill rate", "Profit"] as const;

/** Plain-language reading of the frontier: how much each extra rupee is still worth. */
function DiminishingReturns({ d }: { d: PlanResponse }) {
  const { totals: t, frontier: f, params } = d;
  const seg = (a: number, b: number) => (f[b] && f[a] ? (f[b].fill_rate - f[a].fill_rate) * 100 : 0);
  const step = f[1]?.budget ?? 0;
  // Last frontier segment that still raises fill rate (the curve is flat once everything up to the cap is bought).
  let lastRise = 0;
  for (let i = 1; i < f.length; i++) if (f[i].fill_rate > f[i - 1].fill_rate + 1e-4) lastRise = i;
  const perK = t.marginal_value_per_1000;
  const saturated = t.budget >= t.unconstrained_spend - 1;
  // Values per ₹1,000 can be small in fill-rate mode (units served); keep two significant figures there.
  const perKText = perK == null ? "" : params.objective === "profit" ? `${fmt.inrFull(perK)} expected profit`
    : `${perK >= 10 ? fmt.one(perK) : perK.toPrecision(2)} expected units served`;
  if (t.unconstrained_spend <= 0)
    return (
      <p className="rounded-xl bg-brand-wash px-3.5 py-2.5 text-[13px] leading-relaxed text-brand-ink">
        Stock on hand already reaches the {fmt.pct(params.service_cap, 1)} service cap for every medicine in scope, so there is nothing worth buying
        {params.objective === "profit" ? " at this margin and holding cost" : ""}. Any budget stays unspent.
      </p>
    );
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-ink-2">
      <p className="flex gap-2">
        <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
        <span>
          Every unit is ranked by how likely it is to sell before the next delivery, per rupee. The first rupees buy near-certain sales of fast movers;
          later rupees buy units that only sell in a busy {params.cover_weeks}-week window. The first {fmt.inr(step)} lifts fill rate by
          {" "}<b className="font-semibold text-ink tnum">{seg(0, 1).toFixed(1)} pts</b>
          {lastRise > 1 && <>, the last {fmt.inr(step)} before the cap adds only <b className="font-semibold text-ink tnum">{seg(lastRise - 1, lastRise).toFixed(1)} pts</b></>}.
        </span>
      </p>
      {saturated ? (
        <p className="rounded-xl bg-brand-wash px-3.5 py-2.5 text-brand-ink">
          Your budget covers everything worth buying. {fmt.inrFull(t.budget - t.spend)} stays unspent because further units would exceed the
          {" "}{fmt.pct(params.service_cap, 1)} service cap{params.objective === "profit" ? " or lose money in expectation" : ""}.
        </p>
      ) : perK != null && (
        <p className="rounded-xl bg-sunken px-3.5 py-2.5">
          At your budget, the next ₹1,000 is worth at most <b className="font-semibold text-ink tnum">{perKText}</b>.
          {" "}Buying everything up to the cap would cost {fmt.inr(t.unconstrained_spend)}.
        </p>
      )}
    </div>
  );
}

function LinesTable({ d }: { d: PlanResponse }) {
  const [all, setAll] = useState(false);
  const rows = all ? d.lines : d.lines.slice(0, 12);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th className="px-6 py-3 font-medium">Medicine</th>
              <th className="px-3 py-3 text-right font-medium" title="Expected demand over the cover window ± 1 standard deviation">Window demand</th>
              <th className="px-3 py-3 text-right font-medium">On hand</th>
              <th className="px-3 py-3 font-medium">Buy · of cap</th>
              <th className="px-3 py-3 text-right font-medium">Est. cost</th>
              <th className="px-3 py-3 text-right font-medium">Item fill rate</th>
              <th className="px-6 py-3 font-medium" title="Inferred from sales history: the supplier on most of this medicine's sales lines">Supplier (inferred)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.medicine_id} className="border-t border-hairline transition-colors hover:bg-surface-2">
                <td className="px-6 py-2.5">
                  <Link href={`/medicines/${r.medicine_id}`} className="focus-ring flex items-center gap-2.5 rounded">
                    <AbcBadge abc={r.abc} />
                    <span className="min-w-0"><span className="block max-w-[260px] truncate font-medium hover:underline">{r.medicine_name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{r.category}</span></span>
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-right tnum text-ink-2">
                  <span className="whitespace-nowrap">{fmt.one(r.demand_mu)} <span className="text-ink-3">± {fmt.one(r.demand_sd)}</span></span>
                  <span className="block text-[11px] text-ink-3">{r.model}</span>
                </td>
                <td className="px-3 py-2.5 text-right tnum text-ink-3">{fmt.int(r.on_hand)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-block min-w-[44px] rounded-lg bg-brand-wash px-2 py-1 text-center font-semibold tnum text-brand-ink">{fmt.int(r.qty)}</span>
                    <span className="h-1.5 w-20 rounded-full bg-sunken" title={`${r.qty} of ${r.cap_qty} units up to the service cap`}>
                      <span className="block h-1.5 rounded-full bg-brand" style={{ width: `${r.cap_qty ? Math.min(100, (r.qty / r.cap_qty) * 100) : 0}%` }} />
                    </span>
                    <span className="text-[12px] text-ink-3 tnum">{fmt.int(r.cap_qty)}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tnum">{fmt.inrFull(r.cost)}</td>
                <td className="px-3 py-2.5 text-right tnum">{fmt.pct(r.fill_rate)}</td>
                <td className="px-6 py-2.5 text-ink-2">
                  {r.supplier_id}
                  {r.supplier_share != null && <span className="block whitespace-nowrap text-[11px] text-ink-3 tnum">{fmt.pct(r.supplier_share)} share · {r.n_suppliers} suppliers seen</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.lines.length > 12 && (
        <div className="border-t border-hairline px-6 py-3 text-center">
          <button onClick={() => setAll(!all)} className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-brand hover:bg-brand-wash">
            {all ? "Show top 12" : `Show all ${d.lines.length} lines`}
          </button>
        </div>
      )}
    </>
  );
}

export default function PurchasePage() {
  const [budget, setBudget] = useState(200_000);
  const [objective, setObjective] = useState<Objective>("profit");
  const [lead, setLead] = useState(1);
  const [review, setReview] = useState(2);
  const [cap, setCap] = useState(0.95);
  const [margin, setMargin] = useState(20);
  const [holding, setHolding] = useState(2);
  const [abc, setAbc] = useState<(typeof ABC)[number]>("All");
  const [category, setCategory] = useState("");
  const [stock, setStock] = useState<StockFile | null>(null);
  const [useLive, setUseLive] = useState(false);
  const live = useLiveStock(useLive);
  const onHand = useMemo(() => (useLive ? live.stock : stock?.stock ?? EMPTY), [useLive, live.stock, stock]);
  const [metric, setMetric] = useState<FrontierMetric>("Fill rate");
  const { data: cats } = useApi<{ category: string }[]>("/api/categories");

  const target = useMemo<PlanRequest>(() => ({
    budget, objective, lead_time: lead, review, service_cap: cap, margin_pct: margin, holding_pct: holding,
    on_hand: onHand ?? EMPTY, ...(abc !== "All" ? { abc } : {}), ...(category ? { categories: [category] } : {}),
  }), [budget, objective, lead, review, cap, margin, holding, abc, category, onHand]);
  const [req, setReq] = useState<PlanRequest | null>(null);
  // While live stock is loading, wait instead of solving against an empty shelf.
  useEffect(() => { if (useLive && !live.stock) return; const t = setTimeout(() => setReq(target), 280); return () => clearTimeout(t); }, [target, useLive, live.stock]);
  const { data, error, empty, loading } = usePlan(req);

  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const sliderMax = Math.max(data ? Math.ceil((data.totals.unconstrained_spend * 1.5) / 50_000) * 50_000 : 2_500_000, 100_000);

  const exportAll = () => {
    if (!data) return;
    downloadCsv(`purchase-plan_${today}_${data.params.objective}.csv`, [
      ["medicine_id", "medicine_name", "category", "abc", "supplier_id", "on_hand", "qty", "cap_qty", "est_unit_cost", "est_cost", "window_demand", "demand_sd", "demand_model", "item_fill_rate", "expected_profit"],
      ...data.lines.map((r) => [r.medicine_id, r.medicine_name, r.category, r.abc, r.supplier_id, r.on_hand, r.qty, r.cap_qty, r.unit_cost.toFixed(2), r.cost.toFixed(2),
        r.demand_mu.toFixed(2), r.demand_sd.toFixed(2), r.model, r.fill_rate.toFixed(4), r.expected_profit.toFixed(2)]),
    ]);
  };

  if (error && !data) return <ErrorState error={error} />;
  const t = data?.totals;
  const current = data && t ? { budget: t.budget, fill_rate: t.fill_rate, profit: t.expected_profit, spend: t.spend } : null;

  return (
    <>
      <PageHeader eyebrow="Inventory · Optimizer" title="Purchase optimizer"
        actions={<button onClick={exportAll} disabled={!data?.lines.length || !!empty} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#262624] disabled:opacity-40"><Download className="h-4 w-4" /> Export plan</button>}>
        Tell it how much cash you can spend and it decides how many units of each medicine to buy. Every unit is
        valued by its forecast chance of selling before the next delivery, so each rupee goes where it does the most good. The
        order is then split into a purchase order for each supplier.
      </PageHeader>

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        {/* ───── Controls ───── */}
        <div className="min-w-0">
          <Card className="space-y-5 p-5 xl:sticky xl:top-6" delay={30}>
            <BudgetInput value={budget} onChange={setBudget} max={sliderMax} />
            <div>
              <p className="mb-1.5 text-[12px] text-ink-3">Optimise for</p>
              <Segmented options={OBJECTIVES} value={objective} onChange={setObjective} render={(o) => OBJ_LABEL[o]} />
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                {objective === "profit"
                  ? "Expected gross margin minus the cost of carrying unsold units."
                  : "Most expected units handed to customers. Favours cheap, fast-moving items."}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stepper label="Lead time" value={lead} set={setLead} min={0} max={8} suffix=" wk" />
              <Stepper label="Review period" value={review} set={setReview} min={1} max={8} suffix=" wk" />
              <Stepper label="Gross margin" value={margin} set={setMargin} min={5} max={60} suffix="%" />
              <Stepper label="Holding cost / cycle" value={holding} set={setHolding} min={0} max={20} step={0.5} digits={1} suffix="%" />
            </div>
            <div>
              <p className="mb-1.5 flex justify-between text-[12px] text-ink-3"><span>Service cap (never stock above)</span><span className="font-medium text-ink tnum">{fmt.pct(cap, 1)}</span></p>
              <div className="flex h-11 items-center rounded-xl border border-hairline bg-surface px-4">
                <input type="range" min={0.5} max={0.995} step={0.005} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="w-full" aria-label="Service cap" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] xl:grid-cols-1">
              <div>
                <p className="mb-1.5 text-[12px] text-ink-3">ABC class</p>
                <Segmented options={ABC} value={abc} onChange={setAbc} />
              </div>
              <div>
                <p className="mb-1.5 text-[12px] text-ink-3">Category</p>
                <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface px-3 text-[14px]">
                  <option value="">All categories</option>
                  {cats?.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
                </select>
              </div>
            </div>
            <LiveStockToggle on={useLive} onChange={setUseLive} live={live} />
            <div className={useLive ? "opacity-60" : ""}>
              {useLive && <p className="mb-1.5 text-[12px] text-ink-3">Or upload a CSV instead (turns live stock off):</p>}
              <StockUpload value={useLive ? null : stock} onChange={(p) => { setStock(p); if (p) setUseLive(false); }} unknown={useLive ? 0 : data?.params.unknown_on_hand_count ?? 0} />
            </div>
          </Card>
        </div>

        {/* ───── Results ───── */}
        <div className="min-w-0 space-y-6">
          {error && data && (
            <div role="alert" className="card flex items-start gap-2 border-[rgba(208,59,59,0.35)] px-5 py-3 text-[13px]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-critical" />
              <span><b className="font-semibold text-critical">Could not re-optimise.</b> <span className="text-ink-2">{error}. Showing the last successful plan.</span></span>
            </div>
          )}
          {empty ? (
            <Card className="px-6 py-14 text-center" delay={0}>
              <SearchX className="mx-auto h-6 w-6 text-ink-3" strokeWidth={1.8} />
              <p className="mt-3 text-[15px] font-semibold">No medicines match these filters</p>
              <p className="mt-1.5 text-[13px] text-ink-3">
                No {abc !== "All" ? `class ${abc} ` : ""}medicines{category ? ` in ${category}` : ""}. Pick another ABC class or category.
              </p>
            </Card>
          ) : (<>
          <div className={`relative grid grid-cols-2 gap-4 transition-opacity 2xl:grid-cols-4 ${loading && data ? "opacity-70" : ""}`}>
            {t && data ? (
              <>
                <StatTile label="Spend vs budget" value={fmt.inr(t.spend)} hint={t.utilisation != null ? `${fmt.pct(t.utilisation)} of ${fmt.inr(t.budget)} budget` : "no budget set"} />
                <StatTile label="Expected fill rate" value={fmt.pct(t.fill_rate, 1)}
                  hint={data.params.on_hand_items ? `up from ${fmt.pct(t.fill_rate_on_hand_only, 1)} with stock on hand only` : "of window demand · assumes an empty shelf"} />
                <StatTile label="Expected gross profit" value={fmt.inr(t.expected_profit)} hint="net of holding cost, if sold at median price" />
                <StatTile label="Order lines" value={fmt.int(t.lines)} hint={`${fmt.int(t.units)} units · ${data.purchase_orders.length} ${data.purchase_orders.length === 1 ? "supplier" : "suppliers"}`} />
              </>
            ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
            {loading && data && (
              <span role="status" className="absolute -top-6 right-0 inline-flex items-center gap-1.5 text-[12px] text-ink-3"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Re-optimising…</span>
            )}
          </div>

          <Card delay={60}>
            <CardHeader title="Efficient frontier"
              sub={data ? `Best achievable ${metric === "Fill rate" ? "fill rate" : "expected profit"} at each budget · ${data.params.cover_weeks}-week cover from ${fmt.weekYear(data.params.forecast_start)} · ${fmt.int(t?.items_considered)} medicines` : "Loading…"}
              right={<Segmented options={METRICS} value={metric} onChange={setMetric} />} />
            <div className="px-3 pt-4 sm:px-4">
              {data && current ? <FrontierChart points={data.frontier} current={current} metric={metric} /> : <Skeleton className="mx-2 h-[300px]" />}
            </div>
            <div className="px-6 pb-6 pt-2">{data ? <DiminishingReturns d={data} /> : <Skeleton className="h-16" />}</div>
          </Card>

          <Card delay={90}>
            <CardHeader title="Supplier purchase orders" sub={data?.notes.supplier} />
            <div className="pt-4">
              {data ? <PurchaseOrders orders={data.purchase_orders} date={today} assumptions={`${data.notes.costs} Quantities from MedForecast purchase optimizer (${OBJ_LABEL[data.params.objective]}, ${data.params.cover_weeks}-week cover, ${fmt.pct(data.params.service_cap, 1)} service cap).`} />
                : <div className="space-y-3 px-6 pb-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>}
            </div>
          </Card>

          <Card className="overflow-hidden" delay={120}>
            <CardHeader title="Order lines" sub="Ranked by spend. The bar shows how much of each medicine's service-cap quantity the budget could fund." />
            <div className="pt-4">
              {data ? (data.lines.length ? <LinesTable d={data} /> : <p className="px-6 pb-6 text-[13px] text-ink-3">No lines at this budget.</p>)
                : <div className="space-y-2 px-6 pb-6">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9" />)}</div>}
            </div>
          </Card>

          {data && (
            <Card className="p-6" delay={150}>
              <p className="eyebrow mb-3">Assumptions</p>
              <ul className="space-y-2 text-[13px] leading-relaxed text-ink-2">
                <li>{data.notes.costs} Your real purchase prices may differ, so check the cost column against the supplier&apos;s invoice.</li>
                <li>Demand over the cover window comes from the ensemble forecast and its calibrated error: normal for most medicines, Poisson for slow movers (under 5 units in the window).</li>
                <li>{data.notes.method} Holding cost ({fmt.one(data.params.holding_pct)}% of unit cost per cycle) stands in for carrying and expiry risk on units that don&apos;t sell.</li>
                <li>The cover window starts at the forecast origin ({fmt.weekYear(data.params.forecast_start)}), the same convention as the stock planner.</li>
              </ul>
            </Card>
          )}
          </>)}
        </div>
      </div>
    </>
  );
}
