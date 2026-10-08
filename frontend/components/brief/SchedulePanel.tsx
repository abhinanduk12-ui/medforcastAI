"use client";

import { useState } from "react";
import { CalendarClock, Check, CircleAlert, Mail, MessageCircle, RefreshCw } from "lucide-react";
import { apiSend, ApiError, useApi } from "@/lib/api";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { badEmails, badPhones, ChannelBadge, splitList } from "./SendDialog";
import { istDateTime, type ScheduleResp, type StoreSchedule } from "./types";

type Draft = { enabled: boolean; time: string; channels: ("email" | "whatsapp")[]; email: string; whatsapp: string };

const toDraft = (s: StoreSchedule): Draft => ({
  enabled: s.enabled, time: s.time, channels: [...s.channels].sort() as Draft["channels"],
  email: s.recipients.email.join(", "), whatsapp: s.recipients.whatsapp.join(", "),
});
const key = (d: Draft) => JSON.stringify({ ...d, channels: [...d.channels].sort() });
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Client-side mirror of the server's rules, so the owner sees the problem before saving. */
function problem(d: Draft): string | null {
  if (!TIME_RE.test(d.time)) return "Enter a time as HH:MM (24-hour, IST).";
  const e = badEmails(splitList(d.email)), w = badPhones(splitList(d.whatsapp));
  if (e.length) return `Not a valid email address: ${e.slice(0, 3).join(", ")}`;
  if (w.length) return `Not a valid phone number: ${w.slice(0, 3).join(", ")}`;
  if (d.enabled) {
    if (d.channels.length === 0) return "Choose at least one channel to enable the schedule.";
    const n = (d.channels.includes("email") ? splitList(d.email).length : 0) + (d.channels.includes("whatsapp") ? splitList(d.whatsapp).length : 0);
    if (n === 0) return "Add at least one recipient for the selected channels to enable the schedule.";
  }
  return null;
}

const runDate = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function StoreRow({ s, channelsOk, onSaved }: { s: StoreSchedule; channelsOk: ScheduleResp["channels"]; onSaved: (r: ScheduleResp) => void }) {
  const [d, setD] = useState<Draft>(() => toDraft(s));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Reset the draft only when THIS store's saved settings change, so saving one store does not
  // wipe unsaved edits in another row (every save returns fresh objects for all stores).
  const serverKey = key(toDraft(s));
  const [seenKey, setSeenKey] = useState(serverKey);
  if (seenKey !== serverKey) { setSeenKey(serverKey); setD(toDraft(s)); } // adjust state during render (React docs pattern)
  const dirty = key(d) !== serverKey;
  const invalid = problem(d);
  const edit = (patch: Partial<Draft>) => { setMsg(null); setD((cur) => ({ ...cur, ...patch })); };
  const toggle = (c: "email" | "whatsapp") => edit({ channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : [...d.channels, c] });

  async function save() {
    if (busy || invalid) return;
    setBusy(true); setMsg(null);
    try {
      const r = await apiSend<ScheduleResp>("PUT", "/api/brief/schedule", {
        store_id: s.store_id, enabled: d.enabled, time: d.time, channels: d.channels,
        recipients: { email: splitList(d.email), whatsapp: splitList(d.whatsapp) },
      });
      onSaved(r);
      setMsg({ ok: true, text: "Saved" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const id = `sched-${s.store_id}`;
  const unconfigured = d.enabled && d.channels.some((c) => !channelsOk[c]?.configured);
  return (
    <form className="border-t border-hairline px-6 py-5" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-labelledby={`${id}-name`} noValidate>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p id={`${id}-name`} className="text-[14px] font-semibold">{s.name}{s.simulated && <span className="ml-2 text-[12px] font-normal text-ink-3">simulated branch</span>}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {s.enabled ? `Next: ${istDateTime(s.next_run)}` : "Off"}
            {s.last_run ? ` · last run ${runDate(s.last_run.date)} (${s.last_run.status.replace(/_/g, " ")})` : ""}
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" role="switch" aria-checked={d.enabled} aria-label={`Send ${s.name}'s brief daily`} className="peer sr-only"
            checked={d.enabled} disabled={busy} onChange={(e) => edit({ enabled: e.target.checked })} />
          <span className="relative h-5 w-9 rounded-full bg-sunken transition peer-checked:bg-brand peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--brand)]" aria-hidden>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${d.enabled ? "left-[18px]" : "left-0.5"}`} />
          </span>
          <span aria-hidden>{d.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>
      <fieldset disabled={busy} className="mt-4 grid gap-4 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <label className={labelCls} htmlFor={`${id}-time`}>Time (IST)</label>
          <input id={`${id}-time`} type="time" required className={inputCls} value={d.time} aria-invalid={!TIME_RE.test(d.time)}
            onChange={(e) => edit({ time: e.target.value })} />
        </div>
        <div className="min-w-0">
          <div className={`${labelCls} flex items-center justify-between gap-2`}>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="focus-ring accent-[var(--brand)]" checked={d.channels.includes("email")} onChange={() => toggle("email")} />
              <Mail className="h-3.5 w-3.5" aria-hidden /> Email
            </label>
            <ChannelBadge ok={!!channelsOk.email?.configured} />
          </div>
          <input className={inputCls} type="text" inputMode="email" autoComplete="off" placeholder="owner@pharmacy.in" value={d.email}
            onChange={(e) => edit({ email: e.target.value })} aria-label={`Email recipients for ${s.name}`} />
        </div>
        <div className="min-w-0">
          <div className={`${labelCls} flex items-center justify-between gap-2`}>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="focus-ring accent-[var(--brand)]" checked={d.channels.includes("whatsapp")} onChange={() => toggle("whatsapp")} />
              <MessageCircle className="h-3.5 w-3.5" aria-hidden /> WhatsApp
            </label>
            <ChannelBadge ok={!!channelsOk.whatsapp?.configured} />
          </div>
          <input className={inputCls} type="text" inputMode="tel" autoComplete="off" placeholder="98765 43210" value={d.whatsapp}
            onChange={(e) => edit({ whatsapp: e.target.value })} aria-label={`WhatsApp numbers for ${s.name}`} />
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        {dirty && invalid ? (
          <span className="inline-flex min-w-0 items-start gap-1 text-[12.5px] text-ink-2" role="status">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--serious)" }} aria-hidden />{invalid}
          </span>
        ) : msg ? (
          <span className={`inline-flex min-w-0 items-start gap-1 text-[12.5px] ${msg.ok ? "text-good" : "text-ink-2"}`} role={msg.ok ? "status" : "alert"}>
            {msg.ok
              ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--critical)" }} aria-hidden />}
            {msg.ok ? msg.text : `Not saved: ${msg.text}`}
          </span>
        ) : dirty && unconfigured ? (
          <span className="text-[12px] text-ink-3">A channel that is not configured is logged as “not configured” until it is set up.</span>
        ) : null}
        {dirty && <button type="button" className={ghostBtn} disabled={busy} onClick={() => { setD(toDraft(s)); setMsg(null); }}>Discard</button>}
        <button type="submit" className={primaryBtn} disabled={busy || !dirty || !!invalid}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

export function SchedulePanel() {
  const { data, error, setData, reload, loading } = useApi<ScheduleResp>("/api/brief/schedule", { refetchOnStoreChange: false });
  return (
    <Card className="no-print overflow-hidden" delay={60}>
      <CardHeader title="Daily schedule"
        sub="Sends each store's brief once a day at the chosen time (Asia/Kolkata). Owners only."
        right={<CalendarClock className="h-5 w-5 text-ink-3" aria-hidden />} />
      {error && !data ? (
        <div className="flex flex-wrap items-center gap-3 px-6 py-5 text-[13px]" role="alert">
          <CircleAlert className="h-4 w-4 shrink-0 text-critical" aria-hidden />
          <span className="min-w-0 flex-1 text-ink-2">The schedule could not be loaded: {error}</span>
          <button className={ghostBtn} onClick={reload} disabled={loading}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>
        </div>
      ) : !data ? (
        <div className="space-y-3 px-6 py-5"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
      ) : (
        <>
          <p className="mt-2 px-6 pb-4 text-[12px] leading-relaxed text-ink-3">
            {data.scheduler.env_enabled
              ? `The scheduler checks every ${data.scheduler.tick_seconds} s and sends a missed brief up to ${data.scheduler.catch_up_hours} h late (e.g. after a restart), never twice a day.`
              : "The scheduler is turned off on this server (MEDFORECAST_BRIEF_SCHEDULER=0); schedules are saved but nothing is sent."}
            {data.scheduler.env_enabled && !data.scheduler.running ? " It is not running in this process yet; it starts with the API server." : ""}
            {data.scheduler.last_error ? ` Last scheduler error: ${data.scheduler.last_error}.` : ""}
            {" "}A channel that is not configured is logged as “not configured”, never as sent.
          </p>
          {data.stores.length === 0
            ? <p className="border-t border-hairline px-6 py-5 text-[13px] text-ink-3">No stores exist yet.</p>
            : data.stores.map((s) => <StoreRow key={s.store_id} s={s} channelsOk={data.channels} onSaved={setData} />)}
        </>
      )}
    </Card>
  );
}
