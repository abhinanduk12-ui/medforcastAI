"use client";

import Link from "next/link";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { AbcBadge } from "@/components/ui";
import { SEV, TYPE_META, type Alert, type Severity } from "./model";

const num = (v: unknown) => (typeof v === "number" ? v : null);
const signed = (v: number | null, digits = 1) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`);
const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmt.weekYear(v) : "—");

/* Key numbers per alert type: label + formatted value. Only numbers the backend computed. */
function metrics(a: Alert): [string, string][] {
  const m = a.metric;
  switch (a.type) {
    case "season":
      if ("rising_categories" in m)
        return [["Starts", date(m.season_start)], ["Order by", date(m.order_by)],
          ["Rising categories", fmt.int(num(m.rising_categories))], ["Rising medicines", fmt.int(num(m.rising_medicines))]];
      return [["vs typical", fmt.signedPct(num(m.uplift))], ["vs this season", fmt.signedPct(num(m.vs_now))],
        ["Expected / wk", fmt.one(num(m.expected_weekly))], ...(m.order_by ? [["Order by", date(m.order_by)] as [string, string]] : [])];
    case "anomaly":
      return [["Sold", fmt.int(num(m.actual))], ["Forecast", fmt.one(num(m.expected))],
        ["Ratio", `${fmt.one(num(m.ratio))}×`], ["FDR q-value", String(m.q ?? "—")]];
    case "trend":
      return [["Last 12 wk / wk", fmt.one(num(m.recent_weekly))], ["Forecast / wk", fmt.one(num(m.forecast_weekly))],
        ["Change", fmt.signedPct(num(m.change))], ["z-score", signed(num(m.z))]];
    case "stockout":
      return [["P(runs short)", fmt.pct(num(m.p_short))], ["Forecast 4 wk", fmt.int(num(m.forecast_4w))],
        ["Sold last 4 wk", fmt.int(num(m.last_4w))], ["Expected gap", fmt.int(num(m.expected_short))]];
    case "stockout_now":
      return [["On hand", fmt.int(num(m.on_hand))], [`Demand over ${fmt.int(num(m.lead_time_weeks))} wk`, fmt.one(num(m.lead_time_demand))],
        ["Short by", fmt.int(num(m.short))], ["Forecast / wk", fmt.one(num(m.weekly_rate))]];
    case "expiry":
      if (m.source === "ledger" && "expired_units" in m)
        return [["Expired units", fmt.int(num(m.expired_units))], ["Batches", fmt.int(num(m.batches))], ["Value at cost", fmt.inrFull(num(m.expired_value))]];
      if (m.source === "ledger")
        return [["Expires", date(m.expiry_date)], ["Batch qty", fmt.int(num(m.qty))],
          ["Left at expiry", `${fmt.int(num(m.proj_unsold))}–${fmt.int(num(m.proj_unsold_slow))}`], ["Days left", fmt.int(num(m.days_left))]];
      return [["Shelf life left", `${fmt.int(num(m.shelf_days))} d`],
        m.cover_days != null ? ["Planned cover", `${fmt.int(num(m.cover_days))} d`] : ["Days to sell 1 unit", `${fmt.int(num(m.days_per_unit))} d`],
        ["Order-up-to", fmt.int(num(m.order_up_to))], ["Sells / wk", num(m.weekly_rate)?.toFixed(2) ?? "—"]];
    case "data":
      if ("earlier_weekly" in m)
        return [["Silent weeks", fmt.int(num(m.weeks_silent))], ["Earlier / wk", fmt.one(num(m.earlier_weekly))],
          ["Weeks with sales", fmt.pct(num(m.sell_week_share))], ["Chance of silence", String(m.p ?? "—")]];
      return [["Units ever sold", fmt.int(num(m.total_units) ?? 0)]];
  }
}

/* Column count per number of key figures, so the hairline grid never shows empty grey cells. */
const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" };

/* Observed total against the forecast's 90% range: a single-series range glyph, labelled in text. */
function RangeGlyph({ actual, expected, sd, lo90, hi90 }: { actual: number; expected: number; sd: number; lo90: number | null; hi90: number | null }) {
  // Prefer the 5th-95th percentile of the distribution the test actually used; fall back to a normal range.
  const lo = lo90 ?? Math.max(0, expected - 1.645 * sd), hi = hi90 ?? expected + 1.645 * sd;
  const max = Math.max(hi, actual, 1) * 1.08;
  const x = (v: number) => `${(v / max) * 100}%`;
  const summary = `Forecast ${fmt.one(expected)} (90% range ${fmt.one(lo)}–${fmt.one(hi)}) · actual ${fmt.int(actual)}`;
  return (
    <div className="mt-4" title={summary}>
      <div className="relative h-6" role="img" aria-label={summary}>
        <div className="absolute inset-x-0 top-1/2 h-px bg-[var(--grid)]" />
        <div className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[4px]" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})`, background: C.s1, opacity: 0.2 }} />
        <div className="absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: x(expected), background: C.s1 }} />
        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-ink" style={{ left: x(actual) }} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3.5 rounded-[3px]" style={{ background: C.s1, opacity: 0.25 }} />Forecast 90% range {fmt.one(lo)}–{fmt.one(hi)}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-[2px] rounded-full" style={{ background: C.s1 }} />Forecast {fmt.one(expected)}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ink" />Actual {fmt.int(actual)}</span>
      </div>
    </div>
  );
}

export function SeverityPill({ severity }: { severity: Severity }) {
  const s = SEV[severity];
  const Icon = s.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold text-ink" style={{ background: s.wash }}>
      <Icon className="h-3.5 w-3.5" strokeWidth={2.2} style={{ color: s.color }} aria-hidden />
      {s.label}
    </span>
  );
}

export function AlertCard({ alert: a, done, onToggle, delay = 0 }: { alert: Alert; done: boolean; onToggle: () => void; delay?: number }) {
  const T = TYPE_META[a.type];
  const TypeIcon = T.icon;
  const sev = SEV[a.severity];
  const figures = metrics(a);
  const openLabel = a.medicine_id ? "Open medicine" : a.type === "season" ? "Open season" : "Open";
  const isAnomaly = a.type === "anomaly" && typeof a.metric.actual === "number" && typeof a.metric.expected === "number" && typeof a.metric.sd === "number";
  return (
    <article className={`card rise relative overflow-hidden transition-opacity ${done ? "opacity-60" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: sev.color }} aria-hidden />
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <SeverityPill severity={a.severity} />
          <span className="inline-flex items-center gap-1"><TypeIcon className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />{T.label}</span>
          {a.abc && <AbcBadge abc={a.abc} />}
          {a.category && <span className="min-w-0 max-w-full truncate">· {a.category}</span>}
          {a.impact_inr > 0 && <span className="ml-auto font-medium tnum text-ink-2" title="Estimated revenue at stake">{fmt.inrFull(a.impact_inr)} at stake</span>}
        </div>
        <h2 className={`mt-3 text-[16px] font-semibold leading-snug tracking-tight ${done ? "line-through decoration-ink-3/60" : ""}`}>{a.title}</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{a.detail}</p>

        <dl className={`mt-4 grid gap-px overflow-hidden rounded-xl border border-hairline bg-[var(--hairline)] ${GRID_COLS[figures.length] ?? GRID_COLS[4]}`}>
          {figures.map(([k, v]) => (
            <div key={k} className="bg-surface-2 px-3 py-2.5">
              <dt className="text-[11px] text-ink-3">{k}</dt>
              <dd className="mt-0.5 text-[14px] font-semibold tnum">{v}</dd>
            </div>
          ))}
        </dl>
        {isAnomaly && <RangeGlyph actual={a.metric.actual as number} expected={a.metric.expected as number} sd={a.metric.sd as number}
          lo90={num(a.metric.lo90)} hi90={num(a.metric.hi90)} />}

        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] font-medium text-ink"><span className="text-ink-3">Next step · </span>{a.action}</p>
          <div className="flex shrink-0 gap-2">
            <button onClick={onToggle} aria-label={`${done ? "Reopen" : "Mark as done"}: ${a.title}`}
              className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] font-medium text-ink-2 transition hover:bg-sunken">
              {done ? <><RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reopen</> : <><Check className="h-3.5 w-3.5" aria-hidden /> Mark as done</>}
            </button>
            <Link href={a.href} aria-label={`${openLabel}: ${a.medicine_name ?? a.title}`} className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-[#262624]">
              {openLabel} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
