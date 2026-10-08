"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useApi } from "@/lib/api";
import { useDoneAlerts, type AlertsResp } from "./model";

/* Compact bell for the app shell: counts open critical + serious alerts, links to the Alert Center. */
export function AlertBell({ className = "" }: { className?: string }) {
  const { data } = useApi<AlertsResp>("/api/alerts");
  const { done } = useDoneAlerts();
  // Totals come from the uncapped server counts; only alerts the user has seen (the returned list)
  // can be marked done, so subtracting those gives the exact number still open.
  const doneOf = (s: "critical" | "serious") => data?.alerts.filter((a) => a.severity === s && done[a.id]).length ?? 0;
  const openCritical = data ? Math.max(0, data.counts.severity.critical - doneOf("critical")) : 0;
  const openSerious = data ? Math.max(0, data.counts.severity.serious - doneOf("serious")) : 0;
  const critical = openCritical > 0;
  const n = openCritical + openSerious;
  const label = !data ? "Alerts" : n === 0 ? "Alerts: no critical or serious alerts open"
    : `Alerts: ${openCritical} critical and ${openSerious} serious open`;
  return (
    <Link href="/alerts" aria-label={label} title={label}
      className={`focus-ring relative inline-grid h-10 w-10 place-items-center rounded-xl border border-hairline bg-surface text-ink-2 transition hover:bg-sunken hover:text-ink ${className}`}>
      <Bell className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden />
      {n > 0 && (
        <span aria-hidden className="absolute -right-1.5 -top-1.5 min-w-[20px] rounded-full border-2 border-surface px-1 text-center text-[11px] font-semibold leading-[16px] tnum text-white"
          style={{ background: critical ? "var(--critical)" : "var(--ink)" }}>
          {n > 99 ? "99+" : n}
        </span>
      )}
    </Link>
  );
}

export default AlertBell;
