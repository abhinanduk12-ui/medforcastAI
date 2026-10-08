"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Eye, EyeOff, Inbox } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, ErrorState, PageHeader, PageSkeleton, Segmented } from "@/components/ui";
import { AlertCard } from "@/components/alerts/AlertCard";
import { SEV, SEVERITIES, TYPE_META, TYPES, useDoneAlerts, type AlertType, type AlertsResp, type Severity } from "@/components/alerts/model";

const LEADS = ["0", "1", "2", "3", "4"] as const;

function Chip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition ${
        active ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:border-[var(--hairline-strong)] hover:text-ink"}`}>
      {children}
      {count != null && <span className={`tnum text-[12px] ${active ? "text-white/70" : "text-ink-3"}`}>{count}</span>}
    </button>
  );
}

export default function AlertsPage() {
  const [lead, setLead] = useState<(typeof LEADS)[number]>("1");
  const [sev, setSev] = useState<Severity | null>(null);
  const [type, setType] = useState<AlertType | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { data, error, loading } = useApi<AlertsResp>(`/api/alerts?lead_time=${lead}`);
  const { done, toggle } = useDoneAlerts();

  // Counts and ₹ at stake reflect what is still open, so the tiles shrink as work gets done.
  const open = useMemo(() => data?.alerts.filter((a) => !done[a.id]) ?? [], [data, done]);
  const bySev = useMemo(() => Object.fromEntries(SEVERITIES.map((s) => {
    const xs = open.filter((a) => a.severity === s);
    return [s, { n: xs.length, inr: xs.reduce((t, a) => t + a.impact_inr, 0) }];
  })) as Record<Severity, { n: number; inr: number }>, [open]);
  const byType = useMemo(() => Object.fromEntries(TYPES.map((t) => [t, open.filter((a) => a.type === t && (!sev || a.severity === sev)).length])) as Record<AlertType, number>, [open, sev]);
  const doneCount = data ? data.alerts.length - open.length : 0;

  const list = useMemo(() => (data?.alerts ?? []).filter((a) =>
    (showDone || !done[a.id]) && (!sev || a.severity === sev) && (!type || a.type === type)), [data, done, showDone, sev, type]);

  if (error) return <ErrorState error={error} />;
  if (!data) return <PageSkeleton />;

  const hidden = Object.entries(data.hidden) as [AlertType, number][];

  return (
    <>
      <PageHeader eyebrow="Alert center" title="What needs your attention"
        actions={
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            <span className="text-[12px] text-ink-3" aria-live="polite">Supplier lead time for order-by dates{loading ? " · updating…" : ""}</span>
            <Segmented options={LEADS} value={lead} onChange={setLead} render={(v) => `${v} wk`} />
          </div>
        }>
        Every alert passes a statistical test, so the inbox stays quiet unless the data really says something.
        Sales history runs to the week of {fmt.weekYear(data.history_end)}; forecasts start {fmt.weekYear(data.forecast_start)}.
        Anomalies are judged on the most recent weeks we have, not on today ({fmt.weekYear(data.as_of)}).
      </PageHeader>

      {/* Severity tiles: icon + label + count, never colour alone. Click to filter. */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {SEVERITIES.map((s, i) => {
          const m = SEV[s];
          const Icon = m.icon;
          const active = sev === s;
          return (
            <button key={s} onClick={() => setSev(active ? null : s)} aria-pressed={active}
              className={`card rise focus-ring relative overflow-hidden p-5 text-left transition hover:-translate-y-px ${active ? "ring-2 ring-ink" : ""}`}
              style={{ animationDelay: `${i * 40}ms` }}>
              <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: m.color }} aria-hidden />
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  <Icon className="h-4 w-4" strokeWidth={2.2} style={{ color: m.color }} aria-hidden />{m.label}
                </span>
                <span className="text-[11px] text-ink-3">{m.hint}</span>
              </div>
              <p className="mt-3 text-[30px] font-semibold leading-none tracking-[-0.02em] tnum">{bySev[s].n}</p>
              <p className="mt-2.5 text-[12px] text-ink-3">{bySev[s].inr > 0 ? `${fmt.inr(bySev[s].inr)} at stake` : "No revenue at stake"}</p>
            </button>
          );
        })}
      </div>

      <Card className="mt-6 p-4 sm:p-5" delay={160}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={!type} onClick={() => setType(null)} count={TYPES.reduce((t, k) => t + byType[k], 0)}>All types</Chip>
          {TYPES.map((t) => {
            const Icon = TYPE_META[t].icon;
            return (
              <Chip key={t} active={type === t} onClick={() => setType(type === t ? null : t)} count={byType[t]}>
                <Icon className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden />{TYPE_META[t].label}
              </Chip>
            );
          })}
          <button onClick={() => setShowDone(!showDone)} aria-pressed={showDone}
            className="focus-ring ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-ink-2 hover:bg-sunken">
            {showDone ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
            {showDone ? "Hide done" : "Show done"} <span className="tnum text-ink-3">{doneCount}</span>
          </button>
        </div>
        {type && <p className="mt-3 text-[12px] text-ink-3">{TYPE_META[type].label}: {TYPE_META[type].blurb}.</p>}
        {sev && <p className="mt-2 text-[12px] text-ink-3">Showing {SEV[sev].label.toLowerCase()} alerts only. Click the tile again to clear.</p>}
      </Card>

      <section aria-label="Alerts" aria-busy={loading} className={`mt-6 space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
        {list.length === 0 ? (
          <div className="card rise flex flex-col items-center px-6 py-14 text-center">
            {open.length === 0
              ? <CheckCircle2 className="h-9 w-9 text-good" strokeWidth={1.6} aria-hidden />
              : <Inbox className="h-9 w-9 text-ink-3" strokeWidth={1.6} aria-hidden />}
            <p className="mt-4 text-[16px] font-semibold">
              {data.alerts.length === 0 ? "Nothing needs attention" : open.length === 0 ? "All caught up" : "Nothing matches these filters"}
            </p>
            <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-3">
              {data.alerts.length === 0
                ? "No test crossed its threshold on the current data. New alerts appear when the forecast is retrained or the season turns."
                : open.length === 0
                  ? "Every alert is marked as done. New ones appear when the forecast is retrained or the season turns."
                  : "Try another severity or type, or turn on “Show done” to see alerts you have already handled."}
            </p>
          </div>
        ) : list.map((a, i) => <AlertCard key={a.id} alert={a} done={!!done[a.id]} onToggle={() => toggle(a.id)} delay={Math.min(i, 8) * 35} />)}
      </section>

      {hidden.length > 0 && (
        <p className="mt-4 text-[12px] text-ink-3">
          To keep the inbox readable, each type shows its {data.cap_per_type} highest-priority alerts. Not shown:{" "}
          {hidden.map(([t, n]) => `${n} ${TYPE_META[t].label.toLowerCase()}`).join(", ")}.
        </p>
      )}

      <Card className="mt-8 p-6" delay={80}>
        <p className="eyebrow mb-3">How alerts are decided</p>
        <ul className="grid gap-x-8 gap-y-3 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2">
          {TYPES.map((t) => {
            const Icon = TYPE_META[t].icon;
            return (
              <li key={t} className="flex gap-2.5">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.9} aria-hidden />
                <span><b className="font-semibold text-ink">{TYPE_META[t].label}.</b> {TYPE_META[t].blurb}.</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
          “At stake” is a rough revenue estimate at median selling price (extra or missing units × price), used only to rank alerts.
          Shelf life is the 10th percentile of days-to-expiry on batches when sold. Anomaly tests count demand in typical
          purchase sizes, so an item that sells in occasional large packs is not flagged for a few quiet weeks.
          “Done” is saved in this browser only.
        </p>
      </Card>
    </>
  );
}
