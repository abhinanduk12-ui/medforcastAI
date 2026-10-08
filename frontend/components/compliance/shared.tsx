"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, FileWarning, Info, Pill, ShieldAlert, ShieldCheck, Stethoscope } from "lucide-react";
import type { ReactNode } from "react";

export type Schedule = "OTC" | "H" | "H1" | "X" | "NDPS";
export const SCHEDULES: Schedule[] = ["NDPS", "X", "H1", "H", "OTC"];

export const SCHEDULE_INFO: Record<Schedule, { label: string; blurb: string; cls: string; Icon: typeof Pill }> = {
  NDPS: { label: "NDPS", blurb: "Narcotic / psychotropic (NDPS Act) — register per sale", cls: "bg-ink text-white", Icon: ShieldAlert },
  X: { label: "Sch. X", blurb: "Schedule X — register per sale, prescription retained", cls: "bg-[#3d3c39] text-white", Icon: ShieldAlert },
  H1: { label: "Sch. H1", blurb: "Schedule H1 — register per sale", cls: "bg-brand-wash text-brand-ink border border-brand-soft", Icon: FileWarning },
  H: { label: "Sch. H", blurb: "Prescription only", cls: "bg-sunken text-ink-2", Icon: Stethoscope },
  OTC: { label: "OTC", blurb: "No prescription signal", cls: "border border-hairline text-ink-3", Icon: Pill },
};

export function ScheduleBadge({ s, compact = false }: { s: Schedule; compact?: boolean }) {
  const i = SCHEDULE_INFO[s] ?? SCHEDULE_INFO.OTC;
  return (
    <span title={i.blurb} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ${i.cls}`}>
      <i.Icon className="h-3 w-3" aria-hidden />
      {compact ? s : i.label}
    </span>
  );
}

export function ConfidencePill({ c }: { c: string }) {
  const cls = c === "high" ? "text-good" : c === "medium" ? "text-ink-2" : "text-ink-3";
  const Icon = c === "high" ? ShieldCheck : c === "medium" ? Info : AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{c} confidence
    </span>
  );
}

export function Disclaimer({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-2xl border border-hairline bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ title, children, icon: Icon = Info }: { title: string; children?: ReactNode; icon?: typeof Info }) {
  return (
    <div className="px-6 py-12 text-center">
      <Icon className="mx-auto h-6 w-6 text-ink-3" aria-hidden />
      <p className="mt-3 text-[14px] font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-3">{children}</div>}
    </div>
  );
}

export function InlineError({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-[#fdecea] px-3 py-2 text-[12.5px] text-[#a8302f]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{msg}
    </p>
  );
}

export function Pager({ total, offset, limit, onChange }: { total: number; offset: number; limit: number; onChange: (o: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-hairline px-6 py-3 text-[12.5px] text-ink-3">
      <span className="tnum">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="flex items-center gap-1">
        <button aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}
          className="focus-ring rounded-lg p-1.5 hover:bg-sunken disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
        <span className="tnum px-1">{page} / {pages}</span>
        <button aria-label="Next page" disabled={page >= pages} onClick={() => onChange(offset + limit)}
          className="focus-ring rounded-lg p-1.5 hover:bg-sunken disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export const th = "px-3 py-2.5 text-left text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 first:pl-6 last:pr-6";
export const td = "px-3 py-2.5 align-top first:pl-6 last:pr-6";
export const selectCls = "focus-ring h-10 rounded-xl border border-hairline bg-surface px-3 text-[13.5px]";

export const qs = (o: Record<string, string | number | null | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");

export const inr2 = (n?: number | null) => (n == null ? "—" : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
/** Shop calendar is IST: format timestamps in Asia/Kolkata; a bare YYYY-MM-DD is a calendar day (no timezone shift). */
const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" };
export const dt = (iso?: string | null) => {
  if (!iso) return "—";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(day ? `${iso}T12:00:00+05:30` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", DATE_OPTS);
};
/** Today / n days ago as YYYY-MM-DD on the IST calendar (toISOString() would give the UTC date before 05:30 IST). */
export const istDay = (daysAgo = 0) => new Date(Date.now() - daysAgo * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
/** "YYYY-MM-DD HH:MM" (already IST, from the API's sold_at_ist) -> "30 Sep 2026, 14:05". */
export const istStamp = (s?: string | null, withTime = true) => {
  if (!s) return "—";
  const [d, t] = s.split(" ");
  return withTime && t && t !== "00:00" ? `${dt(d)}, ${t}` : dt(d);
};
