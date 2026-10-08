"use client";

import { CircleCheck, Hourglass, Layers, Minus, PackageX, TriangleAlert, type LucideIcon } from "lucide-react";

export type StockStatus = "out" | "low" | "ok" | "excess" | "none";

export type StoreRef = { id: string; name: string; city?: string | null; demand_scale: number; is_main: boolean; simulated: boolean };

export type StockItem = {
  medicine_id: string; medicine_name: string; generic_name: string; category: string; form: string; abc: string;
  median_price: number; rx_share: number | null; on_hand: number; value: number; retail_value: number;
  earliest_expiry: string | null; days_to_expiry: number | null; n_batches: number; expired_qty: number; expired_value: number;
  weekly_rate: number; weeks_of_cover: number | null; cover_demand: number; safety_stock: number; order_up_to: number;
  policy: string; suggested_order: number; order_value: number; status: StockStatus; expiring: boolean; no_demand: boolean;
};

export type ItemsResp = {
  store: StoreRef; as_of: string; total: number;
  counts: { all: number; out: number; low: number; excess: number; ok: number; expiring: number; reorder: number; stocked: number };
  params: { lead_time: number; review: number; service: number; status: string; sort: string };
  items: StockItem[];
};

export type Window = { batches: number; units: number; value: number };
export type SummaryResp = {
  store: StoreRef; as_of: string; forecast_start: string; params: { lead_time: number; review: number; service: number };
  stock: { value_cost: number; value_retail: number; units: number; skus_in_stock: number; skus_total: number; batches: number };
  stockouts: { count: number; a_class: number; weekly_units_unserved: number };
  status_counts: Record<StockStatus, number>; expiring_count: number;
  near_expiry: Record<"30" | "60" | "90", Window>;
  expired_on_shelf: Window;
  projected_expiry_loss_90d: { units: number; value: number; units_slow: number; value_slow: number; batches: number };
  reorder: { lines: number; units: number; value_retail: number };
  cover_distribution: { bin: string; count: number }[];
  definitions: Record<string, string>;
};

export type Batch = {
  batch_id: number; batch_no: string; expiry_date: string; days_left: number; expired: boolean; qty: number;
  unit_cost: number; value: number; supplier_id: string | null; received_at: string; source: string;
  proj_sold: number; proj_unsold: number; proj_unsold_slow: number; loss_value: number;
};

export type Movement = {
  id: number; store_id: string; medicine_id: string; medicine_name: string | null; batch_id: number | null; kind: string;
  qty: number; unit_cost: number | null; ref: string | null; note: string | null; username: string | null; created_at: string;
  batch_no: string | null; expiry_date: string | null;
};

export type OtherStore = { store_id: string; name: string; simulated: boolean; on_hand: number; earliest_expiry: string | null;
  weekly_rate: number; weeks_of_cover: number | null; spare: number };

export type ItemDetail = {
  store: StoreRef; as_of: string; item: StockItem; batches: Batch[]; movements: Movement[]; movements_total: number;
  other_stores: OtherStore[]; recent_weekly_sales_main: number[]; forecast_weekly: number[]; forecast_weeks: string[];
};

export type ExpiringRow = {
  batch_id: number; medicine_id: string; medicine_name: string; category: string | null; abc: string | null; batch_no: string;
  expiry_date: string; days_left: number; expired: boolean; qty: number; unit_cost: number; value: number; supplier_id: string | null;
  proj_sold: number; proj_unsold: number; proj_unsold_slow: number; loss_value: number; loss_value_slow: number;
  sellout_share: number; will_sell_out: boolean;
};
export type ExpiringResp = {
  store: StoreRef; as_of: string; days: number; method: string;
  totals: { batches: number; units: number; value: number; expired_batches: number; expired_units: number; expired_value: number;
    at_risk_batches: number; proj_unsold_units: number; proj_loss_value: number; proj_unsold_units_slow: number; proj_loss_value_slow: number };
  rows: ExpiringRow[];
};

export type MovementsResp = { store: StoreRef; total: number; limit: number; offset: number; items: Movement[] };

export type Substitute = { medicine_id: string; medicine_name: string; generic_name: string; form: string; same_form: boolean;
  on_hand: number; median_price: number; rx_share: number | null };

export type Allocation = { batch_id: number; batch_no: string; expiry: string; qty: number; days_left?: number };

/* Status colours are reserved for state and always travel with an icon + label. */
export const STATUS: Record<StockStatus, { label: string; icon: LucideIcon; color: string; wash: string }> = {
  out: { label: "Out of stock", icon: PackageX, color: "var(--critical)", wash: "#fbeaea" },
  low: { label: "Low", icon: TriangleAlert, color: "var(--serious)", wash: "#fdf0ea" },
  ok: { label: "OK", icon: CircleCheck, color: "var(--good-ink)", wash: "#e8f5e8" },
  excess: { label: "Excess", icon: Layers, color: "var(--ink-2)", wash: "var(--surface-sunken)" },
  none: { label: "Not stocked", icon: Minus, color: "var(--ink-3)", wash: "transparent" },
};
export const EXPIRING = { label: "Expiring", icon: Hourglass, color: "#8a5a00", wash: "#fef6e3" };

export const MOVEMENT_LABEL: Record<string, string> = {
  receive: "Received", sale: "Sale", adjust: "Adjustment", transfer_out: "Transfer out", transfer_in: "Transfer in",
  expire_writeoff: "Expiry write-off",
};

export function coverText(w: number | null | undefined, onHand?: number) {
  if (w == null) return onHand ? "no demand" : "—";
  if (w === 0) return "0 wk";
  if (w < 1) return `${Math.max(1, Math.round(w * 7))} d`;
  if (w >= 52) return "52+ wk";
  return `${w < 10 ? w.toFixed(1) : Math.round(w)} wk`;
}

export function daysText(d: number | null | undefined) {
  if (d == null) return "—";
  if (d <= 0) return d === 0 ? "expires today" : `expired ${-d} d ago`;
  if (d < 60) return `${d} d`;
  if (d < 730) return `${Math.round(d / 30.4)} mo`;
  return `${(d / 365).toFixed(1)} yr`;
}

export const dateFmt = (iso: string | null | undefined) =>
  iso ? new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

export const dateTimeFmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export function todayIso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Store query string fragment ("" = the session's selected store). */
export const storeQs = (storeId: string | null | undefined, lead = "?") => (storeId ? `${lead}store_id=${encodeURIComponent(storeId)}` : "");
