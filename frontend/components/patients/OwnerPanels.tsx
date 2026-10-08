"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, History, Save } from "lucide-react";
import { apiPost, apiSend, useApi } from "@/lib/api";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { ErrorNote } from "./bits";
import type { AccessResp, Settings } from "./types";
import { dateTime } from "./types";

const ACTION_LABEL: Record<string, string> = {
  list: "Viewed list", view: "Opened patient", reveal_phone: "Revealed number", create: "Added patient", update: "Edited",
  consent_grant: "Consent recorded", consent_withdraw: "Consent withdrawn", dispense: "Refill recorded", erase: "Erased",
  due_list: "Viewed due list", lookup: "Searched (POS)", reminder_link: "Opened message link", reminder_sent: "Marked sent",
  reminder_skipped: "Skipped reminder", reminder_send: "API send", reminder_send_unconfigured: "API send (not configured)",
  reminder_retry: "Retried reminder", settings_update: "Changed settings",
};

export function AccessLogCard({ delay = 0 }: { delay?: number }) {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useApi<AccessResp>(`/api/patients/access-log?limit=50&offset=${offset}`, { refetchOnStoreChange: false });
  return (
    <Card delay={delay}>
      <CardHeader title="Access log" sub="Every read of personal data and every change. Owner only." right={<History className="h-4 w-4 text-ink-3" aria-hidden />} />
      <div className="mt-3 overflow-x-auto">
        {error ? <div className="px-6 pb-5"><ErrorNote msg={error} /></div> : loading && !data ? <div className="space-y-2 px-6 pb-5"><Skeleton className="h-8" /><Skeleton className="h-8" /></div> : (
          <table className="w-full min-w-[560px] text-[12.5px]">
            <thead><tr className="border-b border-hairline text-left text-ink-3">
              <th className="px-6 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Who</th><th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Patient</th><th className="py-2 pl-3 pr-6 font-medium">Detail</th></tr></thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} className="border-b border-hairline last:border-0">
                  <td className="whitespace-nowrap px-6 py-2 tnum text-ink-2">{dateTime(r.at)}</td>
                  <td className="px-3 py-2">{r.username ?? (r.user_id ? `user #${r.user_id}` : "system")}</td>
                  <td className="whitespace-nowrap px-3 py-2">{ACTION_LABEL[r.action] ?? r.action}</td>
                  <td className="px-3 py-2 tnum text-ink-2">{r.patient_id ? `#${r.patient_id}` : "—"}</td>
                  <td className="max-w-[260px] truncate py-2 pl-3 pr-6 text-ink-3" title={r.detail ?? undefined}>{r.detail ?? ""}</td>
                </tr>
              ))}
              {data && !data.rows.length && <tr><td colSpan={5} className="px-6 py-6 text-center text-ink-3">No access recorded yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {data && data.total > 50 && (
        <div className="flex items-center justify-between px-6 py-3 text-[12px] text-ink-3">
          <span className="tnum">{offset + 1}–{Math.min(offset + 50, data.total)} of {data.total}</span>
          <div className="flex gap-2">
            <button className={ghostBtn} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</button>
            <button className={ghostBtn} disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>Older</button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SettingsCard({ settings, onSaved, delay = 0 }: { settings: Settings; onSaved: () => void; delay?: number }) {
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => setF(settings), [settings]);
  const save = async () => {
    setBusy("save"); setErr(null); setOk(null);
    try {
      await apiSend("PUT", "/api/patients/settings", {
        lead_days: f.lead_days, quiet_start: f.quiet_start, quiet_end: f.quiet_end, retention_months: f.retention_months,
        withdrawn_erase_days: f.withdrawn_erase_days,
        include_medicine_name: f.include_medicine_name, auto_send: f.auto_send, days_per_unit: f.days_per_unit,
      });
      setOk("Saved."); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const forms = Object.keys(f.days_per_unit).filter((k) => k !== "_default");
  const wa = settings.channels.whatsapp;
  return (
    <Card delay={delay}>
      <CardHeader title="Reminder & retention settings" sub="Owner only. Applies to every store." />
      <div className="grid gap-4 px-6 pb-6 pt-4 sm:grid-cols-2">
        <label className="block"><span className={labelCls}>Remind days before due</span>
          <input type="number" min={0} max={14} className={inputCls} value={f.lead_days} onChange={(e) => setF({ ...f, lead_days: Number(e.target.value) })} /></label>
        <label className="block"><span className={labelCls}>Erase personal data after (months without a refill)</span>
          <input type="number" min={1} max={120} className={inputCls} value={f.retention_months} onChange={(e) => setF({ ...f, retention_months: Number(e.target.value) })} /></label>
        <label className="block sm:col-span-2"><span className={labelCls}>Erase personal data this many days after consent is withdrawn (0 = at the next daily run)</span>
          <input type="number" min={0} max={365} className={inputCls} value={f.withdrawn_erase_days ?? 30} onChange={(e) => setF({ ...f, withdrawn_erase_days: Number(e.target.value) })} /></label>
        <label className="block"><span className={labelCls}>Quiet hours start (IST)</span>
          <input type="time" className={inputCls} value={f.quiet_start} onChange={(e) => setF({ ...f, quiet_start: e.target.value })} /></label>
        <label className="block"><span className={labelCls}>Quiet hours end (IST)</span>
          <input type="time" className={inputCls} value={f.quiet_end} onChange={(e) => setF({ ...f, quiet_end: e.target.value })} /></label>
        <label className="flex items-start gap-2.5 text-[13px] text-ink-2 sm:col-span-2">
          <input type="checkbox" className="focus-ring mt-0.5 h-4 w-4 accent-[var(--ink)]" checked={f.include_medicine_name} onChange={(e) => setF({ ...f, include_medicine_name: e.target.checked })} />
          <span>Name the medicine in the message. Off by default: a medicine name is health data and the message passes through WhatsApp/SMS providers.</span>
        </label>
        <label className="flex items-start gap-2.5 text-[13px] text-ink-2 sm:col-span-2">
          <input type="checkbox" className="focus-ring mt-0.5 h-4 w-4 accent-[var(--ink)]" checked={f.auto_send} onChange={(e) => setF({ ...f, auto_send: e.target.checked })} />
          <span>Send due WhatsApp reminders automatically (outside quiet hours).{" "}
            <span className="inline-flex items-center gap-1 font-medium">{wa?.configured ? <><CheckCircle2 className="h-3.5 w-3.5 text-good" aria-hidden />Cloud API configured</> : <><CircleSlash className="h-3.5 w-3.5" aria-hidden />Cloud API not configured, so nothing is sent automatically</>}</span>
          </span>
        </label>
        <fieldset className="sm:col-span-2">
          <legend className={labelCls}>Default days of supply per unit, by form (used when the pharmacist leaves days blank)</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2">
            {forms.map((k) => (
              <label key={k} className="flex items-center gap-2 text-[12.5px]"><span className="w-20 shrink-0 truncate text-ink-2">{k}</span>
                <input type="number" step="0.5" min={0.1} max={120} className={`${inputCls} !h-8`} value={f.days_per_unit[k]}
                  onChange={(e) => setF({ ...f, days_per_unit: { ...f.days_per_unit, [k]: Number(e.target.value) } })} aria-label={`Days per ${k} unit`} /></label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <button className={primaryBtn} disabled={!!busy} onClick={save}><Save className="h-4 w-4" aria-hidden />{busy === "save" ? "Saving…" : "Save settings"}</button>
          <button className={ghostBtn} disabled={!!busy} onClick={async () => {
            setBusy("ret"); setErr(null); setOk(null);
            try { const r = await apiPost<{ erased: number }>("/api/patients/retention/run"); setOk(`Retention applied: ${r.erased} patient(s) erased.`); onSaved(); }
            catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
          }}>Apply retention now ({settings.retention.due_for_erasure} due)</button>
          <span className="text-[12px] text-ink-3">Daily job last ran {settings.retention.last_run ? dateTime(settings.retention.last_run.at) : "never"}.</span>
        </div>
        {ok && <p role="status" className="text-[12.5px] text-good sm:col-span-2">{ok}</p>}
        <div className="sm:col-span-2"><ErrorNote msg={err} /></div>
        <p className="text-[12px] leading-relaxed text-ink-3 sm:col-span-2">
          STOP replies: there is no inbound webhook. When a patient replies STOP or asks at the counter, withdraw consent on their record. It takes effect immediately.
        </p>
      </div>
    </Card>
  );
}
