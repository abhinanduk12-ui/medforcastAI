"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Info, Minus, Sparkles, TriangleAlert } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { divergingColor, inkOn } from "@/components/charts";
import { Card, CardHeader, Segmented, SeasonIcon, Skeleton } from "@/components/ui";
import { factorLabel, SHORT, type MedicineExplanation, type Unavailable } from "./types";

const WEEKS = ["1", "4", "12"] as const;
type Weeks = (typeof WEEKS)[number];

// Diverging poles (same steps as the seasonal heatmap): red = more demand, blue = less, gray = no change.
const UP = "#ea7471", DOWN = "#5598e7", FLAT = "#c3c2b7", BASE = "#a3a29b", TOTAL = "#0b0b0b";

type Step = { key: string; label: string; sub: string; kind: "base" | "up" | "down" | "flat" | "total"; from: number; to: number; factor?: number };

function buildSteps(d: MedicineExplanation): Step[] {
  const steps: Step[] = [{ key: "base", label: "Store baseline", sub: "Model’s average week across all medicines", kind: "base", from: 0, to: d.baseline_rate }];
  let run = d.baseline_rate;
  const push = (key: string, label: string, sub: string, f: number) => {
    const kind = Math.abs(f - 1) < 0.01 ? "flat" : f > 1 ? "up" : "down";
    steps.push({ key, label, sub, kind, from: run, to: run * f, factor: f });
    run *= f;
  };
  const big = d.factors.filter((f) => f.direction !== "neutral");
  const small = d.factors.filter((f) => f.direction === "neutral");
  for (const f of big) push(f.group, SHORT[f.group] ?? f.group, f.group, f.factor);
  if (small.length) {
    const f = small.reduce((a, s) => a * s.factor, 1);
    push("small", `${small.length} minor drivers`, small.map((s) => SHORT[s.group] ?? s.group).join(", ") + " (each under 1%)", f);
  }
  // exp(mean log-forecast) is a geometric mean; the arithmetic weekly average is a touch higher.
  if (Math.abs(d.averaging_factor - 1) >= 0.005) push("avg", "Averaging weeks", "Arithmetic vs geometric mean of the weekly forecasts", d.averaging_factor);
  steps.push({ key: "total", label: "Model forecast", sub: `Average units per week, next ${d.weeks} wk`, kind: "total", from: 0, to: d.prediction });
  return steps;
}

const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

function Waterfall({ d }: { d: MedicineExplanation }) {
  const [hover, setHover] = useState<string | null>(null);
  const steps = buildSteps(d);
  const vals = steps.flatMap((s) => (s.kind === "base" || s.kind === "total" ? [s.to] : [s.from, s.to])).map((v) => Math.max(v, 1e-3));
  const lo = Math.min(...vals) / 1.6, hi = Math.max(...vals) * 1.25;
  const x = (v: number) => ((Math.log(Math.max(v, 1e-3)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100;
  let ticks = TICKS.filter((t) => t >= lo && t <= hi);
  // The bar column can be ~140px wide on a phone: keep only the 1·10ⁿ and 5·10ⁿ steps when 1-2-5 gets dense.
  if (ticks.length > 4) ticks = ticks.filter((t) => /^[15]/.test(String(t).replace(/^0\.0*/, "")));
  const cols = "grid grid-cols-[96px_minmax(0,1fr)_58px] items-center gap-3 sm:grid-cols-[150px_minmax(0,1fr)_72px]";

  return (
    <div>
      <div className="space-y-1" role="list" aria-label="Forecast waterfall from the store baseline to the model forecast">
        {steps.map((s, i) => {
          const a = s.kind === "base" || s.kind === "total" ? 0 : x(Math.min(s.from, s.to));
          const b = x(Math.max(s.from, s.to));
          const color = { base: BASE, total: TOTAL, up: UP, down: DOWN, flat: FLAT }[s.kind];
          const Icon = s.kind === "up" ? ArrowUpRight : s.kind === "down" ? ArrowDownRight : Minus;
          const on = hover === s.key;
          return (
            <div key={s.key} tabIndex={0} role="listitem"
              aria-label={s.factor != null
                ? `${s.label}: ${factorLabel(s.factor)}, ${fmt.one(s.from)} to ${fmt.one(s.to)} units a week`
                : `${s.label}: ${fmt.one(s.to)} units a week`}
              className={`focus-ring ${cols} rounded-lg py-1 transition-colors ${on ? "bg-surface-2" : ""}`}
              onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(s.key)} onBlur={() => setHover(null)}>
              <span className={`truncate text-[13px] ${s.kind === "total" ? "font-semibold text-ink" : "text-ink-2"}`} title={s.sub}>{s.label}</span>
              <div className="relative h-7">
                {ticks.map((t) => <div key={t} className="absolute inset-y-0 w-px bg-[#e9e8e2]" style={{ left: `${x(t)}%` }} />)}
                {/* connector from the previous bar's end (16px between bars + this bar's 4px inset) */}
                {i > 0 && s.kind !== "total" && s.kind !== "base" && (
                  <div className="absolute -top-4 h-5 w-px bg-[#c3c2b7]" style={{ left: `${x(s.from)}%` }} />
                )}
                <div className="absolute inset-y-1 rounded-[4px] transition-all duration-500"
                  style={{ left: `${a}%`, width: `${Math.max(b - a, 0.6)}%`, background: color, opacity: hover && !on ? 0.55 : 1 }} />
                {on && (
                  <div className="pointer-events-none absolute bottom-full z-10 mb-1.5 w-[220px] -translate-x-1/2 rounded-xl border border-hairline bg-white/95 px-3 py-2.5 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
                    style={{ left: `${Math.min(Math.max((a + b) / 2, 22), 78)}%` }}>
                    <p className="mb-1.5 font-medium text-ink">{s.kind === "flat" || s.key === "small" || s.key === "avg" ? s.label : s.sub}</p>
                    {s.factor != null ? (
                      <>
                        <div className="flex justify-between gap-3"><span className="text-ink-2">Multiplier</span><span className="tnum font-medium">×{s.factor.toFixed(3)}</span></div>
                        <div className="flex justify-between gap-3"><span className="text-ink-2">Units / week</span><span className="tnum font-medium">{fmt.one(s.from)} → {fmt.one(s.to)}</span></div>
                        {(s.key === "small" || s.key === "avg") && <p className="mt-1.5 text-[11px] leading-snug text-ink-3">{s.sub}</p>}
                      </>
                    ) : (
                      <div className="flex justify-between gap-3"><span className="text-ink-2">Units / week</span><span className="tnum font-medium">{fmt.one(s.to)}</span></div>
                    )}
                  </div>
                )}
              </div>
              <span className="inline-flex items-center justify-end gap-0.5 text-right text-[13px] font-medium tnum">
                {s.factor != null ? <><Icon className="h-3.5 w-3.5 text-ink-3" strokeWidth={2.2} />{factorLabel(s.factor)}</> : fmt.one(s.to)}
              </span>
            </div>
          );
        })}
      </div>
      {/* log axis */}
      <div className={`${cols} mt-1`}>
        <span className="text-[11px] text-muted">units / week</span>
        <div className="relative h-4">
          {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2 text-[11px] text-muted tnum" style={{ left: `${x(t)}%` }}>{t}</span>)}
        </div>
        <span className="text-right text-[11px] text-muted">log scale</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
        {([[UP, "raises the forecast"], [DOWN, "lowers it"], [FLAT, "under 1% (no real change)"], [BASE, "store baseline"], [TOTAL, "model forecast"]] as const).map(([c, l]) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </div>
  );
}

function SeasonStrip({ d }: { d: MedicineExplanation }) {
  return (
    <div>
      <p className="mb-2 text-[12px] text-ink-3">Season effect on each forecast week (model’s multiplier)</p>
      <div className="grid grid-cols-6 gap-x-1 gap-y-2.5 pt-1 sm:grid-cols-12" role="list" aria-label="Season effect per forecast week">
        {d.per_horizon.map((p, i) => {
          const bg = divergingColor(p.season_factor);
          const label = `Week of ${fmt.weekYear(p.week)} (${p.season}): season ${factorLabel(p.season_factor)}, forecast ${fmt.one(p.prediction)} units${p.h <= d.weeks ? "" : " (outside the selected window)"}`;
          // Mark where a new season starts, so a sign flip (e.g. Monsoon -> Post-Monsoon) has a visible cause.
          const starts = i > 0 && d.per_horizon[i - 1].season !== p.season;
          return (
            <div key={p.h} role="listitem" aria-label={label} title={label}
              className={`relative rounded-lg px-1 py-1.5 text-center transition-opacity ${p.h <= d.weeks ? "" : "opacity-40"}`} style={{ background: bg, color: inkOn(bg) }}>
              {starts && (
                <span aria-hidden className="absolute -top-1.5 right-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-surface text-ink-2 ring-1 ring-hairline">
                  <SeasonIcon season={p.season} className="h-2.5 w-2.5" />
                </span>
              )}
              <p className="text-[11px] font-semibold tnum">{factorLabel(p.season_factor)}</p>
              <p className="text-[10px] opacity-80">{fmt.week(p.week)}</p>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: UP }} />season lifts demand</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: DOWN }} />season lowers demand</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: divergingColor(1) }} />within ±4%</span>
        {[...new Set(d.per_horizon.filter((p, i) => i > 0 && d.per_horizon[i - 1].season !== p.season).map((p) => p.season))].map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5"><SeasonIcon season={s} className="h-3 w-3" />{s} starts</span>
        ))}
        <span>Faded weeks are outside the selected window.</span>
      </div>
    </div>
  );
}

export function ExplainCard({ id, delay = 70 }: { id: string; delay?: number }) {
  const [weeks, setWeeks] = useState<Weeks>("4");
  const { data, error, loading } = useApi<MedicineExplanation | Unavailable>(`/api/explain/medicine/${encodeURIComponent(id)}?weeks=${weeks}`);
  // useApi keeps the previous response while a new one loads: fine when only the window changes,
  // but never show another medicine's explanation after navigating between detail pages.
  const d = data && data.available && data.id !== id ? null : data;

  const header = (
    <CardHeader title="Why this forecast?" sub="What the gradient-boosting model weighed, as multipliers on a store-wide baseline (exact TreeSHAP)"
      right={<Segmented options={WEEKS} value={weeks} onChange={setWeeks} render={(w) => (w === "1" ? "Next week" : `${w} weeks`)} />} />
  );

  if (error) {
    return <Card className="mt-6" delay={delay}>{header}<p className="px-6 pb-6 pt-4 text-[13px] text-ink-3">Explanation unavailable: {error}</p></Card>;
  }
  if (!d) {
    return (
      <Card className="mt-6" delay={delay}>{header}
        <div className="grid gap-6 px-6 pb-6 pt-5 lg:grid-cols-[1.35fr_1fr]"><Skeleton className="h-[300px]" /><Skeleton className="h-[300px]" /></div>
      </Card>
    );
  }
  if (!d.available) {
    return (
      <Card className="mt-6" delay={delay}>{header}
        <div className="m-6 flex gap-2 rounded-xl border border-hairline bg-surface-2 p-4 text-[13px] text-ink-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />{d.message}</div>
      </Card>
    );
  }

  const [lead, ...rest] = d.sentences;
  // The previous window stays on screen while the new one loads: dim it rather than blank the card.
  const pending = loading && d.weeks !== Number(weeks);
  return (
    <Card className="mt-6" delay={delay}>
      {header}
      {d.stale && d.stale_message && (
        <div className="mx-6 mt-5 flex gap-2 rounded-xl border border-hairline bg-surface-2 p-3 text-[12px] text-ink-2">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#b37a00" }} strokeWidth={2.2} /><span><b className="font-semibold text-ink">Out of date.</b> {d.stale_message}</span>
        </div>
      )}
      <div aria-busy={pending} className={`grid gap-8 px-6 pb-6 pt-5 transition-opacity lg:grid-cols-[1.35fr_1fr] ${pending ? "opacity-60" : ""}`}>
        <div className="min-w-0 space-y-6">
          <Waterfall d={d} />
          <SeasonStrip d={d} />
        </div>

        <div className="min-w-0 space-y-5">
          <div className="rounded-2xl bg-brand-wash p-4 text-[13px] leading-relaxed text-brand-ink">
            <p className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"><Sparkles className="h-3.5 w-3.5" />In plain words</p>
            <p>{lead}</p>
          </div>
          <ul className="space-y-2.5">
            {rest.map((s, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />{s}
              </li>
            ))}
          </ul>

          {d.top_features.length > 0 && (
            <div>
              <p className="eyebrow mb-2">Strongest individual signals</p>
              <div className="overflow-hidden rounded-xl border border-hairline">
                {d.top_features.slice(0, 5).map((f) => (
                  <div key={f.feature} className="flex items-center justify-between gap-3 border-t border-hairline px-3 py-2 text-[12px] first:border-t-0">
                    <span className="min-w-0 truncate text-ink-2" title={f.group ? `${f.label} · ${f.group}` : f.label}>{f.label}{f.group && <span className="text-ink-3"> · {SHORT[f.group] ?? f.group}</span>}</span>
                    <span className="shrink-0 font-medium tnum">{factorLabel(f.factor)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 rounded-xl bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-3">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              <b className="font-semibold text-ink-2">What this shows.</b> SHAP (Shapley values) splits the model’s prediction exactly into the share each input is responsible for;
              they multiply back to the forecast. It explains the gradient-boosting member{d.gbm_weight != null && <> ({fmt.pct(d.gbm_weight)} of the ensemble weight)</>}.
              {d.ensemble_prediction != null && <> The ensemble you plan with expects <b className="font-semibold text-ink-2 tnum">{fmt.one(d.ensemble_prediction)}</b> units a week for the same weeks.</>}{" "}
              These are the model’s reasons, not proven causes, and related inputs (for example the seasonal baseline, which mixes level and season) share credit.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
