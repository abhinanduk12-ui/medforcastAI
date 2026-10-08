"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Download, PackageCheck, Search, Store } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Card, ErrorState, PageHeader, Segmented, Skeleton, UpliftBadge } from "@/components/ui";
import { SimulatedNote } from "@/components/stock/bits";
import type { StoreRef } from "@/components/stock/types";

type Row = { medicine_id: string; medicine_name: string; category: string; form: string; abc: string; median_price: number;
  weekly_rate: number; cover_demand: number; safety_stock: number; order_up_to: number; stock_value: number; season_index: number; last4: number; policy: string; demand_class: string;
  on_hand?: number; suggested_order?: number; order_value?: number; lead_weeks?: number; committed_refills?: number };
type Plan = { params: { lead_time: number; review: number; service: number; z: number; cover_weeks: number; forecast_start: string; store_id?: string | null; demand_scale?: number; lead_source?: string };
  store?: StoreRef | null;
  summary: { items: number; on_demand: number; units: number; safety_units: number; value: number; by_abc: Record<string, number>;
    on_hand_units?: number; order_lines?: number; order_units?: number; order_value?: number }; rows: Row[] };

const ABC = ["All", "A", "B", "C"] as const;
const LEAD = ["Fixed", "Learned"] as const;

function Num({ label, value, set, min, max, suffix }: { label: string; value: number; set: (v: number) => void; min: number; max: number; suffix: string }) {
  return (
    <div>
      {label && <p className="mb-1.5 text-[12px] text-ink-3">{label}</p>}
      <div className="flex h-11 items-center rounded-xl border border-hairline bg-surface">
        <button aria-label={`Decrease ${label || "lead time"}`} onClick={() => set(Math.max(min, value - 1))} className="focus-ring h-full w-10 rounded-l-xl text-[18px] text-ink-2 hover:bg-sunken">−</button>
        <span className="flex-1 text-center text-[14px] font-medium tnum">{value} {suffix}</span>
        <button aria-label={`Increase ${label || "lead time"}`} onClick={() => set(Math.min(max, value + 1))} className="focus-ring h-full w-10 rounded-r-xl text-[18px] text-ink-2 hover:bg-sunken">+</button>
      </div>
    </div>
  );
}

export default function PlannerPage() {
  const [lead, setLead] = useState(1);
  const [review, setReview] = useState(2);
  const [service, setService] = useState(0.95);
  const [abc, setAbc] = useState<(typeof ABC)[number]>("All");
  const [leadSource, setLeadSource] = useState<(typeof LEAD)[number]>("Fixed");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const { data: cats } = useApi<{ category: string }[]>("/api/categories");

  const target = useMemo(() => `/api/planner?lead_time=${lead}&review=${review}&service=${service}&limit=600&lead_source=${leadSource.toLowerCase()}` +
    (abc !== "All" ? `&abc=${abc}` : "") + (category ? `&category=${encodeURIComponent(category)}` : "") + (q ? `&q=${encodeURIComponent(q)}` : ""), [lead, review, service, abc, category, q, leadSource]);
  useEffect(() => { const t = setTimeout(() => setUrl(target), 220); return () => clearTimeout(t); }, [target]);
  const { data, error } = useApi<Plan>(url || null);
  const refillRows = data?.rows.filter((r) => (r.committed_refills ?? 0) > 0).length ?? 0;

  const exportCsv = () => {
    if (!data) return;
    const head = ["store_id", "medicine_id", "medicine_name", "category", "abc", "weekly_rate", "cover_demand", "safety_stock", "order_up_to", "on_hand", "order_qty", "unit_price", "stock_value", "order_value", "policy", "demand_class"];
    const q = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = data.rows.map((r) => [data.params.store_id ?? "", r.medicine_id, q(r.medicine_name), q(r.category), r.abc, r.weekly_rate.toFixed(2), r.cover_demand.toFixed(2),
      r.safety_stock.toFixed(2), r.order_up_to, r.on_hand ?? 0, r.suggested_order ?? r.order_up_to, r.median_price.toFixed(2), r.stock_value.toFixed(2), (r.order_value ?? 0).toFixed(2), r.policy, r.demand_class].join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `stock-plan_${data.params.store_id ?? "main"}_${data.params.forecast_start}_L${lead}R${review}_SL${Math.round(service * 100)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader eyebrow="Inventory" title="Stock planner"
        actions={<button onClick={exportCsv} disabled={!data} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#262624] disabled:opacity-40"><Download className="h-4 w-4" aria-hidden /> Export CSV</button>}>
        How much of each medicine to have on the shelf so it lasts until the next delivery.
        The order-up-to level is forecast demand over lead time plus review period, plus a safety buffer sized from the
        model&apos;s calibrated forecast error for the service level you choose. Very slow movers (under 0.5 units a week, often costly oncology or specialty items) switch to an on-demand policy based on an exact Poisson quantile, so you don't tie up cash in expiring stock. Sellable stock on hand from the live ledger is subtracted to give the order quantity. Refills due from consented patients set a minimum, so the plan never falls below what regular patients are known to need.
      </PageHeader>

      <Card className="p-5" delay={30}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_1.2fr]">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-ink-3">
              <span>Supplier lead time</span>
              <Segmented options={LEAD} value={leadSource} onChange={setLeadSource} />
            </div>
            {leadSource === "Fixed"
              ? <Num label="" value={lead} set={setLead} min={0} max={8} suffix="wk" />
              : <p className="flex h-11 items-center rounded-xl border border-hairline bg-surface-2 px-3 text-[12.5px] leading-snug text-ink-2">Each medicine uses its supplier&apos;s learned lead time (7-day default until deliveries are recorded).</p>}
          </div>
          <Num label="Review period" value={review} set={setReview} min={1} max={8} suffix="wk" />
          <div>
            <p className="mb-1.5 flex justify-between text-[12px] text-ink-3"><span>Service level</span><span className="font-medium text-ink tnum">{fmt.pct(service, 0)} · z = {data?.params.z.toFixed(2) ?? "…"}</span></p>
            <div className="flex h-11 items-center rounded-xl border border-hairline bg-surface px-4">
              <input type="range" min={0.8} max={0.99} step={0.01} value={service} onChange={(e) => setService(Number(e.target.value))} className="w-full" aria-label="Service level" />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] text-ink-3">ABC class</p>
            <Segmented options={ABC} value={abc} onChange={setAbc} />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3 md:flex-row">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by medicine name…" aria-label="Filter by medicine name" className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-4 text-[14px] placeholder:text-muted" />
          </label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="focus-ring h-11 rounded-xl border border-hairline bg-surface px-3 text-[14px] md:w-72">
            <option value="">All categories</option>
            {cats?.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
          </select>
        </div>
        {refillRows > 0 && (
          <p className="mt-3 text-[12px] text-ink-3">{refillRows} medicine{refillRows === 1 ? "" : "s"} raised to cover refills due from consented patients.</p>
        )}
      </Card>

      {data?.store && (
        <div className="rise mt-6 flex flex-col gap-3 rounded-[20px] border border-hairline bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-center gap-2.5 text-[13px] text-ink-2">
            <Store className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <span>Planning for <b className="font-semibold text-ink">{data.store.name}</b>{data.store.simulated ? ` (simulated: demand × ${data.store.demand_scale.toFixed(2)})` : ""}.
              {" "}On hand is sellable stock from the live ledger ({fmt.int(data.summary.on_hand_units)} units; expired stock excluded).</span>
          </p>
          <p className="flex shrink-0 items-center gap-2 text-[13px]">
            <PackageCheck className="h-4 w-4 text-brand" aria-hidden />
            <span><b className="font-semibold tnum">{fmt.int(data.summary.order_units)}</b> units to order across <b className="font-semibold tnum">{fmt.int(data.summary.order_lines)}</b> lines
              <span className="text-ink-3"> · ≈ {fmt.inr(data.summary.order_value)} at median price</span></span>
          </p>
        </div>
      )}
      {data?.store?.simulated && <SimulatedNote store={data.store} className="rise mt-3" />}

      <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {data ? (
          <>
            <div className="card rise p-5"><p className="text-[13px] text-ink-3">Medicines to stock</p><p className="mt-3 text-[28px] font-semibold tracking-tight">{fmt.int(data.summary.items)}</p><p className="mt-2 text-[12px] text-ink-3">{data.summary.on_demand} slow movers on demand · {data.params.cover_weeks}-week cover</p></div>
            <div className="card rise p-5"><p className="text-[13px] text-ink-3">Target units on shelf</p><p className="mt-3 text-[28px] font-semibold tracking-tight">{fmt.compact(data.summary.units)}</p><p className="mt-2 text-[12px] text-ink-3">sum of order-up-to levels · {fmt.compact(data.summary.safety_units)} safety stock</p></div>
            <div className="card rise p-5"><p className="text-[13px] text-ink-3">Target inventory value</p><p className="mt-3 text-[28px] font-semibold tracking-tight">{fmt.inr(data.summary.value)}</p><p className="mt-2 text-[12px] text-ink-3">at median selling price</p></div>
            <div className="card rise p-5"><p className="text-[13px] text-ink-3">Value by ABC class</p>
              <div className="mt-3 flex h-2.5 gap-[2px] overflow-hidden rounded-full">
                {["A", "B", "C"].map((k, i) => <span key={k} style={{ flex: data.summary.by_abc[k] ?? 0, background: ["#0b0b0b", "#6b6a65", "#c3c2b7"][i] }} />)}
              </div>
              <div className="mt-2.5 flex justify-between text-[12px] text-ink-2">{["A", "B", "C"].map((k) => <span key={k} className="tnum"><b className="font-semibold">{k}</b> {fmt.inr(data.summary.by_abc[k] ?? 0)}</span>)}</div>
            </div>
          </>
        ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
      </div>

      <Card className="mt-6 overflow-hidden" delay={60}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-6 py-3 font-medium">Medicine</th>
                <th className="px-3 py-3 font-medium">Pattern · policy</th>
                <th className="px-3 py-3 text-right font-medium">Last 4 wk sold</th>
                <th className="px-3 py-3 text-right font-medium">Forecast /wk</th>
                <th className="px-3 py-3 text-right font-medium">Cover demand</th>
                <th className="px-3 py-3 text-right font-medium">Safety stock</th>
                <th className="px-3 py-3 text-right font-medium">Order-up-to</th>
                <th className="px-3 py-3 text-right font-medium" title="Sellable units on hand at this store (live ledger)">On hand</th>
                <th className="px-3 py-3 text-right font-medium" title="Order-up-to minus on hand, never below 0">Order qty</th>
                <th className="px-3 py-3 text-right font-medium">Value</th>
                <th className="px-6 py-3 text-right font-medium">Season effect now</th>
              </tr>
            </thead>
            <tbody>
              {!data && [...Array(8)].map((_, i) => <tr key={i}><td colSpan={11} className="px-6 py-2"><Skeleton className="h-9" /></td></tr>)}
              {data && data.rows.length === 0 && (
                <tr><td colSpan={11} className="px-6 py-14 text-center">
                  <p className="text-[14px] font-semibold">No medicines match these filters</p>
                  <p className="mt-1 text-[13px] text-ink-3">Clear the search or pick another category or ABC class.</p>
                </td></tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.medicine_id} className="border-t border-hairline transition-colors hover:bg-surface-2">
                  <td className="px-6 py-2.5">
                    <Link href={`/medicines/${r.medicine_id}`} className="focus-ring flex items-center gap-2.5 rounded">
                      <AbcBadge abc={r.abc} />
                      <span className="min-w-0"><span className="block max-w-[240px] truncate font-medium hover:underline">{r.medicine_name}</span><span className="block truncate text-[12px] text-ink-3">{r.category}</span></span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block text-[12px] text-ink-2">{r.demand_class}</span>
                    <span className={`mt-0.5 inline-block rounded-md px-1.5 py-px text-[11px] font-medium ${r.policy === "On demand" ? "bg-sunken text-ink-3" : "bg-brand-wash text-brand-ink"}`}>{r.policy}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-3">{fmt.int(r.last4)}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">{fmt.one(r.weekly_rate)}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">{fmt.one(r.cover_demand)}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">+{fmt.one(r.safety_stock)}</td>
                  <td className="px-3 py-2.5 text-right font-medium tnum">{fmt.int(r.order_up_to)}</td>
                  <td className="px-3 py-2.5 text-right tnum text-ink-2">{r.on_hand == null ? "—" : fmt.int(r.on_hand)}</td>
                  <td className="px-3 py-2.5 text-right">{(r.suggested_order ?? 0) > 0
                    ? <span className="inline-block min-w-[44px] rounded-lg bg-brand-wash px-2 py-1 text-center font-semibold tnum text-brand-ink">{fmt.int(r.suggested_order)}</span>
                    : <span className="text-ink-3 tnum">0</span>}</td>
                  <td className="px-3 py-2.5 text-right tnum">{fmt.inrFull(r.stock_value)}</td>
                  <td className="px-6 py-2.5 text-right"><UpliftBadge value={r.season_index - 1} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
