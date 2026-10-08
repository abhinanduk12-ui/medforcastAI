"use client";

import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Check } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C, Columns } from "@/components/charts";
import { Card, CardHeader, ErrorState, Skeleton } from "@/components/ui";
import type { CurveSummary, EvidenceResp, SeasonalClass } from "./types";
import {
  ClassChip, DIV, DataEndBar, Empty, Footnote, Key, Keys, MoreButton, NumberedList, RAIN, TipShell, Tile, haloLineEnd, qText, sDec,
} from "./b-kit";

const CAT_FIRST = 12;
const YOY_FIRST = 16;
const YOY_BAND = 0.15;       // within ±15% = consistent
const LOW_VOLUME = 10;       // under 10 units a week, a year-on-year change is mostly noise
const QUIET: SeasonalClass[] = ["Steady", "Possible pattern (weak evidence)"];
const NULL_LABEL = haloLineEnd("if nothing were seasonal");

/* ───────────────── p-value histogram ───────────────── */

type Bin = { label: string; lo: number; hi: number; n: number };

function PHistogram({ hist, expected, fdrQ, summary }: { hist: number[]; expected: number; fdrQ: number; summary: EvidenceResp["summary"] }) {
  const bins: Bin[] = hist.map((n, i) => ({ label: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, lo: i / 10, hi: (i + 1) / 10, n }));
  const total = hist.reduce((a, b) => a + b, 0);
  const max = Math.max(expected, ...hist);
  const step = max > 60 ? 20 : max > 30 ? 10 : 5;
  const top = Math.ceil((max * 1.08) / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // Storey's estimate of the share of true nulls from p-values above 0.5 (flat region).
  const above = hist.slice(5).reduce((a, b) => a + b, 0);
  const pi0 = total > 0 ? Math.min(1, above / (0.5 * total)) : 1;
  const signal = 1 - pi0;
  const first = hist[0] ?? 0;
  const ratio = expected > 0 ? first / expected : null;

  return (
    <div className="grid gap-6 px-6 pb-6 pt-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">
        <div className="-mx-2" role="img" aria-label={`Histogram of ${total} medicine p-values in ten bands: ${bins.map((b) => `${b.label}: ${b.n}`).join(", ")}. A flat histogram would hold ${fmt.one(expected)} per band.`}>
          <ResponsiveContainer width="100%" height={270}>
            <BarChart data={bins} margin={{ top: 22, right: 10, bottom: 0, left: 0 }} barCategoryGap="18%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: C.axis }} interval="preserveStartEnd" minTickGap={6} tick={{ fontSize: 10 }} />
              <YAxis domain={[0, top]} ticks={ticks} allowDecimals={false} tickLine={false} axisLine={false} width={36} />
              <Bar dataKey="n" fill={C.s1} maxBarSize={36} shape={DataEndBar} isAnimationActive={false} />
              <ReferenceLine y={expected} stroke={C.ink} strokeWidth={1.5} strokeDasharray="5 4" label={NULL_LABEL} />
              <Tooltip
                cursor={{ fill: "rgba(11,11,11,0.04)" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const b = payload[0].payload as Bin;
                  return (
                    <TipShell title={`p between ${b.lo.toFixed(1)} and ${b.hi.toFixed(1)}`} rows={[
                      { label: "Medicines", value: fmt.int(b.n), color: C.s1, rect: true },
                      { label: "If nothing were seasonal", value: fmt.one(expected), color: C.ink, dash: true },
                    ]} />
                  );
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-center text-[11px] text-muted">p-value of each medicine’s own seasonal test (near 0 = strong evidence of a yearly shape)</p>
      </div>

      <div className="space-y-4 text-[13px] leading-relaxed text-ink-2">
        {ratio != null && (
          <div className="rounded-2xl bg-surface-2 p-4">
            <p className="text-[24px] font-semibold leading-none tracking-tight text-ink">{ratio.toFixed(1)}×</p>
            <p className="mt-1.5 text-[12px] text-ink-3">
              {fmt.int(first)} medicines have p below 0.1, against {fmt.one(expected)} if every pattern were chance.
            </p>
          </div>
        )}
        <p>
          <b className="font-semibold text-ink">How to read it.</b> If no medicine were seasonal, p-values would spread evenly, about {fmt.one(expected)} per band
          (the dashed line). Real seasonality piles them up near 0; a flat histogram would mean noise.
        </p>
        <p>
          <b className="font-semibold text-ink">Why so few pass on their own.</b> One medicine’s weekly sales are mostly noise: a typical item sells a handful of units a
          week, and after correcting for testing {fmt.int(summary.medicines_tested)} medicines at once (q &lt; {fdrQ.toFixed(2)}) only {fmt.int(summary.medicines_significant)} {summary.medicines_significant === 1 ? "clears" : "clear"} the bar alone.
          That is why each medicine’s curve borrows strength from its category, where the signal is strong: {summary.categories_significant} of {summary.categories} categories pass.
        </p>
        {total > 0 && (
          <p className="text-[12px] text-ink-3">
            {signal > 0.02
              ? <>Rough estimate: about {fmt.pct(signal)} of tested medicines (≈{fmt.int(signal * total)}) carry a real seasonal signal that is too faint to prove one at a time, judged from how many p-values sit above 0.5 (Storey’s method).</>
              : <>The upper half of the histogram is as full as chance predicts, so there is no detectable excess of seasonal medicines beyond those listed.</>}
          </p>
        )}
      </div>
    </div>
  );
}

/* ───────────────── category evidence table ───────────────── */

function CategoryTable({ rows, fdrQ }: { rows: CurveSummary[]; fdrQ: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, CAT_FIRST);
  const th = "whitespace-nowrap px-2.5 py-3 font-medium";
  return (
    <>
      <div className="mt-4 overflow-x-auto">
        <table id="evidence-cats" className="w-full min-w-[960px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th scope="col" className={`${th} sticky left-0 z-[1] bg-surface-2 pl-6`}>Category</th>
              <th scope="col" className={th}>Class</th>
              <th scope="col" className={`${th} text-right`} title="False-discovery-adjusted p-value of the seasonal curve vs a flat line">q</th>
              <th scope="col" className={th} title="Share of week-to-week variation explained by the seasonal curve (0 to 1, log scale)">Strength</th>
              <th scope="col" className={`${th} text-right`} title="Peak multiplier divided by trough multiplier">Peak ÷ trough</th>
              <th scope="col" className={th}>Peak</th>
              <th scope="col" className={th} title="Stretch of the year where demand is at least 10% above an average week">Season window</th>
              <th scope="col" className={`${th} text-right`} title="How much of the curve comes from the category's own sales (1) versus being shrunk toward flat (0)">Shrink wt.</th>
              <th scope="col" className={`${th} text-right`} title="Rank correlation of the 12 monthly multipliers with Kochi's monthly rainfall">Rain ρ</th>
              <th scope="col" className={`${th} pr-6 text-right`}>Units sold</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const sig = r.q != null && r.q < fdrQ;
              return (
                <tr key={r.id} className="group border-t border-hairline transition-colors hover:bg-surface-2">
                  <td className="sticky left-0 z-[1] max-w-[220px] bg-surface py-2.5 pl-6 pr-3 transition-colors group-hover:bg-surface-2">
                    <span className="block truncate font-medium" title={r.label}>{r.label}</span>
                    {r.small_sample && (
                      <span title="Few units sold in total: the curve is shrunk toward flat and left out of the timing views"
                        className="mt-1 inline-flex items-center gap-1 rounded-md border border-hairline bg-sunken px-1.5 py-[3px] text-[11px] font-medium leading-none text-ink-2">
                        <span aria-hidden className="text-[9px]">◌</span>Small sample
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-2.5"><ClassChip cls={r.class} /></td>
                  <td className={`whitespace-nowrap px-2.5 py-2.5 text-right tnum ${sig ? "font-semibold text-ink" : "text-ink-3"}`}>
                    {sig && <span aria-hidden className="mr-1 align-[1px] text-[8px]">●</span>}
                    {r.tested ? qText(r.q) : "not tested"}
                    {sig && <span className="sr-only"> (significant)</span>}
                  </td>
                  <td className="px-2.5 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="w-8 text-right tnum text-ink-2">{r.strength.toFixed(2)}</span>
                      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-sunken" aria-hidden>
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(1, r.strength) * 100)}%`, background: C.s1 }} />
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-right tnum text-ink-2">{r.amplitude.toFixed(2)}×</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-ink-2">{r.peak}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5">
                    {r.onset && r.end
                      ? <span className="text-ink-2">{r.onset} – {r.end} <span className="text-[12px] text-ink-3 tnum">· {r.duration_days} d</span></span>
                      : <span className="text-[12px] text-ink-3" title="The peak never reaches +10% above an average week">No window</span>}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-right tnum text-ink-2">{r.shrink_weight != null ? r.shrink_weight.toFixed(2) : "—"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-right tnum text-ink-2">{sDec(r.rain_corr)}</td>
                  <td className="whitespace-nowrap py-2.5 pl-3 pr-6 text-right tnum text-ink-2">{fmt.int(r.units)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-6 py-3.5">
        <p className="text-[12px] text-ink-3">
          <span aria-hidden className="mr-1 text-[8px] text-ink">●</span>q below {fdrQ.toFixed(2)}: the seasonal shape is unlikely to be chance after testing every category.
          Strength is the share of week-to-week variation the curve explains.
        </p>
        {rows.length > CAT_FIRST && (
          <MoreButton open={all} onClick={() => setAll((v) => !v)} controls="evidence-cats" more={`Show all ${rows.length}`} less={`Show first ${CAT_FIRST}`} />
        )}
      </div>
    </>
  );
}

/* ───────────────── repeatability (August, seen twice) ───────────────── */

function Repeatability({ rows, storeRatio }: { rows: EvidenceResp["yoy_august"]; storeRatio: number | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, YOY_FIRST);
  const consistent = rows.filter((r) => Math.abs(r.ratio - 1) <= YOY_BAND).length;
  const solid = rows.filter((r) => r.aug_2025 >= LOW_VOLUME);
  const solidConsistent = solid.filter((r) => Math.abs(r.ratio - 1) <= YOY_BAND).length;

  if (!rows.length) return <Empty title="No repeat month yet">August has to be observed in two years before repeatability can be checked.</Empty>;
  return (
    <div className="pb-2">
      <div className="mx-6 mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-surface-2 p-4">
          <p className="text-[12px] text-ink-3">Whole store</p>
          <p className="mt-2 text-[24px] font-semibold leading-none tracking-tight">{storeRatio != null ? `${storeRatio.toFixed(2)}×` : "—"}</p>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {storeRatio != null ? <>Aug 2026 vs Aug 2025 weekly units ({fmt.signedPct(storeRatio - 1, 1)})</> : "Not available"}
          </p>
        </div>
        <div className="rounded-2xl bg-surface-2 p-4">
          <p className="text-[12px] text-ink-3">Categories within ±{Math.round(YOY_BAND * 100)}%</p>
          <p className="mt-2 text-[24px] font-semibold leading-none tracking-tight">{consistent}<span className="text-[15px] font-medium text-ink-3"> / {rows.length}</span></p>
          <p className="mt-1.5 text-[12px] text-ink-3">{solidConsistent} of {solid.length} selling {LOW_VOLUME}+ units a week</p>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto px-2">
        <table id="evidence-yoy" className="w-full min-w-[440px] text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th scope="col" className="px-4 py-2 font-medium">Category</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 text-right font-medium" title="Mean weekly units, August 2025">Aug ’25</th>
              <th scope="col" className="whitespace-nowrap px-2 py-2 text-right font-medium" title="Mean weekly units, August 2026">Aug ’26</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Change</th>
              <th scope="col" className="py-2 pl-2 pr-4 font-medium">Repeat</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const d = r.ratio - 1;
              const ok = Math.abs(d) <= YOY_BAND;
              const low = r.aug_2025 < LOW_VOLUME;
              return (
                <tr key={r.category} className="border-t border-hairline transition-colors hover:bg-surface-2">
                  <td className="max-w-[200px] py-2.5 pl-4 pr-2">
                    <span className="block truncate text-ink-2" title={r.category}>{r.category}</span>
                    {low && <span className="block text-[11px] text-ink-3">low volume: mostly noise</span>}
                  </td>
                  <td className="px-2 py-2.5 text-right tnum text-ink-2">{fmt.one(r.aug_2025)}</td>
                  <td className="px-2 py-2.5 text-right tnum text-ink-2">{fmt.one(r.aug_2026)}</td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right font-medium tnum" title={`Ratio ${r.ratio.toFixed(2)}×`}>{fmt.signedPct(d)}</td>
                  <td className="py-2.5 pl-2 pr-4">
                    {ok ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-brand-soft bg-brand-wash px-1.5 py-[3px] text-[11px] font-medium leading-none text-brand-ink">
                        <Check className="h-3 w-3" strokeWidth={2.6} aria-hidden />Consistent
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-hairline bg-sunken px-1.5 py-[3px] text-[11px] font-medium leading-none text-ink-2">
                        {d > 0 ? <ArrowUpRight className="h-3 w-3" strokeWidth={2.4} aria-hidden /> : <ArrowDownRight className="h-3 w-3" strokeWidth={2.4} aria-hidden />}Changed
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-3">
        <p className="text-[12px] text-ink-3">Mean weekly units. Consistent = within ±{Math.round(YOY_BAND * 100)}% of last year.</p>
        {rows.length > YOY_FIRST && (
          <MoreButton open={all} onClick={() => setAll((v) => !v)} controls="evidence-yoy" more={`Show all ${rows.length}`} less={`Show top ${YOY_FIRST}`} />
        )}
      </div>
    </div>
  );
}

/* ───────────────── rain shape ───────────────── */

function RainShape({ rain }: { rain: EvidenceResp["rain"] }) {
  const rows = [...rain.categories].filter((r) => r.rain_corr != null).sort((a, b) => (b.rain_corr ?? 0) - (a.rain_corr ?? 0));
  const cols = rain.months.map((m, i) => ({ x: m, y: rain.mm[i] ?? null }));
  const grid = "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] items-center gap-x-3 sm:grid-cols-[minmax(0,210px)_minmax(0,1fr)_48px]";
  return (
    <div className="px-6 pb-6 pt-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Kochi rainfall, mm per month</p>
      <div className="-mx-2 mt-1" role="img" aria-label={`Kochi monthly rainfall: ${cols.map((c) => `${c.x} ${c.y} mm`).join(", ")}`}>
        <Columns data={cols} height={120} color={RAIN.col} valueLabel="mm" />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <Keys>
          <Key kind="rect" color={DIV.pos} label="Same shape as rainfall" />
          <Key kind="rect" color={DIV.neg} label="Opposite shape" />
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
            <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: DIV.pos, opacity: 0.35 }} />Faded: no clear season (weak or steady)
          </span>
        </Keys>
      </div>
      <ul className="mt-3 space-y-0.5">
        {rows.map((r) => {
          const v = Math.max(-1, Math.min(1, r.rain_corr ?? 0));
          const quiet = QUIET.includes(r.class);
          return (
            <li key={r.category} className={`${grid} rounded-lg px-2 py-1 transition-colors hover:bg-surface-2`}
              title={`${r.category}: ρ ${sDec(r.rain_corr)} · ${r.class}`}>
              <span className="truncate text-[13px] text-ink-2">{r.category}</span>
              <div className="relative h-5" aria-hidden>
                <div className="absolute inset-y-0 left-1/2 w-px" style={{ background: DIV.mid }} />
                <div className="absolute inset-y-[5px]" style={{
                  left: v >= 0 ? "50%" : `${50 + v * 50}%`, width: `max(${Math.abs(v) * 50}%, 2px)`,
                  background: v >= 0 ? DIV.pos : DIV.neg, opacity: quiet ? 0.35 : 1,
                  borderRadius: v >= 0 ? "0 4px 4px 0" : "4px 0 0 4px",
                }} />
              </div>
              <span className="text-right text-[13px] font-medium tnum text-ink">{sDec(r.rain_corr)}</span>
            </li>
          );
        })}
      </ul>
      <div className={`${grid} mt-1 px-2 text-[11px] text-muted`}>
        <span />
        <div className="flex justify-between tnum"><span>−1</span><span>0</span><span>+1</span></div>
        <span />
      </div>
      <div className="mt-4 space-y-2">
        <Footnote>
          Spearman rank correlation between each category’s 12 monthly multipliers and the rainfall above. It measures shape similarity, not causation:
          anything that climbs out of a dry-season low into mid-year will match the monsoon, and 12 smooth monthly values make high correlations easy to get by chance.
          Faded bars belong to categories with no clear season, where the correlation describes an almost flat curve.
        </Footnote>
        <Footnote>Source: {rain.source}.</Footnote>
      </div>
    </div>
  );
}

/* ───────────────── tab ───────────────── */

export default function EvidenceTab() {
  const { data, error, loading } = useApi<EvidenceResp>("/api/seasonal/evidence");
  const cats = useMemo(() => data?.categories ?? [], [data]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36" />)}</div>
        <Skeleton className="h-[380px]" />
        <Skeleton className="h-[560px]" />
        <div className="grid gap-6 lg:grid-cols-2"><Skeleton className="h-[640px]" /><Skeleton className="h-[640px]" /></div>
      </div>
    );
  }

  const s = data.summary;
  const q = data.fdr_q;
  const total = s.medicines_tested + s.medicines_insufficient;

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <p className="rise mb-6 max-w-3xl text-[13px] leading-relaxed text-ink-2">
        How sure we are that the seasonal patterns are real: the statistical tests behind every curve, whether last year’s pattern repeated, and how
        the shapes line up with the monsoon. Based on {fmt.int(s.weeks)} weeks of sales, {fmt.weekYear(s.first_week)} – {fmt.weekYear(s.last_week)}.
      </p>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Tile label="Medicines tested" value={fmt.int(s.medicines_tested)} delay={20}>
          {total > 0 && <>{fmt.pct(s.medicines_tested / total)} of {fmt.int(total)} medicines; each tested on its own weekly sales.</>}
        </Tile>
        <Tile label="Significant on their own" value={fmt.int(s.medicines_significant)} delay={40}>
          After false-discovery control at q &lt; {q.toFixed(2)}{s.medicines_tested > 0 && <> ({fmt.pct(s.medicines_significant / s.medicines_tested, 1)} of those tested)</>}.
        </Tile>
        <Tile label="Not testable" value={fmt.int(s.medicines_insufficient)} delay={60}>
          Too few bills to test alone; their curves lean on their category’s shape.
        </Tile>
        <Tile label="Categories significant" value={<>{fmt.int(s.categories_significant)}<span className="text-[18px] font-medium text-ink-3"> / {fmt.int(s.categories)}</span></>} delay={80}>
          Category curves that pass at q &lt; {q.toFixed(2)}; this is where the seasonal evidence lives.
        </Tile>
      </div>

      <Card className="mt-6" delay={100}>
        <CardHeader title="Where the medicine p-values fall"
          sub={`${fmt.int(data.p_histogram.reduce((a, b) => a + b, 0))} medicines, each testing its seasonal curve against a flat line`}
          right={<div className="w-full md:w-auto"><Keys><Key kind="rect" color={C.s1} label="Medicines per p-value band" /><Key kind="dash" color={C.ink} label="If nothing were seasonal" /></Keys></div>} />
        {data.p_histogram.length
          ? <PHistogram hist={data.p_histogram} expected={data.expected_null_per_bin} fdrQ={q} summary={s} />
          : <Empty title="No medicine could be tested yet">Medicines need enough bills before their own seasonal curve can be tested.</Empty>}
      </Card>

      <Card className="mt-6" delay={130}>
        <CardHeader title="Category evidence" sub={`All ${cats.length} categories, most convincing first. Medicines inherit their seasonal shape largely from these curves.`} />
        {cats.length ? <CategoryTable rows={cats} fdrQ={q} /> : <Empty title="No category curves yet" />}
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card delay={160}>
          <CardHeader title="Does the pattern repeat?" sub="August is the only month seen in both years. If seasonality is real, each category’s August should look alike." />
          <Repeatability rows={data.yoy_august} storeRatio={data.yoy_store_ratio} />
        </Card>
        <Card delay={180}>
          <CardHeader title="Does demand follow the rain?" sub="Each category’s monthly shape compared with Kochi’s rainfall, from same shape (+1) to opposite (−1)" />
          {data.rain.categories.length ? <RainShape rain={data.rain} /> : <Empty title="No category shapes to compare" />}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-6" delay={200}>
          <p className="eyebrow mb-4">Method</p>
          <NumberedList items={data.method} />
        </Card>
        <Card className="p-6" delay={220}>
          <p className="eyebrow mb-4">Limits</p>
          <NumberedList items={data.limits} />
        </Card>
      </div>
    </div>
  );
}
