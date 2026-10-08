"use client";

import { ArrowRight, CalendarClock, ChevronDown, CloudRain, Flame, Snowflake, Sun, CloudSun } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { divergingColor, inkOn } from "@/components/charts";
import { Card, CardHeader, ErrorState, Skeleton, UpliftBadge } from "@/components/ui";
import { CLASS_STYLE, type CalendarResp, type OverviewResp, type SeasonalClass, type TimingRow } from "./types";

const SEASON_TINT: Record<string, { bg: string; ink: string; Icon: typeof Sun }> = {
  Winter: { bg: "#e8f0fa", ink: "#1c5cab", Icon: Snowflake },
  Summer: { bg: "#fdf1dc", ink: "#8a5a00", Icon: Sun },
  Monsoon: { bg: "#e3f2ec", ink: "#0e5c4f", Icon: CloudRain },
  "Post-Monsoon": { bg: "#efeef3", ink: "#4a3aa7", Icon: CloudSun },
};

function ClassChip({ c, compact = false }: { c: SeasonalClass; compact?: boolean }) {
  const s = CLASS_STYLE[c];
  return (
    <span title={c} className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium ${s.tone}`}>
      <span aria-hidden className="text-[9px] leading-none">{s.glyph}</span>{compact ? s.short : c}
    </span>
  );
}

function daysText(d: number | null | undefined) {
  if (d == null) return "";
  if (d === 0) return "today";
  return d > 0 ? `in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} ago`;
}

/* ─────────────── Up next: soonest order-by among seasonal categories ─────────────── */
function UpNext({ rows, onOpenTab }: { rows: TimingRow[]; onOpenTab: (k: string) => void }) {
  const first = rows[0];
  if (!first) {
    return (
      <Card className="flex flex-col justify-center p-6" delay={20}>
        <p className="eyebrow">Next to order</p>
        <p className="mt-3 text-[14px] text-ink-2">No seasonal category has an upcoming season window.</p>
      </Card>
    );
  }
  return (
    <section className="rise flex flex-col overflow-hidden rounded-[20px] bg-ink text-white shadow-[0_18px_40px_-20px_rgba(11,11,11,0.55)]" style={{ animationDelay: "20ms" }}>
      <div className="p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/55">Next to order</p>
        <h2 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight">{first.label}</h2>
        <p className="mt-1 text-[13px] text-white/60">Season starts {first.next_onset} · peaks {first.next_peak} at {fmt.signedPct(first.peak_mult - 1)}</p>
        <div className="mt-5 flex items-end justify-between gap-4">
          <div>
            <p className="text-[12px] text-white/55">Order by</p>
            <p className="mt-1 text-[30px] font-semibold leading-none tracking-tight">{first.order_by}</p>
            <p className="mt-1.5 text-[12px] text-white/60">{daysText(first.days_to_order)} · {Math.round(first.lead_days)}-day lead time</p>
          </div>
          <CalendarClock className="h-9 w-9 shrink-0 text-white/25" strokeWidth={1.5} aria-hidden />
        </div>
      </div>
      {rows.length > 1 && (
        <ul className="mt-auto divide-y divide-white/10 border-t border-white/10">
          {rows.slice(1, 5).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-6 py-2.5 text-[13px]">
              <span className="min-w-0 truncate text-white/85">{r.label}</span>
              <span className="shrink-0 tnum text-white/60">by {r.order_by}</span>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => onOpenTab("timing")} className="focus-ring flex items-center justify-between border-t border-white/10 px-6 py-3 text-left text-[13px] font-medium text-white/85 transition hover:bg-white/5">
        All timing & order-by dates <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </section>
  );
}

/* ─────────────── In season now ─────────────── */
function InSeason({ rows, today }: { rows: TimingRow[]; today: { category: string; m: number }[] }) {
  const lows = [...today].sort((a, b) => a.m - b.m).slice(0, 3).filter((x) => x.m < 0.95);
  return (
    <Card className="flex flex-col p-6" delay={50}>
      <div className="flex items-center gap-2">
        <Flame className="h-4 w-4 text-[#c23b3a]" aria-hidden />
        <p className="eyebrow">In season this week</p>
      </div>
      {rows.length ? (
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium">{r.label}</p>
                <p className="truncate text-[12px] text-ink-3">window {r.onset} – {r.end}</p>
              </div>
              <UpliftBadge value={r.today_mult - 1} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[13px] leading-relaxed text-ink-3">No seasonal category is in its high-demand window this week; demand is close to normal.</p>
      )}
      {lows.length > 0 && (
        <div className="mt-auto border-t border-hairline pt-4">
          <p className="text-[12px] text-ink-3">Running below normal this week</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lows.map((x) => (
              <span key={x.category} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-[12px] text-ink-2">
                {x.category} <span className="tnum font-medium text-[#1c5cab]">{fmt.signedPct(x.m - 1)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/* ─────────────── KPI tiles ─────────────── */
function Kpis({ d }: { d: OverviewResp }) {
  const k = d.kpi;
  const own = (d.classes["Strongly seasonal"] ?? 0) + (d.classes["Seasonal"] ?? 0);
  const viaCat = d.classes["Seasonal (category evidence)"] ?? 0;
  const tiles = [
    { label: "Seasonal medicines", value: fmt.int(k.seasonal_medicines), sub: `${own} on their own sales · ${viaCat} via their category` },
    { label: "Seasonal categories", value: `${k.significant_categories} / ${k.categories}`, sub: "significant after false-discovery control" },
    {
      label: "Season effect, next 12 weeks", value: `${k.forecast_seasonal_value >= 0 ? "+" : "−"}${fmt.inr(Math.abs(k.forecast_seasonal_value))}`,
      sub: `${k.forecast_seasonal_units >= 0 ? "+" : "−"}${fmt.int(Math.abs(k.forecast_seasonal_units))} units vs a season-free forecast`,
    },
    { label: "Seasonal archetypes", value: String(k.archetypes), sub: "shapes of the year found in the data" },
  ];
  return (
    <div className="grid grid-cols-2 gap-4">
      {tiles.map((t, i) => (
        <div key={t.label} className="card rise flex flex-col p-5" style={{ animationDelay: `${80 + i * 25}ms` }}>
          <p className="text-[12.5px] text-ink-3">{t.label}</p>
          <p className="mt-2.5 text-[26px] font-semibold leading-none tracking-[-0.02em]">{t.value}</p>
          <p className="mt-auto pt-2.5 text-[11.5px] leading-snug text-ink-3">{t.sub}</p>
        </div>
      ))}
    </div>
  );
}

/* ─────────────── Seasonal calendar heatmap (category x 52 weeks) ─────────────── */
function seasonOfCol(label: string): string {
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(label.split(" ")[1]) + 1;
  if ([12, 1, 2].includes(mon)) return "Winter";
  if ([3, 4, 5].includes(mon)) return "Summer";
  if ([6, 7, 8, 9].includes(mon)) return "Monsoon";
  return "Post-Monsoon";
}

function CalendarHeatmap({ cal, onOpenCurve }: { cal: CalendarResp; onOpenCurve: (id: string) => void }) {
  const cols = cal.columns;
  // contiguous season runs for the band strip above the grid
  const runs: { season: string; start: number; len: number }[] = [];
  cols.forEach((c, i) => {
    const s = seasonOfCol(c);
    const last = runs[runs.length - 1];
    if (last && last.season === s) last.len++;
    else runs.push({ season: s, start: i, len: 1 });
  });
  const tickAt = new Map(cal.month_ticks.map((t) => [t.col, t.month]));
  const grid = `minmax(190px, 240px) repeat(${cols.length}, minmax(13px, 1fr))`;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[940px]">
        {/* season bands */}
        <div className="grid items-end gap-x-[2px]" style={{ gridTemplateColumns: grid }}>
          <div />
          {runs.map((r) => {
            const t = SEASON_TINT[r.season];
            return (
              <div key={`${r.season}-${r.start}`} className="flex h-6 items-center gap-1 overflow-hidden rounded-md px-1.5 text-[10.5px] font-medium"
                style={{ gridColumn: `${r.start + 2} / span ${r.len}`, background: t.bg, color: t.ink }}>
                <t.Icon className="h-3 w-3 shrink-0" aria-hidden />{r.len >= 5 && <span className="truncate">{r.season}</span>}
              </div>
            );
          })}
        </div>
        {/* month labels */}
        <div className="mt-1.5 grid gap-x-[2px]" style={{ gridTemplateColumns: grid }}>
          <div className="text-[11px] font-medium text-ink-3">Category</div>
          {cols.map((c, i) => (
            <div key={c} className={`relative h-4 text-[10.5px] ${i === cal.today_col ? "font-semibold text-ink" : "text-muted"}`}>
              {tickAt.get(i) && <span className="absolute left-0 top-0 whitespace-nowrap">{tickAt.get(i)}</span>}
            </div>
          ))}
        </div>
        {/* rows */}
        <div className="mt-1 space-y-[2px]">
          {cal.rows.map((r) => (
            <button key={r.id} onClick={() => onOpenCurve(`cat:${r.id}`)} aria-label={`Open the seasonal curve for ${r.label}`}
              className="focus-ring group grid w-full items-center gap-x-[2px] rounded-md text-left hover:bg-surface-2" style={{ gridTemplateColumns: grid }}>
              <div className="flex min-w-0 items-center justify-between gap-2 py-0.5 pr-3">
                <span className="min-w-0 truncate text-[12.5px] text-ink-2 group-hover:text-ink">{r.label}</span>
                <ClassChip c={r.class} compact />
              </div>
              {r.values.map((v, i) => {
                const bg = divergingColor(v);
                return (
                  <span key={i} title={`${r.label} · week of ${cols[i]}: ${fmt.signedPct(v - 1)} vs an average week`}
                    className={`block h-[22px] rounded-[3px] ${i === cal.today_col ? "ring-[1.5px] ring-ink/70 ring-offset-[1px]" : ""}`}
                    style={{ background: bg, color: inkOn(bg) }} />
                );
              })}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] text-ink-3">
        <div className="flex items-center gap-2">
          <span>Less demand</span>
          <div className="flex overflow-hidden rounded">
            {[0.6, 0.72, 0.84, 0.93, 1, 1.07, 1.16, 1.28, 1.4].map((v) => <span key={v} className="h-3 w-5" style={{ background: divergingColor(v) }} />)}
          </div>
          <span>More demand</span>
        </div>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] ring-[1.5px] ring-ink/70" /> this week</span>
        <span>Each cell: that week vs an average week of the year. Click a category to open its curve.</span>
      </div>
    </div>
  );
}

/* ─────────────── tab ─────────────── */
export default function OverviewTab({ onOpenCurve, onOpenTab }: { onOpenCurve: (id: string) => void; onOpenTab: (k: string) => void }) {
  const { data, error } = useApi<OverviewResp>("/api/seasonal/overview");
  const { data: cal, error: calError } = useApi<CalendarResp>("/api/seasonal/calendar");
  if (error) return <ErrorState error={error} />;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[1fr_1fr_1.15fr]">
        {data ? <UpNext rows={data.upcoming} onOpenTab={onOpenTab} /> : <Skeleton className="h-[300px]" />}
        {data ? <InSeason rows={data.in_season} today={data.today_by_category} /> : <Skeleton className="h-[300px]" />}
        {data ? <Kpis d={data} /> : <Skeleton className="h-[300px]" />}
      </div>

      <Card delay={140}>
        <CardHeader title="Seasonal calendar"
          sub="Every category's demand through the year, week by week, from its fitted seasonal curve. Strongest, most certain patterns first." />
        <div className="px-6 pb-6 pt-5">
          {calError ? <ErrorState error={calError} /> : cal ? <CalendarHeatmap cal={cal} onOpenCurve={onOpenCurve} /> : <Skeleton className="h-[560px]" />}
        </div>
      </Card>

      {data && (
        <details className="card rise group p-6" style={{ animationDelay: "180ms" }}>
          <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg">
            <span>
              <span className="block text-[15px] font-semibold tracking-tight">How these curves are made</span>
              <span className="mt-1 block text-[13px] text-ink-3">
                {data.summary.weeks} weeks of sales ({fmt.weekYear(data.summary.first_week)} – {fmt.weekYear(data.summary.last_week)}) · {data.summary.medicines_tested} medicines tested
              </span>
            </span>
            <ChevronDown className="h-5 w-5 shrink-0 text-ink-3 transition group-open:rotate-180" aria-hidden />
          </summary>
          <div className="mt-5 grid gap-6 text-[13px] leading-relaxed text-ink-2 lg:grid-cols-2">
            <div>
              <p className="eyebrow mb-2">Method</p>
              <ol className="list-decimal space-y-2 pl-5">{data.method.map((m) => <li key={m}>{m}</li>)}</ol>
            </div>
            <div>
              <p className="eyebrow mb-2">Limits</p>
              <ol className="list-decimal space-y-2 pl-5">{data.limits.map((m) => <li key={m}>{m}</li>)}</ol>
              <button onClick={() => onOpenTab("evidence")} className="focus-ring mt-4 inline-flex items-center gap-1 rounded text-[13px] font-medium text-brand hover:underline">
                Full evidence and tests <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
