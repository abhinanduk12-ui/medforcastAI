"use client";

import { useEffect, useRef, useState } from "react";
import { CloudRain, Droplets, Info, RefreshCw, Siren, Umbrella } from "lucide-react";
import { apiPost, ApiError, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, Skeleton } from "@/components/ui";
import { LicenceNotice, StatusStrip } from "@/components/signals/StatusStrip";
import { RainChart, SeasonalOutlook } from "@/components/signals/RainChart";
import { DiseasePanels } from "@/components/signals/DiseasePanels";
import { WatchList } from "@/components/signals/WatchList";
import { EvidenceCard } from "@/components/signals/EvidenceCard";
import { ManualData } from "@/components/signals/ManualData";
import { ago, dayFmt, LEVEL, ordinal, type DiseaseResp, type EvidenceResp, type StatusResp, type WatchResp, type WeatherResp } from "@/components/signals/model";

const NO_STORE = { refetchOnStoreChange: false };

export default function SignalsPage() {
  const status = useApi<StatusResp>("/api/signals/status", NO_STORE);
  const weather = useApi<WeatherResp>("/api/signals/weather?weeks=26", NO_STORE);
  const disease = useApi<DiseaseResp>("/api/signals/disease", NO_STORE);
  const watch = useApi<WatchResp>("/api/signals/watch", NO_STORE);
  const evidence = useApi<EvidenceResp>("/api/signals/evidence", NO_STORE);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // A refresh runs in a background thread that may not have flagged itself as running when the
  // first status poll returns, so wait for a run that started after `since` to finish instead.
  const [awaiting, setAwaiting] = useState(false);
  const since = useRef<{ started: string | null; at: number }>({ started: null, at: 0 });

  const reloadAll = () => { status.reload(); weather.reload(); disease.reload(); watch.reload(); evidence.reload(); };
  const reloadDisease = () => { disease.reload(); watch.reload(); status.reload(); };

  const rs = status.data?.refresh;
  const running = !!rs?.running;
  const polling = running || awaiting;

  // Poll the status every 2.5 s while a refresh is running or expected.
  useEffect(() => {
    if (!polling || status.loading) return;
    const t = setTimeout(status.reload, 2500);
    return () => clearTimeout(t);
  }, [polling, status.loading, status.reload]);

  // A run started elsewhere (scheduler, another user): follow it too, so the page reloads when it ends.
  useEffect(() => {
    if (running && !awaiting) { since.current = { started: null, at: Date.now() }; setAwaiting(true); }
  }, [running, awaiting]);

  useEffect(() => {
    if (!awaiting || !rs || rs.running) return;
    const finished = rs.started_at != null && rs.started_at !== since.current.started && rs.finished_at != null;
    const timedOut = Date.now() - since.current.at > 10 * 60 * 1000;
    if (!finished && !timedOut) return;
    setAwaiting(false);
    if (timedOut && !finished) { setRefreshMsg("Still waiting for the refresh to report back. Reload the page later."); return; }
    const failed = Object.entries(rs.results ?? {}).filter(([, v]) => typeof v === "string" && v.startsWith("error")).map(([k]) => k);
    setRefreshMsg(rs.error ? `Refresh failed: ${rs.error}`
      : failed.length ? `Refresh finished; ${failed.length} source(s) could not be reached and keep their last cached data.`
      : "Refresh finished.");
    weather.reload(); disease.reload(); watch.reload(); evidence.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting, rs]);

  const refresh = async () => {
    setRefreshMsg(null); setStarting(true);
    since.current = { started: rs?.started_at ?? null, at: Date.now() };
    try {
      const r = await apiPost<{ started: boolean; message: string }>("/api/signals/refresh", { parts: ["weather", "disease"] });
      setRefreshMsg(r.message);
      if (!r.started) since.current = { started: null, at: Date.now() };   // follow the run already in progress
      setAwaiting(true);
      status.reload();
    } catch (e) { setRefreshMsg((e as ApiError).message); }
    finally { setStarting(false); }
  };
  const busy = starting || polling;

  if (status.error && !status.data) return <ErrorState error={status.error} />;
  if (!status.data) return <PageSkeleton />;
  const st = status.data;
  const w = weather.data, n16 = w?.forecast.next16 ?? null;
  const ekmWatch = watch.data?.items.filter((i) => i.kind === "disease" && i.district === "EKM") ?? [];
  const top = ekmWatch[0];
  const ev = evidence.data;
  const evClaim = !ev ? "Whether weather adds predictive power on this shop's data is tested below."
    : !ev.available ? "Whether weather adds predictive power is tested below once rainfall history is cached."
    : ev.verdict === "none" ? "On this shop's data, weather adds no measurable predictive power (see the evidence below)."
    : "On this shop's data, weather adds a small supported signal for a few categories only (see the evidence below).";

  return (
    <>
      <PageHeader eyebrow="Early warning" title="Weather and outbreak signals"
        actions={st.can_refresh ? (
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <button onClick={refresh} disabled={busy} aria-busy={busy} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white transition hover:bg-[#262624] disabled:opacity-60">
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />{busy ? "Refreshing…" : "Refresh sources"}
            </button>
            <span className="text-[11.5px] text-ink-3" aria-live="polite">{busy ? st.refresh.progress ?? "Working in the background; cached data stays visible" : refreshMsg ?? (st.autofetch ? "Auto-refresh: daily" : "Auto-refresh is off")}</span>
          </div>
        ) : <span className="text-[12px] text-ink-3">{st.autofetch ? "Sources refresh automatically each day" : "Auto-refresh is off"}</span>}>
        Rain around {st.place} and communicable-disease reports from the Kerala health department, read as early hints of demand.
        They are context for the forecast, not inputs to it. {evClaim}
      </PageHeader>

      <StatusStrip status={st} />
      <LicenceNotice status={st} onChanged={reloadAll} />

      {/* Headline tiles */}
      <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile icon={Umbrella} label={`Rain next ${n16?.days ?? 16} days`} value={n16 ? `${Math.round(n16.total_mm)} mm` : "—"}
          sub={n16 ? `${n16.outlook ?? "no normal"}${n16.anomaly_pct != null ? ` · ${fmt.signedPct(n16.anomaly_pct)} vs normal ${Math.round(n16.clim_mean ?? 0)} mm` : ""}` : (w?.forecast.reason ? "Forecast switched off" : "No forecast cached")} />
        <Tile icon={CloudRain} label="Heavy-rain days ahead" value={n16 ? `${n16.heavy_days}` : "—"}
          sub={n16 ? `days ≥ ${w!.observed.heavy_rain_mm} mm · ${n16.wet_days} wet days forecast` : "—"} />
        <Tile icon={Droplets} label="Last full week observed" value={w?.observed.weeks.length ? `${Math.round(w.observed.weeks[w.observed.weeks.length - 1].rain_mm)} mm` : "—"}
          sub={w?.observed.weeks.length ? (() => { const l = w.observed.weeks[w.observed.weeks.length - 1]; return `week of ${dayFmt(l.week)} · ${l.percentile != null ? `${ordinal(Math.min(99, Math.max(1, l.percentile * 100)))} percentile for the time of year` : "no normal to compare"}`; })() : "—"} />
        <Tile icon={Siren} label="Ernakulam disease watch" value={watch.data ? `${ekmWatch.length}` : "—"}
          sub={watch.error && !watch.data ? "Watch list unavailable" : !watch.data ? "Loading" : top ? `${LEVEL[top.level].label}: ${top.title}`
            : watch.data.as_of ? `Nothing above its recent baseline · reports to ${dayFmt(watch.data.as_of)}` : "No disease reports yet"} />
      </div>

      {/* Watch list */}
      <section className="mt-8" aria-labelledby="watch-h">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 id="watch-h" className="text-[18px] font-semibold tracking-tight">Watch list</h2>
          {watch.data && <p className="max-w-xl text-[12px] text-ink-3">{watch.data.rule_note} Scenario Lab links open the matching outbreak preset from the current forecast week.</p>}
        </div>
        {watch.error && !watch.data ? <p className="card p-5 text-[13px] text-ink-3">Watch list unavailable: {watch.error}</p> : !watch.data ? <Skeleton className="h-48" /> : <WatchList data={watch.data} />}
      </section>

      {/* Weather */}
      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card delay={60}>
          <CardHeader title="Weekly rainfall vs normal"
            sub={w ? <>Kochi · observed to {w.observed.last_date ? dayFmt(w.observed.last_date) : "—"}{w.observed.lag_days != null ? ` (${w.observed.lag_days}-day lag)` : ""}{w.forecast.available ? ` · forecast fetched ${ago(w.forecast.fetched_at)}` : ""}</> : "Loading"}
            right={w?.observed.stale || w?.forecast.stale ? <span className="text-[12px] text-ink-3">Some data is stale</span> : undefined} />
          <div className="px-4 pb-5 pt-3 sm:px-6">
            {weather.error && !w ? <p className="py-10 text-center text-[13px] text-ink-3">{weather.error}</p>
              : !w ? <Skeleton className="h-[300px]" />
              : w.chart.length === 0 ? <p className="py-10 text-center text-[13px] text-ink-3">No rainfall cached yet. {st.can_refresh ? "Use Refresh sources." : "Ask an owner or buyer to refresh."}</p>
              : <RainChart data={w.chart} />}
            {w && !w.forecast.available && w.forecast.reason && <p className="mt-3 flex gap-2 text-[12px] text-ink-3"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{w.forecast.reason}</p>}
            {w && <p className="mt-3 text-[11.5px] leading-relaxed text-muted">
              Observed weeks are compared with NASA POWER&apos;s own 1991–2020 climate; forecast weeks with Open-Meteo ERA5 1991–2020, so each anomaly uses one source.
              Normal = weeks around the same date in 30 years. Forecast bars that cover fewer than 7 days are partial.
            </p>}
          </div>
        </Card>
        <Card delay={100}>
          <CardHeader title="Seasonal outlook" sub="Monthly rain as % of normal, next 6 months" />
          <div className="px-4 pb-5 pt-3 sm:px-6">
            {weather.error && !w ? <p className="py-8 text-center text-[13px] text-ink-3">{weather.error}</p>
              : !w ? <Skeleton className="h-[260px]" />
              : !w.seasonal.available ? <p className="py-8 text-center text-[13px] text-ink-3">{w.seasonal.reason ?? "No seasonal outlook cached yet."}</p>
              : <>
                  <SeasonalOutlook months={w.seasonal.months} />
                  <p className="mt-4 text-[11.5px] leading-relaxed text-muted">{w.seasonal.caveat} Normal = ERA5 1991–2020 for the same days.</p>
                </>}
          </div>
        </Card>
      </div>

      {/* Disease */}
      <Card className="mt-8" delay={120}>
        <CardHeader title="Disease reports"
          sub={disease.data ? <>DHS Kerala IDSP daily reports · {disease.data.reports.ok} days validated (districts must sum to the state total){disease.data.stale ? " · latest report is more than 3 days old" : ""}</> : "Loading"} />
        {disease.error && !disease.data ? <p className="p-6 text-[13px] text-ink-3">{disease.error}</p> : !disease.data ? <div className="p-6"><Skeleton className="h-48" /></div> : <DiseasePanels data={disease.data} />}
        {disease.data && (
          <p className="px-6 pb-5 text-[11.5px] leading-relaxed text-muted">
            {disease.data.method.z}. Levels: watch ({disease.data.method.levels.watch}), elevated ({disease.data.method.levels.elevated}), high ({disease.data.method.levels.high}); {disease.data.method.min_cases}.
            The baseline is the last 12 weeks, not the same season last year, so normal seasonal rises can show as a watch. Reports are provisional and may be revised by DHS.
          </p>
        )}
      </Card>

      {/* Evidence */}
      <Card className="mt-8" delay={140}>
        <CardHeader title="Does weather predict this shop's demand?" sub="Lagged rainfall anomaly vs demand left over after the seasonal index, per category" />
        {evidence.error && !evidence.data ? <p className="p-6 text-[13px] text-ink-3">{evidence.error}</p> : !evidence.data ? <div className="p-6"><Skeleton className="h-40" /></div> : <EvidenceCard data={evidence.data} />}
      </Card>

      {/* Manual data */}
      <Card className="mt-8" delay={160}>
        <CardHeader title="Add or correct disease counts"
          sub="For days the automatic reader could not validate, or numbers from other bulletins. Manual entries are labelled and override automatic values for the same day." />
        {disease.data ? <ManualData data={disease.data} today={st.today} canUpload={st.can_upload} onSaved={reloadDisease} />
          : disease.error ? <p className="p-6 text-[13px] text-ink-3">Manual entry is unavailable while disease data cannot be loaded: {disease.error}</p>
          : <div className="p-6"><Skeleton className="h-40" /></div>}
      </Card>

      <p className="mt-6 text-[12px] leading-relaxed text-ink-3">{st.simulated_branches_note} Signals inform stock checks only; clinical advice, substitutions and prescription items remain the pharmacist&apos;s and prescriber&apos;s decision.</p>
    </>
  );
}

function Tile({ icon: Icon, label, value, sub }: { icon: typeof CloudRain; label: string; value: string; sub: string }) {
  return (
    <div className="card rise flex min-w-0 flex-col p-5">
      <p className="inline-flex items-center gap-1.5 text-[13px] text-ink-3"><Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />{label}</p>
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.02em] tnum">{value}</p>
      <p className="mt-3 text-[12px] leading-snug text-ink-3">{sub}</p>
    </div>
  );
}
