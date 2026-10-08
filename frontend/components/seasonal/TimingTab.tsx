"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Download, Info, Search } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { AbcBadge, Card, CardHeader, ErrorState, Segmented, Skeleton, UpliftBadge } from "@/components/ui";
import { CLASS_STYLE, type SeasonalClass, type TimingResp, type TimingRow, type TimingStatus } from "./types";
import {
  ClassChip, MON, STATUS_META, multText, StatusBadge, TONE, addDays, dateLabel, dayDiff, daysText, downloadCsv, isoDate, labelDoy, leadSourceText,
} from "./a-bits";

const LEVELS = ["Category", "Medicine"] as const;
type Level = (typeof LEVELS)[number];
const CLASSES = ["All seasonal", "Strongly seasonal", "Seasonal", "Seasonal (category evidence)", "Possible pattern (weak evidence)"] as const;
type ClassFilter = (typeof CLASSES)[number];
const STATUS_ORDER: TimingStatus[] = ["Order now", "Order within a month", "In season now: keep stocked", "Upcoming", "No distinct season"];
const TIMELINE_MAX = 30;
const BAR = C.s1;

/* ───────────────────────── season-window geometry ───────────────────────── */

type Occ = { start: Date; end: Date; peak: Date };

/** Every occurrence of a row's season window that overlaps [from, to). Dates follow the API: day-of-year in each year. */
function occurrences(r: TimingRow, from: Date, to: Date): Occ[] {
  const on = labelDoy(r.onset), pk = labelDoy(r.peak);
  if (on == null || !r.duration_days) return [];
  const out: Occ[] = [];
  for (let y = from.getFullYear() - 1; y <= to.getFullYear(); y++) {
    const start = new Date(y, 0, on);
    const end = addDays(start, r.duration_days - 1);
    if (end >= from && start < to) {
      const off = pk == null ? 0 : (((pk - on) % 365) + 365) % 365;
      out.push({ start, end, peak: addDays(start, Math.min(off, r.duration_days - 1)) });
    }
  }
  return out;
}

/* ───────────────────────── 12-month timeline ───────────────────────── */

function Timeline({ rows, today, level, total }: { rows: TimingRow[]; today: Date; level: "category" | "medicine"; total: number }) {
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(start.getFullYear() + 1, start.getMonth(), 1);
  const span = dayDiff(end, start);
  const pct = (d: Date) => Math.max(0, Math.min(100, (dayDiff(d, start) / span) * 100));
  const months = Array.from({ length: 12 }, (_, i) => new Date(start.getFullYear(), start.getMonth() + i, 1));
  const todayPct = pct(today);
  const [hover, setHover] = useState<{ id: string; x: number } | null>(null);

  const withWindow = rows.filter((r) => r.onset && r.duration_days > 0);
  const shown = withWindow.slice(0, TIMELINE_MAX);

  const grid = (
    <>
      {months.map((m, i) => i > 0 && <span key={i} aria-hidden className="absolute inset-y-0 w-px bg-[#efeee9]" style={{ left: `${pct(m)}%` }} />)}
      <span aria-hidden className="absolute inset-y-0 w-px bg-ink/55" style={{ left: `${todayPct}%` }} />
    </>
  );

  if (!shown.length) {
    return <p className="px-6 py-10 text-center text-[13px] text-ink-3">None of these rows has a season window: their curves never reach +10% above an average week.</p>;
  }

  return (
    <div className="px-4 pb-5 pt-2 sm:px-6">
      {/* month header */}
      <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-x-4">
        <div />
        <div className="relative h-11">
          <span className="absolute top-0 -translate-x-1/2 rounded-full bg-ink px-2 py-0.5 text-[10.5px] font-semibold text-white" style={{ left: `${Math.max(todayPct, 3)}%` }}>Today</span>
          {months.map((m, i) => (
            <span key={i} className="absolute bottom-1 whitespace-nowrap pl-1 text-[10.5px] text-muted sm:text-[11px]" style={{ left: `${pct(m)}%` }}>
              {MON[m.getMonth()]}{m.getMonth() === 0 && <span className="hidden sm:inline"> ’{String(m.getFullYear()).slice(2)}</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-hairline">
        {shown.map((r) => {
          const occ = occurrences(r, start, end);
          const order = r.order_by_iso ? isoDate(r.order_by_iso) : null;
          const onset = r.next_onset_iso ? isoDate(r.next_onset_iso) : null;
          const orderIn = order && order >= start && order < end;
          const href = level === "medicine" ? `/medicines/${r.id}` : `/seasons?tab=curves&ids=${encodeURIComponent(`cat:${r.id}`)}`;
          const cur = occ.find((o) => o.start <= today && o.end >= today);
          const nextOcc = occ.find((o) => o.start > today);
          const summary = [
            cur ? `In season now until ${dateLabel(cur.end)}` : null,
            nextOcc ? `Season ${dateLabel(nextOcc.start)} – ${dateLabel(nextOcc.end)} (${r.duration_days} days)` : null,
            `Peak ${multText(r.peak_mult)} around ${r.peak}`,
            r.order_by ? `Order by ${r.order_by} (${daysText(r.days_to_order)}, ${Math.round(r.lead_days)}-day lead time)` : null,
          ].filter(Boolean).join(" · ");
          const isHover = hover?.id === r.id;
          return (
            <div key={r.id} className="group grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 border-b border-hairline sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-x-4">
              <Link href={href} className="focus-ring flex min-w-0 items-center gap-1.5 rounded py-1 text-[11.5px] leading-[1.2] text-ink-2 hover:text-ink sm:text-[12.5px]">
                <span aria-hidden className="hidden w-4 shrink-0 text-center text-[9px] text-ink-3 sm:inline" title={r.class}>{CLASS_STYLE[r.class]?.glyph}</span>
                <span className="line-clamp-2 break-words group-hover:underline sm:line-clamp-1 sm:truncate" title={r.label}>{r.label.replace(/\//g, "/\u200b")}</span>
              </Link>
              <div tabIndex={0} role="img" aria-label={`${r.label}: ${summary}`}
                onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); setHover({ id: r.id, x: ((e.clientX - b.left) / b.width) * 100 }); }}
                onMouseLeave={() => setHover(null)} onFocus={() => setHover({ id: r.id, x: onset ? pct(onset) : 50 })} onBlur={() => setHover(null)}
                className={`focus-ring relative h-9 rounded-sm transition-colors ${isHover ? "bg-surface-2" : ""}`}>
                {grid}
                {occ.map((o, i) => {
                  const l = pct(o.start), w = Math.max(pct(addDays(o.end, 1)) - l, 0.6);
                  const clipL = o.start < start, clipR = o.end >= end;
                  return (
                    <span key={i} aria-hidden className="absolute top-1/2 h-3.5 -translate-y-1/2"
                      style={{ left: `${l}%`, width: `${w}%`, background: BAR, opacity: 0.22,
                        borderRadius: `${clipL ? 0 : 7}px ${clipR ? 0 : 7}px ${clipR ? 0 : 7}px ${clipL ? 0 : 7}px` }} />
                  );
                })}
                {orderIn && onset && order && onset > order && (
                  <span aria-hidden className="absolute top-1/2 border-t border-dashed border-ink/45"
                    style={{ left: `${pct(order)}%`, width: `${Math.max(pct(onset) - pct(order), 0)}%` }} />
                )}
                {occ.map((o, i) => o.peak >= start && o.peak < end && (
                  <span key={`p${i}`} aria-hidden className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white"
                    style={{ left: `${pct(o.peak)}%`, background: BAR }} />
                ))}
                {orderIn && order && (
                  <span aria-hidden className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-ink ring-2 ring-white"
                    style={{ left: `${pct(order)}%` }} />
                )}
                {isHover && (
                  <div className="pointer-events-none absolute top-[calc(100%+4px)] z-20 w-[260px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
                    style={{ left: `clamp(0px, calc(${hover.x}% - 130px), calc(100% - 260px))` }}>
                    <p className="font-medium text-ink">{r.label}</p>
                    <div className="mt-1.5 space-y-1 text-ink-2">
                      {cur && <p><span className="text-ink-3">In season now ·</span> until {dateLabel(cur.end)}</p>}
                      {nextOcc && <p><span className="text-ink-3">{cur ? "Next season" : "Season"} ·</span> {dateLabel(nextOcc.start)} – {dateLabel(nextOcc.end)}</p>}
                      <p><span className="text-ink-3">Peak ·</span> {r.next_peak ?? r.peak} <b className="font-semibold text-ink tnum">{multText(r.peak_mult)}</b></p>
                      {r.order_by && <p><span className="text-ink-3">Order by ·</span> <b className="font-semibold text-ink">{r.order_by}</b> ({daysText(r.days_to_order)})</p>}
                      <p className="text-ink-3">{Math.round(r.lead_days)}-day lead time · {leadSourceText(r.lead_source)}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-6 rounded-full" style={{ background: BAR, opacity: 0.22 }} />Season window (+10% or more)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[9px] w-[9px] rounded-full" style={{ background: BAR }} />Peak</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-[9px] w-[9px] rotate-45 bg-ink" />Order by</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t border-dashed border-ink/50" />Supplier lead time</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3.5 w-px bg-ink/60" />Today</span>
        {withWindow.length > shown.length && <span className="text-ink-3">Showing the first {shown.length} of {withWindow.length} by order-by date; the table lists all.</span>}
        {withWindow.length < total && <span className="text-ink-3">{total - withWindow.length} without a season window not drawn.</span>}
      </div>
    </div>
  );
}

/* ───────────────────────── tab ───────────────────────── */

function classLabel(c: ClassFilter) {
  if (c === "All seasonal") return <span>All seasonal</span>;
  const s = CLASS_STYLE[c as SeasonalClass];
  return <><span aria-hidden className="text-[9px]">{s.glyph}</span><span>{s.short}</span></>;
}

export default function TimingTab() {
  const params = useSearchParams();
  const router = useRouter();
  const level: Level = params.get("level") === "medicine" ? "Medicine" : "Category";
  const setLevel = useCallback((l: Level) => {
    router.replace(`/seasons?tab=timing${l === "Medicine" ? "&level=medicine" : ""}`, { scroll: false });
  }, [router]);

  const [cls, setCls] = useState<ClassFilter>("All seasonal");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<TimingStatus | null>(null);

  const path = level === "Category"
    ? "/api/seasonal/timing?level=category"
    : `/api/seasonal/timing?level=medicine&limit=500${cls !== "All seasonal" ? `&cls=${encodeURIComponent(cls)}` : ""}`;
  const { data, error, loading } = useApi<TimingResp>(path);
  const fresh = data && data.level === (level === "Category" ? "category" : "medicine") ? data : null;

  const today = useMemo(() => (fresh ? isoDate(fresh.today) : null), [fresh]);
  const categories = useMemo(() => [...new Set((fresh?.rows ?? []).map((r) => r.category))].sort(), [fresh]);

  // filters before status (status pills count against these)
  const base = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (fresh?.rows ?? []).filter((r) =>
      (!category || level === "Category" || r.category === category) &&
      (!needle || `${r.label} ${r.id} ${r.category}`.toLowerCase().includes(needle)));
  }, [fresh, q, category, level]);
  const counts = useMemo(() => {
    const c = new Map<TimingStatus, number>();
    for (const r of base) c.set(r.status, (c.get(r.status) ?? 0) + 1);
    return c;
  }, [base]);
  const visible = useMemo(() => (status ? base.filter((r) => r.status === status) : base), [base, status]);

  const exportCsv = () => {
    if (!fresh) return;
    const isMed = fresh.level === "medicine";
    const head = ["level", "id", "name", "category", "class", "status", "order_by", "days_to_order", "next_season_start", "next_peak", "peak_change_pct",
      "window_start", "window_end", "window_days", "lead_days", "lead_source", "this_week_change_pct", "q_value", ...(isMed ? ["abc", "typical_weekly_units"] : [])];
    const rows = visible.map((r) => [fresh.level, r.id, r.label, r.category, r.class, r.status, r.order_by_iso ?? "", r.days_to_order ?? "",
      r.next_onset_iso ?? "", r.next_peak ?? "", ((r.peak_mult - 1) * 100).toFixed(1), r.onset ?? "", r.end ?? "", r.duration_days || "",
      Math.round(r.lead_days), r.lead_source, ((r.today_mult - 1) * 100).toFixed(1), r.q == null ? "" : r.q.toFixed(4),
      ...(isMed ? [r.abc ?? "", r.base_weekly == null ? "" : r.base_weekly.toFixed(2)] : [])]);
    downloadCsv(`seasonal-timing_${fresh.level}_${fresh.today}.csv`, head, rows);
  };

  const isMed = level === "Medicine";
  const noun = isMed ? "medicine" : "category";
  const plural = (n: number) => `${fmt.int(n)} ${noun === "category" ? (n === 1 ? "category" : "categories") : n === 1 ? "medicine" : "medicines"}`;

  return (
    <>
      <div className="rise mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <p className="flex max-w-3xl items-start gap-2 text-[13px] leading-relaxed text-ink-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <span>
            <b className="font-semibold text-ink">Order-by date = season start − supplier lead time.</b> The season starts on the first day the curve
            reaches +10% above an average week; lead times are learned from deliveries (7 days until there are enough). Dates come from one year of
            history, so treat them as give-or-take a week or two.
          </span>
        </p>
        <Segmented options={LEVELS} value={level} onChange={(l) => { setLevel(l); setStatus(null); setQ(""); setCategory(""); }} />
      </div>

      {error && !fresh ? <ErrorState error={error} /> : (
        <>
          {/* filters */}
          <Card className="p-4 sm:p-5" delay={20}>
            {isMed && (
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
                  <Segmented options={CLASSES} value={cls} onChange={(c) => { setCls(c); setStatus(null); }} render={classLabel} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row">
                  <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"
                    className="focus-ring h-10 min-w-0 rounded-xl border border-hairline bg-surface px-3 text-[13.5px] sm:w-56">
                    <option value="">All categories</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <label className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicines…" aria-label="Search medicines"
                      className="focus-ring h-10 w-full rounded-xl border border-hairline bg-surface pl-9 pr-3 text-[13.5px] placeholder:text-muted" />
                  </label>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
                {STATUS_ORDER.map((s) => {
                  const n = counts.get(s) ?? 0;
                  const m = STATUS_META[s], t = TONE[m.tone], on = status === s;
                  return (
                    <button key={s} onClick={() => setStatus(on ? null : s)} aria-pressed={on} disabled={!n && !on}
                      className={`focus-ring inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] transition disabled:opacity-40 ${on ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:bg-sunken"}`}>
                      <m.Icon className="h-3.5 w-3.5" style={{ color: on ? "#fff" : t.ink }} aria-hidden />
                      {m.short}
                      <span className={`tnum font-semibold ${on ? "text-white" : "text-ink"}`}>{fresh ? n : "…"}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[12.5px] text-ink-3 tnum" aria-live="polite">
                  {fresh ? (visible.length === fresh.rows.length ? plural(visible.length) : `${fmt.int(visible.length)} of ${plural(fresh.rows.length)}`) : "Loading…"}
                </span>
                <button onClick={exportCsv} disabled={!fresh || !visible.length}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-[#262624] disabled:opacity-40">
                  <Download className="h-4 w-4" aria-hidden /> Export CSV
                </button>
              </div>
            </div>
          </Card>

          {/* timeline */}
          <Card className="mt-6" delay={50}>
            <CardHeader title="The next 12 months"
              sub={isMed ? "Season windows of the medicines below, sorted by order-by date. Hover a row for dates." : "Each category's season window, peak and order-by date, sorted by when to order. Hover a row for dates; click a name to open its curve."} />
            <div className={`mt-3 transition-opacity ${loading && fresh ? "opacity-60" : ""}`}>
              {fresh && today ? <Timeline rows={visible} today={today} level={fresh.level} total={visible.length} />
                : <div className="space-y-2 px-6 pb-6">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-7" />)}</div>}
            </div>
          </Card>

          {/* table */}
          <Card className="mt-6 overflow-hidden" delay={80}>
            <div className={`overflow-x-auto transition-opacity ${loading && fresh ? "opacity-60" : ""}`}>
              <table className={`w-full text-[13px] ${isMed ? "min-w-[1120px]" : "min-w-[980px]"}`}>
                <thead>
                  <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                    <th className="px-5 py-3 font-medium whitespace-nowrap">{isMed ? "Medicine" : "Category"}</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Class</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Status</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Order by</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Season starts</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Peak</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap">Window</th>
                    <th className="px-2.5 py-3 font-medium whitespace-nowrap" title="Supplier lead time used for the order-by date">Lead time</th>
                    {isMed && <th className="px-2.5 py-3 text-right font-medium whitespace-nowrap" title="Season-adjusted run-rate for the selected store">Typical /wk</th>}
                    <th className="px-5 py-3 text-right font-medium whitespace-nowrap" title="Seasonal curve today vs an average week">This week</th>
                  </tr>
                </thead>
                <tbody>
                  {!fresh && [...Array(8)].map((_, i) => <tr key={i}><td colSpan={10} className="px-6 py-2"><Skeleton className="h-9" /></td></tr>)}
                  {fresh && visible.length === 0 && (
                    <tr><td colSpan={10} className="px-6 py-14 text-center">
                      <p className="text-[14px] font-semibold">No {isMed ? "medicines" : "categories"} match these filters</p>
                      <p className="mt-1 text-[13px] text-ink-3">
                        {isMed && cls !== "All seasonal" && !fresh.rows.length
                          ? `No medicine is classed “${cls}” in this data.`
                          : "Clear the search, the category or the status filter."}
                      </p>
                    </td></tr>
                  )}
                  {fresh && today && visible.map((r) => {
                    const occ = occurrences(r, addDays(today, -400), addDays(today, 400));
                    const cur = r.in_season ? occ.find((o) => o.start <= today && o.end >= today) : undefined;
                    return (
                      <tr key={r.id} className="border-t border-hairline align-top transition-colors hover:bg-surface-2">
                        <td className="px-5 py-3">
                          {isMed ? (
                            <Link href={`/medicines/${r.id}`} className="focus-ring flex items-center gap-2.5 rounded">
                              {r.abc && <AbcBadge abc={r.abc} />}
                              <span className="min-w-0">
                                <span className="block max-w-[210px] truncate font-medium hover:underline">{r.label}</span>
                                <span className="block truncate text-[12px] text-ink-3">{r.category}</span>
                              </span>
                            </Link>
                          ) : (
                            <Link href={`/seasons?tab=curves&ids=${encodeURIComponent(`cat:${r.id}`)}`} className="focus-ring group inline-flex items-center gap-1 rounded font-medium">
                              <span className="hover:underline">{r.label}</span>
                              <ArrowUpRight className="h-3.5 w-3.5 text-ink-3 opacity-0 transition group-hover:opacity-100" aria-hidden />
                            </Link>
                          )}
                        </td>
                        <td className="px-2.5 py-3"><ClassChip c={r.class} compact /></td>
                        <td className="px-2.5 py-3"><StatusBadge status={r.status} compact /></td>
                        <td className="px-2.5 py-3">
                          {r.order_by ? (
                            <>
                              <span className="block whitespace-nowrap font-medium tnum">{r.order_by}</span>
                              <span className="block text-[12px] text-ink-3">{daysText(r.days_to_order)}{r.in_season ? " · next season" : ""}</span>
                            </>
                          ) : <span className="text-ink-3">—</span>}
                        </td>
                        <td className="px-2.5 py-3">
                          {cur ? (
                            <>
                              <span className="block whitespace-nowrap font-medium">Now, until {dateLabel(cur.end, false)}</span>
                              <span className="block text-[12px] text-ink-3">next {r.next_onset}</span>
                            </>
                          ) : r.next_onset ? <span className="whitespace-nowrap tnum">{r.next_onset}</span> : <span className="text-ink-3">—</span>}
                        </td>
                        <td className="px-2.5 py-3">
                          <span className="block whitespace-nowrap tnum">{r.next_peak ?? r.peak}</span>
                          <span className="block whitespace-nowrap text-[12px] text-ink-3 tnum">{multText(r.peak_mult)} vs average</span>
                        </td>
                        <td className="px-2.5 py-3">
                          {r.duration_days > 0 ? (
                            <>
                              <span className="block whitespace-nowrap tnum">{r.duration_days} days</span>
                              <span className="block whitespace-nowrap text-[12px] text-ink-3">{r.onset} – {r.end}</span>
                            </>
                          ) : <span className="text-[12px] text-ink-3">never +10%</span>}
                        </td>
                        <td className="px-2.5 py-3">
                          <span className="block whitespace-nowrap tnum">{Math.round(r.lead_days)} d</span>
                          <span className="block whitespace-nowrap text-[12px] text-ink-3" title={r.lead_source === "median of members" ? "Median learned lead time of the medicines in this category" : undefined}>{leadSourceText(r.lead_source)}</span>
                        </td>
                        {isMed && <td className="px-2.5 py-3 text-right tnum text-ink-2">{r.base_weekly == null ? "—" : fmt.one(r.base_weekly)}</td>}
                        <td className="px-5 py-3 text-right"><UpliftBadge value={r.today_mult - 1} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
