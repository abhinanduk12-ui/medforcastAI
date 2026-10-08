"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Link2, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, Skeleton, StatTile } from "@/components/ui";
import { ControlPanel, PresetRow } from "@/components/simulator/Controls";
import { CategoryImpact, ImpactTable, ScenarioChart } from "@/components/simulator/Results";
import { Assumptions } from "@/components/simulator/Assumptions";
import { DEFAULTS, fromQuery, toQuery, type OutbreakType, type Params, type Preset, type PresetsResp, type SimResp } from "@/components/simulator/model";

/** Debounced POST to the simulator. Keeps the previous result on screen while a new one loads. */
function useSimulation(params: Params, delay = 250) {
  const [data, setData] = useState<SimResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const body = JSON.stringify(params);
  useEffect(() => {
    const ctrl = new AbortController();
    setPending(true);
    const t = setTimeout(() => {
      fetch("/api/scenarios/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctrl.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.json() as Promise<SimResp>;
        })
        .then((d) => { setData(d); setError(null); setPending(false); })
        .catch((e) => { if (e.name !== "AbortError") { setError(String(e.message ?? e)); setPending(false); } });
    }, delay);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [body, delay]);
  return { data, error, pending };
}

/** Copies a link built from the current params (the address bar lags behind by the URL debounce).
 *  Falls back to a hidden textarea where the async clipboard API is unavailable (plain http on a LAN IP). */
function ShareButton({ qs }: { qs: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = (s: "copied" | "failed") => {
    setState(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };
  const copy = () => {
    const url = `${window.location.origin}/simulator${qs ? `?${qs}` : ""}`;
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = url; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        flash(ok ? "copied" : "failed");
      } catch { flash("failed"); }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => flash("copied"), legacy);
    else legacy();
  };
  return (
    <button onClick={copy} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-hairline bg-surface px-4 py-2.5 text-[13px] font-medium text-ink shadow-sm transition hover:bg-sunken">
      {state === "copied" ? <Check className="h-4 w-4 text-good" /> : <Link2 className="h-4 w-4" />}
      <span aria-live="polite">{state === "copied" ? "Link copied" : state === "failed" ? "Copy the address bar" : "Copy share link"}</span>
    </button>
  );
}

function SimulatorInner() {
  const search = useSearchParams();
  const router = useRouter();
  const [params, setParams] = useState<Params>(() => fromQuery(new URLSearchParams(search.toString())));
  const set = (p: Partial<Params>) => setParams((x) => ({ ...x, ...p }));
  const { data: pre, error: preErr } = useApi<PresetsResp>("/api/scenarios/presets");
  const { data, error, pending } = useSimulation(params);

  // Mirror state into the URL (debounced) so any scenario can be shared or bookmarked.
  const qs = toQuery(params);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => router.replace(qs ? `/simulator?${qs}` : "/simulator", { scroll: false }), 300);
    return () => clearTimeout(t);
  }, [qs, router]);

  const summaries = useMemo(() => {
    const out: Partial<Record<OutbreakType, string>> = {};
    pre?.outbreak_types.forEach((o) => { out[o.type] = o.summary; });
    return out;
  }, [pre]);

  const pick = (p: Preset) => set({ ...p.params, outbreaks: p.params.outbreaks.map((o) => ({ ...o })) });
  const reset = () => setParams({ ...DEFAULTS, horizon: params.horizon, lead_time: params.lead_time, review: params.review, service: params.service, rank_by: params.rank_by });

  if (preErr && !data) return <ErrorState error={preErr} />;
  if (error && !data) return <ErrorState error={error} />;

  const s = data?.summary;
  const start = data?.horizon_weeks[0], end = data?.horizon_weeks[data.horizon_weeks.length - 1];

  return (
    <>
      <PageHeader eyebrow="Scenario Lab" title="What if the season turns?"
        actions={<>
          <button onClick={reset} className="focus-ring inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium text-ink-2 transition hover:bg-sunken hover:text-ink"><RotateCcw className="h-4 w-4" /> Reset</button>
          <ShareButton qs={qs} />
        </>}>
        Stress-test the {params.horizon}-week ensemble forecast. Change how strong the season is, add an outbreak or a price change, and see how
        demand, revenue and stock needs shift. The panel also shows which medicines would run out if you kept to today&apos;s stock plan.
      </PageHeader>

      <PresetRow presets={pre?.presets ?? null} error={preErr} params={params} onPick={pick} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        {/* Controls */}
        <div className="min-w-0">
          {/* Sticks below the 64px app header; scrolls internally when several outbreaks make it taller than the viewport */}
          <Card className="xl:sticky xl:top-[88px] xl:max-h-[calc(100vh-112px)] xl:overflow-y-auto" delay={60}>
            <div className="flex items-center justify-between px-5 pt-5">
              <h2 className="text-[15px] font-semibold tracking-tight">Scenario controls</h2>
              <span className={`inline-flex items-center gap-1.5 text-[12px] text-ink-3 transition-opacity ${pending ? "opacity-100" : "opacity-0"}`} aria-hidden>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Simulating
              </span>
              <span className="sr-only" role="status">{pending ? "Simulating" : data ? "Results updated" : ""}</span>
            </div>
            <ControlPanel params={params} set={set} summaries={summaries} weeks={pre?.weeks ?? data?.horizon_weeks ?? []} />
          </Card>
        </div>

        {/* Results */}
        <div className={`min-w-0 space-y-6 transition-opacity duration-300 ${pending && data ? "opacity-70" : ""}`} aria-busy={pending}>
          {error && data && (
            <p className="flex items-start gap-2 rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px] text-ink-2">
              <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-critical" strokeWidth={2.2} />
              <span><b className="font-semibold text-ink">Update failed</b> ({error}). Showing the previous result.</span>
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 2xl:grid-cols-4">
            {s ? (
              <>
                <StatTile label={`Demand, next ${params.horizon} weeks`} value={`${fmt.compact(s.scenario_units)} units`}
                  deltaLabel={`${fmt.signedPct(s.pct, 1)} vs baseline ${fmt.compact(s.baseline_units)}`} />
                <StatTile label="Sales at scenario prices" value={fmt.inr(s.scenario_revenue)}
                  deltaLabel={`${fmt.signedPct(s.baseline_revenue > 0 ? s.scenario_revenue / s.baseline_revenue - 1 : 0, 1)} vs ${fmt.inr(s.baseline_revenue)}`} />
                <StatTile label="Extra stock to hold" value={fmt.inr(s.extra_stock_value)}
                  deltaLabel={`${fmt.int(s.extra_stock_units)} units at peak${s.freed_stock_value > 0 ? ` · ${fmt.inr(s.freed_stock_value)} can be released` : ""}`} />
                <StatTile label={`Medicines over ${fmt.pct(s.risk_threshold)} stockout risk`} value={fmt.int(s.at_risk)}
                  deltaLabel={s.at_risk === s.at_risk_baseline ? "on the baseline plan, no change" : `on the baseline plan (baseline: ${s.at_risk_baseline})`} />
              </>
            ) : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
          </div>

          <Card delay={90}>
            <CardHeader title="Weekly store demand"
              sub={start && end ? `All medicines, week of ${fmt.week(start)} to ${fmt.weekYear(end)}. The forecast window begins the week after the sales data ends.` : "All medicines"} />
            <div className="px-3 pb-5 pt-2 sm:px-5">
              {data ? <ScenarioChart series={data.series} /> : <Skeleton className="h-[320px]" />}
            </div>
          </Card>

          <Card delay={120}>
            <CardHeader title="Impact by category" sub={`Change in units over ${params.horizon} weeks vs the baseline forecast, with the ₹ change at scenario prices.`} />
            <div className="px-6 pb-6 pt-4">{data ? <CategoryImpact rows={data.categories} /> : <Skeleton className="h-64" />}</div>
          </Card>

          <Card className="overflow-hidden" delay={150}>
            <CardHeader title="Most-impacted medicines" sub="Top 15, with the scenario-adjusted order-up-to level and the stockout risk if you don't adjust." />
            {data ? <ImpactTable data={data} rankBy={params.rank_by} setRankBy={(r) => set({ rank_by: r })} /> : <Skeleton className="mx-6 my-6 h-72" />}
          </Card>

          <Card delay={180}>
            <CardHeader title="Assumptions applied" sub="Exactly what this simulation changed. Every number above comes from these multipliers applied to the model's forecast." />
            <div className="pt-2">{data ? <Assumptions a={data.assumptions} /> : <Skeleton className="mx-6 my-6 h-48" />}</div>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function SimulatorPage() {
  return <Suspense fallback={<PageSkeleton />}><SimulatorInner /></Suspense>;
}
