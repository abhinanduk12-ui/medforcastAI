"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, Info, PackageCheck } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C, Columns, ForecastChart, monthTick, SeasonIndexBars, type SeriesPoint } from "@/components/charts";
import { AbcBadge, Card, CardHeader, ErrorState, Legend, PageSkeleton, SeasonChip, SeasonIcon, StatTile } from "@/components/ui";
import { ExplainCard } from "@/components/explain/ExplainCard";
import { MedicineSeasonCard } from "@/components/seasonal/MedicineSeasonCard";
import { StockCard } from "@/components/stock/StockCard";
import { SubstitutesCard } from "@/components/substitutes/SubstitutesCard";
import { ScheduleBadge } from "@/components/compliance/shared";

type Detail = {
  id: string; name: string; generic: string; category: string; form: string; price: number; rx_share: number; abc: string; schedule?: string; demand_class: string; adi: number | null; cv2: number | null;
  total_units: number; total_revenue: number; total_tx: number; avg_weekly: number; base_level: number;
  next4: number; next12: number; last4: number; last12: number;
  series: (SeriesPoint & { gbm?: number; deep?: number; snaive?: number })[];
  seasons: { season: string; index: number; raw: number | null; category: number | null; expected_weekly: number; transactions: number }[];
  monthly: (number | null)[];
  backtest: { actual: number; forecast: number; covered: number } | null;
  plan: { lead_time: number; review: number; service: number; cover_demand: number; safety_stock: number; order_up_to: number; stock_value: number; policy: string };
  current_season: string;
};

function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between text-[13px]"><span className="text-ink-2">{label}</span><span className="font-medium tnum">{display}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}

export default function MedicinePage() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState(1);
  const [review, setReview] = useState(2);
  const [service, setService] = useState(0.95);
  const [params, setParams] = useState("lead_time=1&review=2&service=0.95");
  useEffect(() => { const t = setTimeout(() => setParams(`lead_time=${lead}&review=${review}&service=${service}`), 200); return () => clearTimeout(t); }, [lead, review, service]);
  const { data, error } = useApi<Detail>(`/api/medicines/${id}?${params}`);
  const [first, setFirst] = useState<Detail | null>(null);
  useEffect(() => { if (data) setFirst(data); }, [data]);
  const d = data ?? first;

  if (error) return <ErrorState error={error} />;
  if (!d) return <PageSkeleton />;

  const fc = d.series.filter((s) => s.actual == null);
  const models = [
    { key: "gbm", label: "Gradient boosting", color: C.s1 },
    { key: "deep", label: "Deep SeasonalGRU", color: C.s7 },
    { key: "snaive", label: "Seasonal baseline", color: C.s3 },
  ] as const;
  const total = (k: string) => fc.reduce((a, s) => a + ((s as any)[k] ?? 0), 0);
  const peak = [...d.seasons].sort((a, b) => b.index - a.index)[0];
  const cur = d.seasons.find((s) => s.season === d.current_season);

  return (
    <>
      <Link href="/medicines" className="focus-ring mb-5 inline-flex items-center gap-1.5 rounded text-[13px] text-ink-3 hover:text-ink"><ArrowLeft className="h-4 w-4" /> All medicines</Link>
      <div className="rise mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-md bg-sunken px-2 py-0.5 font-mono text-ink-2">{d.id}</span>
            <span className="rounded-md border border-hairline px-2 py-0.5 text-ink-2">{d.category}</span>
            <span className="rounded-md border border-hairline px-2 py-0.5 text-ink-2">{d.form}</span>
            <span className="rounded-md border border-hairline px-2 py-0.5 text-ink-2">{fmt.pct(d.rx_share)} prescription</span>
            {d.schedule && <ScheduleBadge s={d.schedule as never} />}
            <span className="rounded-md border border-hairline px-2 py-0.5 text-ink-2" title={`ADI ${d.adi?.toFixed(2) ?? "–"} · CV² ${d.cv2?.toFixed(2) ?? "–"} (Syntetos–Boylan)`}>{d.demand_class} demand</span>
            <span className="inline-flex items-center gap-1 text-ink-3"><AbcBadge abc={d.abc} /> class</span>
          </div>
          <h1 className="mt-3 text-[32px] font-semibold leading-tight tracking-[-0.02em]">{d.name}</h1>
          <p className="mt-1 text-[14px] text-ink-3">{d.generic} · {fmt.inrFull(d.price)} median unit price</p>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">Peaks in <SeasonChip season={peak.season} /></div>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="Forecast · next 4 weeks" value={`${fmt.one(d.next4)} units`} delta={d.last4 ? d.next4 / d.last4 - 1 : null} deltaLabel="vs last 4 weeks" />
        <StatTile label="Forecast · next 12 weeks" value={`${fmt.one(d.next12)} units`} delta={d.last12 ? d.next12 / d.last12 - 1 : null} deltaLabel="vs last 12 weeks" />
        <StatTile label="Typical weekly demand" value={fmt.one(d.base_level)} hint="season-adjusted run-rate" />
        <StatTile label="Revenue to date" value={fmt.inr(d.total_revenue)} hint={`${fmt.int(d.total_units)} units · ${fmt.int(d.total_tx)} bills`} />
      </div>

      <Card className="mt-6" delay={60}>
        <CardHeader title="Weekly demand & forecast" sub="Actual weekly units, the holdout backtest, and the 12-week ensemble forecast with its 90% range"
          right={<Legend items={[{ label: "Actual", color: C.s1 }, { label: "Backtest", color: C.s3 }, { label: "Forecast", color: C.s2, kind: "dash" }, { label: "90% range", color: C.s2, kind: "band" }]} />} />
        <div className="px-4 pb-4 pt-4"><ForecastChart data={d.series} height={320} /></div>
        {d.backtest && (
          <div className="flex flex-wrap gap-x-8 gap-y-2 border-t border-hairline px-6 py-4 text-[13px] text-ink-2">
            <span>Holdout (Jun–Aug 2026): actual <b className="font-semibold text-ink tnum">{fmt.int(d.backtest.actual)}</b> vs forecast <b className="font-semibold text-ink tnum">{fmt.int(d.backtest.forecast)}</b> units</span>
            <span>Weeks inside the 90% range: <b className="font-semibold text-ink">{fmt.pct(d.backtest.covered)}</b></span>
          </div>
        )}
      </Card>

      <MedicineSeasonCard id={id} />

      <ExplainCard id={id} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <StockCard id={id} delay={80} />
        <SubstitutesCard id={id} delay={100} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card delay={90}>
          <CardHeader title="Seasonal impact" sub={<>Demand in each season vs a typical week{cur && <> · now <b className="font-medium text-ink">{d.current_season}</b> ({fmt.signedPct(cur.index - 1)})</>}</>} />
          <div className="px-6 pb-4 pt-5">
            <SeasonIndexBars items={d.seasons.map((s) => ({ season: s.season, index: s.index, icon: <SeasonIcon season={s.season} className="h-4 w-4 text-ink-3" /> }))} />
          </div>
          <div className="mx-6 mb-6 overflow-hidden rounded-xl border border-hairline">
            <table className="w-full text-[12px]">
              <thead><tr className="bg-surface-2 text-left text-ink-3"><th className="px-3 py-2 font-medium">Season</th><th className="px-3 py-2 text-right font-medium">Expected /wk</th><th className="px-3 py-2 text-right font-medium">Item signal</th><th className="px-3 py-2 text-right font-medium">Category</th><th className="px-3 py-2 text-right font-medium">Bills</th></tr></thead>
              <tbody>
                {d.seasons.map((s) => (
                  <tr key={s.season} className="border-t border-hairline">
                    <td className="px-3 py-2">{s.season}</td>
                    <td className="px-3 py-2 text-right font-medium tnum">{fmt.one(s.expected_weekly)}</td>
                    <td className="px-3 py-2 text-right tnum text-ink-2">{s.raw != null ? fmt.signedPct(s.raw - 1) : "—"}</td>
                    <td className="px-3 py-2 text-right tnum text-ink-2">{s.category != null ? fmt.signedPct(s.category - 1) : "—"}</td>
                    <td className="px-3 py-2 text-right tnum text-ink-3">{fmt.int(s.transactions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="flex gap-1.5 border-t border-hairline bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-ink-3"><Info className="mt-0.5 h-3 w-3 shrink-0" />The bars blend this medicine’s own signal with its category, weighted by how many bills back it up.</p>
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card delay={110}>
            <CardHeader title="Restock recommendation" sub="Order-up-to level from the forecast and its uncertainty" right={<PackageCheck className="h-5 w-5 text-brand" />} />
            <div className="grid gap-6 px-6 pb-6 pt-5 sm:grid-cols-2">
              <div className="space-y-4">
                <Slider label="Supplier lead time" value={lead} min={0} max={6} step={1} onChange={setLead} display={`${lead} wk`} />
                <Slider label="Review period" value={review} min={1} max={6} step={1} onChange={setReview} display={`${review} wk`} />
                <Slider label="Service level" value={service} min={0.8} max={0.99} step={0.01} onChange={setService} display={fmt.pct(service)} />
              </div>
              <div className="rounded-2xl bg-ink p-5 text-white">
                <p className="text-[12px] text-white/60">Keep on shelf</p>
                <p className="mt-1 text-[44px] font-semibold leading-none tracking-tight">{fmt.int(d.plan.order_up_to)}</p>
                <p className="mt-1 text-[12px] text-white/60">units · ≈ {fmt.inrFull(d.plan.stock_value)}</p>
                <div className="mt-5 space-y-1.5 text-[12px]">
                  <div className="flex justify-between"><span className="text-white/60">Expected demand ({lead + review} wk)</span><span className="tnum">{fmt.one(d.plan.cover_demand)}</span></div>
                  <div className="flex justify-between"><span className="text-white/60">Safety stock</span><span className="tnum">{fmt.one(d.plan.safety_stock)}</span></div>
                  <div className="flex justify-between"><span className="text-white/60">Policy</span><span>{d.plan.policy}</span></div>
                </div>
              </div>
            </div>
          </Card>

          <Card delay={130}>
            <CardHeader title="Model comparison" sub="Total units forecast for the next 12 weeks" />
            <div className="space-y-3 px-6 pb-6 pt-4">
              {[...models, { key: "forecast", label: "Ensemble (used)", color: C.s2 }].map((m) => {
                const v = total(m.key);
                const max = Math.max(...[...models.map((x) => total(x.key)), total("forecast")], 1e-9);
                return (
                  <div key={m.key} className="grid grid-cols-[150px_1fr_56px] items-center gap-3 text-[13px]">
                    <span className={`inline-flex items-center gap-2 ${m.key === "forecast" ? "font-semibold" : "text-ink-2"}`}><span className="h-2 w-2 rounded-full" style={{ background: m.color }} />{m.label}</span>
                    <div className="h-2 rounded-full bg-sunken"><div className="h-2 rounded-full" style={{ width: `${(v / max) * 100}%`, background: m.color }} /></div>
                    <span className="text-right font-medium tnum">{fmt.one(v)}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-6" delay={150}>
        <CardHeader title="Month-of-year pattern" sub="Average weekly units in each calendar month (August is averaged over 2025 and 2026)" />
        <div className="px-4 pb-4 pt-3">
          <Columns data={d.monthly.map((v, i) => ({ x: i + 1, y: v ?? 0 }))} xFormatter={monthTick} valueLabel="Avg units / week" height={220}
            highlight={(m: number) => [6, 7, 8, 9].includes(m)} />
          <div className="mt-2 px-2"><Legend items={[{ label: "Monsoon months", color: C.s1, kind: "dot" }, { label: "Other months", color: "#c9d9ee", kind: "dot" }]} /></div>
        </div>
      </Card>
    </>
  );
}
