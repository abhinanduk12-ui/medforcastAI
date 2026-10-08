"use client";

import Link from "next/link";
import { ArrowRight, CircleCheck, CloudRain, ShieldAlert } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { UpliftBadge } from "@/components/ui";
import { fmt } from "@/lib/format";
import { LEVEL, LevelBadge, type WatchItem, type WatchResp } from "./model";

export function WatchList({ data }: { data: WatchResp }) {
  if (data.items.length === 0)
    return (
      <div className="card rise flex flex-col items-center px-6 py-10 text-center">
        <CircleCheck className="h-9 w-9 text-good" strokeWidth={1.6} aria-hidden />
        <p className="mt-3 text-[16px] font-semibold">Nothing on watch</p>
        <p className="mt-1.5 max-w-lg text-[13px] leading-relaxed text-ink-3">
          No tracked disease in Ernakulam is above its recent baseline{data.as_of ? ` (reports to ${fmt.weekYear(data.as_of)})` : ""}, and
          no weather rule fired. This list updates as new DHS reports and forecasts arrive.
        </p>
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {data.items.map((it, i) => <WatchCard key={it.id} it={it} delay={i * 40} />)}
    </div>
  );
}

function WatchCard({ it, delay }: { it: WatchItem; delay: number }) {
  const m = LEVEL[it.level];
  const spark = (it.spark ?? []).filter((v): v is number => v != null);   // missing weeks are not zero cases
  return (
    <article className="card rise relative overflow-hidden p-5" style={{ animationDelay: `${delay}ms` }}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: m.color }} aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <LevelBadge level={it.level} />
            {it.rule && <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-[11.5px] text-ink-3"><CloudRain className="h-3 w-3" aria-hidden />Rule of thumb</span>}
            <span className="text-[12px] text-ink-3">{it.district_name}</span>
          </div>
          <h3 className="mt-2 text-[16px] font-semibold leading-snug">{it.title}</h3>
        </div>
        {spark.length > 1 && <Sparkline data={spark} width={110} height={36} />}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{it.why}</p>

      {it.categories.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5">Categories likely to move</p>
          <div className="flex flex-wrap gap-1.5">
            {it.categories.map((c) => <span key={c} className="rounded-full border border-hairline bg-surface-2 px-2.5 py-0.5 text-[12px] text-ink-2">{c}</span>)}
          </div>
        </div>
      )}
      {it.medicines.length > 0 && (
        <div className="mt-4">
          <p className="eyebrow mb-1.5">Medicines to check stock for</p>
          <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-hairline">
            {it.medicines.slice(0, 6).map((md) => (
              <li key={md.medicine_id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <Link href={`/medicines/${encodeURIComponent(md.medicine_id)}`} className="focus-ring min-w-0 truncate hover:underline">
                  {md.medicine_name} <span className="text-ink-3">· {md.category}</span>
                </Link>
                {md.uplift_at_peak != null ? <span className="shrink-0" title="Scenario Lab rule uplift at the outbreak peak (intensity 1); an assumption, not a forecast"><UpliftBadge value={md.uplift_at_peak} /></span>
                  : <span className="shrink-0 text-[11.5px] text-ink-3">not quantified</span>}
              </li>
            ))}
          </ul>
          {it.medicines.length > 6 && <p className="mt-1.5 text-[11.5px] text-ink-3">+{it.medicines.length - 6} more medicine{it.medicines.length - 6 > 1 ? "s" : ""} with the same rules</p>}
        </div>
      )}
      {it.caution && (
        <p className="mt-4 flex gap-2 rounded-xl bg-sunken px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden /><span><b className="font-semibold text-ink">Pharmacist check.</b> {it.caution}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {it.note ? <p className="max-w-md text-[12px] text-ink-3">{it.note}</p> : <span />}
        {it.preset?.href ? (
          <Link href={it.preset.href} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-[#262624]">
            Open in Scenario Lab<ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : it.preset?.unavailable_reason ? <p className="text-[12px] text-ink-3">{it.preset.unavailable_reason}</p> : null}
      </div>
      {it.preset?.href && (
        <p className="mt-2 text-right text-[11px] text-muted">
          {it.preset.label} at intensity {it.preset.intensity}, from forecast week {it.preset.start_week} for {it.preset.duration_weeks} weeks
        </p>
      )}
    </article>
  );
}
