import { CircleAlert, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

export type Tone = "critical" | "serious" | "warning" | "info" | "good";
export type Tier = "out" | "before_delivery" | "before_review";

export type OrderItem = {
  medicine_id: string; medicine_name: string; category: string; form: string; abc: string; on_hand: number;
  weekly_rate: number; weeks_cover: number | null; order_up_to: number; suggested: number; order_value: number;
  tier: Tier; policy: string; rx_share: number | null;
};

export type ExpItem = {
  medicine_id: string; medicine_name: string; category: string | null; batch_id: number; batch_no: string;
  expiry_date: string; days_left: number; expired: boolean; qty: number; value: number; projected_unsold: number; unsold_value: number;
};

export type BriefAlert = {
  id: string; type: string; type_label: string; severity: "critical" | "serious" | "warning" | "info"; title: string;
  action: string | null; impact_inr: number; href: string | null; medicine_id: string | null; medicine_name: string | null;
};

export type Range = { units: number; value: number; lo: number; hi: number };

export type Brief = {
  store: { id: string; name: string; city: string | null; demand_scale: number; is_main: boolean; simulated: boolean };
  date: string; weekday: string; generated_at: string; greeting: string;
  data_window: { history_end: string; forecast_start: string; forecast_end: string; forecast_week: string; in_horizon: boolean; model_generated_at: string | null };
  focus: { rule: string; tone: Tone; title: string; detail: string; href: string };
  focus_rules: string[];
  headline: {
    expected_today: Range & { dow_share: number; forecast_week: string; in_horizon: boolean };
    expected_week: Range & { week: string };
    same_week_last_year: { week: string; units: number; value: number; change: number | null } | null;
    latest_actual_week: { week: string; units: number; value: number; change_vs_prior: number | null; days_old: number };
    yesterday_recorded: { date: string; units: number; lines: number; medicines: number; value: number };
  };
  stock: { value: number; in_stock: number; out_with_demand: number; medicines: number };
  order_today: {
    count: number; a_out?: number; a_out_names?: string[]; units: number; value: number; tiers: Record<Tier, number>; items: OrderItem[]; source: string;
    assumptions: { lead_weeks: number; review_weeks: number; service: number; cost_factor: number; note: string };
  };
  expiring: {
    expired: { batches: number; qty: number; value: number };
    within_30: { batches: number; value: number }; within_60: { batches: number; value: number }; within_90: { batches: number; value: number };
    at_risk: { batches: number; units: number; value: number };
    items: ExpItem[]; method: string;
  };
  alerts: { counts: Record<string, number>; total: number; top: BriefAlert[]; complete: boolean; note: string };
  season: {
    current: string; next: string; next_start: string; days_to_next: number; day_of_season: number; just_started: boolean;
    current_drivers: string | null; next_drivers: string | null;
    next_rising: { medicine_id: string; medicine_name: string; uplift: number; category: string }[];
    current_rising: { medicine_id: string; medicine_name: string; uplift: number; category: string }[];
    festivals: { name: string; start: string; end: string; days_to: number }[];
  };
  signals: { available: boolean; weather: string | null; outbreaks: string[]; headline?: string | null; high_risk?: boolean; stale?: boolean; source?: string | null; simulated?: boolean | null; note: string | null };
  notes: string[];
};

export type ShareResp = { store_id: string; date: string; text: string; chars: number; url: string };

export type ChannelStatus = Record<"email" | "whatsapp" | "share_link", { configured: boolean; detail: string }>;

export type SendResult = { channel: string; recipient: string; status: "sent" | "failed" | "not_configured" | "invalid" | "skipped"; error: string | null };
export type SendResp = { store_id: string; date: string; results: SendResult[]; summary: Record<string, number>; share_url: string; channels: ChannelStatus; recipients_masked?: boolean };

export type StoreSchedule = {
  store_id: string; name: string; city: string | null; simulated: boolean; enabled: boolean; time: string;
  channels: ("email" | "whatsapp")[]; recipients: { email: string[]; whatsapp: string[] }; next_run: string | null;
  last_run: { date: string; status: string; error: string | null; created_at: string } | null;
};
export type ScheduleResp = {
  timezone: string; stores: StoreSchedule[]; channels: ChannelStatus;
  scheduler: { env_enabled: boolean; running: boolean; last_tick: string | null; last_error: string | null; tick_seconds: number; catch_up_hours: number };
};

export type HistoryRow = {
  id: number; store_id: string; store_name: string | null; date: string; channel: string; recipient: string | null;
  status: string; error: string | null; trigger: string; created_at: string; username: string | null;
};
export type HistoryResp = { store_id: string | null; total: number; limit: number; offset: number; rows: HistoryRow[]; recipients_masked: boolean };

/* Status colours are reserved for state and always travel with an icon + label. */
export const TONE: Record<Tone, { label: string; color: string; wash: string; icon: LucideIcon }> = {
  critical: { label: "Act now", color: "var(--critical)", wash: "#fbeaea", icon: OctagonAlert },
  serious: { label: "Today", color: "var(--serious)", wash: "#fdf0ea", icon: TriangleAlert },
  warning: { label: "This week", color: "var(--warn)", wash: "#fef6e3", icon: CircleAlert },
  info: { label: "Plan ahead", color: "var(--brand)", wash: "var(--brand-wash)", icon: Info },
  good: { label: "All good", color: "var(--good)", wash: "#e8f5e8", icon: CircleCheck },
};

export const TIER_META: Record<Tier, { label: string; tone: Tone }> = {
  out: { label: "Out of stock", tone: "critical" },
  before_delivery: { label: "Runs out before delivery", tone: "serious" },
  before_review: { label: "Below reorder level", tone: "warning" },
};

export function coverText(w: number | null | undefined): string {
  if (w == null || !Number.isFinite(w)) return "No demand";
  if (w <= 0) return "None";
  const d = w * 7;
  return d < 1 ? "< 1 day" : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
}

/** "1 Oct 2026, 07:30 IST": timestamps shown in Asia/Kolkata, the time zone the schedule uses. */
export function istDateTime(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit",
  }) + " IST";
}

/** Signed percentage in neutral text (a demand change is not a good/bad status). */
export function signedPct(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  const v = Math.abs(x * 100).toFixed(digits);
  return `${x > 0 ? "+" : x < 0 ? "−" : "±"}${v}%`;
}

export function longDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
