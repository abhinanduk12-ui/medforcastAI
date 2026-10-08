"use client";

import Link from "next/link";
import { ArrowRight, ShieldCheck, Sparkles } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { BarList, C, Columns, ForecastChart, type SeriesPoint } from "@/components/charts";
import { Card, CardHeader, ErrorState, Legend, PageHeader, PageSkeleton, SeasonChip, SeasonIcon, StatTile, UpliftBadge } from "@/components/ui";

type Mover = { medicine_id: string; medicine_name: string; category: string; uplift: number; expected_weekly: number; extra_weekly: number };
type Overview = {
  data: { start: string; end: string; transactions: number; medicines: number; forecast_start: string; forecast_end: string };
  kpi: { revenue: number; units: number; transactions: number; avg_basket: number; next4_units: number; next12_units: number; last12_units: number;
         ly_same_period_units: number | null; holdout_category_accuracy: number; holdout_store_accuracy: number; coverage_90: number };
  spark: { units: number[]; revenue: number[]; tx: number[] };
  series: SeriesPoint[];
  monthly: { month: string; units: number; revenue: number; tx: number }[];
  mix: { category: string; units: number }[];
  dow: number[]; hour: number[];
  season: { current: string; next: string; strongest: string; strongest_movers: { rising: Mover[] }; meta: Record<string, { months: string; drivers: string }>;
            current_movers: { rising: Mover[] }; next_movers: { rising: Mover[] } };
};

function SeasonCard({ label, season, meta, movers, delay }: { label: string; season: string; meta: { months: string; drivers: string }; movers: Mover[]; delay: number }) {
  return (
    <Card className="flex flex-col p-6" delay={delay}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow">{label}</p>
          <h3 className="mt-2 flex items-center gap-2 text-[20px] font-semibold tracking-tight">
            <SeasonIcon season={season} className="h-5 w-5 text-brand" />{season}
            <span className="text-[13px] font-normal text-ink-3">{meta.months}</span>
          </h3>
          <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">{meta.drivers}</p>
        </div>
      </div>
      <div className="mt-5 divide-y divide-[rgba(11,11,11,0.06)] rounded-2xl border border-hairline">
        {movers.length === 0 && (
          <div className="p-5 text-[13px] leading-relaxed text-ink-2">
            <p className="font-medium text-ink">Demand stays close to normal</p>
            <p className="mt-1 text-ink-3">No medicine rises 8% or more in {season}. Order from the regular forecast; the strongest seasonal swing in this shop is the Monsoon.</p>
          </div>
        )}
        {movers.map((m) => (
          <Link key={m.medicine_id} href={`/medicines/${m.medicine_id}`} className="focus-ring flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{m.medicine_name}</p>
              <p className="truncate text-[12px] text-ink-3">{m.category}</p>
            </div>
            <div className="text-right">
              <p className="text-[13px] font-medium tnum">{fmt.one(m.expected_weekly)}<span className="text-ink-3"> /wk</span></p>
            </div>
            <UpliftBadge value={m.uplift} />
          </Link>
        ))}
      </div>
      <Link href={`/seasons?season=${encodeURIComponent(season)}`} className="focus-ring mt-4 inline-flex items-center gap-1 self-start text-[13px] font-medium text-brand hover:underline">
        Full {season.toLowerCase()} impact <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </Card>
  );
}

export default function OverviewPage() {
  const { data, error } = useApi<Overview>("/api/overview");
  if (error) return <ErrorState error={error} />;
  if (!data) return <PageSkeleton />;
  const k = data.kpi;
  const yoy = k.ly_same_period_units ? k.next12_units / k.ly_same_period_units - 1 : null;
  const vsRecent = k.next12_units / k.last12_units - 1;
  const months = data.monthly;

  return (
    <>
      <PageHeader eyebrow={`Sales history ${fmt.weekYear(data.data.start)} – ${fmt.weekYear(data.data.end)}`} title="Seasonal demand outlook"
        actions={<Link href="/planner" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#262624]">Plan stock <ArrowRight className="h-4 w-4" /></Link>}>
        Weekly demand forecast for every medicine, with each season&apos;s effect on what the shop sells.
        Forecasts come from an ensemble of a deep GRU network, gradient-boosted trees and a seasonal baseline.
      </PageHeader>

      {/* Hero */}
      <Card className="overflow-hidden" delay={40}>
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr]">
          <div className="flex flex-col justify-between gap-6 border-b border-hairline bg-gradient-to-b from-brand-wash/70 to-transparent p-6 lg:border-b-0 lg:border-r">
            <div>
              <p className="eyebrow">Forecast · next 12 weeks</p>
              <p className="mt-3 text-[52px] font-semibold leading-none tracking-[-0.03em]">{fmt.compact(k.next12_units)}</p>
              <p className="mt-2 text-[13px] text-ink-3">units, {fmt.week(data.data.forecast_start)} – {fmt.weekYear(data.data.forecast_end)}</p>
            </div>
            <div className="space-y-3 text-[13px]">
              <div className="flex items-center justify-between"><span className="text-ink-3">vs same weeks last year</span><UpliftBadge value={yoy} /></div>
              <div className="flex items-center justify-between"><span className="text-ink-3">vs last 12 weeks</span><UpliftBadge value={vsRecent} /></div>
              <div className="flex items-center justify-between"><span className="text-ink-3">Next 4 weeks</span><span className="font-medium tnum">{fmt.int(k.next4_units)} units</span></div>
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-hairline bg-surface p-3 text-[12px] leading-relaxed text-ink-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <span>On the unseen 2026 monsoon, category-level forecasts were <b className="font-semibold text-ink">{fmt.pct(k.holdout_category_accuracy)}</b> accurate. The 90% range covered <b className="font-semibold text-ink">{fmt.pct(k.coverage_90)}</b> of actual weeks.</span>
            </div>
          </div>
          <div className="p-6 pb-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold tracking-tight">Store-wide weekly demand</h2>
                <p className="mt-0.5 text-[13px] text-ink-3">Units sold per week, all medicines</p>
              </div>
              <Legend items={[{ label: "Actual", color: C.s1 }, { label: "Backtest (holdout)", color: C.s3 }, { label: "Forecast", color: C.s2, kind: "dash" }, { label: "90% range", color: C.s2, kind: "band" }]} />
            </div>
            <ForecastChart data={data.series} height={330} />
          </div>
        </div>
      </Card>

      {/* KPI row */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Revenue (13 months)" value={fmt.inr(k.revenue)} spark={data.spark.revenue}
          delta={months.at(-1)!.revenue / months.at(-2)!.revenue - 1} deltaLabel="last month vs prior" />
        <StatTile label="Units sold" value={fmt.compact(k.units)} spark={data.spark.units}
          delta={months.at(-1)!.units / months.at(-2)!.units - 1} deltaLabel="last month vs prior" />
        <StatTile label="Transactions" value={fmt.compact(k.transactions)} spark={data.spark.tx} hint={`${fmt.inrFull(k.avg_basket)} average bill`} />
        <StatTile label="Store-level forecast accuracy" value={fmt.pct(k.holdout_store_accuracy)} hint="weekly, unseen holdout" />
      </div>

      {/* Seasons */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SeasonCard label="This season · stock up" season={data.season.current} meta={data.season.meta[data.season.current]} movers={data.season.current_movers.rising} delay={80} />
        {data.season.next_movers.rising.length > 0 || data.season.strongest === data.season.current ? (
          <SeasonCard label="Coming next · prepare" season={data.season.next} meta={data.season.meta[data.season.next]} movers={data.season.next_movers.rising} delay={120} />
        ) : (
          <SeasonCard label={`Strongest season · ${data.season.next} ahead is flat`} season={data.season.strongest} meta={data.season.meta[data.season.strongest]} movers={data.season.strongest_movers.rising} delay={120} />
        )}
      </div>

      {/* Patterns */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" delay={140}>
          <CardHeader title="Monthly revenue" sub="Two Augusts let you compare year over year" />
          <div className="px-4 pb-4 pt-3">
            <Columns data={months.map((m) => ({ x: m.month, y: m.revenue }))} xFormatter={fmt.month} valueLabel="Revenue (₹)" height={240}
              highlight={(x: string) => ["06", "07", "08", "09"].includes(x.slice(5))} />
            <div className="mt-2 px-2"><Legend items={[{ label: "Monsoon months", color: C.s1, kind: "dot" }, { label: "Other months", color: "#c9d9ee", kind: "dot" }]} /></div>
          </div>
        </Card>
        <Card delay={160}>
          <CardHeader title="Demand mix" sub="Units by therapeutic category" />
          <div className="px-6 pb-6 pt-4">
            <BarList items={data.mix.map((m) => ({ label: m.category, value: m.units }))} />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card delay={180}>
          <CardHeader title="When customers come in" sub="Transactions by hour of day" />
          <div className="px-4 pb-4 pt-3">
            <Columns data={data.hour.map((v, h) => ({ x: h, y: v })).filter((d) => d.x >= 7 && d.x <= 22)} xFormatter={(h: number) => `${h}:00`} valueLabel="Transactions" height={200} />
          </div>
        </Card>
        <Card delay={200}>
          <CardHeader title="Day of week" sub="Average transactions per day" />
          <div className="px-4 pb-4 pt-3">
            <Columns data={data.dow.map((v, d) => ({ x: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d], y: v }))} valueLabel="Transactions / day" height={200} />
          </div>
        </Card>
      </div>

      <div className="mt-6 flex items-center gap-2 text-[12px] text-ink-3">
        <Sparkles className="h-3.5 w-3.5" /> Current season is <SeasonChip season={data.season.current} /> · models retrain with <code className="font-mono">python -m ml.train</code>
      </div>
    </>
  );
}
