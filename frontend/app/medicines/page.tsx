"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { SEASONS, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { divergingColor, inkOn, Sparkline } from "@/components/charts";
import { AbcBadge, Card, ErrorState, PageHeader, SeasonIcon, Skeleton, UpliftBadge } from "@/components/ui";

type Item = {
  id: string; name: string; generic: string; category: string; form: string; price: number; abc: string;
  total_units: number; avg_weekly: number; next4: number; next12: number; last4: number; trend: number | null;
  peak_season: string; peak_index: number; season_index: Record<string, number>; spark: number[];
};

const SORTS = [
  { key: "next4", label: "Forecast · next 4 weeks" },
  { key: "total_units", label: "Units sold" },
  { key: "total_revenue", label: "Revenue" },
  { key: "peak_index", label: "Seasonality strength" },
  { key: "medicine_name", label: "Name A–Z" },
];

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function SeasonStrip({ idx }: { idx: Record<string, number> }) {
  return (
    <div className="flex gap-[3px]">
      {SEASONS.map((s) => {
        const bg = divergingColor(idx[s]);
        return (
          <span key={s} title={`${s}: ${fmt.signedPct(idx[s] - 1)}`} className="grid h-6 w-7 place-items-center rounded-[5px]" style={{ background: bg, color: inkOn(bg) }}>
            <SeasonIcon season={s} className="h-3 w-3 opacity-80" />
          </span>
        );
      })}
    </div>
  );
}

export default function MedicinesPage() {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("next4");
  const dq = useDebounced(q);
  const { data: cats } = useApi<{ category: string; medicines: number }[]>("/api/categories");
  const url = useMemo(() => `/api/medicines?limit=500&sort=${sort}&q=${encodeURIComponent(dq)}${category ? `&category=${encodeURIComponent(category)}` : ""}`, [dq, category, sort]);
  const { data, error, loading } = useApi<{ count: number; items: Item[] }>(url);
  const [show, setShow] = useState(60);
  useEffect(() => setShow(60), [url]);

  if (error) return <ErrorState error={error} />;

  return (
    <>
      <PageHeader eyebrow="Catalogue" title="Medicines">
        Every medicine with recent sales, its 4-week forecast and its seasonal profile.
        The four tiles show the effect of Winter, Summer, Monsoon and Post-Monsoon (red means more demand, blue means less).
      </PageHeader>

      {/* Filters: one row above the table */}
      <div className="rise mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicine, generic name or ID…"
            className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface pl-10 pr-4 text-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-muted" />
        </label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="focus-ring h-11 rounded-xl border border-hairline bg-surface px-3 text-[14px] md:w-64">
          <option value="">All categories</option>
          {cats?.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.medicines})</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="focus-ring h-11 rounded-xl border border-hairline bg-surface px-3 text-[14px] md:w-60">
          {SORTS.map((s) => <option key={s.key} value={s.key}>Sort: {s.label}</option>)}
        </select>
      </div>

      <Card delay={40} className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-hairline px-6 py-3 text-[12px] text-ink-3">
          <span>{loading ? "Loading…" : `${data?.count ?? 0} medicines`}</span>
          <span className="hidden sm:inline">Forecast = ensemble, next 4 weeks from the end of data</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-[13px]">
            <thead>
              <tr className="whitespace-nowrap bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-6 py-3 font-medium">Medicine</th>
                <th className="px-3 py-3 font-medium">Last 16 weeks</th>
                <th className="px-3 py-3 text-right font-medium">Last 4 wk</th>
                <th className="px-3 py-3 text-right font-medium">Next 4 wk</th>
                <th className="px-3 py-3 text-right font-medium">Trend</th>
                <th className="px-3 py-3 font-medium">Seasonal profile</th>
                <th className="px-3 py-3 font-medium">Peak</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {!data && [...Array(8)].map((_, i) => (
                <tr key={i}><td colSpan={8} className="px-6 py-2"><Skeleton className="h-10" /></td></tr>
              ))}
              {data?.items.slice(0, show).map((m) => (
                <tr key={m.id} className="group border-t border-hairline transition-colors hover:bg-surface-2">
                  <td className="px-6 py-3">
                    <Link href={`/medicines/${m.id}`} className="focus-ring flex items-center gap-3 rounded">
                      <AbcBadge abc={m.abc} />
                      <span className="min-w-0">
                        <span className="block max-w-[260px] truncate font-medium group-hover:underline">{m.name}</span>
                        <span className="block max-w-[260px] truncate text-[12px] text-ink-3">{m.category} · {m.form} · {fmt.inrFull(m.price)}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-3"><Sparkline data={m.spark} width={110} height={28} /></td>
                  <td className="px-3 py-3 text-right tnum text-ink-2">{fmt.int(m.last4)}</td>
                  <td className="px-3 py-3 text-right font-semibold tnum">{fmt.one(m.next4)}</td>
                  <td className="px-3 py-3 text-right"><UpliftBadge value={m.trend} /></td>
                  <td className="px-3 py-3"><SeasonStrip idx={m.season_index} /></td>
                  <td className="px-3 py-3"><span className="inline-flex items-center gap-1.5 text-ink-2"><SeasonIcon season={m.peak_season} className="h-3.5 w-3.5" />{m.peak_season}</span></td>
                  <td className="pr-4"><ChevronRight className="h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-ink" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.items.length > show && (
          <div className="border-t border-hairline p-4 text-center">
            <button onClick={() => setShow((s) => s + 60)} className="focus-ring rounded-xl border border-hairline px-4 py-2 text-[13px] font-medium hover:bg-sunken">
              Show more ({data.items.length - show} remaining)
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
