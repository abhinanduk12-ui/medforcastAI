"use client";

import Link from "next/link";
import { ArrowRight, CalendarClock, CloudSun, FlaskConical, Hourglass, PackageX, ShoppingCart, Siren, Sparkles } from "lucide-react";
import { fmt } from "@/lib/format";
import { AbcBadge, Card, CardHeader, SeasonChip, SeasonIcon, StatTile, UpliftBadge } from "@/components/ui";
import { coverText, istDateTime, longDate, signedPct, TIER_META, TONE, type Brief, type BriefAlert } from "./types";

const SEV_TONE = { critical: "critical", serious: "serious", warning: "warning", info: "info" } as const;
const SEV_LABEL = { critical: "Critical", serious: "Serious", warning: "Warning", info: "Info" } as const;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium text-ink" style={{ background: t.wash }}>
      <Icon className="h-3.5 w-3.5" style={{ color: t.color }} strokeWidth={2.2} aria-hidden />
      {children}
    </span>
  );
}

function Empty({ icon: Icon, title, sub }: { icon: typeof Sparkles; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-good" strokeWidth={1.6} aria-hidden />
      <p className="mt-3 text-[14px] font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-[12.5px] text-ink-3">{sub}</p>
    </div>
  );
}

export function Hero({ b }: { b: Brief }) {
  const f = b.focus;
  const t = TONE[f.tone] ?? TONE.info;
  const Icon = t.icon;
  return (
    <Card className="relative overflow-hidden p-0">
      <div className="absolute inset-y-0 left-0 w-1.5" style={{ background: t.color }} aria-hidden />
      <div className="flex flex-col gap-4 px-6 py-6 pl-8 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:pl-10">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Focus of the day
          </p>
          <h2 className="mt-2 text-[22px] font-semibold leading-snug tracking-[-0.015em] sm:text-[26px]">{f.title}</h2>
          {f.detail && <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">{f.detail}</p>}
        </div>
        <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col sm:items-end">
          <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium text-ink" style={{ background: t.wash }}>
            <Icon className="h-4 w-4" style={{ color: t.color }} strokeWidth={2.2} aria-hidden />{t.label}
          </span>
          {f.href && (
            <Link href={f.href} className="no-print focus-ring inline-flex items-center gap-1 rounded-lg text-[13px] font-medium text-brand hover:underline">
              Go there <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

export function Kpis({ b }: { b: Brief }) {
  const h = b.headline;
  const et = h.expected_today, ew = h.expected_week, ly = h.same_week_last_year, la = h.latest_actual_week, yr = h.yesterday_recorded;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Expected demand today (forecast)" value={`${fmt.int(et.units)} units`}
        hint={`90% range ${fmt.int(et.lo)}–${fmt.int(et.hi)} · ~${fmt.inr(et.value)}${et.in_horizon ? "" : " · nearest forecast week"}`} />
      {/* Demand changes are neutral text: more or less demand is not a good/bad status. */}
      <StatTile label="This week (forecast)" value={`${fmt.int(ew.units)} units`}
        hint={ly
          ? `${ly.change == null ? "" : `${signedPct(ly.change)} `}vs ${fmt.int(ly.units)} in the same week last year`
          : `90% range ${fmt.int(ew.lo)}–${fmt.int(ew.hi)} · week of ${fmt.week(ew.week)}`} />
      <StatTile label="Recorded in the app yesterday" value={yr.lines ? `${fmt.int(yr.units)} units` : "No sales"}
        hint={yr.lines ? `${plural(yr.lines, "sale line")} · ${plural(yr.medicines, "medicine")} · ~${fmt.inr(yr.value)}` : "Sales entered on the Stock page appear here"} />
      <StatTile label="Latest week of sales data" value={`${fmt.int(la.units)} units`}
        hint={`${la.change_vs_prior == null ? "" : `${signedPct(la.change_vs_prior)} vs prior week · `}week of ${fmt.week(la.week)}, ${la.days_old} days old`} />
    </div>
  );
}

export function OrderToday({ b }: { b: Brief }) {
  const o = b.order_today;
  const a = o.assumptions;
  return (
    <Card className="overflow-hidden" delay={60}>
      <div id="order" className="scroll-mt-24" />
      <CardHeader title="Order today"
        sub={`${o.count} line${o.count === 1 ? "" : "s"} · ${fmt.int(o.units)} units · ${fmt.inr(o.value)} est. cost · lead ${a.lead_weeks} wk, review ${a.review_weeks} wk, ${Math.round(a.service * 100)}% service`}
        right={
          <Link href="/stock" className="no-print focus-ring inline-flex items-center gap-1 rounded-lg text-[13px] font-medium text-brand hover:underline">
            Stock ledger <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        } />
      <div className="mt-3 flex flex-wrap gap-2 px-6">
        {(Object.keys(TIER_META) as (keyof typeof TIER_META)[]).map((k) => (
          <Pill key={k} tone={TIER_META[k].tone}>{TIER_META[k].label} <span className="tnum text-ink-3">{o.tiers[k] ?? 0}</span></Pill>
        ))}
      </div>
      {o.items.length === 0 ? (
        <Empty icon={ShoppingCart} title="Nothing needs ordering today" sub="Every medicine with demand has enough stock to last until the next review." />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-y border-hairline text-left text-[11px] uppercase tracking-[0.06em] text-ink-3">
                <th scope="col" className="px-6 py-2.5 font-semibold">Medicine</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Why</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">On hand</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Cover</th>
                <th scope="col" className="px-3 py-2.5 text-right font-semibold">Order</th>
                <th scope="col" className="px-6 py-2.5 text-right font-semibold">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.medicine_id} className="border-b border-hairline last:border-0 hover:bg-surface-2">
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <AbcBadge abc={i.abc} />
                      <Link href={`/medicines/${i.medicine_id}`} className="focus-ring rounded font-medium text-ink hover:underline">{i.medicine_name}</Link>
                    </div>
                    <p className="mt-0.5 pl-7 text-[11.5px] text-ink-3">
                      {i.category} · {i.policy === "On demand" ? "slow mover, on-demand policy" : `${fmt.one(i.weekly_rate)}/wk`}
                      {i.rx_share != null && i.rx_share >= 0.5 ? " · mostly on prescription" : ""}
                    </p>
                  </td>
                  <td className="px-3 py-3"><Pill tone={TIER_META[i.tier].tone}>{TIER_META[i.tier].label}</Pill></td>
                  <td className="tnum px-3 py-3 text-right">{fmt.int(i.on_hand)}</td>
                  <td className="tnum px-3 py-3 text-right text-ink-2">{coverText(i.weeks_cover)}</td>
                  <td className="tnum px-3 py-3 text-right font-semibold">{fmt.int(i.suggested)}</td>
                  <td className="tnum px-6 py-3 text-right text-ink-2">{fmt.inrFull(i.order_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-6 pb-5 pt-3 text-[12px] leading-relaxed text-ink-3">
        {o.count > o.items.length ? `Showing the ${o.items.length} most urgent of ${o.count}. ` : ""}{a.note} Source: {o.source}.
      </p>
    </Card>
  );
}

export function Expiring({ b }: { b: Brief }) {
  const e = b.expiring;
  return (
    <Card className="overflow-hidden" delay={90}>
      <div id="expiring" className="scroll-mt-24" />
      <CardHeader title="Expiring soon"
        sub={`${plural(e.within_60.batches, "batch", "batches")} within 60 days · next 90 days: ${fmt.int(e.at_risk.units)} units likely unsold (${fmt.inr(e.at_risk.value)} at cost)`} />
      {e.expired.batches > 0 && (
        <div className="mx-6 mt-3 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]" style={{ background: TONE.critical.wash }} role="status">
          <PackageX className="mt-0.5 h-4 w-4 shrink-0" style={{ color: TONE.critical.color }} aria-hidden />
          <span><b className="font-semibold">Expired on the shelf:</b> {e.expired.batches} batch{e.expired.batches === 1 ? "" : "es"}, {fmt.int(e.expired.qty)} units ({fmt.inr(e.expired.value)}). Do not dispense; quarantine and write off.</span>
        </div>
      )}
      {e.items.length === 0 ? (
        <Empty icon={Hourglass} title="No short-dated stock at risk" sub="No batch expires within 60 days or is projected to remain unsold." />
      ) : (
        <ul className="mt-3 divide-y divide-[var(--hairline)]">
          {e.items.map((i) => {
            const share = i.qty > 0 ? i.projected_unsold / i.qty : 0;
            return (
              <li key={i.batch_id} className="flex items-center gap-3 px-6 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/medicines/${i.medicine_id}`} className="focus-ring block truncate rounded text-[13px] font-medium hover:underline">{i.medicine_name}</Link>
                  <p className="truncate text-[11.5px] text-ink-3">Batch {i.batch_no} · expires {fmt.weekYear(i.expiry_date)} · {fmt.int(i.qty)} units</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tnum text-[13px] font-semibold">{plural(i.days_left, "day")}</p>
                  <p className="tnum text-[11.5px] text-ink-3">
                    {i.projected_unsold > 0 ? `${fmt.int(i.projected_unsold)} likely unsold` : "should sell out"}
                  </p>
                </div>
                <div className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-sunken sm:block" title={`${Math.round(share * 100)}% projected unsold`} aria-hidden>
                  <div className="h-full rounded-full bg-ink-3" style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-6 pb-5 pt-3 text-[12px] leading-relaxed text-ink-3">{e.method} Bar: share of the batch projected to remain unsold.</p>
    </Card>
  );
}

function AlertRow({ a }: { a: BriefAlert }) {
  const tone = TONE[SEV_TONE[a.severity] ?? "info"] ?? TONE.info;
  const Icon = tone.icon;
  const body = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: tone.color }} strokeWidth={2.2} aria-hidden />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{SEV_LABEL[a.severity] ?? a.severity} · {a.type_label}</p>
        <p className="mt-0.5 text-[13px] font-medium leading-snug">{a.title}</p>
        {a.action && <p className="mt-0.5 text-[12px] text-ink-3">{a.action}</p>}
      </div>
    </>
  );
  return a.href
    ? <Link href={a.href} className="focus-ring flex gap-2.5 rounded-xl px-3 py-2.5 hover:bg-surface-2">{body}</Link>
    : <div className="flex gap-2.5 px-3 py-2.5">{body}</div>;
}

export function Alerts({ b }: { b: Brief }) {
  const a = b.alerts;
  return (
    <Card className="flex flex-col" delay={120}>
      <CardHeader title="Top alerts"
        sub={`${a.counts.critical ?? 0} critical · ${a.counts.serious ?? 0} serious · ${a.counts.warning ?? 0} warning`}
        right={<Link href="/alerts" className="no-print focus-ring inline-flex items-center gap-1 rounded-lg text-[13px] font-medium text-brand hover:underline">All {a.total} <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>} />
      {a.top.length === 0
        ? <Empty icon={Siren} title="No alerts" sub="No statistical test crossed its threshold." />
        : <div className="mt-2 space-y-0.5 px-3">{a.top.map((x) => <AlertRow key={x.id} a={x} />)}</div>}
      <p className="mt-auto px-6 pb-5 pt-3 text-[12px] leading-relaxed text-ink-3">{a.note}</p>
    </Card>
  );
}

export function SeasonStrip({ b }: { b: Brief }) {
  const s = b.season, sig = b.signals;
  const rising = s.days_to_next <= 45 ? s.next_rising : (s.current_rising.length ? s.current_rising : s.next_rising);
  const risingFor = rising === s.current_rising ? s.current : s.next;
  return (
    <Card className="p-6" delay={150}>
      <div id="signals" className="scroll-mt-24" />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="min-w-0">
          <p className="eyebrow mb-2">Season</p>
          <div className="flex flex-wrap items-center gap-2">
            <SeasonChip season={s.current} />
            <ArrowRight className="h-3.5 w-3.5 text-ink-3" aria-hidden />
            <SeasonChip season={s.next} active={false} />
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Day {s.day_of_season} of {s.current}. <b className="font-semibold text-ink">{s.next}</b> starts {fmt.weekYear(s.next_start)} ({s.days_to_next} days).
          </p>
          {s.current_drivers && <p className="mt-1.5 text-[12px] text-ink-3">{s.current_drivers}</p>}
        </div>
        <div className="min-w-0">
          <p className="eyebrow mb-2 flex items-center gap-1.5"><SeasonIcon season={risingFor} className="h-3.5 w-3.5" /> Rising in {risingFor}</p>
          {rising.length ? (
            <ul className="space-y-1.5">
              {rising.slice(0, 4).map((r) => (
                <li key={r.medicine_id} className="flex items-center justify-between gap-3 text-[13px]">
                  <Link href={`/medicines/${r.medicine_id}`} className="focus-ring min-w-0 truncate rounded hover:underline">{r.medicine_name}</Link>
                  <UpliftBadge value={r.uplift} />
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-ink-3">No medicine rises by 8% or more with enough volume to rank.</p>}
          {s.festivals.length > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {s.festivals.map((f) => `${f.name} in ${f.days_to} days`).join(" · ")}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <p className="eyebrow mb-2 flex flex-wrap items-center gap-1.5"><CloudSun className="h-3.5 w-3.5" aria-hidden /> Weather & outbreaks
            {sig.stale && <span className="rounded-full border border-hairline px-1.5 py-px text-[10.5px] normal-case tracking-normal text-ink-2">Stale data</span>}
            {sig.simulated && <span className="rounded-full border border-hairline px-1.5 py-px text-[10.5px] normal-case tracking-normal text-ink-2">Simulated</span>}
          </p>
          {sig.available ? (
            <div className="space-y-1.5 text-[13px] text-ink-2">
              {sig.headline && <p className="font-medium text-ink">{sig.headline}</p>}
              {sig.weather && !(sig.headline ?? "").includes(sig.weather.replace(/\.$/, "")) && <p>{sig.weather}</p>}
              {sig.outbreaks.map((o) => (
                <p key={o} className="flex items-start gap-1.5"><FlaskConical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />{o}</p>
              ))}
              {sig.note && <p className="text-[12px] text-ink-3">{sig.note}</p>}
              <Link href="/signals" className="no-print focus-ring inline-flex items-center gap-1 rounded text-[12px] font-medium text-brand hover:underline">
                Signals <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[13px] text-ink-3">{sig.note ?? "Not connected yet."}</p>
              <Link href="/signals" className="no-print focus-ring inline-flex items-center gap-1 rounded text-[12px] font-medium text-brand hover:underline">
                Signals <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function BriefHeader({ b, actions }: { b: Brief; actions?: React.ReactNode }) {
  return (
    <div className="rise mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
      <p className="eyebrow mb-2">Morning brief · {longDate(b.date)}</p>
      <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[34px]">{b.greeting}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
        {b.store.city && <span>{b.store.city}</span>}
        <SeasonChip season={b.season.current} />
        {b.store.simulated && (
          <span className="inline-flex items-center rounded-full border border-hairline bg-surface px-2.5 py-1 text-[12px] text-ink-2">
            Simulated branch · main-shop forecast × {b.store.demand_scale.toFixed(2)}
          </span>
        )}
      </div>
      </div>
      {actions && <div className="no-print flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Notes({ b }: { b: Brief }) {
  return (
    <div className="mt-6 space-y-1 text-[12px] leading-relaxed text-ink-3">
      {b.notes.map((n) => <p key={n}>{n}</p>)}
      <p>Any substitution or change to a prescription medicine needs pharmacist / prescriber confirmation.</p>
      <p>
        Sales history to the week of {fmt.weekYear(b.data_window.history_end)} · forecast {fmt.weekYear(b.data_window.forecast_start)}–{fmt.weekYear(b.data_window.forecast_end)}
        {" "}· generated {istDateTime(b.generated_at, true)}.
      </p>
    </div>
  );
}

/** The brief itself (what prints). */
export function BriefView({ b, actions }: { b: Brief; actions?: React.ReactNode }) {
  return (
    <div className="brief-root">
      <BriefHeader b={b} actions={actions} />
      <Hero b={b} />
      <div className="mt-6"><Kpis b={b} /></div>
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <OrderToday b={b} />
        <div className="grid content-start gap-6">
          <Expiring b={b} />
          <Alerts b={b} />
        </div>
      </div>
      <div className="mt-6"><SeasonStrip b={b} /></div>
      <Notes b={b} />
      <style>{`
        @media print {
          @page { margin: 12mm; }
          body * { visibility: hidden !important; }
          .brief-root, .brief-root * { visibility: visible !important; }
          .brief-root { position: absolute; left: 0; top: 0; width: 100%; }
          .brief-root .no-print { display: none !important; }
          .brief-root .card { box-shadow: none !important; break-inside: avoid; }
          .brief-root .rise { animation: none !important; }
          .brief-root a { color: inherit !important; text-decoration: none !important; }
        }
      `}</style>
    </div>
  );
}
