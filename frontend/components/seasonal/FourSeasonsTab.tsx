"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PartyPopper, TrendingDown, TrendingUp } from "lucide-react";
import { SEASONS, useApi, type Season } from "@/lib/api";
import { fmt } from "@/lib/format";
import { divergingColor, inkOn } from "@/components/charts";
import { AbcBadge, Card, CardHeader, ErrorState, SeasonIcon, Segmented, Skeleton, UpliftBadge } from "@/components/ui";

type Cell = { index: number; lo: number; hi: number; significant: boolean; weeks: number };
type SeasonsResp = {
  current: string; next: string; meta: Record<string, { months: string; drivers: string }>;
  heatmap: { category: string; units: number; cells: Record<string, Cell> }[];
  festivals: Record<string, { category: string; uplift: number; festival_weekly: number; baseline_weekly: number; significant: boolean }[]>;
};
type Mover = { medicine_id: string; medicine_name: string; category: string; form: string; base_level: number; expected_weekly: number; uplift: number; extra_weekly: number; extra_revenue_weekly: number; abc: string };
type Detail = {
  season: string; weeks: number; extra_units: number; extra_revenue: number; rising_count: number; falling_count: number;
  categories: { category: string; base_weekly: number; expected_weekly: number; uplift: number }[];
  rising: Mover[]; falling: Mover[];
};

function Heatmap({ rows, selected, onSelect }: { rows: SeasonsResp["heatmap"]; selected: Season; onSelect: (s: Season) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-[3px] text-[12px]">
        <thead>
          <tr>
            <th className="w-[38%] pb-2 text-left font-medium text-ink-3">Category</th>
            {SEASONS.map((s) => (
              <th key={s} className="pb-2 font-medium">
                <button onClick={() => onSelect(s)} className={`focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 transition ${s === selected ? "bg-ink text-white" : "text-ink-2 hover:bg-sunken"}`}>
                  <SeasonIcon season={s} className="h-3.5 w-3.5" />{s}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category}>
              <td className="truncate pr-2 text-[13px] text-ink-2">{r.category}</td>
              {SEASONS.map((s) => {
                const c = r.cells[s];
                if (!c) return <td key={s} className="rounded-md bg-sunken" />;
                const bg = divergingColor(c.index);
                return (
                  <td key={s} title={`${r.category} · ${s}: ${fmt.signedPct(c.index - 1)} (90% CI ${fmt.signedPct(c.lo - 1)} to ${fmt.signedPct(c.hi - 1)}) · ${c.weeks} weeks observed`}
                    className={`h-9 rounded-md text-center font-medium tnum transition ${s === selected ? "ring-[1.5px] ring-ink/55" : ""}`}
                    style={{ background: bg, color: inkOn(bg) }}>
                    {fmt.signedPct(c.index - 1)}{c.significant && <span className="ml-0.5 align-super text-[9px]">●</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] text-ink-3">
        <div className="flex items-center gap-2">
          <span>Less demand</span>
          <div className="flex overflow-hidden rounded">
            {[0.6, 0.72, 0.84, 0.93, 1, 1.07, 1.16, 1.28, 1.4].map((v) => <span key={v} className="h-3 w-5" style={{ background: divergingColor(v) }} />)}
          </div>
          <span>More demand</span>
        </div>
        <span>● statistically significant: 90% bootstrap interval excludes “no change”</span>
      </div>
    </div>
  );
}

function MoverTable({ rows, kind }: { rows: Mover[]; kind: "rising" | "falling" }) {
  if (!rows.length) return <p className="px-6 pb-6 text-[13px] leading-relaxed text-ink-3">No medicine {kind === "rising" ? "rises" : "drops"} by 8% or more in this season, so demand stays close to normal and the regular forecast is enough.</p>;
  return (
    <div className="overflow-x-auto px-2 pb-3">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-ink-3">
            <th className="px-4 py-2 font-medium">Medicine</th>
            <th className="px-2 py-2 text-right font-medium">Typical /wk</th>
            <th className="px-2 py-2 text-right font-medium">In season /wk</th>
            <th className="px-4 py-2 text-right font-medium">Impact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.medicine_id} className="border-t border-hairline transition-colors hover:bg-surface-2">
              <td className="px-4 py-2.5">
                <Link href={`/medicines/${m.medicine_id}`} className="focus-ring flex items-center gap-2 rounded">
                  <AbcBadge abc={m.abc} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium hover:underline">{m.medicine_name}</span>
                    <span className="block truncate text-[12px] text-ink-3">{m.category} · {m.form}</span>
                  </span>
                </Link>
              </td>
              <td className="px-2 py-2.5 text-right tnum text-ink-2">{fmt.one(m.base_level)}</td>
              <td className="px-2 py-2.5 text-right font-medium tnum">{fmt.one(m.expected_weekly)}</td>
              <td className="px-4 py-2.5 text-right"><UpliftBadge value={m.uplift} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 pt-2 text-[11px] text-ink-3">
        {kind === "rising" ? "Ranked by extra units per week." : "Ranked by units per week no longer needed."} Seasonal indices are empirical-Bayes shrunk toward the category, so sparse items don’t over-react.
      </p>
    </div>
  );
}

/** The original four-season view (season blocks, mover lists, festivals), kept as one tab of Seasonal Intelligence. */
export default function FourSeasonsTab() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = (params.get("season") as Season) || null;
  const { data, error } = useApi<SeasonsResp>("/api/seasons");
  const [season, setSeason] = useState<Season | null>(initial);
  useEffect(() => { if (!season && data) setSeason(data.current as Season); }, [data, season]);
  const { data: detail } = useApi<Detail>(season ? `/api/seasons/${encodeURIComponent(season)}?n=10` : null);

  if (error) return <ErrorState error={error} />;
  if (!data || !season) return <Skeleton className="h-[520px]" />;
  const select = (s: Season) => { setSeason(s); router.replace(`/seasons?tab=four&season=${encodeURIComponent(s)}`, { scroll: false }); };
  const meta = data.meta[season];

  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-[13px] leading-relaxed text-ink-2">
          Four-season view: a seasonal index compares a typical week in each Kerala climate season with an average week of the year.
        </p>
        <Segmented options={SEASONS} value={season} onChange={select} render={(s) => (<><SeasonIcon season={s} className="h-3.5 w-3.5" /><span className="hidden sm:inline">{s}</span></>)} />
      </div>

      {/* Season summary */}
      <Card className="p-6" delay={30}>
        <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-wash text-brand"><SeasonIcon season={season} className="h-5 w-5" /></span>
              <div>
                <h2 className="text-[20px] font-semibold tracking-tight">{season}</h2>
                <p className="text-[12px] text-ink-3">{meta.months}{season === data.current && " · current season"}</p>
              </div>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{meta.drivers}</p>
          </div>
          {detail ? (
            <>
              <div className="rounded-2xl bg-surface-2 p-4"><p className="text-[12px] text-ink-3">Extra units needed</p><p className="mt-2 text-[26px] font-semibold tracking-tight">{fmt.compact(detail.extra_units)}</p><p className="mt-1 text-[12px] text-ink-3">across ~{detail.weeks} weeks</p></div>
              <div className="rounded-2xl bg-surface-2 p-4"><p className="text-[12px] text-ink-3">Extra sales opportunity</p><p className="mt-2 text-[26px] font-semibold tracking-tight">{fmt.inr(detail.extra_revenue)}</p><p className="mt-1 text-[12px] text-ink-3">summed over every medicine with any lift</p></div>
              <div className="rounded-2xl bg-surface-2 p-4"><p className="text-[12px] text-ink-3">Medicines shifting</p><p className="mt-2 flex items-baseline gap-3 text-[26px] font-semibold tracking-tight"><span className="inline-flex items-center gap-1"><TrendingUp className="h-5 w-5 text-[#c23b3a]" />{detail.rising_count}</span><span className="inline-flex items-center gap-1"><TrendingDown className="h-5 w-5 text-[#256abf]" />{detail.falling_count}</span></p><p className="mt-1 text-[12px] text-ink-3">over ±10% vs typical</p></div>
            </>
          ) : [0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card delay={60}>
          <CardHeader title="Season × category impact" sub="Change in weekly demand vs an average week. Click a season to focus it." />
          <div className="px-5 pb-6 pt-4"><Heatmap rows={data.heatmap} selected={season} onSelect={select} /></div>
        </Card>
        <div className="flex flex-col gap-6">
          <Card delay={90}>
            <CardHeader title={`Stock up for ${season}`} sub="Medicines with the biggest demand lift" right={<TrendingUp className="h-5 w-5 text-[#c23b3a]" />} />
            <div className="pt-3">{detail ? <MoverTable rows={detail.rising} kind="rising" /> : <Skeleton className="mx-6 mb-6 h-64" />}</div>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card delay={120}>
          <CardHeader title={`Scale back in ${season}`} sub="Medicines whose demand drops; avoid overstock and expiry" right={<TrendingDown className="h-5 w-5 text-[#256abf]" />} />
          <div className="pt-3">{detail ? <MoverTable rows={detail.falling} kind="falling" /> : <Skeleton className="mx-6 mb-6 h-64" />}</div>
        </Card>
        <Card delay={150}>
          <CardHeader title="Festival effects" sub="Festival weeks vs other weeks of the same season, by category" right={<PartyPopper className="h-5 w-5 text-ink-3" />} />
          <div className="grid gap-4 px-6 pb-6 pt-4">
            {Object.entries(data.festivals).map(([fest, rows]) => (
              <div key={fest} className="rounded-2xl border border-hairline p-4">
                <p className="text-[13px] font-semibold">{fest}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {rows.filter((r) => r.significant && r.uplift > 0.05).slice(0, 5).map((r) => (
                    <span key={r.category} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink-2" title={`${fmt.one(r.festival_weekly)} vs ${fmt.one(r.baseline_weekly)} units/week`}>
                      {r.category} <UpliftBadge value={r.uplift} />
                    </span>
                  ))}
                  {!rows.some((r) => r.significant && r.uplift > 0.05) && <span className="text-[12px] text-ink-3">No statistically clear lift detected.</span>}
                </div>
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-ink-3">Only lifts that clear normal week-to-week noise are shown (z ≥ 3, corrected for testing many festival × category pairs). Each festival appears only once or twice in the data, so treat these as directional signals.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
