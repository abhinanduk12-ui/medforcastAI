"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, CircleAlert, CloudSun, DatabaseZap, Hourglass, Info, OctagonAlert, PackageMinus, PackageX, TrendingUp, TriangleAlert,
  type LucideIcon,
} from "lucide-react";

export const SEVERITIES = ["critical", "serious", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const TYPES = ["season", "anomaly", "trend", "stockout", "stockout_now", "expiry", "data"] as const;
export type AlertType = (typeof TYPES)[number];

export type Alert = {
  id: string; type: AlertType; type_label: string; severity: Severity; title: string; detail: string; action: string;
  impact_inr: number; metric: Record<string, number | string | boolean | null>; medicine_id: string | null;
  medicine_name: string | null; abc: string | null; category: string | null; href: string;
};

export type AlertsResp = {
  generated_at: string; as_of: string; history_end: string; forecast_start: string;
  store?: { id: string; name: string; demand_scale: number; simulated: boolean } | null;
  counts: { severity: Record<Severity, number>; type: Record<AlertType, number>; total: number };
  matched: number; hidden: Partial<Record<AlertType, number>>; cap_per_type: number;
  type_labels: Record<AlertType, string>;
  thresholds: Record<string, number>;
  alerts: Alert[];
};

/* Status colours are reserved for severity and always travel with an icon + label. */
export const SEV: Record<Severity, { label: string; color: string; wash: string; icon: LucideIcon; hint: string }> = {
  critical: { label: "Critical", color: "var(--critical)", wash: "#fbeaea", icon: OctagonAlert, hint: "Act today" },
  serious: { label: "Serious", color: "var(--serious)", wash: "#fdf0ea", icon: TriangleAlert, hint: "Act this week" },
  warning: { label: "Warning", color: "var(--warn)", wash: "#fef6e3", icon: CircleAlert, hint: "Plan for it" },
  info: { label: "Info", color: "var(--ink-3)", wash: "var(--surface-sunken)", icon: Info, hint: "Good to know" },
};

export const TYPE_META: Record<AlertType, { label: string; icon: LucideIcon; blurb: string }> = {
  season: { label: "Season transition", icon: CloudSun, blurb: "Next season within a quarter; categories and medicines rising 8% or more" },
  anomaly: { label: "Demand anomaly", icon: Activity, blurb: "Recent weeks outside the forecast distribution, false discovery rate 5%" },
  trend: { label: "Trend shift", icon: TrendingUp, blurb: "Forecast run-rate moves 25% or more from the last 12 weeks, z ≥ 2.58" },
  stockout: { label: "Stockout risk", icon: PackageX, blurb: "A-class items where reordering last month's sales likely runs short" },
  stockout_now: { label: "Stockout now", icon: PackageMinus, blurb: "A/B items whose live on-hand stock in the selected store is below forecast demand over the supplier lead time" },
  expiry: { label: "Expiry risk", icon: Hourglass, blurb: "Expired stock still on the shelf, batches projected (FEFO, at the forecast rate) not to sell out within 90 days, and planned stock that outlives half the typical shelf life" },
  data: { label: "Data quality", icon: DatabaseZap, blurb: "Never sold, or unexpectedly silent for 8 weeks" },
};

/* "Mark as done" lives in this browser only. Every access is guarded: storage can be blocked. */
const KEY = "medforecast.alerts.done.v1";
const EVENT = "medforecast:alerts-done";

function readDone(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function useDoneAlerts() {
  const [done, setDone] = useState<Record<string, number>>({});
  useEffect(() => {
    const sync = () => setDone(readDone());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  const toggle = useCallback((id: string) => {
    const next = { ...readDone() };
    if (next[id]) delete next[id];
    else next[id] = Date.now();
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: keep the change for this session only */
    }
    setDone(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { done, toggle };
}
