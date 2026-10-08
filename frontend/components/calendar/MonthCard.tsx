"use client";

import Link from "next/link";
import { PackagePlus, PartyPopper, Sparkles } from "lucide-react";
import { fmt } from "@/lib/format";
import { AbcBadge, SeasonChip, UpliftBadge } from "@/components/ui";
import type { CalMonth } from "./types";

export function MonthCard({ m, current, delay = 0 }: { m: CalMonth; current: boolean; delay?: number }) {
  const idx = m.index ?? 1;
  return (
    <article className={`card rise flex min-w-0 flex-col p-5 ${current ? "ring-[1.5px] ring-ink/60" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold tracking-tight">{m.label}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {current ? "This month · " : ""}{m.days} days
          </p>
        </div>
        <SeasonChip season={m.season} active={current} />
      </header>

      {/* Headline numbers */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-surface-2 p-3">
          <p className="text-[11px] text-ink-3">Expected units</p>
          <p className="mt-1 text-[20px] font-semibold leading-none tracking-tight tnum">{fmt.compact(m.units)}</p>
          <p className="mt-1.5 text-[11px] text-ink-3 tnum">90%: {fmt.compact(m.units_lo)}–{fmt.compact(m.units_hi)}</p>
        </div>
        <div className="rounded-2xl bg-surface-2 p-3">
          <p className="text-[11px] text-ink-3">Purchase value</p>
          <p className="mt-1 text-[20px] font-semibold leading-none tracking-tight tnum">{fmt.inr(m.value)}</p>
          <p className="mt-1.5 text-[11px] text-ink-3 tnum">90%: {fmt.inr(m.value_lo)}–{fmt.inr(m.value_hi)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 font-medium text-ink-2 tnum" title="Daily demand vs the average month of this plan">
          {fmt.signedPct(idx - 1)} vs avg month
        </span>
        {m.ml_days > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-brand-wash px-1.5 py-0.5 font-medium text-brand-ink"
            title={`Blended toward the ML ensemble on ${m.ml_days} of ${m.days} days (forecast weeks ${m.ml_horizon?.[0]}–${m.ml_horizon?.[1]})`}>
            <Sparkles className="h-3 w-3" /> ML blend {Math.round(m.ml_weight * 100)}%
          </span>
        ) : (
          <span className="rounded-md border border-hairline px-1.5 py-0.5 text-ink-3">Seasonal projection</span>
        )}
        {m.festivals.map((f) => (
          <span key={f.name} className="inline-flex items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-ink-2" title={`${f.days_in_month} festival days this month`}>
            <PartyPopper className="h-3 w-3 text-ink-3" />{f.name} · {f.days_in_month}d
          </span>
        ))}
      </div>

      {/* Rising medicines */}
      <div className="mt-4 border-t border-hairline pt-3">
        <p className="eyebrow mb-2">Rising this month</p>
        {m.rising.length ? (
          <ul className="space-y-1.5">
            {m.rising.slice(0, 3).map((r) => (
              <li key={r.medicine_id} className="flex items-center justify-between gap-2 text-[13px]">
                <Link href={`/medicines/${r.medicine_id}`} className="focus-ring flex min-w-0 items-center gap-2 rounded hover:underline"
                  title={`${r.medicine_name}: ${fmt.one(r.expected_units)} units expected vs ${fmt.one(r.typical_units)} in a typical month`}>
                  <AbcBadge abc={r.abc} />
                  <span className="truncate">{r.medicine_name}</span>
                </Link>
                <UpliftBadge value={r.uplift} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-3">No medicine is 8% or more above its typical month. Demand stays close to normal.</p>
        )}
      </div>

      {/* Pre-order chips */}
      {m.pre_order.length > 0 && (
        <div className="mt-auto pt-4">
          <div className="rounded-2xl border border-dashed border-[rgba(11,11,11,0.18)] p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-ink">
              <PackagePlus className="h-3.5 w-3.5" /> Pre-order for {m.pre_order[0].for_label}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {m.pre_order.slice(0, 4).map((p) => (
                <span key={p.category} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-[11px] text-ink-2"
                  title={`${p.category}: daily demand ${fmt.signedPct(p.change)} next month, about ${fmt.int(p.extra_units)} extra units`}>
                  {p.category} <span className="font-semibold text-ink tnum">{fmt.signedPct(p.change)}</span>
                </span>
              ))}
              {m.pre_order.length > 4 && <span className="px-1 py-1 text-[11px] text-ink-3">+{m.pre_order.length - 4} more</span>}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
