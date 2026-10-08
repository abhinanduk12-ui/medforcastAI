"use client";

import { useState } from "react";
import { ChevronDown, CircleCheck, CircleMinus, FlaskConical } from "lucide-react";
import { C } from "@/components/charts";
import { fmt } from "@/lib/format";
import { dayFmt, type EvidenceResp, type EvidenceTest } from "./model";

/** Honest rainfall-vs-demand test: effect of +1 SD rain anomaly on demand beyond the seasonal index, with bootstrap CI. */
export function EvidenceCard({ data }: { data: EvidenceResp }) {
  const [open, setOpen] = useState(false);
  if (!data.available) return <p className="px-6 pb-6 pt-3 text-[13px] text-ink-3">{data.reason}</p>;
  const none = data.verdict === "none";
  const lim = Math.min(0.6, Math.max(0.15, ...data.rows.map((r) => Math.max(Math.abs(r.effect_ci_pct[0]), Math.abs(r.effect_ci_pct[1])))));
  const clipped = data.rows.some((r) => Math.max(Math.abs(r.effect_ci_pct[0]), Math.abs(r.effect_ci_pct[1]), Math.abs(r.effect_per_sd_pct)) > lim);
  const x = (v: number) => `${((Math.max(-lim, Math.min(lim, v)) + lim) / (2 * lim)) * 100}%`;
  return (
    <div className="px-6 pb-6 pt-4">
      <div className={`flex gap-3 rounded-2xl px-4 py-3.5 ${none ? "bg-sunken" : "bg-brand-wash"}`}>
        <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-ink-2" strokeWidth={1.8} aria-hidden />
        <div>
          <p className="text-[14px] font-semibold">{none ? "No extra predictive power found" : "A small supported effect"}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{data.headline}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Weeks analysed" value={`${data.period.weeks}`} sub={data.period.start && data.period.end ? `${dayFmt(data.period.start)} – ${fmt.weekYear(data.period.end)}` : ""} />
        <Fact label="Tests run" value={`${data.n_tests}`} sub={data.lags.length ? `categories × lags ${data.lags[0]}–${data.lags[data.lags.length - 1]} wk` : "categories × lags"} />
        <Fact label="Raw p < 0.05" value={`${data.n_raw_p05}`} sub={`≈${data.expected_false_positives.toFixed(1)} expected by chance`} />
        <Fact label="Survive correction" value={`${data.supported.length}`} sub={`FDR q ≤ ${data.fdr_q}, CI ≠ 0, helps out of sample`} />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <caption className="sr-only">Strongest lag per category: demand change for a one-standard-deviation wetter week</caption>
          <thead>
            <tr className="border-b border-hairline text-left text-[11.5px] text-ink-3">
              <th className="py-2 pr-3 font-medium">Category (strongest lag)</th>
              <th className="py-2 pr-3 font-medium">Lag</th>
              <th className="w-[34%] py-2 pr-3 font-medium">Demand change per +1 SD wetter week, 95% CI</th>
              <th className="py-2 pr-3 text-right font-medium">q</th>
              <th className="py-2 pr-3 text-right font-medium">Out-of-sample</th>
              <th className="py-2 font-medium">Supported</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => <EvRow key={r.category} r={r} x={x} />)}
          </tbody>
        </table>
        <div className="mt-1 grid min-w-[640px] grid-cols-[1fr] text-[11px] text-muted">
          <p>Bars share one axis from −{Math.round(lim * 100)}% to +{Math.round(lim * 100)}%; the dot is the estimate, the line its bootstrap 95% CI, the tick at 0 means no effect.{clipped ? " Larger values are cut at the edge; the number on the right is exact." : ""}</p>
        </div>
      </div>

      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="evidence-method" className="focus-ring mt-4 inline-flex items-center gap-1 rounded-lg text-[13px] font-medium text-ink-2 hover:text-ink">
        Method and caveats<ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div id="evidence-method" className="mt-3 grid gap-4 text-[12.5px] leading-relaxed text-ink-2 md:grid-cols-2">
          <ul className="list-disc space-y-1.5 pl-4">{data.method.map((m) => <li key={m}>{m}</li>)}</ul>
          <ul className="list-disc space-y-1.5 pl-4">{data.caveats.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-2 px-3.5 py-3">
      <p className="text-[11.5px] text-ink-3">{label}</p>
      <p className="mt-1 text-[20px] font-semibold leading-none tnum">{value}</p>
      <p className="mt-1.5 text-[11px] leading-snug text-muted">{sub}</p>
    </div>
  );
}

function EvRow({ r, x }: { r: EvidenceTest; x: (v: number) => string }) {
  const [lo, hi] = r.effect_ci_pct;
  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="py-2 pr-3"><span className="font-medium">{r.category}</span> <span className="text-[11.5px] text-ink-3">{fmt.int(r.mean_units)}/wk</span></td>
      <td className="whitespace-nowrap py-2 pr-3 tnum text-ink-2">{r.lag_weeks} wk</td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2" title={`${fmt.signedPct(r.effect_per_sd_pct, 1)} (95% CI ${fmt.signedPct(lo, 1)} to ${fmt.signedPct(hi, 1)})`}>
          <div className="relative h-5 flex-1">
            <div className="absolute inset-y-0 w-px bg-[#6b6a65]" style={{ left: x(0) }} aria-hidden />
            <div className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})`, background: C.s1 }} />
            <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style={{ left: x(r.effect_per_sd_pct), background: C.s1 }} />
          </div>
          <span className="w-[52px] shrink-0 text-right text-[12px] tnum">{fmt.signedPct(r.effect_per_sd_pct, 1)}</span>
        </div>
      </td>
      <td className="py-2 pr-3 text-right tnum text-ink-2">{r.q == null ? "—" : r.q.toFixed(2)}</td>
      <td className="py-2 pr-3 text-right tnum text-ink-2" title="Reduction in mean absolute error vs no-rain baseline (rolling origin)">{r.oos_gain == null ? "—" : fmt.signedPct(r.oos_gain, 1)}</td>
      <td className="py-2">
        {r.supported
          ? <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink"><CircleCheck className="h-3.5 w-3.5 text-good" aria-hidden />Yes</span>
          : <span className="inline-flex items-center gap-1 text-[12px] text-ink-3"><CircleMinus className="h-3.5 w-3.5" aria-hidden />No</span>}
      </td>
    </tr>
  );
}
