"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { ErrorNote, NoticeText } from "./bits";
import type { Channel, Notice, PatientDetail, PatientRow } from "./types";
import { CHANNEL_LABEL } from "./types";

const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const EVIDENCE_PRESETS = ["Verbal at counter, notice read out", "Signed consent form", "Notice sent on WhatsApp, patient replied YES"];

function ConsentFields({ notice, channel, setChannel, evidence, setEvidence, confirmed, setConfirmed }: {
  notice: Notice; channel: Channel; setChannel: (c: Channel) => void; evidence: string; setEvidence: (s: string) => void;
  confirmed: boolean; setConfirmed: (b: boolean) => void;
}) {
  return (
    <fieldset className="mt-4 rounded-2xl border border-hairline p-4">
      <legend className="px-1 text-[12.5px] font-semibold">Consent · purpose: refill reminders · notice {notice.version}</legend>
      <div className="max-h-44 overflow-y-auto rounded-xl bg-sunken px-3 py-2.5"><NoticeText notice={notice} /></div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>Remind by</span>
          <select className={inputCls} value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Evidence of consent</span>
          <input className={inputCls} list="consent-evidence" value={evidence} maxLength={200} required
            placeholder="e.g. signed form ref 123" onChange={(e) => setEvidence(e.target.value)} />
          <datalist id="consent-evidence">{EVIDENCE_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
      </div>
      <label className="mt-3 flex items-start gap-2.5 text-[13px] text-ink-2">
        <input type="checkbox" className="focus-ring mt-0.5 h-4 w-4 accent-[var(--ink)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I gave the patient this notice and they freely agreed to refill reminders. They know they can say no or stop at any time.</span>
      </label>
    </fieldset>
  );
}

export function NewPatientDialog({ open, onClose, notice, onCreated }: {
  open: boolean; onClose: () => void; notice: Notice | null; onCreated: (p: PatientRow) => void;
}) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [yob, setYob] = useState("");
  const [channel, setChannel] = useState<Channel>("whatsapp"); const [evidence, setEvidence] = useState(EVIDENCE_PRESETS[0]);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setPhone(""); setYob(""); setConfirmed(false); setErr(null); setChannel("whatsapp"); setEvidence(EVIDENCE_PRESETS[0]); } }, [open]);
  if (!notice) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const p = await apiPost<PatientRow>("/api/patients", {
        display_name: name.trim(), phone: phone.trim(), year_of_birth: yob ? Number(yob) : null,
        consent: { notice_version: notice.version, channel, evidence: evidence.trim(), confirmed },
      });
      onCreated(p); onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add patient for refill reminders" sub="Collect only what is needed: a first name or initials and a mobile number." width={560}>
      <form onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1.2fr_0.8fr]">
          <label className="block"><span className={labelCls}>Name shown to staff</span>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="First name or initials" autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Mobile</span>
            <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} required inputMode="tel" placeholder="98765 43210" autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Birth year <span className="font-normal text-ink-3">(optional)</span></span>
            <input className={inputCls} value={yob} onChange={(e) => setYob(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="1962" /></label>
        </div>
        <ConsentFields {...{ notice, channel, setChannel, evidence, setEvidence, confirmed, setConfirmed }} />
        <ErrorNote msg={err} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={busy || !confirmed || !name.trim() || !phone.trim() || evidence.trim().length < 2} className={primaryBtn}>
            {busy ? "Saving…" : "Record consent & add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function GrantConsentDialog({ patient, notice, onClose, onDone }: {
  patient: PatientDetail | null; notice: Notice | null; onClose: () => void; onDone: (p: PatientDetail) => void;
}) {
  const [channel, setChannel] = useState<Channel>("whatsapp"); const [evidence, setEvidence] = useState(EVIDENCE_PRESETS[0]);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setConfirmed(false); setErr(null); }, [patient]);
  if (!notice || !patient) return null;
  return (
    <Modal open onClose={onClose} title={`Record consent · ${patient.display_name}`} width={560}>
      <form onSubmit={async (e) => {
        e.preventDefault(); if (busy || !confirmed || evidence.trim().length < 2) return;
        setBusy(true); setErr(null);
        try { onDone(await apiPost<PatientDetail>(`/api/patients/${patient.id}/consent`, { notice_version: notice.version, channel, evidence: evidence.trim(), confirmed })); onClose(); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <ConsentFields {...{ notice, channel, setChannel, evidence, setEvidence, confirmed, setConfirmed }} />
        <ErrorNote msg={err} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={busy || !confirmed || evidence.trim().length < 2} className={primaryBtn}>{busy ? "Saving…" : "Record consent"}</button>
        </div>
      </form>
    </Modal>
  );
}

type MedHit = { id: string; name: string; form: string };
type DefaultDays = { days_supply: number; basis: string };

export function DispenseDialog({ patient, onClose, onDone }: { patient: PatientDetail | null; onClose: () => void; onDone: (p: PatientDetail) => void }) {
  const [q, setQ] = useState(""); const [hits, setHits] = useState<MedHit[]>([]); const [med, setMed] = useState<MedHit | null>(null);
  const [qty, setQty] = useState("30"); const [days, setDays] = useState(""); const [def, setDef] = useState<DefaultDays | null>(null);
  const [date, setDate] = useState(""); const [inv, setInv] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setQ(""); setHits([]); setMed(null); setQty("30"); setDays(""); setDef(null); setInv(""); setErr(null); setDate(todayIST()); }, [patient]);
  useEffect(() => {
    if (med || q.trim().length < 2) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(() => apiGet<{ items: MedHit[] }>(`/api/medicines?q=${encodeURIComponent(q.trim())}&limit=8&sort=total_units`)
      .then((r) => { if (alive) setHits(r.items); }).catch(() => { if (alive) setHits([]); }), 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, med]);
  useEffect(() => {
    const n = Number(qty);
    if (!med || !Number.isInteger(n) || n < 1) { setDef(null); return; }
    let alive = true;
    apiGet<DefaultDays>(`/api/patients/default-days?medicine_id=${encodeURIComponent(med.id)}&qty=${n}`)
      .then((r) => { if (alive) setDef(r); }).catch(() => { if (alive) setDef(null); });
    return () => { alive = false; };
  }, [med, qty]);
  if (!patient) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!med) return; setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ patient: PatientDetail }>(`/api/patients/${patient.id}/dispenses`, {
        medicine_id: med.id, qty: Number(qty), days_supply: days ? Number(days) : null, invoice_no: inv.trim() || null, dispensed_at: date || null,
      });
      onDone(r.patient); onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Record refill · ${patient.display_name}`} sub="Sets the next due date. Use the prescribed dose for days of supply." width={520}>
      <form onSubmit={submit}>
        {med ? (
          <div>
            <span className={labelCls}>Medicine</span>
            <div className="flex items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[13.5px]">
              <span className="truncate font-medium">{med.name} <span className="font-normal text-ink-3">· {med.form}</span></span>
              <button type="button" className="focus-ring rounded-lg px-2 py-0.5 text-[12px] text-ink-2 hover:bg-sunken" onClick={() => { setMed(null); setQ(""); }}
                aria-label={`Change medicine (selected: ${med.name})`}>Change</button>
            </div>
          </div>
        ) : (
          <label className="block"><span className={labelCls}>Medicine</span>
            <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by brand or generic" autoComplete="off"
              role="combobox" aria-expanded={hits.length > 0} aria-controls="disp-med-list" aria-autocomplete="list" />
          </label>
        )}
        {!med && hits.length > 0 && (
          <ul id="disp-med-list" role="listbox" className="mt-1 max-h-52 overflow-y-auto rounded-xl border border-hairline">
            {hits.map((h) => (
              <li key={h.id} role="option" aria-selected={false}>
                <button type="button" onClick={() => setMed(h)} className="focus-ring w-full px-3 py-2 text-left text-[13px] hover:bg-sunken">
                  {h.name} <span className="text-ink-3">· {h.form}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block"><span className={labelCls}>Quantity (units)</span>
            <input className={inputCls} value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" required /></label>
          <label className="block"><span className={labelCls}>Days of supply</span>
            <input className={inputCls} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric"
              placeholder={def ? String(def.days_supply) : "auto"} aria-describedby="days-basis" /></label>
          <label className="block col-span-2 sm:col-span-1"><span className={labelCls}>Dispensed on</span>
            <input type="date" className={inputCls} value={date} max={todayIST()} onChange={(e) => setDate(e.target.value)} required /></label>
        </div>
        <p id="days-basis" className="mt-1.5 text-[12px] text-ink-3">
          {def ? <>Default if left blank: <b className="text-ink-2">{def.days_supply} days</b> ({def.basis}).</> : "Pick a medicine to see the default."}
        </p>
        <label className="mt-3 block"><span className={labelCls}>Invoice no. <span className="font-normal text-ink-3">(optional)</span></span>
          <input className={inputCls} value={inv} onChange={(e) => setInv(e.target.value)} maxLength={100} /></label>
        <ErrorNote msg={err} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={busy || !med || !Number(qty) || !date} className={primaryBtn}>{busy ? "Saving…" : "Record refill"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Withdraw consent or erase; erase needs the word ERASE typed. */
export function DangerDialog({ kind, patient, onClose, onDone }: {
  kind: "withdraw" | "erase" | null; patient: PatientDetail | null; onClose: () => void; onDone: (k: "withdraw" | "erase", p: PatientDetail | null) => void;
}) {
  const [note, setNote] = useState(""); const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setNote(""); setTyped(""); setErr(null); }, [kind, patient]);
  if (!kind || !patient) return null;
  const erase = kind === "erase";
  return (
    <Modal open onClose={onClose} title={erase ? `Erase ${patient.display_name}?` : `Withdraw consent for ${patient.display_name}?`} width={460}>
      <form onSubmit={async (e) => {
        e.preventDefault(); if (busy || (erase && typed !== "ERASE")) return;
        setBusy(true); setErr(null);
        try {
          if (erase) { await apiPost(`/api/patients/${patient.id}/erase`, { confirm: "ERASE", reason: note.trim() || null }); onDone("erase", null); }
          else onDone("withdraw", await apiPost<PatientDetail>(`/api/patients/${patient.id}/consent/withdraw`, { note: note.trim() || null }));
          onClose();
        } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
      <div className="text-[13.5px] leading-relaxed text-ink-2">
        {erase ? (
          <p>Name, mobile number, birth year, consent evidence and notes, and invoice numbers are scrubbed permanently. Only anonymous refill counts stay for demand planning. This cannot be undone.</p>
        ) : (
          <p>Takes effect now: pending reminders are cancelled and no further refills are tracked. The patient&apos;s details are erased automatically after the withdrawal grace period set by the owner (default 30 days), or sooner if they ask for erasure.</p>
        )}
      </div>
      <label className="mt-4 block"><span className={labelCls}>{erase ? "Reason" : "How was it withdrawn?"}</span>
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={erase ? 120 : 200}
          placeholder={erase ? "Patient request at counter" : "Replied STOP on WhatsApp"} /></label>
      {erase && (
        <label className="mt-3 block"><span className={labelCls}>Type ERASE to confirm</span>
          <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} /></label>
      )}
      <ErrorNote msg={err} />
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="submit" disabled={busy || (erase && typed !== "ERASE")} className={`${primaryBtn} !bg-[#b42f2f] hover:!bg-[#982626]`}>
          {busy ? "Working…" : erase ? "Erase permanently" : "Withdraw consent"}</button>
      </div>
      </form>
    </Modal>
  );
}
