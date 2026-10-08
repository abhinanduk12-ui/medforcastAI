"use client";

import type { LucideIcon } from "lucide-react";
import { CircleAlert, FlaskConical, Info, OctagonAlert, PackageSearch, Pill, Route, Scale, ScrollText, ShieldAlert } from "lucide-react";

export type Level = "critical" | "warning" | "info";

/** qty is null for single-store users: other branches' figures are redacted (presence only). */
export type StoreQty = { store_id: string; store_name?: string; qty: number | null; simulated?: boolean };

export type Flag = { kind: string; level: Level; label: string; text: string };
export type Warning = { level: Level; code: string; title: string; text: string };

export type StrengthParsed = {
  kind: "mass" | "mass_set" | "concentration" | "percent" | "volume" | "units" | "unknown";
  value: number | null; unit: string | null; per_value: number | null; per_unit: string | null;
  assumed: boolean; mg: number | null; label: string; raw: string | null;
  /** mass_set only: per-component masses of a combination. */
  components?: unknown[] | null;
};

export type Availability = {
  on_hand_here: number; earliest_expiry_here?: string | null; on_hand_other_stores: StoreQty[];
  on_hand_total: number | null; in_stock_elsewhere?: boolean; in_stock_anywhere?: boolean; transfer_hint: string | null;
};

export type Candidate = Availability & {
  id: string; name: string; generic: string; strength: string; strength_parsed: StrengthParsed; form: string;
  price: number | null; price_diff_pct: number | null; price_per_mg: number | null; price_per_mg_diff_pct: number | null;
  equivalent_dose_cost: number | null; savings_for_qty: number | null; qty: number;
  rx: boolean; rx_share: number | null; nti: boolean; category: string;
  tier: "exact" | "same_molecule"; match_note: string; reasons: string[]; flags: Flag[];
};

export type MedicineInfo = Availability & {
  id: string; name: string; generic: string; strength: string; strength_parsed: StrengthParsed; form: string;
  price: number | null; rx: boolean; rx_share: number | null; nti: boolean; category: string; abc: string | null;
  price_per_mg: number | null; form_conflict: string | null;
  molecule: { components: string[]; is_combination: boolean; qualifiers: string[]; key?: string; molecule_key?: string; label?: string };
};

export type StoreRow = { id: string; name: string; city: string; demand_scale: number; is_main: boolean; simulated: boolean; created_at?: string };

/**
 * Rupee amount for unit prices and price-per-mg. Values below ₹1 (typical per-mg prices such as ₹0.0062)
 * keep 2 significant digits instead of rounding to ₹0.00.
 */
export function inrPrecise(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = a !== 0 && a < 1
    ? a.toLocaleString("en-IN", { minimumSignificantDigits: 2, maximumSignificantDigits: 2 })
    : a.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}₹${s}`;
}

/** 'YYYY-MM-DD' -> '12 Apr 2027' (en-IN); null-safe. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export type SubstitutesResp = {
  medicine: MedicineInfo; store: StoreRow | null; qty: number;
  exact: Candidate[]; same_molecule: Candidate[]; warnings: Warning[];
  therapeutic_alternatives: { included: boolean; note: string };
  counts: { exact: number; same_molecule: number; exact_in_stock_here: number };
  assumptions: string[];
};

export type CatalogueProduct = {
  id: string; name: string; strength: string; form: string; price: number | null; price_per_mg: number | null;
  rx: boolean; rx_share: number | null; abc: string | null; form_conflict: string | null; strength_known: boolean;
  on_hand_here: number; on_hand_total: number | null; on_hand_other_stores: StoreQty[]; in_stock_anywhere?: boolean;
};

export type MoleculeGroup = {
  key: string; label: string; generic_names: string[]; components: string[]; is_combination: boolean; nti: boolean;
  rx: boolean; categories: string[]; n_products: number; products: CatalogueProduct[]; strengths: string[]; forms: string[];
  price_min: number | null; price_max: number | null; in_stock_here: number; in_stock_anywhere: number; exact_pairs: number;
};

export type CatalogueResp = {
  store_id: string; store: StoreRow | null; groups: MoleculeGroup[];
  summary: { products: number; molecules: number; multi_product_molecules: number; exact_pairs: number | null; combination_molecules: number };
  therapeutic_alternatives: { included: boolean; note: string };
  assumptions: string[];
};

export type OosItem = {
  medicine: MedicineInfo; weekly_demand: number | null; abc: string | null; warnings: Warning[];
  available_here: boolean; best: Candidate; exact?: Candidate[]; same_molecule?: Candidate[]; same_molecule_in_stock?: number;
};

export type OosResp = {
  store_id: string; store: StoreRow | null; items: OosItem[]; review_items: OosItem[];
  counts: { exact: number; review: number; exact_here: number }; note: string; weekly_demand_basis?: string;
};

export const LEVEL: Record<Level, { label: string; color: string; wash: string; ink: string; icon: LucideIcon }> = {
  critical: { label: "Critical", color: "var(--critical)", wash: "#fbeaea", ink: "#8f2222", icon: OctagonAlert },
  warning: { label: "Caution", color: "var(--warn)", wash: "#fef6e3", ink: "#7a5200", icon: CircleAlert },
  info: { label: "Note", color: "var(--ink-3)", wash: "var(--surface-sunken)", ink: "var(--ink-2)", icon: Info },
};

const FLAG_ICON: Record<string, LucideIcon> = {
  rx: ScrollText, nti: ShieldAlert, liquid_solid: FlaskConical, route: Route, form: Pill,
  data: PackageSearch, strength_unknown: PackageSearch, strength: Scale,
};

/** Safety badge: always icon + text label, colour is only a secondary cue. */
export function SafetyBadge({ flag, compact = false }: { flag: { kind?: string; code?: string; level: Level; label?: string; title?: string; text: string }; compact?: boolean }) {
  const m = LEVEL[flag.level];
  const Icon = FLAG_ICON[flag.kind ?? flag.code ?? ""] ?? m.icon;
  return (
    <span title={flag.text}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium ${compact ? "text-[11px]" : "text-[12px]"}`}
      style={{ background: m.wash, color: m.ink, borderColor: "transparent" }}>
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2.2} style={{ color: m.color }} aria-hidden />
      {flag.label ?? flag.title}
    </span>
  );
}

export function TierBadge({ tier }: { tier: "exact" | "same_molecule" }) {
  return tier === "exact" ? (
    <span className="inline-flex items-center rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-white">Exact substitute</span>
  ) : (
    <span className="inline-flex items-center rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">Same molecule · dose review</span>
  );
}

export function StockPill({ qty, label = "here" }: { qty: number; label?: string }) {
  const ok = qty > 0;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium tnum ${ok ? "bg-[#e9f6e9] text-good" : "bg-sunken text-ink-3"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-[var(--good)]" : "bg-[var(--ink-3)]"}`} aria-hidden />
      {ok ? `${qty} ${label}` : `None ${label}`}
    </span>
  );
}
