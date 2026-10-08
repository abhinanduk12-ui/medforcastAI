"use client";

import { useState } from "react";
import { CalendarRange, Info, PackagePlus, Sparkles } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, SeasonIcon } from "@/components/ui";
import { SeasonTimeline } from "@/components/calendar/SeasonTimeline";
import { MonthCard } from "@/components/calendar/MonthCard";
import { CategoryMonthHeatmap } from "@/components/calendar/CategoryMonthHeatmap";
import { PurchaseValueChart } from "@/components/calendar/PurchaseValueChart";
import type { CalendarResp } from "@/components/calendar/types";

/* Kerala climate season of a YYYY-MM (mirrors ml/config.py SEASONS). Used when a pre-order targets the month after
   the plan window, which has no entry in data.months. */
const SEASON_OF_MONTH = ["Winter", "Winter", "Summer", "Summer", "Summer", "Monsoon", "Monsoon", "Monsoon", "Monsoon", "Post-Monsoon", "Post-Monsoon", "Winter"];
const seasonOf = (ym: string) => SEASON_OF_MONTH[Number(ym.slice(5, 7)) - 1] ?? "Post-Monsoon";

function Tile({ label, value, sub, delay }: { label: string; value: string; sub: string; delay: number }) {
  return (
    <div className="card rise min-w-0 p-5" style={{ animationDelay: `${delay}ms` }}>
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className="mt-3 text-[26px] font-semibold leading-none tracking-[-0.02em] tnum">{value}</p>
      <p className="mt-3 text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}

export default function CalendarPage() {
  const [category, setCategory] = useState("");
  const { data, error, loading } = useApi<CalendarResp>(`/api/calendar?months=12${category ? `&category=${encodeURIComponent(category)}` : ""}`);

  // A failed refetch (e.g. after switching category) keeps the last good plan on screen with an inline notice,
  // so the category picker stays reachable; only a failed first load replaces the page.
  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <PageSkeleton />;

  const s = data.summary;
  const thisMonth = data.today.slice(0, 7);
  const ml = data.months.filter((m) => m.ml_days > 0);
  const rhythm = data.months.filter((m) => m.pre_order.length > 0);
  const scope = data.category ?? "all categories";

  return (
    <>
      <PageHeader eyebrow="Year planner" title="12-month seasonal planning calendar"
        actions={
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"
            className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface px-3 text-[14px] sm:w-72">
            <option value="">All categories</option>
            {data.categories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
          </select>
        }>
        Demand and purchase value for each month from {data.months[0]?.label} to {data.months[data.months.length - 1]?.label},
        built from each medicine&apos;s seasonal profile and significant festival effects. The first months lean on the ML
        forecast; later months are a seasonal projection with a wider range.
      </PageHeader>

      {error && (
        <div role="alert" className="mb-6 rounded-2xl border border-hairline bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
          Could not load the plan for {category || "all categories"} ({error}). Showing {scope} instead.
        </div>
      )}

      <div aria-busy={loading} className={`transition-opacity ${loading ? "opacity-60" : ""}`}>
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Tile delay={0} label="Expected units, 12 months" value={fmt.compact(s.units)} sub={`90% range ${fmt.compact(s.units_lo)}–${fmt.compact(s.units_hi)} · ${scope}`} />
          <Tile delay={30} label="Purchase value at median price" value={fmt.inr(s.value)} sub={`90% range ${fmt.inr(s.value_lo)}–${fmt.inr(s.value_hi)}`} />
          <Tile delay={60} label="Busiest month" value={s.peak_label ?? "—"} sub={`${fmt.signedPct((s.peak_index ?? 1) - 1, 1)} daily demand vs avg month · quietest ${s.low_label} (${fmt.signedPct((s.low_index ?? 1) - 1, 1)})`} />
          <Tile delay={90} label="Months with a pre-order signal" value={String(s.pre_order_months)} sub="a category rises ≥ 8% into the next month" />
        </div>

        {/* Timeline */}
        <Card className="mt-6" delay={120}>
          <CardHeader title="Season & festival timeline" sub="Kerala climate seasons, festival windows and how much each month leans on the ML forecast"
            right={<CalendarRange className="h-5 w-5 text-ink-3" />} />
          <div className="px-6 pb-5 pt-4"><SeasonTimeline months={data.months} /></div>
        </Card>

        {/* Value chart + purchase rhythm */}
        <div className="mt-6 grid gap-6 xl:grid-cols-[1.5fr_1fr] xl:items-start">
          <Card className="min-w-0" delay={150}>
            <CardHeader title="Monthly purchase value" sub="Expected units × median selling price, a proxy for what has to be bought in. Whiskers show the 90% range." />
            <div className="px-4 pb-5 pt-4 sm:px-6"><PurchaseValueChart months={data.months} /></div>
          </Card>
          <Card className="min-w-0" delay={180}>
            <CardHeader title="Purchase rhythm" sub="Categories to pre-order a month ahead of a seasonal rise"
              right={<PackagePlus className="h-5 w-5 text-ink-3" />} />
            <div className="px-6 pb-6 pt-4">
              {rhythm.length ? (
                <ol className="relative space-y-4 border-l border-hairline pl-5">
                  {rhythm.map((m) => (
                    <li key={m.month} className="relative">
                      <span className="absolute -left-[25px] top-1 grid h-2.5 w-2.5 place-items-center rounded-full border-2 border-surface bg-ink" />
                      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
                        Order in {m.short} <span className="font-normal text-ink-3">for</span>
                        <SeasonIcon season={data.months.find((x) => x.month === m.pre_order[0].for_month)?.season ?? seasonOf(m.pre_order[0].for_month)} className="h-3.5 w-3.5 text-ink-3" />
                        {m.pre_order[0].for_label}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {m.pre_order.slice(0, 6).map((p) => (
                          <span key={p.category} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-[12px] text-ink-2" title={`About ${fmt.int(p.extra_units)} extra units next month`}>
                            {p.category} <span className="font-semibold text-ink tnum">{fmt.signedPct(p.change)}</span>
                          </span>
                        ))}
                        {m.pre_order.length > 6 && <span className="px-1 py-1 text-[12px] text-ink-3">+{m.pre_order.length - 6} more</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[13px] leading-relaxed text-ink-3">
                  No category in {scope} rises by 8% or more from one month to the next, so a steady ordering rhythm is enough.
                </p>
              )}
            </div>
          </Card>
        </div>

        {/* Month cards */}
        <div className="mb-4 mt-10 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow mb-1">Month by month</p>
            <h2 className="text-[20px] font-semibold tracking-tight">What each month needs</h2>
          </div>
          <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <Sparkles className="h-3.5 w-3.5 text-brand" />
            {ml.length ? `${ml.map((m) => m.short).join(" & ")} blend in the ML forecast; the rest are seasonal projections` : "All months are seasonal projections"}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.months.map((m, i) => <MonthCard key={m.month} m={m} current={m.month === thisMonth} delay={Math.min(i, 8) * 30} />)}
        </div>

        {/* Heatmap */}
        <Card className="mt-6" delay={60}>
          <CardHeader title="Category × month demand" sub="Each row compared with that category's own average month (per day, so short months aren't penalised)" />
          <div className="px-5 pb-6 pt-4">
            {data.heatmap.rows.length ? <CategoryMonthHeatmap rows={data.heatmap.rows} months={data.months} />
              : <p className="text-[13px] text-ink-3">No category has projected demand in this window.</p>}
          </div>
        </Card>

        {/* Method */}
        <Card className="mt-6" delay={90}>
          <CardHeader title="How the calendar is built" sub="Assumptions and uncertainty, stated plainly" right={<Info className="h-5 w-5 text-ink-3" />} />
          <div className="grid gap-6 px-6 pb-6 pt-4 lg:grid-cols-[1.4fr_1fr]">
            <ul className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
              {data.method.notes.map((n) => <li key={n} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-3" />{n}</li>)}
            </ul>
            <dl className="grid grid-cols-2 gap-3 self-start text-[12px]">
              {[
                ["History ends", fmt.weekYear(data.method.data_end)],
                ["ML forecast covers", data.method.forecast_span ? `${fmt.week(data.method.forecast_span[0])} – ${fmt.week(data.method.forecast_span[1])}` : "—"],
                ["ML weight, week 1", fmt.pct(data.method.ml_w0)],
                ["Level drift / month", `${fmt.pct(data.method.drift_per_month, 1)}${(data.method.drift_estimated ?? 0) < data.method.drift_floor ? " (assumed)" : ""}`],
                ["Month-to-month swing", fmt.pct(data.method.month_shock_sd, 1)],
                ["Shared ML error", fmt.pct(data.method.ml_shared_error, 1)],
                ["Range", `90% (z = ${data.method.z})`],
                ["Festival dates known to", fmt.weekYear(data.method.festival_dates_until)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-2xl bg-surface-2 p-3">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="mt-1 font-medium text-ink tnum">{v}</dd>
                </div>
              ))}
              <div className="col-span-2 rounded-2xl bg-surface-2 p-3">
                <dt className="text-ink-3">Significant festival effects used</dt>
                <dd className="mt-1 font-medium text-ink">
                  {data.method.significant_festivals.length
                    ? data.method.significant_festivals.map((f) => `${f.festival}: ${f.category} ${fmt.signedPct(f.uplift)} in festival weeks${f.per_day_uplift != null ? ` (${fmt.signedPct(f.per_day_uplift)} per festival day)` : ""}`).join(" · ")
                    : "None cleared the significance test"}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      </div>
    </>
  );
}
