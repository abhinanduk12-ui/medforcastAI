"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { Download, ExternalLink, FileWarning, PencilLine, Trash2, Upload } from "lucide-react";
import { apiFetch, apiPost, apiSend, ApiError } from "@/lib/api";
import { ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { ConfirmDialog } from "@/components/auth/UserDialogs";
import { dayFmt, dayYearFmt, DISEASE_LABEL, LEVEL, REPORT_STATUS, type DiseaseResp, type Level, type ManualRow } from "./model";

const DISEASES = ["dengue", "fever", "lepto", "add", "hepatitis_a", "influenza", "chikungunya", "ili", "other"] as const;
const COUNTS = ["suspected", "confirmed", "deaths"] as const;
const MAX_COUNT = 1_000_000;
const MAX_UPLOAD = 1_000_000;

type Form = { date: string; period: "day" | "week"; district: "EKM" | "KERALA"; disease: string; suspected: string; confirmed: string; deaths: string; source: string; source_url: string; notes: string };
type Msg = { ok: boolean; text: string; errors?: string[] };

/** The day before `today` (YYYY-MM-DD), computed in UTC so the browser's time zone cannot shift it. */
function yesterday(today: string) {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Client-side checks that mirror the API (the server validates again). */
function validate(f: Form, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return "Choose a date.";
  if (f.date > today) return "The date cannot be in the future.";
  for (const k of COUNTS) {
    const v = f[k].trim();
    if (v === "") continue;
    if (!/^\d+$/.test(v)) return `${k[0].toUpperCase() + k.slice(1)} must be a whole number of 0 or more.`;
    if (Number(v) > MAX_COUNT) return `${k[0].toUpperCase() + k.slice(1)} is too large.`;
  }
  if (f.suspected.trim() === "" && f.confirmed.trim() === "") return "Give at least a suspected or a confirmed count.";
  if (f.source_url.trim() && !/^https?:\/\//i.test(f.source_url.trim())) return "The source link must start with http:// or https://.";
  return null;
}

export function ManualData({ data, today, canUpload, onSaved }: { data: DiseaseResp; today: string; canUpload: boolean; onSaved: () => void }) {
  const blank: Form = { date: yesterday(today), period: "day", district: "EKM", disease: "dengue", suspected: "", confirmed: "", deaths: "", source: "DHS Kerala IDSP daily report", source_url: "", notes: "" };
  const [f, setF] = useState<Form>(blank);
  const [busy, setBusy] = useState<"save" | "upload" | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [del, setDel] = useState<ManualRow | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const n = (s: string) => (s.trim() === "" ? null : Number(s.trim()));
  const closeDel = useCallback(() => setDel(null), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = validate(f, today);
    if (problem) { setMsg({ ok: false, text: problem }); return; }
    setBusy("save"); setMsg(null);
    try {
      const r = await apiPost<{ saved: number; disease: Level | null }>("/api/signals/disease/manual", {
        ...f, source_url: f.source_url.trim(), suspected: n(f.suspected), confirmed: n(f.confirmed), deaths: n(f.deaths),
      });
      const lvl = r?.disease ? LEVEL[r.disease]?.label : null;
      setMsg({ ok: true, text: `Saved ${DISEASE_LABEL[f.disease] ?? f.disease} for ${f.district === "EKM" ? "Ernakulam" : "Kerala"} on ${dayYearFmt(f.date)}${f.period === "week" ? " (week)" : ""}. Manual values replace the automatic ones for that day${lvl ? `; level now: ${lvl}` : ""}.` });
      setF({ ...blank, date: f.date, district: f.district, source: f.source, source_url: f.source_url });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: (err as ApiError).message });
    } finally { setBusy(null); }
  };

  const upload = async (fl: File | undefined) => {
    if (!fl || busy) return;
    setBusy("upload"); setMsg(null);
    try {
      if (fl.size > MAX_UPLOAD) throw new ApiError(413, "File too large (max 1 MB)");
      const text = await fl.text();
      const r = await apiFetch<{ saved: number }>("/api/signals/disease/upload", { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
      setMsg({ ok: true, text: `Uploaded ${r.saved} row${r.saved === 1 ? "" : "s"} from ${fl.name}.` });
      onSaved();
    } catch (err) {
      const e = err as ApiError;
      const d = e.detail as { errors?: unknown } | undefined;
      const errors = d && typeof d === "object" && Array.isArray(d.errors) ? d.errors.map(String) : undefined;
      setMsg({ ok: false, text: e.message, errors });
    } finally {
      setBusy(null);
      if (file.current) file.current.value = "";
    }
  };

  const remove = async (m: ManualRow) => {
    await apiSend("DELETE", `/api/signals/disease/manual/${m.id}`);   // errors are shown inside the dialog
    setMsg({ ok: true, text: `Deleted the manual ${DISEASE_LABEL[m.disease] ?? m.disease} entry for ${dayYearFmt(m.date)}.` });
    onSaved();
  };

  const fillFrom = (date: string) => {
    setF((p) => ({ ...p, date, period: "day" }));
    setMsg(null);
    dateInput.current?.focus();
    dateInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const gaps = data.reports.needs_manual;
  const counts = (m: ManualRow) =>
    [m.suspected != null && `${m.suspected} susp.`, m.confirmed != null && `${m.confirmed} conf.`, m.deaths != null && `${m.deaths} deaths`].filter(Boolean).join(", ");

  return (
    <div className="grid gap-6 p-4 pt-4 sm:p-6 lg:grid-cols-[1.25fr_1fr]">
      <form onSubmit={submit} noValidate className="min-w-0" aria-label="Manual disease count entry">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="col-span-2 min-w-0 sm:col-span-1"><span className={labelCls}>Date</span>
            <input ref={dateInput} type="date" required max={today} value={f.date} onChange={(e) => set("date", e.target.value)} className={inputCls} /></label>
          <label className="min-w-0"><span className={labelCls}>Period</span>
            <select value={f.period} onChange={(e) => set("period", e.target.value as Form["period"])} className={inputCls}>
              <option value="day">Day</option><option value="week">Week (7 days from date)</option></select></label>
          <label className="min-w-0"><span className={labelCls}>Area</span>
            <select value={f.district} onChange={(e) => set("district", e.target.value as Form["district"])} className={inputCls}>
              <option value="EKM">Ernakulam</option><option value="KERALA">Kerala total</option></select></label>
          <label className="col-span-2 min-w-0 sm:col-span-1"><span className={labelCls}>Disease</span>
            <select value={f.disease} onChange={(e) => set("disease", e.target.value)} className={inputCls}>
              {DISEASES.map((v) => <option key={v} value={v}>{DISEASE_LABEL[v]}</option>)}</select></label>
          {COUNTS.map((k) => (
            <label key={k} className="min-w-0"><span className={labelCls}>{k[0].toUpperCase() + k.slice(1)}</span>
              <input type="number" min={0} max={MAX_COUNT} step={1} inputMode="numeric" value={f[k]} onChange={(e) => set(k, e.target.value)} className={inputCls} placeholder="—" /></label>
          ))}
          <label className="col-span-2 min-w-0 sm:col-span-1"><span className={labelCls}>Source</span>
            <input maxLength={120} value={f.source} onChange={(e) => set("source", e.target.value)} className={inputCls} /></label>
          <label className="col-span-2 min-w-0"><span className={labelCls}>Source link (PDF)</span>
            <input type="url" maxLength={300} value={f.source_url} onChange={(e) => set("source_url", e.target.value)} className={inputCls} placeholder="https://dhs.kerala.gov.in/…" /></label>
          <label className="col-span-2 min-w-0"><span className={labelCls}>Notes</span>
            <input maxLength={500} value={f.notes} onChange={(e) => set("notes", e.target.value)} className={inputCls} /></label>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          Copy numbers exactly as printed; leave a box empty when the report shows “-” for not reported. Fever uses the OP count as “suspected”.
          Entries are saved under your name.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy !== null} aria-busy={busy === "save"} className={primaryBtn}>{busy === "save" ? "Saving…" : "Save entry"}</button>
          <a href="/api/signals/disease/template.csv" download className={ghostBtn}><Download className="h-3.5 w-3.5" aria-hidden />CSV template</a>
          {canUpload ? (
            <label className={`${ghostBtn} cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--brand)] ${busy ? "pointer-events-none opacity-50" : ""}`} aria-disabled={busy !== null}>
              <Upload className="h-3.5 w-3.5" aria-hidden />{busy === "upload" ? "Uploading…" : "Upload CSV"}
              <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" disabled={busy !== null} onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          ) : <span className="text-[12px] text-ink-3">CSV upload: owner or buyer</span>}
        </div>
        {msg && (
          <div role={msg.ok ? "status" : "alert"} className={`mt-3 rounded-xl px-3 py-2.5 text-[12.5px] text-ink ${msg.ok ? "bg-[#eaf6ea]" : "bg-[#fbeaea]"}`}>
            {msg.text}
            {msg.errors && msg.errors.length > 0 && <ul className="mt-1.5 max-h-40 list-disc overflow-y-auto pl-4 text-[12px] text-ink-2">{msg.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        )}
      </form>

      <div className="min-w-0 space-y-5">
        <div>
          <p className="eyebrow mb-2">Days that need manual entry</p>
          {gaps.length === 0 ? (
            <p className="text-[13px] text-ink-3">None: every report in the backfill window was read and validated{data.reports.pending.length ? `; ${data.reports.pending.length} recent day(s) not yet published` : ""}.</p>
          ) : (
            <ul className="max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
              {gaps.map((g) => (
                <li key={g.date} className="flex items-start gap-2 rounded-xl border border-hairline px-3 py-2 text-[12.5px]">
                  <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{dayYearFmt(g.date)} <span className="font-normal text-ink-3">· {REPORT_STATUS[g.status] ?? g.status}</span></p>
                    {g.message && <p className="truncate text-[11.5px] text-ink-3" title={g.message}>{g.message}</p>}
                  </div>
                  <button type="button" onClick={() => fillFrom(g.date)} aria-label={`Enter counts for ${dayYearFmt(g.date)}`} title="Fill the form with this date"
                    className="focus-ring shrink-0 rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink"><PencilLine className="h-3.5 w-3.5" aria-hidden /></button>
                  {g.url && <a href={g.url} target="_blank" rel="noreferrer" aria-label={`Open the DHS report PDF for ${dayYearFmt(g.date)}`} className="focus-ring shrink-0 rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink"><ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="eyebrow mb-2">Recent manual entries</p>
          {data.manual_entries.length === 0 ? <p className="text-[13px] text-ink-3">No manual entries yet.</p> : (
            <ul className="max-h-[260px] divide-y divide-[var(--hairline)] overflow-y-auto rounded-xl border border-hairline">
              {data.manual_entries.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[12.5px]">
                  <span className="min-w-0">
                    <span className="block truncate">
                      {dayFmt(m.date)}{m.period === "week" ? " (week)" : ""} · {m.district === "EKM" ? "Ernakulam" : "Kerala"} · {DISEASE_LABEL[m.disease] ?? m.disease}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-3" title={m.notes ?? undefined}>
                      {counts(m) || "no counts"}{m.entered_by_name ? ` · by ${m.entered_by_name}` : ""}
                    </span>
                  </span>
                  {m.can_delete !== false ? (
                    <button type="button" onClick={() => setDel(m)} aria-label={`Delete manual entry for ${DISEASE_LABEL[m.disease] ?? m.disease} on ${dayYearFmt(m.date)}`}
                      className="focus-ring shrink-0 rounded-md p-1 text-ink-3 hover:bg-sunken hover:text-ink">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  ) : <span className="shrink-0 text-[11px] text-muted" title="Only the person who entered it, an owner or a buyer can delete it">locked</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog open={del !== null} onClose={closeDel} danger confirm="Delete entry"
        title="Delete manual entry?"
        body={del ? <>The {DISEASE_LABEL[del.disease] ?? del.disease} count for {del.district === "EKM" ? "Ernakulam" : "Kerala"} on {dayYearFmt(del.date)} will be removed. The automatic DHS value for that day, if any, is used again.</> : null}
        onConfirm={() => (del ? remove(del) : undefined)} />
    </div>
  );
}
