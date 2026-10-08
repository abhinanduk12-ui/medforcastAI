"use client";

import { useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Clock, ShieldCheck, ShieldOff } from "lucide-react";
import type { Adherence, ConsentState, Notice } from "./types";
import { CHANNEL_LABEL, dueLabel } from "./types";

/** Due status: icon + label, never colour alone. */
export function DueBadge({ days }: { days: number | null | undefined }) {
  if (days == null) return <span className="inline-flex items-center gap-1 text-[12px] text-ink-3"><CalendarClock className="h-3.5 w-3.5" aria-hidden />No refill due</span>;
  const overdue = days < 0, soon = days <= 3;
  const Icon = overdue ? AlertTriangle : soon ? Clock : CalendarClock;
  const cls = overdue ? "bg-[#fdecea] text-[#8f2626]" : soon ? "bg-[#fff4dc] text-[#7a5300]" : "bg-sunken text-ink-2";
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ${cls}`}>
      <Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden />{dueLabel(days)}
    </span>
  );
}

export function ConsentBadge({ consent }: { consent: ConsentState }) {
  return consent.active ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-[#e8f5e8] px-1.5 py-0.5 text-[11.5px] font-medium text-good" title={`Consent ${consent.notice_version ?? ""}`}>
      <ShieldCheck className="h-3 w-3" strokeWidth={2.2} aria-hidden />Consent · {consent.channel ? CHANNEL_LABEL[consent.channel] : ""}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-[11.5px] font-medium text-ink-3">
      <ShieldOff className="h-3 w-3" strokeWidth={2.2} aria-hidden />No active consent
    </span>
  );
}

/** Privacy notice banner shown on top of the page. */
export function PrivacyBanner({ notice }: { notice: Notice | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card rise mb-6 border-l-4 !border-l-[var(--brand)] px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink" strokeWidth={1.8} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold">Personal data, consent only</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">
            Patients appear here only after they agree to refill reminders. Phone numbers are masked; every view, reveal and change is logged.
            Withdrawal stops tracking and reminders immediately, and erasure removes name and number for good.
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            Built with India&apos;s DPDP Act, 2023 in mind. This is not legal advice: verify the notice, consent process and retention period with counsel.
          </p>
        </div>
        {notice && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-sunken">
            Notice {notice.version} <ChevronDown className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
        )}
      </div>
      {open && notice && <div className="mt-3 border-t border-hairline pt-3"><NoticeText notice={notice} /></div>}
    </div>
  );
}

export function NoticeText({ notice }: { notice: Notice }) {
  return (
    <div className="text-[13px] leading-relaxed text-ink-2">
      <p className="font-medium text-ink">{notice.purpose}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{notice.points.map((p) => <li key={p}>{p}</li>)}</ul>
      <p className="mt-2 text-[12px] text-ink-3">{notice.legal_note}</p>
    </div>
  );
}

/** PDC meter: one bar with an 80% threshold tick, plus icon + label. */
export function AdherenceMeter({ a }: { a: Adherence }) {
  if (a.pdc == null) return <p className="text-[12px] text-ink-3">{a.reason ?? "Not enough data"}</p>;
  const pct = Math.round(a.pdc * 100);
  const good = !!a.adherent;
  const Icon = good ? CheckCircle2 : AlertTriangle;
  return (
    <div className="min-w-[160px]">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className={`inline-flex items-center gap-1 font-medium ${good ? "text-good" : "text-[#7a5300]"}`}>
          <Icon className="h-3.5 w-3.5" aria-hidden />{good ? "Adherent" : "Gaps in supply"}
        </span>
        <span className="tnum font-semibold">{pct}%</span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
        aria-label={`Proportion of days covered ${pct}%`} title={`${a.covered_days} of ${a.period_days} days covered`}>
        <div className="h-2 rounded-full bg-ink" style={{ width: `${Math.min(100, pct)}%` }} />
        <span className="absolute -top-0.5 h-3 w-[2px] rounded bg-ink-3" style={{ left: "80%" }} aria-hidden />
      </div>
      <p className="mt-1 text-[11px] text-ink-3">{a.covered_days} of {a.period_days} days covered · tick = 80%</p>
    </div>
  );
}

export function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p role="alert" className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{msg}</p>;
}
