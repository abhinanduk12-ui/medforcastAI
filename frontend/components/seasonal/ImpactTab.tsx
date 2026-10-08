"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Card, CardHeader, ErrorState, Skeleton } from "@/components/ui";
import type { ForecastImpactResp, ImpactMed, ImpactRow } from "./types";
import {
  DIV, DataEndBar, Empty, Footnote, Key, Keys, MoreButton, Reading, TipShell, Tile,
  corrReading, niceDomain, sInr, sInt, weekSpan,
} from "./b-kit";

/* Series identity on this tab: forecast = ink, seasonal curves = C.s1, forecasting model (SHAP) = C.s2. */
const COL = { forecast: C.ink, curve: C.s1, model: C.s2 } as const;
const DAY = 86_400_000;
const CAT_TOP = 12;

type WeekRow = ForecastImpactResp["weekly"][number] & { i: number };

/* ───────────────── helpers ───────────────── */

/** Season's share of the forecast, as lift over the same forecast without the season. */
const liftPct = (forecast: number, season: number) => {
  const base = forecast - season;
  return base > 0 ? season / base : null;
};

function Direction({ v, size = "h-4 w-4" }: { v: number; size?: string }) {
  const r = Math.round(v);
  if (r > 0) return <ArrowUpRight className={size} style={{ color: DIV.posInk }} strokeWidth={2.2} aria-hidden />;
  if (r < 0) return <ArrowDownRight className={size} style={{ color: DIV.negInk }} strokeWidth={2.2} aria-hidden />;
  return <Minus className={`${size} text-ink-3`} aria-hidden />;
}

const dirWords = (v: number) => (Math.round(v) > 0 ? "Season adds demand" : Math.round(v) < 0 ? "Season lowers demand" : "No net seasonal effect");

/** One plain sentence describing how the curve-based effect moves across the window. */
function weeklyStory(rows: WeekRow[]): string | null {
  if (!rows.length) return null;
  const s = rows.map((r) => r.season_curve);
  const wk = (i: number) => fmt.week(rows[i].week);
  const maxI = s.indexOf(Math.max(...s));
  const minI = s.indexOf(Math.min(...s));
  if (s.every((v) => v >= 0)) return `By the curves, the season adds demand in every week of the window, most in the week of ${wk(maxI)} (${sInt(s[maxI])} units).`;
  if (s.every((v) => v <= 0)) return `By the curves, the season lowers demand in every week of the window, most in the week of ${wk(minI)} (${sInt(s[minI])} units).`;
  if (s[0] > 0) {
    const turn = s.findIndex((v) => v < 0);
    return `By the curves, the season still adds demand at the start of the window (${sInt(s[maxI])} units in the week of ${wk(maxI)}), turns negative from the week of ${wk(turn)}, and reaches ${sInt(s[minI])} units in the week of ${wk(minI)}.`;
  }
  const turn = s.findIndex((v) => v > 0);
  return `By the curves, the season lowers demand at the start of the window (${sInt(s[minI])} units in the week of ${wk(minI)}), turns positive from the week of ${wk(turn)}, and reaches ${sInt(s[maxI])} units in the week of ${wk(maxI)}.`;
}

/* ───────────────── weekly charts ───────────────── */

function WeeklyCharts({ rows, hasShap }: { rows: WeekRow[]; hasShap: boolean }) {
  const n = rows.length;
  const weeks = rows.map((r) => r.week);
  // Today's position on the week axis (fractional), shown only if it falls inside the window.
  const todayX = useMemo(() => {
    const t0 = new Date(`${weeks[0]}T00:00:00`).getTime();
    const x = (Date.now() - t0) / (7 * DAY);
    return x >= 0 && x <= n - 0.01 ? x : null;
  }, [weeks, n]);

  const level = useMemo(() => {
    const vals = rows.flatMap((r) => [r.forecast, r.without_curve, ...(hasShap && r.without_shap != null ? [r.without_shap] : [])]);
    return niceDomain(Math.min(...vals), Math.max(...vals), 4, 0.1);
  }, [rows, hasShap]);
  const effect = useMemo(() => {
    const vals = rows.flatMap((r) => [r.season_curve, ...(hasShap && r.season_shap != null ? [r.season_shap] : [])]);
    return niceDomain(Math.min(0, ...vals), Math.max(0, ...vals), 5, 0.05);
  }, [rows, hasShap]);

  const xAxis = (
    <XAxis dataKey="i" type="number" domain={[-0.5, n - 0.5]} ticks={rows.map((r) => r.i)} tickFormatter={(i: number) => (weeks[i] ? fmt.week(weeks[i]) : "")}
      tickLine={false} axisLine={{ stroke: C.axis }} interval="preserveStartEnd" minTickGap={14} allowDecimals={false} />
  );
  const today = todayX != null && (
    <ReferenceLine x={todayX} stroke={C.axis} strokeWidth={1}
      label={{ value: "Today", position: "insideTopLeft", fill: C.muted, fontSize: 11, dx: 4, dy: -2 }} />
  );

  return (
    <>
      <div className="px-3 pt-4 sm:px-4" role="img" aria-label="Store-wide forecast units per week, with and without the seasonal effect">
        <ResponsiveContainer width="100%" height={290}>
          <ComposedChart data={rows} margin={{ top: 14, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            {xAxis}
            <YAxis domain={level.domain} ticks={level.ticks} tickFormatter={(v: number) => fmt.int(v)} tickLine={false} axisLine={false} width={52} />
            {today}
            <Line dataKey="without_curve" stroke={COL.curve} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
            {hasShap && <Line dataKey="without_shap" stroke={COL.model} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />}
            <Line dataKey="forecast" stroke={COL.forecast} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
            <Tooltip
              cursor={{ stroke: C.axis, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as WeekRow;
                const lc = liftPct(p.forecast, p.season_curve), ls = p.season_shap != null ? liftPct(p.forecast, p.season_shap) : null;
                return (
                  <TipShell title={`Week of ${fmt.weekYear(p.week)}`} rows={[
                    { label: "Forecast", value: `${fmt.int(p.forecast)} units`, color: COL.forecast },
                    { label: "Without season · curves", value: fmt.int(p.without_curve), note: `season ${sInt(p.season_curve)}${lc != null ? ` (${fmt.signedPct(lc, 1)})` : ""}`, color: COL.curve, dash: true },
                    ...(hasShap && p.without_shap != null ? [{ label: "Without season · model", value: fmt.int(p.without_shap), note: `season ${sInt(p.season_shap)}${ls != null ? ` (${fmt.signedPct(ls, 1)})` : ""}`, color: COL.model, dash: true }] : []),
                  ]} />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 border-t border-hairline px-3 pt-4 sm:px-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 sm:px-2">
          <p className="text-[13px] font-medium text-ink">Season’s effect each week</p>
          <p className="text-[12px] text-ink-3">units per week · above 0 the season adds demand, below 0 it removes it</p>
        </div>
        <div role="img" aria-label="Seasonal effect in units per week, by the seasonal curves and by the forecasting model">
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={rows} margin={{ top: 12, right: 14, bottom: 0, left: 0 }} barGap={2} barCategoryGap="30%">
              <CartesianGrid vertical={false} />
              {xAxis}
              <YAxis domain={effect.domain} ticks={effect.ticks} tickFormatter={(v: number) => sInt(v)} tickLine={false} axisLine={false} width={52} />
              <ReferenceLine y={0} stroke={C.axis} />
              {today}
              <Bar dataKey="season_curve" fill={COL.curve} maxBarSize={14} shape={DataEndBar} isAnimationActive={false} />
              {hasShap && <Bar dataKey="season_shap" fill={COL.model} maxBarSize={14} shape={DataEndBar} isAnimationActive={false} />}
              <Tooltip
                cursor={{ fill: "rgba(11,11,11,0.04)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as WeekRow;
                  return (
                    <TipShell title={`Week of ${fmt.weekYear(p.week)}`} rows={[
                      { label: "Season · curves", value: `${sInt(p.season_curve)} units`, color: COL.curve, rect: true },
                      ...(hasShap && p.season_shap != null ? [{ label: "Season · model", value: `${sInt(p.season_shap)} units`, color: COL.model, rect: true }] : []),
                    ]} foot={`Forecast that week: ${fmt.int(p.forecast)} units`} />
                  );
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

/* ───────────────── category diverging list ───────────────── */

function CategoryImpact({ rows, hasShap }: { rows: ImpactRow[]; hasShap: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, CAT_TOP);
  const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.value_curve), hasShap ? Math.abs(r.value_shap ?? 0) : 0)));
  const pos = (v: number) => 50 + (v / max) * 50; // % from left; centre line = no seasonal effect
  const grid = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)_112px]";

  return (
    <div className="px-6 pb-6 pt-4">
      <Keys>
        <Key kind="rect" color={DIV.neg} label="Season lowers demand (curves)" />
        <Key kind="rect" color={DIV.pos} label="Season raises demand (curves)" />
        {hasShap && <Key kind="tick" color={C.ink} label="Forecasting model (SHAP)" />}
      </Keys>
      <ul id="impact-cats" className="mt-4 space-y-1">
        {shown.map((r) => {
          const left = Math.min(pos(r.value_curve), 50), width = Math.abs(pos(r.value_curve) - 50);
          const up = r.value_curve >= 0;
          const model = hasShap && r.value_shap != null ? r.value_shap : null;
          const tip = `${r.category}: ${sInr(r.value_curve)} (${sInt(r.season_curve)} units${r.share_curve != null ? `, ${fmt.signedPct(r.share_curve, 1)} of its forecast` : ""}) by the curves`
            + (model != null ? `; ${sInr(model)} (${sInt(r.season_shap)} units) by the model` : "") + ` · 12-week forecast ${fmt.int(r.forecast)} units`;
          return (
            <li key={r.category} title={tip} className={`${grid} gap-y-0.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2`}>
              <span className="truncate text-[13px] text-ink-2">{r.category}</span>
              <span className="order-2 text-right leading-tight sm:order-3">
                <span className="block text-[13px] font-medium text-ink tnum">{sInr(r.value_curve)}</span>
                {model != null && <span className="block text-[11px] text-ink-3 tnum">model {sInr(model)}</span>}
              </span>
              <div className="relative order-3 col-span-2 h-5 sm:order-2 sm:col-span-1 sm:h-6" aria-hidden>
                <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: DIV.mid }} />
                {width > 0.05 && (
                  <div className="absolute inset-y-[6px]" style={{
                    left: `${left}%`, width: `max(${width}%, 2px)`, background: up ? DIV.pos : DIV.neg,
                    borderRadius: up ? "0 4px 4px 0" : "4px 0 0 4px",
                  }} />
                )}
                {model != null && (
                  <div className="absolute inset-y-[2px] w-[3px] -translate-x-1/2 rounded-full ring-2 ring-white" style={{ left: `${pos(model)}%`, background: C.ink }} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {/* scale */}
      <div className={`${grid} mt-1 px-2 text-[11px] text-muted`}>
        <span className="hidden sm:block" />
        <div className="order-3 col-span-2 flex justify-between tnum sm:order-2 sm:col-span-1">
          <span>{sInr(-max)}</span><span>0</span><span>{sInr(max)}</span>
        </div>
        <span className="order-2 hidden sm:order-3 sm:block" />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-ink-3">
          Seasonal ₹ over the 12 weeks at selling price, sorted by size{rows.length > CAT_TOP && !all ? `; ${CAT_TOP} of ${rows.length} categories shown` : ""}.
        </p>
        {rows.length > CAT_TOP && (
          <MoreButton open={all} onClick={() => setAll((v) => !v)} more={`Show all ${rows.length}`} less={`Show top ${CAT_TOP}`} controls="impact-cats" />
        )}
      </div>
    </div>
  );
}

/* ───────────────── medicine tables ───────────────── */

function MedTable({ rows, hasShap, kind }: { rows: ImpactMed[]; hasShap: boolean; kind: "up" | "down" }) {
  if (!rows.length) {
    return <Empty title={kind === "up" ? "No medicine gains from the season" : "No medicine loses from the season"}>Over these 12 weeks the curves put every medicine at or {kind === "up" ? "below" : "above"} its average-week level.</Empty>;
  }
  return (
    <div className="overflow-x-auto px-2 pb-2">
      <table className="w-full min-w-[440px] text-[13px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-ink-3">
            <th scope="col" rowSpan={2} className="pb-2 pl-4 pr-2 pt-1 text-left align-bottom font-medium">Medicine</th>
            <th scope="col" rowSpan={2} className="px-2 pb-2 pt-1 text-right align-bottom font-medium" title="Ensemble forecast, units over the 12 weeks">Forecast</th>
            <th scope="colgroup" colSpan={hasShap ? 2 : 1} className="px-2 pt-1 font-medium">
              <span className="block border-b border-hairline pb-1 text-center">Seasonal units</span>
            </th>
            <th scope="col" rowSpan={2} className="pb-2 pl-2 pr-4 pt-1 text-right align-bottom font-medium" title="Curve-based seasonal units × median selling price">Value</th>
          </tr>
          <tr className="text-[11px] uppercase tracking-wider text-ink-3">
            <th scope="col" className="px-2 pb-2 pt-1.5 text-right font-medium" title="By the seasonal curves; % = lift over the same forecast without the season">Curves</th>
            {hasShap && <th scope="col" className="px-2 pb-2 pt-1.5 text-right font-medium" title="By the forecasting model's own SHAP season effect">Model</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const lift = liftPct(m.forecast, m.season_curve);
            const disagree = hasShap && m.season_shap != null && Math.abs(m.season_shap) >= 1 && Math.sign(m.season_shap) !== Math.sign(m.season_curve);
            return (
              <tr key={m.medicine_id} className="border-t border-hairline align-top transition-colors hover:bg-surface-2">
                <td className="max-w-[160px] py-2.5 pl-4 pr-2 sm:max-w-[230px]">
                  <Link href={`/medicines/${m.medicine_id}`} className="focus-ring block rounded">
                    <span className="block truncate font-medium hover:underline">{m.medicine_name}</span>
                    <span className="block truncate text-[12px] text-ink-3">{m.category}</span>
                  </Link>
                </td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right tnum text-ink-2">{fmt.int(m.forecast)}</td>
                <td className="whitespace-nowrap px-2 py-2.5 text-right">
                  <span className="inline-flex items-center gap-1 font-medium tnum"><Direction v={m.season_curve} size="h-3.5 w-3.5" />{sInt(m.season_curve)}</span>
                  {lift != null && <span className="block text-[11px] text-ink-3 tnum" title="Lift over the same forecast without the season">{fmt.signedPct(lift, 0)}</span>}
                </td>
                {hasShap && (
                  <td className="whitespace-nowrap px-2 py-2.5 text-right tnum text-ink-2">
                    {sInt(m.season_shap)}
                    {disagree && (
                      <span className="block text-[11px] text-ink-3" title="The forecasting model's season effect points the other way for this medicine">≠ opposite</span>
                    )}
                  </td>
                )}
                <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right font-medium tnum">{sInr(m.value_curve)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────── tab ───────────────── */

function ImpactSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-full max-w-2xl" />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      <Skeleton className="h-[560px]" />
      <Skeleton className="h-[460px]" />
    </div>
  );
}

export default function ImpactTab() {
  const { data, error, loading } = useApi<ForecastImpactResp>("/api/seasonal/forecast-impact");
  const rows = useMemo<WeekRow[]>(() => (data?.weekly ?? []).map((w, i) => ({ ...w, i })), [data]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) return <ImpactSkeleton />;

  const t = data.totals;
  const hasShap = data.has_shap && t.season_shap != null;
  const weeks = data.weeks.length ? data.weeks : rows.map((r) => r.week);
  const span = weekSpan(weeks);
  const shareCurve = t.forecast > 0 ? t.season_curve / t.forecast : null;
  const shareModel = hasShap && t.forecast > 0 && t.season_shap != null ? t.season_shap / t.forecast : null;
  const agree = hasShap ? corrReading(t.agreement_corr) : null;
  const story = weeklyStory(rows);
  const pastWeeks = weeks.filter((w) => new Date(`${w}T00:00:00`).getTime() + 7 * DAY <= Date.now()).length;
  const sameDir = hasShap && t.season_shap != null && Math.sign(Math.round(t.season_shap)) === Math.sign(Math.round(t.season_curve));

  if (!rows.length) {
    return <Card><Empty title="No forecast loaded yet">The seasonal effect is measured on the 12-week forecast. Train or load the models on the Data &amp; models page, then come back here.</Empty></Card>;
  }

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <p className="rise mb-6 max-w-3xl text-[13px] leading-relaxed text-ink-2">
        How much of the 12-week forecast (weeks of {span}) comes from the time of year, measured two independent ways:
        by this page’s <b className="font-semibold text-ink">seasonal curves</b>, and by the forecasting model’s own
        <b className="font-semibold text-ink"> SHAP season effect</b>{hasShap ? "" : " (not available for the current model, so only the curve view is shown)"}.
        A negative effect means the season pulls demand below an average week of the year.
      </p>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile label="12-week forecast" value={fmt.int(t.forecast)} unit="units" delay={20}>
          All medicines, weeks of {span}.
        </Tile>
        <Tile label="Seasonal effect · curves" value={sInt(t.season_curve)} unit="units" delay={40} icon={<Direction v={t.season_curve} />}>
          <span className="font-medium text-ink">{sInr(t.value_curve)}</span> at selling price
          {shareCurve != null && <> · {fmt.signedPct(shareCurve, 1)} of the forecast</>}
          <span className="block">{dirWords(t.season_curve)} over the 12 weeks</span>
        </Tile>
        <Tile label="Seasonal effect · model (SHAP)" value={hasShap ? sInt(t.season_shap) : "—"} unit={hasShap ? "units" : undefined} delay={60}
          icon={hasShap && t.season_shap != null ? <Direction v={t.season_shap} /> : undefined}>
          {hasShap ? (
            <>
              <span className="font-medium text-ink">{sInr(t.value_shap)}</span> at selling price
              {shareModel != null && <> · {fmt.signedPct(shareModel, 1)} of the forecast</>}
              {t.season_shap != null && <span className="block">{dirWords(t.season_shap)} over the 12 weeks</span>}
            </>
          ) : "The model’s SHAP explanation file is not available, so only the curve view is shown."}
        </Tile>
        <Tile label="Agreement between the two" delay={80}
          value={hasShap && t.agreement_corr != null ? (
            <span className="inline-flex items-center gap-2.5">
              {t.agreement_corr.toFixed(2)}
              {agree && <Reading level={agree.level} label={agree.label} title="Correlation of the two estimates across medicines: above 0.6 strong, 0.3–0.6 moderate, below 0.3 weak" />}
            </span>
          ) : "—"}>
          {hasShap && t.agreement_corr != null ? (
            <>
              Correlation of the two estimates across medicines.{" "}
              {agree?.level === 3 ? "They largely tell the same story." : agree?.level === 2 ? "Same broad direction, different sizes for many medicines." : agree?.level === 1 ? "They often disagree medicine by medicine; trust categories more than single items." : "They point in opposite directions; treat single-medicine effects as unreliable."}
            </>
          ) : "Needs the model’s SHAP season effect."}
        </Tile>
      </div>

      <Card className="mt-6" delay={100}>
        <CardHeader title="Weekly forecast, with and without the season"
          sub="Store-wide units per week. The gap between the solid forecast and a dashed line is the season’s effect that week."
          right={<div className="w-full lg:w-auto"><Keys>
            <Key kind="line" color={COL.forecast} label="Forecast" />
            <Key kind="dash" color={COL.curve} label="Without season · curves" />
            {hasShap && <Key kind="dash" color={COL.model} label="Without season · model" />}
          </Keys></div>} />
        <WeeklyCharts rows={rows} hasShap={hasShap} />
        <div className="space-y-2 border-t border-hairline bg-surface-2 px-6 py-4 text-[13px] leading-relaxed text-ink-2" style={{ borderRadius: "0 0 19px 19px" }}>
          {story && <p>{story}</p>}
          {hasShap && t.season_shap != null && (
            <p className="text-ink-3">
              {sameDir
                ? `Both methods agree on the direction over the whole window (${sInt(t.season_curve)} vs ${sInt(t.season_shap)} units); the model attributes ${Math.abs(t.season_shap) > Math.abs(t.season_curve) ? "a larger" : "a smaller"} share to the season.`
                : `The two methods disagree on the net direction over the window (${sInt(t.season_curve)} by the curves vs ${sInt(t.season_shap)} by the model), so the net effect is uncertain.`}
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-6" delay={130}>
        <CardHeader title="Where the season’s effect lands, by category"
          sub="Seasonal contribution in ₹ over the 12 weeks. Bars extend left when the season lowers a category’s demand and right when it raises it." />
        {data.categories.length
          ? <CategoryImpact rows={data.categories} hasShap={hasShap} />
          : <Empty title="No categories in the forecast" />}
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card delay={160}>
          <CardHeader title="Season lifts most" sub="Largest seasonal gain over the 12 weeks by the curves; % = lift over the same forecast without the season"
            right={<TrendingUp className="h-5 w-5" style={{ color: DIV.posInk }} aria-hidden />} />
          <div className="pt-3"><MedTable rows={data.top_up} hasShap={hasShap} kind="up" /></div>
        </Card>
        <Card delay={180}>
          <CardHeader title="Season lowers most" sub="Largest seasonal drop over the 12 weeks by the curves; % = change against the same forecast without the season"
            right={<TrendingDown className="h-5 w-5" style={{ color: DIV.negInk }} aria-hidden />} />
          <div className="pt-3"><MedTable rows={data.top_down} hasShap={hasShap} kind="down" /></div>
        </Card>
      </div>

      <Card className="mt-6 px-6 py-5" delay={200}>
        <div className="space-y-2">
          <Footnote>{data.note}</Footnote>
          <Footnote>
            “Without the season” is the same forecast divided by that week’s seasonal multiplier, i.e. what the medicines would sell in an average week of the year.
            Values are units × each medicine’s median selling price.{hasShap ? " “≠ opposite” marks medicines where the model’s season effect points the other way." : ""}
          </Footnote>
          {pastWeeks > 0 && (
            <Footnote>
              The forecast starts the week after the last loaded sales week, so its first {pastWeeks} {pastWeeks === 1 ? "week is" : "weeks are"} already in the past.
              Load newer sales on the Data &amp; models page to roll the window forward.
            </Footnote>
          )}
        </div>
      </Card>
    </div>
  );
}
