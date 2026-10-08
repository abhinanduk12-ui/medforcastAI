"use client";

import { useState } from "react";
import { Check, MessageCircle, Moon, Phone, Send, SkipForward } from "lucide-react";
import { apiPost } from "@/lib/api";
import { DueBadge } from "./bits";
import type { DueItem, DueResp } from "./types";
import { CHANNEL_LABEL, dateShort } from "./types";

type LinkResp = { link: string; text: string; quiet_hours: boolean };
type SendResp = { status: string; sent: boolean; error: string | null };

const btn = "focus-ring inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink-2 transition hover:bg-sunken hover:text-ink disabled:opacity-50";

function Row({ r, api, onChanged, onOpen }: { r: DueItem; api: boolean; onChanged: () => void; onOpen: (pid: number) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tel, setTel] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setMsg(null);
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };
  const openLink = () => run("link", async () => {
    // Open the tab synchronously (keeps the click's user activation), then point it at the link.
    const w = r.channel === "whatsapp" ? window.open("", "_blank") : null;
    try {
      const res = await apiPost<LinkResp>(`/api/patients/reminders/${r.id}/link`);
      if (w) { w.opener = null; w.location.href = res.link; } else window.location.href = res.link;
      setMsg(res.quiet_hours ? "Opened. Note: it is quiet hours, consider sending in the morning. Then press Mark sent." : "Opened. Press send in the app, then Mark sent here.");
    } catch (e) { w?.close(); throw e; }
  });
  return (
    <li className="grid grid-cols-1 gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_auto] sm:items-center sm:px-6">
      <div className="min-w-0">
        <button onClick={() => onOpen(r.patient_id)} className="focus-ring truncate rounded text-left text-[14px] font-semibold hover:underline">{r.display_name}</button>
        <p className="text-[12px] text-ink-3 tnum">{r.masked_phone} · {CHANNEL_LABEL[r.channel]}</p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px]">{r.medicine_name} <span className="text-ink-3">· last {r.qty} units</span></p>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-3"><DueBadge days={r.days_to_due} /> {dateShort(r.due_date)}{!r.ready && <> · remind from {dateShort(r.remind_on)}</>}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        {r.channel === "call" ? (
          tel ? <a href={`tel:${tel}`} className={btn}><Phone className="h-3.5 w-3.5" aria-hidden />{tel}</a> : (
            <button className={btn} disabled={!!busy} onClick={() => run("tel", async () => {
              const res = await apiPost<{ phone: string }>(`/api/patients/${r.patient_id}/reveal`, { reason: "refill reminder call" }); setTel(res.phone);
            })} aria-label={`Show number to call ${r.display_name} (logged)`}><Phone className="h-3.5 w-3.5" aria-hidden />Call</button>
          )
        ) : (
          <button className={btn} disabled={!!busy} onClick={openLink} aria-label={`Open ${CHANNEL_LABEL[r.channel]} message to ${r.display_name}`}>
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />{r.channel === "whatsapp" ? "WhatsApp" : "SMS"}
          </button>
        )}
        {api && r.channel === "whatsapp" && (
          <button className={btn} disabled={!!busy} onClick={() => run("send", async () => {
            const res = await apiPost<SendResp>(`/api/patients/reminders/${r.id}/send`, {});
            if (res.sent) onChanged(); else setMsg(res.error ?? res.status);
          })}><Send className="h-3.5 w-3.5" aria-hidden />Send via API</button>
        )}
        <button className={btn} disabled={!!busy} onClick={() => run("sent", async () => {
          await apiPost(`/api/patients/reminders/${r.id}/mark-sent`, { channel: r.channel === "call" ? "call" : r.channel === "sms" ? "sms_link" : "whatsapp_link" }); onChanged();
        })}><Check className="h-3.5 w-3.5" aria-hidden />Mark sent</button>
        <button className={btn} disabled={!!busy} aria-label={`Skip reminder for ${r.display_name}`} onClick={() => run("skip", async () => {
          await apiPost(`/api/patients/reminders/${r.id}/skip`, { note: "skipped by staff" }); onChanged();
        })}><SkipForward className="h-3.5 w-3.5" aria-hidden /><span className="sr-only sm:not-sr-only">Skip</span></button>
      </div>
      {msg && <p role="status" className="text-[12px] text-ink-2 sm:col-span-3">{msg}</p>}
    </li>
  );
}

export function DueList({ data, onChanged, onOpen }: { data: DueResp; onChanged: () => void; onOpen: (pid: number) => void }) {
  if (!data.reminders.length) {
    return <p className="px-6 py-10 text-center text-[13px] text-ink-3">No refills due in the next {data.days} days. Reminders appear here once refills are recorded for consented patients.</p>;
  }
  return (
    <>
      {data.quiet_hours && (
        <p className="mx-5 mt-3 inline-flex items-center gap-1.5 rounded-lg bg-sunken px-2.5 py-1.5 text-[12px] text-ink-2 sm:mx-6">
          <Moon className="h-3.5 w-3.5" aria-hidden />Quiet hours ({data.quiet_window}): automatic sends are paused. Manual messages are your call.
        </p>
      )}
      <ul className="mt-2 divide-y divide-[var(--hairline)]">{data.reminders.map((r) => <Row key={r.id} r={r} api={data.whatsapp_api} onChanged={onChanged} onOpen={onOpen} />)}</ul>
    </>
  );
}
