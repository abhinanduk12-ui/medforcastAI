"use client";

import { useCallback, useState } from "react";
import { Eye, Pill, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { apiPost, useApi } from "@/lib/api";
import { Modal, ghostBtn, primaryBtn } from "@/components/auth/Modal";
import { Skeleton } from "@/components/ui";
import { AdherenceMeter, ConsentBadge, ErrorNote } from "./bits";
import { DangerDialog, DispenseDialog, GrantConsentDialog } from "./Dialogs";
import type { Notice, PatientDetail } from "./types";
import { CHANNEL_LABEL, dateShort, dateTime } from "./types";

const STATUS_LABEL: Record<string, string> = { pending: "Pending", sent: "Sent", skipped: "Skipped", failed: "Failed" };

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
      {sub && <p className="mt-0.5 text-[12px] text-ink-3">{sub}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function PatientDetailDialog({ id, notice, onClose, onChanged }: {
  id: number | null; notice: Notice | null; onClose: () => void; onChanged: () => void;
}) {
  const { data, error, loading, setData } = useApi<PatientDetail>(id ? `/api/patients/${id}` : null, { refetchOnStoreChange: false });
  const [phone, setPhone] = useState<string | null>(null);
  const [revErr, setRevErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | "dispense" | "consent" | "withdraw" | "erase">(null);
  const close = useCallback(() => { setPhone(null); setRevErr(null); setDlg(null); onClose(); }, [onClose]);
  const closeSub = useCallback(() => setDlg(null), []);
  if (id == null) return null;
  const p = data && data.id === id ? data : null;
  const update = (np: PatientDetail) => { setData(np); onChanged(); };

  return (
    <>
      <Modal open={!dlg} onClose={close} title={p?.display_name ?? "Patient"} width={760}
        sub={p ? <span className="inline-flex flex-wrap items-center gap-2"><span className="tnum">{phone ?? p.masked_phone}</span>{p.year_of_birth ? <span>· born {p.year_of_birth}</span> : null}<ConsentBadge consent={p.consent} /></span> : undefined}>
        {error && !p ? <ErrorNote msg={error} /> : loading && !p ? (
          <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-32" /><Skeleton className="h-24" /></div>
        ) : p && (
          <div>
            <div className="flex flex-wrap gap-2">
              {p.consent.active && <button className={primaryBtn} onClick={() => setDlg("dispense")}><Pill className="h-4 w-4" aria-hidden />Record refill</button>}
              {!phone && (
                <button className={ghostBtn} onClick={async () => {
                  setRevErr(null);
                  try { setPhone((await apiPost<{ phone: string }>(`/api/patients/${p.id}/reveal`, { reason: "viewed in patient detail" })).phone); }
                  catch (e) { setRevErr((e as Error).message); }
                }} title="Shows the full number. This is recorded in the access log."><Eye className="h-4 w-4" aria-hidden />Reveal number (logged)</button>
              )}
              {p.consent.active
                ? <button className={ghostBtn} onClick={() => setDlg("withdraw")}><ShieldOff className="h-4 w-4" aria-hidden />Withdraw consent</button>
                : <button className={ghostBtn} onClick={() => setDlg("consent")}><ShieldCheck className="h-4 w-4" aria-hidden />Record consent</button>}
              <button className={`${ghostBtn} !text-[#a8302f]`} onClick={() => setDlg("erase")}><Trash2 className="h-4 w-4" aria-hidden />Erase</button>
            </div>
            <ErrorNote msg={revErr} />
            {!p.consent.active && (
              <p className="mt-3 rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-ink-2">No active consent: no reminders are sent and refills are not tracked. Personal details are erased automatically after the withdrawal grace period (owner setting), or sooner on request.</p>
            )}

            <Section title="Medicines & adherence" sub={p.adherence_note}>
              {p.medicines.length === 0 ? <p className="text-[13px] text-ink-3">No refills recorded yet.</p> : (
                <ul className="divide-y divide-[var(--hairline)] rounded-2xl border border-hairline">
                  {p.medicines.map((m) => (
                    <li key={m.medicine_id} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium">{m.medicine_name}</p>
                        <p className="text-[12px] text-ink-3 tnum">{m.n_fills} fill{m.n_fills === 1 ? "" : "s"} · last {m.last_qty} units on {dateShort(m.last_dispensed)} ({m.days_supply} days){m.next_due ? ` · next due ${dateShort(m.next_due)}` : ""}</p>
                      </div>
                      <AdherenceMeter a={m.adherence} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Refill timeline">
              {p.dispenses.length === 0 ? <p className="text-[13px] text-ink-3">Nothing yet.</p> : (
                <ol className="relative ml-2 border-l border-hairline">
                  {p.dispenses.slice(0, 30).map((d) => (
                    <li key={d.id} className="relative pb-3 pl-4">
                      <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-ink" aria-hidden />
                      <p className="text-[13px]"><span className="font-medium">{dateShort(d.dispensed_at)}</span> · {d.medicine_name}</p>
                      <p className="text-[12px] text-ink-3 tnum">{d.qty} units · {d.days_supply} days · covers to {dateShort(d.due_date)}{d.invoice_no ? ` · ${d.invoice_no}` : ""}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Section>

            <div className="grid gap-x-6 sm:grid-cols-2">
              <Section title="Consent history">
                <ul className="space-y-2">
                  {p.consents.map((c) => (
                    <li key={c.id} className="rounded-xl border border-hairline px-3 py-2 text-[12.5px]">
                      <p className="font-medium">{c.withdrawn_at ? "Withdrawn" : "Active"} · {CHANNEL_LABEL[c.channel]} · notice {c.notice_version}</p>
                      <p className="text-ink-3">Granted {dateTime(c.granted_at)}{c.evidence ? ` · ${c.evidence}` : ""}</p>
                      {c.withdrawn_at && <p className="text-ink-3">Withdrawn {dateTime(c.withdrawn_at)}{c.withdraw_note ? ` · ${c.withdraw_note}` : ""}</p>}
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Reminders">
                {p.reminders.length === 0 ? <p className="text-[13px] text-ink-3">None yet.</p> : (
                  <ul className="space-y-1.5 text-[12.5px]">
                    {p.reminders.slice(0, 12).map((r) => (
                      <li key={r.id} className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate">{dateShort(r.due_date)} · {r.medicine_name}</span>
                        <span className="shrink-0 text-ink-3" title={r.error ?? undefined}>{STATUS_LABEL[r.status] ?? r.status}{r.sent_at ? ` ${dateShort(r.sent_at)}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        )}
      </Modal>
      {dlg === "dispense" && <DispenseDialog patient={p} onClose={closeSub} onDone={update} />}
      {dlg === "consent" && <GrantConsentDialog patient={p} notice={notice} onClose={closeSub} onDone={update} />}
      {(dlg === "withdraw" || dlg === "erase") && (
        <DangerDialog kind={dlg} patient={p} onClose={closeSub} onDone={(k, np) => {
          if (k === "erase") { onChanged(); setDlg(null); close(); } else if (np) update(np);
        }} />
      )}
    </>
  );
}
