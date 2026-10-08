"use client";

import { fmt } from "@/lib/format";
import { SeasonIcon, UpliftBadge } from "@/components/ui";
import { CurvePreview } from "./Controls";
import type { SimResp } from "./model";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-hairline px-6 py-5 first:border-t-0">
      <p className="eyebrow mb-3">{title}</p>
      {children}
    </div>
  );
}

/** Exactly which multipliers and elasticities the last simulation applied. */
export function Assumptions({ a }: { a: SimResp["assumptions"] }) {
  return (
    <div>
      <Block title="Seasonal intensity">
        <p className="text-[13px] text-ink-2">
          <span className="font-semibold tnum text-ink">{a.seasonal.intensity.toFixed(2)}×</span>
          {a.seasonal.intensity === 1 ? ", the forecast's own seasonality (unchanged)." : " of each medicine's seasonal deviation."}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {a.seasonal.seasons.map((s) => (
            <div key={s.season} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-[12px]">
              <span className="inline-flex items-center gap-1.5 text-ink-2"><SeasonIcon season={s.season} className="h-3.5 w-3.5" />{s.season} · {s.weeks} wk</span>
              <span className="tnum text-ink-3">avg index {s.mean_index.toFixed(3)} <span className="text-muted">→</span> <b className="font-semibold text-ink">{s.mean_scenario_index.toFixed(3)}</b></span>
            </div>
          ))}
        </div>
        <p className="mt-2 font-mono text-[11px] text-ink-3">{a.seasonal.formula}</p>
      </Block>

      <Block title="Outbreak multipliers">
        {a.outbreaks.length === 0 ? <p className="text-[13px] text-ink-3">None applied.</p> : (
          <div className="space-y-5">
            {a.outbreaks.map((o, i) => (
              <div key={i}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[13px] font-semibold">{o.label} <span className="font-normal text-ink-3">· intensity {o.intensity.toFixed(1)}× · weeks {o.start_week}–{Math.min(12, o.start_week + o.duration_weeks - 1)}</span></p>
                  <CurvePreview o={o} width={110} height={26} />
                </div>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-[12px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-ink-3">
                        <th className="py-1.5 pr-3 font-medium">Applies to</th>
                        <th className="px-2 py-1.5 text-right font-medium">Peak change</th>
                        <th className="px-2 py-1.5 text-right font-medium">Medicines</th>
                        <th className="py-1.5 pl-3 font-medium">Clinical rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.rules.map((r) => (
                        <tr key={r.target} className="border-t border-hairline align-top">
                          <td className="py-2 pr-3">
                            <span className="font-medium text-ink">{r.target}</span>
                            <span className="block text-[11px] text-ink-3">{r.match === "generic" ? "by molecule" : "whole category"}{r.examples.length ? `: ${r.examples.slice(0, 3).join(", ")}` : ""}</span>
                          </td>
                          <td className="px-2 py-2 text-right"><UpliftBadge value={r.peak_uplift} /></td>
                          <td className="px-2 py-2 text-right tnum text-ink-2">{r.medicines}</td>
                          <td className="py-2 pl-3 leading-snug text-ink-2">{r.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-ink-3">
              Each medicine takes the first rule that matches it, so molecule rules override category rules. The change shown is at the epidemic peak. Earlier and later weeks follow the curve, and overlapping outbreaks add together.
              These multipliers are expert assumptions informed by clinical guidance, not estimates from this shop&apos;s data.
            </p>
          </div>
        )}
      </Block>

      <Block title="Price elasticity">
        {a.price.change_pct === 0 ? <p className="text-[13px] text-ink-3">No price change applied.</p> : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {a.price.groups.map((g) => (
                <div key={g.group} className="rounded-xl bg-surface-2 px-3 py-2.5 text-[12px]" title={g.why}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-ink">{g.group}</span>
                    <span className="tnum text-ink-3">ε = {g.elasticity.toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-3 text-ink-3">
                    <span>{g.medicines} medicines</span>
                    <span className="tnum">volume <b className="font-semibold text-ink">{fmt.signedPct(g.volume_change, 1)}</b></span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 font-mono text-[11px] text-ink-3">{a.price.formula}</p>
          </>
        )}
      </Block>

      <Block title="Uncertainty and stock">
        <ul className="space-y-2 text-[12px] leading-relaxed text-ink-2">
          <li>{a.uncertainty}</li>
          <li>{a.inventory}</li>
        </ul>
      </Block>
    </div>
  );
}
