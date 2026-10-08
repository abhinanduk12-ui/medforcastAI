"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, ChevronDown, ClipboardList, FlaskConical, Info, PackagePlus, Store, Timer } from "lucide-react";
import { SEASONS, useApi, type Season } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { AbcBadge, Card, CardHeader, ErrorState, SeasonIcon, Segmented, Skeleton, UpliftBadge } from "@/components/ui";
import type { ReadinessCat, ReadinessResp } from "./types";
import { ClassChip, Meter, SEASON_TINT, TONE, addDays, coverageTone, dateLabel, dayDiff, isoDate } from "./a-bits";

const CAT_PREVIEW = 10;

function CoverageMeter({ value, big = false, label }: { value: number; big?: boolean; label: string }) {
  const t = coverageTone(value);
  return (
    <div className="relative">
      <Meter value={value} tone={t.tone} height={big ? 12 : 8} label={label} />
      {big && (
        <div aria-hidden className="relative mt-1.5 h-4 text-[11px] text-ink-3">
          {[0.7, 0.9].map((th) => (
            <span key={th} className="absolute top-0 -translate-x-1/2 whitespace-nowrap" style={{ left: `${th * 100}%` }}>
              <span className="absolute -top-[18px] left-1/2 h-[12px] w-[2px] -translate-x-1/2 rounded bg-white" />
              {Math.round(th * 100)}%
            </span>
          ))}
          <span className="absolute right-0 top-0 hidden sm:inline">100%</span>
        </div>
      )}
    </div>
  );
}

function ToneLabel({ value, compact = false }: { value: number; compact?: boolean }) {
  const t = coverageTone(value);
  const tone = TONE[t.tone];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-medium" style={{ color: tone.ink }}>
      <t.Icon className="h-3.5 w-3.5" aria-hidden />{compact ? null : t.label}
    </span>
  );
}

function CategoryRow({ c, season }: { c: ReadinessCat; season: string }) {
  // Coverage counts each medicine only up to its own target (surplus of one item cannot fill another's gap),
  // which is target − gap; the plain available ÷ target can exceed 100% while items are still short.
  const covered = c.target > 0 ? Math.max(0, (c.target - c.gap) / c.target) : 1;
  return (
    <div className="grid gap-x-8 gap-y-2 border-t border-hairline px-6 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(110px,auto)] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-medium text-ink" title={c.category}>{c.category}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          <span className="tnum">{c.short_items ? `${c.short_items} of ${c.items} items short` : `all ${c.items} items covered`}</span>
          <span className="inline-flex items-center gap-1" title="Average of the category's seasonal curve over the season, vs an average week">
            {season} <UpliftBadge value={c.season_mult - 1} />
          </span>
        </p>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><CoverageMeter value={covered} label={`${c.category}: ${fmt.pct(covered)} of target covered`} /></div>
          <span className="flex w-[64px] shrink-0 items-center justify-end gap-1 text-[13px] font-semibold tnum">
            <ToneLabel value={covered} compact />{fmt.pct(covered)}
          </span>
        </div>
        <p className="mt-1 text-[11.5px] text-ink-3 tnum">
          {fmt.int(c.available)} available · target {fmt.int(c.target)}{c.coverage > 1.005 && c.gap > 0 ? ` · ${fmt.pct(c.coverage)} overall` : ""}
        </p>
      </div>
      <div className="flex items-baseline justify-between gap-3 sm:block sm:text-right">
        <p className={`text-[14px] font-semibold tnum ${c.gap_value > 0 ? "text-ink" : "text-ink-3"}`}>{c.gap_value > 0 ? fmt.inr(c.gap_value) : "₹0"}</p>
        <p className="text-[11.5px] text-ink-3 tnum">{c.gap > 0 ? `${fmt.int(c.gap)} units short` : "no gap"}</p>
      </div>
    </div>
  );
}

export default function ReadinessTab() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("season");
  const season = (SEASONS as readonly string[]).includes(raw ?? "") ? (raw as Season) : null;
  const { data, error, loading } = useApi<ReadinessResp>(`/api/seasonal/readiness${season ? `?season=${encodeURIComponent(season)}` : ""}`);
  const { me } = useMe();
  const [allCats, setAllCats] = useState(false);
  const select = useCallback((s: Season) => {
    router.replace(`/seasons?tab=readiness&season=${encodeURIComponent(s)}`, { scroll: false });
  }, [router]);

  const current = (season ?? data?.season ?? null) as Season | null;
  const stale = loading && !!data && !!season && data.season !== season;

  const header = (
    <div className="rise mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <p className="max-w-2xl text-[13px] leading-relaxed text-ink-2">
        Is the shelf ready for the season? Stock that will still be sellable when it starts, plus open purchase orders, measured against
        the demand the seasonal curves expect in its first {data?.target_weeks ?? 4} weeks.
      </p>
      {current ? (
        <div className="-mx-1 overflow-x-auto px-1">
          <Segmented options={SEASONS} value={current} onChange={select}
            render={(s) => (<><SeasonIcon season={s} className="h-3.5 w-3.5" /><span>{s}</span></>)} />
        </div>
      ) : <Skeleton className="h-10 w-[420px] max-w-full" />}
    </div>
  );

  if (error && !data) return <>{header}<ErrorState error={error} /></>;
  if (!data) {
    return (
      <>
        {header}
        <Skeleton className="h-[300px]" />
        <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1.25fr]"><Skeleton className="h-[520px]" /><Skeleton className="h-[520px]" /></div>
      </>
    );
  }

  const start = isoDate(data.start), end = isoDate(data.end);
  const today = addDays(start, -data.starts_in_days);
  const daysLeft = dayDiff(end, today);
  const tint = SEASON_TINT[data.season] ?? SEASON_TINT.Winter;
  const sum = data.summary;
  const tone = coverageTone(sum.coverage);
  const toneC = TONE[tone.tone];
  const store = me?.stores.find((s) => s.id === data.store_id) ?? (me?.selected_store_info?.id === data.store_id ? me.selected_store_info : null);
  const storeName = store?.name ?? data.store_id ?? "All stores";
  const simulated = Math.abs(data.demand_scale - 1) > 1e-6;
  const cats = allCats ? data.categories : data.categories.slice(0, CAT_PREVIEW);
  const windowText = data.in_progress ? `the next ${data.target_weeks} weeks of ${data.season}` : `the first ${data.target_weeks} weeks of ${data.season}`;

  return (
    <>
      {header}
      <div className={`transition-opacity ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
        {/* hero */}
        <Card className="overflow-hidden" delay={20}>
          <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
            <div className="flex flex-col gap-5 border-b border-hairline p-6 lg:border-b-0 lg:border-r">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl" style={{ background: tint.bg, color: tint.ink }}>
                  <tint.Icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{data.season}</h2>
                  <p className="text-[13px] text-ink-3">{dateLabel(start)} – {dateLabel(end)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {data.in_progress ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#cbe7cb] bg-[#eaf6ea] px-2.5 py-1 text-[12.5px] font-medium text-[#006300]">
                    <Timer className="h-3.5 w-3.5" aria-hidden />In progress · {daysLeft} day{daysLeft === 1 ? "" : "s"} left
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-sunken px-2.5 py-1 text-[12.5px] font-medium text-ink-2">
                    <CalendarClock className="h-3.5 w-3.5" aria-hidden />Starts in {data.starts_in_days} day{data.starts_in_days === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <dl className="space-y-2.5 text-[12.5px] leading-snug">
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
                  <dt className="text-ink-3">Target</dt>
                  <dd className="text-ink-2">expected demand in {windowText} (curve × run-rate × store scale)</dd>
                </div>
                <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
                  <dt className="text-ink-3">Counted stock</dt>
                  <dd className="text-ink-2">units still in date on {dateLabel(data.in_progress ? today : start)}, plus open purchase orders</dd>
                </div>
              </dl>
              <div className="mt-auto rounded-2xl bg-surface-2 p-4 text-[12.5px] leading-relaxed text-ink-2">
                <p className="flex items-center gap-2 font-medium text-ink">
                  <Store className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />{storeName}
                  <span className="font-normal text-ink-3 tnum">· demand scale {data.demand_scale.toFixed(2)}</span>
                </p>
                {simulated ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-ink-3">
                    <FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    Simulated branch: its demand is the main shop&apos;s × {data.demand_scale.toFixed(2)}, and its stock was generated for the demo.
                  </p>
                ) : (
                  <p className="mt-1 text-ink-3">Stock from the live ledger of this store. Switch store at the top to check a branch.</p>
                )}
              </div>
            </div>

            <div className="p-6">
              <p className="eyebrow">Pre-season coverage</p>
              <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
                <p className="text-[52px] font-semibold leading-none tracking-[-0.03em]">{fmt.pct(sum.coverage)}</p>
                <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] font-medium"
                  style={{ background: toneC.bg, color: toneC.ink, borderColor: toneC.border }}>
                  <tone.Icon className="h-4 w-4" aria-hidden />{tone.label}
                </span>
              </div>
              <div className="mt-5">
                <CoverageMeter value={sum.coverage} big label={`Pre-season coverage ${fmt.pct(sum.coverage)}`} />
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
                Share of the stock needed for {windowText} that is on the shelf (and will not have expired by then) or on order. Each medicine
                counts only up to its own target. Ready at 90% or more; below 70% is not ready.
              </p>

              <dl className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
                {[
                  { label: "Medicines short", value: fmt.int(sum.short_items), sub: `of ${fmt.int(sum.items)} with demand` },
                  { label: "Units short", value: fmt.int(sum.gap_units), sub: "to reach every target" },
                  { label: "Gap value", value: fmt.inr(sum.gap_value), sub: "at cost (80% of price)" },
                  { label: "Expected demand", value: fmt.compact(sum.expected_season_units), sub: `units over the whole ${data.season}` },
                ].map((k) => (
                  <div key={k.label} className="min-w-0 rounded-2xl bg-surface-2 p-4">
                    <dt className="text-[12px] text-ink-3">{k.label}</dt>
                    <dd className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight">{k.value}</dd>
                    <dd className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{k.sub}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </Card>

        <div className="mt-6 grid gap-6">
          {/* categories */}
          <Card className="overflow-hidden" delay={50}>
            <CardHeader title="By category"
              sub="Sorted by gap value. The bar is the share of the category's target covered item by item: surplus of one medicine cannot fill another's gap, so a category can hold more than 100% overall and still be short." />
            <div className="mt-4">
              {data.categories.length === 0 && <p className="px-6 pb-6 text-[13px] text-ink-3">No category has expected demand in this season.</p>}
              {cats.map((c) => <CategoryRow key={c.category} c={c} season={data.season} />)}
            </div>
            {data.categories.length > CAT_PREVIEW && (
              <button onClick={() => setAllCats((v) => !v)} aria-expanded={allCats}
                className="focus-ring flex w-full items-center justify-center gap-1.5 border-t border-hairline px-6 py-3 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
                {allCats ? "Show fewer" : `Show all ${data.categories.length} categories`}
                <ChevronDown className={`h-4 w-4 transition-transform ${allCats ? "rotate-180" : ""}`} aria-hidden />
              </button>
            )}
          </Card>

          {/* top gaps */}
          <Card className="overflow-hidden" delay={80}>
            <CardHeader title="Biggest gaps" sub={`The ${data.top_gaps.length} medicines with the largest shortfall by value, before ${data.in_progress ? "the next weeks" : "the season starts"}.`}
              right={
                <div className="flex flex-wrap gap-2">
                  <Link href="/purchase" className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-[12.5px] font-medium text-ink transition hover:bg-sunken">
                    <ClipboardList className="h-4 w-4" aria-hidden />Plan purchase
                  </Link>
                  <Link href="/suppliers" className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-[#262624]">
                    <PackagePlus className="h-4 w-4" aria-hidden />Create order
                  </Link>
                </div>
              } />
            {data.top_gaps.length === 0 ? (
              <p className="px-6 py-10 text-center text-[13px] text-ink-3">Nothing is short: every medicine&apos;s target for {windowText} is covered.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[820px] text-[13px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                      <th className="whitespace-nowrap px-5 py-3 font-medium">Medicine</th>
                      <th className="whitespace-nowrap px-2 py-3 font-medium" title="Average of the medicine's seasonal curve over the season, vs an average week">Season</th>
                      <th className="whitespace-nowrap px-2 py-3 text-right font-medium" title={`Expected demand in ${windowText}`}>Target</th>
                      <th className="whitespace-nowrap px-2 py-3 text-right font-medium" title="Sellable units that will not have expired by the season start">On hand</th>
                      <th className="whitespace-nowrap px-2 py-3 text-right font-medium" title="Open purchase orders (sent or partly received)">On order</th>
                      <th className="whitespace-nowrap px-2 py-3 text-right font-medium">Gap</th>
                      <th className="whitespace-nowrap px-5 py-3 text-right font-medium">Gap ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_gaps.map((g) => (
                      <tr key={g.medicine_id} className="border-t border-hairline align-top transition-colors hover:bg-surface-2">
                        <td className="px-5 py-2.5">
                          <Link href={`/medicines/${g.medicine_id}`} className="focus-ring flex items-start gap-2.5 rounded">
                            <span className="mt-0.5"><AbcBadge abc={g.abc} /></span>
                            <span className="min-w-0">
                              <span className="block max-w-[280px] truncate font-medium hover:underline">{g.medicine_name}</span>
                              <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-[12px] text-ink-3">{g.category}</span>
                                <ClassChip c={g.class} compact />
                              </span>
                            </span>
                          </Link>
                        </td>
                        <td className="px-2 py-2.5"><UpliftBadge value={g.season_mult - 1} /></td>
                        <td className="px-2 py-2.5 text-right tnum text-ink-2">{fmt.int(g.target)}</td>
                        <td className={`px-2 py-2.5 text-right tnum ${g.on_hand > 0 ? "text-ink-2" : "text-ink-3"}`}>{fmt.int(g.on_hand)}</td>
                        <td className={`px-2 py-2.5 text-right tnum ${g.on_order > 0 ? "text-ink-2" : "text-ink-3"}`}>{fmt.int(g.on_order)}</td>
                        <td className="px-2 py-2.5 text-right">
                          <span className="inline-block min-w-[44px] rounded-lg bg-brand-wash px-2 py-0.5 text-center font-semibold tnum text-brand-ink">{fmt.int(g.gap)}</span>
                        </td>
                        <td className="px-5 py-2.5 text-right font-medium tnum">{fmt.inrFull(g.gap_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <p className="rise mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-ink-3">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {data.note} Season = the average of each seasonal curve over the season&apos;s weeks, vs an average week. Curves come from about one year of
            (synthetic) sales, so targets are estimates.
          </span>
        </p>
      </div>
    </>
  );
}
