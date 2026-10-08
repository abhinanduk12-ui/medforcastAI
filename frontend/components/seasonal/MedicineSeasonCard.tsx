"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CalendarClock } from "lucide-react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from "recharts";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Card, CardHeader, Legend, Skeleton } from "@/components/ui";
import { CLASS_STYLE, type MedicineSeasonalResp } from "./types";

const MONTH_START_DOY = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthOf = (doy: number) => MONTHS[Math.max(0, MONTH_START_DOY.findLastIndex((s) => s <= doy))];

function evidenceText(q: number | null, tested: boolean, cls: string) {
  if (!tested) return "Too few sales to test on its own; shape comes from its category";
  if (q != null && q < 0.1) return `Significant on its own sales (q ${q < 0.001 ? "< 0.001" : "= " + q.toFixed(3)})`;
  if (cls === "Seasonal (category evidence)") return "Not provable on its own sales; follows its category's significant pattern";
  return `Not significant on its own sales (q = ${q == null ? "–" : q.toFixed(2)})`;
}

/** Week-by-week seasonal curve for one medicine, with its category's curve and the actual weekly sales. */
export function MedicineSeasonCard({ id, delay = 70 }: { id: string; delay?: number }) {
  const { data, error } = useApi<MedicineSeasonalResp>(`/api/seasonal/medicine/${encodeURIComponent(id)}`);
  // Today's day of year is read after mount (pre-rendered HTML must not depend on the clock).
  const [todayDoy, setTodayDoy] = useState<number | null>(null);
  useEffect(() => {
    const n = new Date();
    setTodayDoy(Math.floor((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - Date.UTC(n.getFullYear(), 0, 1)) / 864e5) + 1);
  }, []);
  if (error) return null;               // the rest of the medicine page stays useful without it
  if (!data) return <Skeleton className="mt-6 h-[420px]" />;

  const cv = data.curve, cat = data.category_curve, t = data.timing;
  const catAt = new Map((cat?.grid ?? []).map((g) => [g.doy, g.m]));
  const rows = cv.grid.map((g) => ({ doy: g.doy, med: g.m - 1, band: [g.lo - 1, g.hi - 1] as [number, number], cat: catAt.has(g.doy) ? catAt.get(g.doy)! - 1 : null }));
  // Single weeks of one medicine are mostly noise, so the dots show a centred 4-week average of actual sales.
  const ordered = [...(cv.observed ?? [])].sort((a, b) => a.week.localeCompare(b.week));
  const obs = ordered.map((o, i) => {
    const win = ordered.slice(Math.max(0, i - 2), Math.min(ordered.length, i + 2));
    const avg = win.reduce((a, w) => a + w.ratio, 0) / win.length - 1;
    return { doy: o.doy, r: avg, raw: avg, week: o.week };
  });
  const lo = Math.min(...rows.map((r) => r.band[0]), ...rows.map((r) => r.cat ?? 0), ...obs.map((o) => o.r));
  const hi = Math.max(...rows.map((r) => r.band[1]), ...rows.map((r) => r.cat ?? 0), ...obs.map((o) => o.r), 0.15);
  const pad = (hi - lo) * 0.08;
  // Round ticks (every 25 / 50 / 100 %) so the axis reads cleanly.
  const span = hi - lo + 2 * pad;
  const step = span > 2 ? 1 : span > 1 ? 0.5 : span > 0.5 ? 0.25 : 0.1;
  const yMin = Math.max(-1, Math.floor((lo - pad) / step) * step);
  const yMax = Math.ceil((hi + pad) / step) * step;
  const yDomain: [number, number] = [yMin, yMax];
  const yTicks = Array.from({ length: Math.round((yMax - yMin) / step) + 1 }, (_, i) => Number((yMin + i * step).toFixed(4)));
  const s = CLASS_STYLE[cv.class];
  const share = cv.shrink_weight == null ? null : Math.round(cv.shrink_weight * 100);

  return (
    <Card className="mt-6" delay={delay}>
      <CardHeader
        title="Seasonal curve"
        sub="How demand for this medicine moves through the year, week by week, vs an average week (with a 90% band)"
        right={
          <Link href={`/seasons?tab=curves&ids=${encodeURIComponent(`med:${id}`)}${cat ? `,${encodeURIComponent(`cat:${cat.id}`)}` : ""}`}
            className="focus-ring inline-flex items-center gap-1 rounded text-[13px] font-medium text-brand hover:underline">
            Open in Seasonal intelligence <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        } />
      <div className="grid gap-6 px-4 pb-5 pt-4 sm:px-6 xl:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <div className="mb-2 px-2">
            <Legend items={[
              { label: "This medicine", color: C.s1 },
              { label: "90% band", color: C.s1, kind: "band" },
              ...(cat ? [{ label: `${cat.label} (category)`, color: C.s2 }] : []),
              { label: "Actual sales (4-week average)", color: "#a3a29b", kind: "dot" as const },
            ]} />
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={rows} margin={{ top: 18, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis type="number" dataKey="doy" domain={[1, 365]} ticks={MONTH_START_DOY} tickFormatter={(d: number) => monthOf(d)}
                tickLine={false} axisLine={{ stroke: C.axis }} allowDataOverflow />
              <YAxis type="number" tickFormatter={(v: number) => fmt.signedPct(v)} tickLine={false} axisLine={false} width={48} domain={yDomain} ticks={yTicks} allowDataOverflow />
              <ReferenceLine y={0} stroke={C.axis} />
              <ReferenceLine y={0.1} stroke={C.muted} strokeDasharray="3 3"
                label={{ value: "+10% season threshold", position: "insideTopRight", fill: C.muted, fontSize: 10 }} />
              {todayDoy != null && <ReferenceLine x={todayDoy} stroke={C.ink} label={{ value: "Today", position: "insideTopLeft", fill: C.ink, fontSize: 10 }} />}
              <Scatter data={obs} dataKey="r" fill="#a3a29b" fillOpacity={0.55} shape="circle" isAnimationActive={false} legendType="none" />
              <Area dataKey="band" stroke="none" fill={C.s1} fillOpacity={0.12} isAnimationActive={false} />
              {cat && <Line dataKey="cat" stroke={C.s2} strokeWidth={2} dot={false} isAnimationActive={false} />}
              <Line dataKey="med" stroke={C.s1} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
              <Tooltip
                cursor={{ stroke: C.axis }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as { doy: number; med?: number; band?: [number, number]; cat?: number | null; raw?: number; week?: string };
                  if (p.week) {
                    return (
                      <div className="rounded-xl border border-hairline bg-white/95 px-3 py-2 text-[12px] shadow-lg">
                        <p className="font-medium">Week of {fmt.weekYear(p.week)}</p>
                        <p className="mt-1 text-ink-2">Actual (4-week average): <span className="tnum font-medium text-ink">{fmt.signedPct(p.raw ?? 0)}</span> vs an average week</p>
                      </div>
                    );
                  }
                  const label = cv.grid.find((g) => g.doy === p.doy)?.label ?? "";
                  return (
                    <div className="min-w-[200px] rounded-xl border border-hairline bg-white/95 px-3 py-2 text-[12px] shadow-lg">
                      <p className="mb-1.5 font-medium">Week of {label}</p>
                      <p className="flex justify-between gap-4 text-ink-2"><span>This medicine</span><span className="tnum font-medium text-ink">{fmt.signedPct(p.med ?? 0)}</span></p>
                      {p.band && <p className="flex justify-between gap-4 text-ink-3"><span>90% band</span><span className="tnum">{fmt.signedPct(p.band[0])} to {fmt.signedPct(p.band[1])}</span></p>}
                      {p.cat != null && <p className="flex justify-between gap-4 text-ink-2"><span>Category</span><span className="tnum font-medium text-ink">{fmt.signedPct(p.cat)}</span></p>}
                    </div>
                  );
                }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="space-y-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium ${s.tone}`}>
              <span aria-hidden className="text-[9px]">{s.glyph}</span>{cv.class}
            </span>
            {data.archetype && <span className="rounded-md border border-hairline px-2 py-0.5 text-[12px] text-ink-2">{data.archetype}</span>}
          </div>
          <dl className="divide-y divide-[rgba(11,11,11,0.06)] rounded-2xl border border-hairline">
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-ink-3">Peak</dt><dd className="text-right font-medium tnum">{cv.peak} · {fmt.signedPct(cv.peak_mult - 1)}</dd></div>
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-ink-3">Quietest</dt><dd className="text-right tnum">{cv.trough} · {fmt.signedPct(cv.trough_mult - 1)}</dd></div>
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-ink-3">Season window</dt>
              <dd className="text-right tnum">{cv.onset ? `${cv.onset} – ${cv.end} (${cv.duration_days} d)` : "No distinct season"}</dd></div>
            <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-ink-3">Swing</dt><dd className="text-right tnum">{cv.amplitude.toFixed(2)}× peak vs quietest</dd></div>
            {share != null && (
              <div className="flex justify-between gap-3 px-3.5 py-2.5"><dt className="text-ink-3">Curve built from</dt><dd className="text-right tnum">{share}% own sales · {100 - share}% category</dd></div>
            )}
          </dl>
          {t.order_by && (
            <div className="flex items-start gap-2.5 rounded-2xl bg-ink p-3.5 text-white">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-white/60" aria-hidden />
              <div>
                <p className="text-[12px] text-white/60">{t.in_season ? "In season now · next season starts" : "Next season starts"} {t.next_onset}</p>
                <p className="mt-0.5 font-semibold">Order by {t.order_by}</p>
                <p className="mt-0.5 text-[11.5px] text-white/55">{Math.round(t.lead_days)}-day lead time ({t.lead_source})</p>
              </div>
            </div>
          )}
          <p className="text-[12px] leading-relaxed text-ink-3">{evidenceText(cv.q, cv.tested, cv.class)}.</p>
        </div>
      </div>
    </Card>
  );
}

export default MedicineSeasonCard;
