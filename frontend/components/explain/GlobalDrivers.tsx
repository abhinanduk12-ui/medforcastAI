"use client";

import { useState } from "react";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { BarList, C, inkOn } from "@/components/charts";
import { Card, CardHeader, SeasonIcon, Skeleton } from "@/components/ui";
import { sci, SHORT, type GlobalExplanation, type Unavailable } from "./types";

// Sequential single-hue ramp (pine, light -> dark) for "how much this driver matters".
const SEQ = ["#f1f0eb", "#d7ebe5", "#a9d2c6", "#6fb1a0", "#33877a", "#0e5c4f"];
const seq = (t: number) => SEQ[Math.min(SEQ.length - 1, Math.max(0, Math.round(t * (SEQ.length - 1))))];

/** Typical size of a driver's effect: mean |SHAP| in log space as a ± multiplier. */
const typical = (meanAbs: number) => {
  const f = Math.exp(meanAbs);
  return f >= 2 ? `×${f.toFixed(1)}` : `±${((f - 1) * 100).toFixed((f - 1) * 100 < 1 ? 1 : 0)}%`;
};

function SeasonHeatmap({ d }: { d: GlobalExplanation }) {
  const [hover, setHover] = useState<string | null>(null);
  const groups = d.overall.map((o) => o.group);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-separate border-spacing-[3px] text-[12px]">
        <caption className="sr-only">Typical size of each driver’s effect by season of the target week</caption>
        <thead>
          <tr>
            <th scope="col" className="px-2 pb-1 text-left font-medium text-ink-3">Driver</th>
            {d.by_season.map((s) => (
              <th key={s.name} scope="col" className="px-1 pb-1 font-medium text-ink-3">
                <span className="inline-flex items-center gap-1"><SeasonIcon season={s.name} className="h-3.5 w-3.5" />{s.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, ri) => {
            const max = Math.max(...d.by_season.map((s) => s.importance[g]), 1e-9);
            return (
              <tr key={g}>
                <th scope="row" className="whitespace-nowrap px-2 text-left font-normal text-ink-2">{SHORT[g] ?? g}</th>
                {d.by_season.map((s, ci) => {
                  const v = s.importance[g];
                  // Shade compares seasons within one driver as a ratio to its strongest season (½ of the peak or less =
                  // lightest), so a real seasonal swing shows while a 3% wobble in a big driver stays flat.
                  const bg = seq(Math.max(0, (v / max - 0.5) / 0.5));
                  const k = `${g}|${s.name}`;
                  // The wrapper scrolls horizontally, which clips overflow: open the tooltip below the top rows and
                  // anchor it to the right edge in the last column.
                  const place = `${ri < 3 ? "top-full mt-1.5" : "bottom-full mb-1.5"} ${ci === d.by_season.length - 1 ? "right-0" : "left-1/2 -translate-x-1/2"}`;
                  return (
                    <td key={s.name} className="relative h-9 rounded-md text-center font-medium tnum transition-[outline]"
                      style={{ background: bg, color: inkOn(bg), outline: hover === k ? `2px solid ${C.ink}` : "none" }}
                      onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
                      {typical(v)}
                      {hover === k && (
                        <div className={`pointer-events-none absolute z-10 w-[200px] rounded-xl border border-hairline bg-white/95 px-3 py-2.5 text-left text-[12px] font-normal text-ink shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur ${place}`}>
                          <p className="mb-1 font-medium">{g} · {s.name}</p>
                          <div className="flex justify-between gap-3"><span className="text-ink-2">Typical effect</span><span className="tnum font-medium">{typical(v)}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-ink-2">vs its peak season</span><span className="tnum font-medium">{fmt.pct(v / max)}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-ink-2">Share of all effects</span><span className="tnum font-medium">{fmt.pct(s.share[g], 1)}</span></div>
                          <div className="flex justify-between gap-3"><span className="text-ink-2">Rows</span><span className="tnum">{fmt.int(s.rows)}</span></div>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2 px-2 text-[11px] text-ink-3">
        <span>half its peak or less</span>
        <span className="flex">{SEQ.map((c) => <span key={c} className="h-2.5 w-5 first:rounded-l-[3px] last:rounded-r-[3px]" style={{ background: c }} />)}</span>
        <span>this driver’s peak season</span>
      </div>
    </div>
  );
}

export function GlobalDrivers({ delay = 160 }: { delay?: number }) {
  const { data, error } = useApi<GlobalExplanation | Unavailable>("/api/explain/global");

  if (error) return <Card className="mt-6 p-6" delay={delay}><p className="text-[13px] text-ink-3">Forecast-driver explanations unavailable: {error}</p></Card>;
  if (!data) return <div className="mt-6 grid gap-6 lg:grid-cols-2" aria-busy><Skeleton className="h-[380px]" /><Skeleton className="h-[380px]" /></div>;
  if (!data.available) {
    return (
      <Card className="mt-6" delay={delay}>
        <CardHeader title="Explainable AI: forecast drivers" />
        <div className="m-6 flex gap-2 rounded-xl border border-hairline bg-surface-2 p-4 text-[13px] text-ink-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />{data.message}</div>
      </Card>
    );
  }

  const ck = data.checks;
  // Categories with few sampled rows give noisy averages, so they are left out of the ranking.
  const seasonRank = [...data.by_category].filter((c) => (c.rows ?? 0) >= 300).sort((a, b) => b.importance["Season effect"] - a.importance["Season effect"]).slice(0, 6);
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      {data.stale && data.stale_message && (
        <div className="flex gap-2 rounded-xl border border-hairline bg-surface p-3 text-[12px] text-ink-2 lg:col-span-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#b37a00" }} strokeWidth={2.2} /><span><b className="font-semibold text-ink">Out of date.</b> {data.stale_message}</span>
        </div>
      )}
      <Card className="min-w-0" delay={delay}>
        <CardHeader title="Explainable AI: what moves the forecast"
          sub="Typical size of each driver’s effect on the 12-week forecast (mean |SHAP|, shown as a multiplier)"
          right={!data.stale &&
            <span className="inline-flex items-center gap-1 rounded-full border border-hairline px-2.5 py-1 text-[11px] text-ink-2"
              title={`Max |Σ SHAP + bias − model output| = ${sci(ck.additivity_max_err)} (log units); refit matches the production GBM to ${sci(ck.agreement_with_forecast_csv.max_abs_diff)} units a week`}>
              <CircleCheck className="h-3.5 w-3.5 text-good" strokeWidth={2.2} />Exact: adds up to the model
            </span>
          } />
        <div className="px-6 pb-5 pt-4">
          <BarList items={data.overall.map((o) => ({ label: o.group, value: o.mean_abs }))} color={C.s1} format={typical} />
        </div>
        <div className="border-t border-hairline px-6 py-4">
          <p className="eyebrow mb-2">Where the season matters most</p>
          <div className="flex flex-wrap gap-1.5">
            {seasonRank.map((c) => (
              <span key={c.name} className="rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12px] text-ink-2">
                {c.name} <b className="font-semibold text-ink tnum">{typical(c.importance["Season effect"])}</b>
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card className="min-w-0" delay={delay + 20}>
        <CardHeader title="Drivers by season of the target week" sub={`How strongly each driver acts in each season · ${fmt.int(data.sample_rows)} sampled training rows`} />
        <div className="px-4 pb-4 pt-4"><SeasonHeatmap d={data} /></div>
        <div className="flex gap-2 border-t border-hairline bg-surface-2 px-6 py-4 text-[12px] leading-relaxed text-ink-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
          <p>
            SHAP values come from XGBoost’s exact TreeSHAP and are additive in the Poisson model’s log space, so each driver is a multiplier on the
            baseline of {fmt.one(data.baseline_rate)} units a week. Unlike the permutation importance above, they explain individual forecasts and
            show direction. They describe the gradient-boosting member{data.gbm_weight != null && <> ({fmt.pct(data.gbm_weight)} of the ensemble)</>} only; the season
            effect is modest on average because most medicines are not season-sensitive
            {seasonRank[0] && <>, while in the most season-sensitive category ({seasonRank[0].name}) it is typically {typical(seasonRank[0].importance["Season effect"])}</>}.
            {!data.stale && <>
              {" "}Checks: SHAP values plus the bias reproduce the model’s log output to within <span className="tnum">{sci(ck.additivity_max_err)}</span>, and the
              refit model matches the production forecast to <span className="tnum">{sci(ck.agreement_with_forecast_csv.max_abs_diff)}</span> units a week
              across {fmt.int(ck.agreement_with_forecast_csv.rows)} forecast rows.
            </>}
          </p>
        </div>
      </Card>
    </div>
  );
}
