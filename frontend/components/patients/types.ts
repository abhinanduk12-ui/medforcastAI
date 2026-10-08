export type Channel = "whatsapp" | "sms" | "call";
export const CHANNEL_LABEL: Record<Channel, string> = { whatsapp: "WhatsApp", sms: "SMS", call: "Phone call" };

export type ConsentState = { active: boolean; channel?: Channel; granted_at?: string; notice_version?: string };

export type PatientRow = {
  id: number; store_id: string; display_name: string; masked_phone: string | null; year_of_birth: number | null;
  created_at: string; updated_at: string | null; consent: ConsentState;
  next_due: string | null; days_to_due: number | null; n_medicines: number; last_dispense: string | null;
};
export type PatientsResp = { store_id: string; patients: PatientRow[]; counts: { due_7d: number } };

export type Notice = { version: string; title: string; purpose: string; points: string[]; legal_note: string; purpose_code: string };

export type DueItem = {
  id: number; patient_id: number; display_name: string; masked_phone: string | null; medicine_id: string; medicine_name: string;
  qty: number; due_date: string; remind_on: string; days_to_due: number; ready: boolean;
  state: "overdue" | "due_today" | "due_soon" | "upcoming"; channel: Channel;
};
export type DueResp = { store_id: string; days: number; reminders: DueItem[]; quiet_hours: boolean; quiet_window: string; whatsapp_api: boolean };

export type Adherence = { pdc: number | null; reason: string | null; period_days?: number; covered_days?: number; adherent?: boolean };
export type Consent = {
  id: number; purpose: string; notice_version: string; channel: Channel; granted_at: string; withdrawn_at: string | null;
  captured_by: number | null; withdrawn_by: number | null; evidence: string | null; withdraw_note: string | null;
};
export type Dispense = {
  id: number; medicine_id: string; medicine_name: string; qty: number; days_supply: number; store_id: string;
  invoice_no: string | null; dispensed_at: string; due_date: string; user_id: number | null;
};
export type Reminder = {
  id: number; medicine_id: string; medicine_name: string; dispense_id: number | null; qty: number; due_date: string;
  remind_on: string; status: "pending" | "sent" | "skipped" | "failed"; channel: string | null; sent_at: string | null; error: string | null;
};
export type MedSummary = {
  medicine_id: string; medicine_name: string; n_fills: number; last_dispensed: string; last_qty: number; days_supply: number;
  next_due: string | null; adherence: Adherence;
};
export type PatientDetail = Omit<PatientRow, "next_due" | "days_to_due" | "n_medicines" | "last_dispense"> & {
  consents: Consent[]; dispenses: Dispense[]; reminders: Reminder[]; medicines: MedSummary[]; adherence_note: string;
};

export type Settings = {
  notice_version: string; lead_days: number; quiet_start: string; quiet_end: string; retention_months: number; withdrawn_erase_days: number;
  include_medicine_name: boolean; auto_send: boolean; days_per_unit: Record<string, number>;
  channels: Record<string, { configured: boolean; detail: string }>; quiet_now: boolean;
  retention: { months: number; withdrawn_erase_days?: number; last_run: { at: string; erased: number } | null; due_for_erasure: number };
  can_edit: boolean; notices: string[];
};

export type AccessRow = { id: number; user_id: number | null; username: string | null; store_id: string | null; patient_id: number | null; action: string; detail: string | null; at: string };
export type AccessResp = { rows: AccessRow[]; total: number; limit: number; offset: number };

export type CommittedResp = {
  store_id: string; weeks: number; total_units: number; basis: string;
  medicines: { medicine_id: string; medicine_name: string; units: number; patients?: number }[];
};

/** 'YYYY-MM-DD' is a calendar date (shown as-is); a full ISO timestamp is shown in IST. */
export const dateShort = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const ts = iso.length > 10;
  const d = new Date(ts ? iso : iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", ...(ts ? { timeZone: "Asia/Kolkata" } : {}) });
};
export const dateTime = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—"
    : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
};

export function dueLabel(days: number | null | undefined): string {
  if (days == null) return "No refill due";
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}
