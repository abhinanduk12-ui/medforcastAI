"use client";

import { useEffect, useState } from "react";

export type Objective = "profit" | "fill_rate";

export type PlanRequest = {
  budget: number; lead_time: number; review: number; service_cap: number; margin_pct: number; holding_pct: number;
  objective: Objective; on_hand: Record<string, number>; categories?: string[]; abc?: string;
};

export type PlanLine = {
  medicine_id: string; medicine_name: string; category: string; abc: string; form: string; price: number; unit_cost: number;
  on_hand: number; qty: number; cap_qty: number; cost: number; demand_mu: number; demand_sd: number; model: "Normal" | "Poisson";
  served: number; added_served: number; fill_rate: number; supplier_id: string; supplier_share: number | null; n_suppliers: number;
  expected_profit: number;
};

export type POItem = { medicine_id: string; medicine_name: string; category: string; form: string; qty: number; unit_cost: number; cost: number; supplier_share: number | null };
export type PurchaseOrder = { supplier_id: string; lines: number; units: number; total: number; expected_profit: number; items: POItem[] };
export type FrontierPoint = { budget: number; fill_rate: number; profit: number; spend: number };

export type PlanResponse = {
  // The echo omits on_hand (it can be thousands of keys); unused filters come back as null.
  params: Omit<PlanRequest, "on_hand" | "categories" | "abc"> & {
    categories: string[] | null; abc: string | null;
    cover_weeks: number; forecast_start: string; on_hand_items: number; unknown_on_hand_ids: string[]; unknown_on_hand_count: number;
  };
  totals: {
    budget: number; spend: number; utilisation: number | null; unconstrained_spend: number; lines: number; units: number;
    fill_rate: number; fill_rate_on_hand_only: number; expected_profit: number; expected_demand: number; expected_served: number;
    items_considered: number; items_short_of_cap: number; marginal_value_per_rupee: number | null; marginal_value_per_1000: number | null; marginal_unit: string;
  };
  frontier: FrontierPoint[];
  lines: PlanLine[];
  purchase_orders: PurchaseOrder[];
  notes: { supplier: string; method: string; costs: string };
};

/** POST the plan request (debounced by the caller); keeps the previous result visible while re-solving.
 *  `empty` is set (instead of `error`) when the filters match no medicines (HTTP 404), so the page can show an
 *  empty state rather than a stale plan for different filters. */
export function usePlan(req: PlanRequest | null) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const body = req ? JSON.stringify(req) : null;

  useEffect(() => {
    if (!body) return;
    const ctl = new AbortController();
    setLoading(true);
    fetch("/api/optimizer/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          const detail = typeof j?.detail === "string" ? j.detail : Array.isArray(j?.detail) ? j.detail.map((d: { msg: string }) => d.msg).join("; ") : r.statusText;
          // A 404 with a JSON detail is "no medicines match"; a bare 404 means the route itself is missing.
          if (r.status === 404 && typeof j?.detail === "string" && j.detail !== "Not Found") return { empty: j.detail };
          throw new Error(`${r.status} ${detail}`);
        }
        return { plan: (await r.json()) as PlanResponse };
      })
      .then((res) => {
        if ("empty" in res) { setEmpty(res.empty); setError(null); return; }
        setData(res.plan); setEmpty(null); setError(null);
      })
      .catch((e) => { if (e.name !== "AbortError") setError(String(e.message ?? e)); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [body]);

  return { data, error, empty, loading };
}

export function downloadCsv(name: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
