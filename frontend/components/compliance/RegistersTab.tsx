"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ClipboardList, Download, FilePlus2, Printer, Search, TriangleAlert } from "lucide-react";
import { apiGet, apiPost, useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { Disclaimer, Empty, InlineError, Pager, ScheduleBadge, dt, istDay, istStamp, qs, selectCls, td, th, type Schedule } from "./shared";

type Row = {
  id: number; store_id: string; invoice_no: string; medicine_id: string; medicine_name: string; schedule: Schedule;
  batch_no: string | null; qty: number; patient_name: string; patient_address: string | null; prescriber_name: string;
  prescriber_reg_no: string | null; prescriber_address?: string | null; rx_ref: string | null; sold_by_name: string; sold_at: string; sold_at_ist?: string | null; masked?: boolean;
};
type RegResp = { store_id: string | null; total: number; rows: Row[]; masked: boolean; retention_note: string; disclaimer: string };
type Gap = { invoice_no: string; store_id: string; sold_at: string; medicine_id: string; medicine_name: string; qty: number; schedule: Schedule };
type GapResp = { pos_available: boolean; checked_lines: number; gaps: Gap[]; message: string; from: string; to: string };
type Cls = { medicine_id: string; medicine_name: string; schedule: Schedule; needs_register: boolean };

const SCH = ["all", "H1", "NDPS", "X"] as const;
const LIMIT = 50;
const PRINT_MAX = 500; // backend limit cap
const today = () => istDay(0);
const daysAgo = (n: number) => istDay(n);

export function RegistersTab({ onChanged }: { onChanged?: () => void } = {}) {
  const { can } = useMe();
  const [sch, setSch] = useState<(typeof SCH)[number]>("all");
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [scope, setScope] = useState<"store" | "all">("store");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [printRows, setPrintRows] = useState<Row[] | null>(null);
  const [printErr, setPrintErr] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printTotal, setPrintTotal] = useState(0);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => setOffset(0), [sch, from, to, scope, dq]);

  const filt = qs({ schedule: sch, from, to, store_id: scope === "all" ? "all" : null, q: dq || null });
  const reg = useApi<RegResp>(`/api/compliance/register?${filt}&limit=${LIMIT}&offset=${offset}`);
  const gaps = useApi<GapResp>(`/api/compliance/register/gaps?${qs({ from: to, to, store_id: scope === "all" ? "all" : null })}`);

  const print = async () => {
    if (printing) return;
    setPrintErr(null); setPrinting(true);
    try {
      const r = await apiGet<RegResp>(`/api/compliance/register?${filt}&limit=${PRINT_MAX}`);
      if (!r.rows.length) { setPrintErr("Nothing to print for these filters."); return; }
      setPrintTotal(r.total);
      setPrintRows(r.rows);
      setTimeout(() => { window.print(); }, 80);
    } catch (e) { setPrintErr((e as Error).message); } finally { setPrinting(false); }
  };
  const closeAdd = useCallback(() => setAdding(false), []);
  const { reload: reloadReg } = reg, { reload: reloadGaps } = gaps;
  const savedAdd = useCallback(() => { setAdding(false); reloadReg(); reloadGaps(); onChanged?.(); }, [reloadReg, reloadGaps, onChanged]);
  useEffect(() => {
    const done = () => setPrintRows(null);
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, []);

  return (
    <div className="space-y-5">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className={labelCls}>Schedule</span>
            <Segmented options={SCH} value={sch} onChange={setSch} render={(v) => (v === "all" ? "All" : v)} />
          </div>
          <label className="block">
            <span className={labelCls}>From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputCls + " w-[150px]"} />
          </label>
          <label className="block">
            <span className={labelCls}>To</span>
            <input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} className={inputCls + " w-[150px]"} />
          </label>
          {can("stores.all") && (
            <label className="block">
              <span className={labelCls}>Stores</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as "store" | "all")} className={selectCls}>
                <option value="store">Selected store</option>
                <option value="all">All stores</option>
              </select>
            </label>
          )}
          <label className="block min-w-[180px] flex-1">
            <span className={labelCls}>Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice, patient, prescriber…" aria-label="Search register" className={inputCls + " pl-9"} />
            </span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a className={ghostBtn} href={`/api/compliance/register.csv?${filt}`} download><Download className="h-4 w-4" aria-hidden />Export CSV</a>
          <button className={ghostBtn} onClick={print} disabled={printing} aria-busy={printing}><Printer className="h-4 w-4" aria-hidden />{printing ? "Preparing…" : "Print register"}</button>
          {can("sales.record") && <button className={primaryBtn} onClick={() => setAdding(true)}><FilePlus2 className="h-4 w-4" aria-hidden />Add entry</button>}
        </div>
        <div className="mt-3"><InlineError msg={printErr} /></div>
      </Card>

      <GapsCard g={gaps.data} loading={gaps.loading} error={gaps.error} day={to} />

      <Card delay={60}>
        <CardHeader title="Sales register" sub={reg.data ? `${reg.data.total} entr${reg.data.total === 1 ? "y" : "ies"} · conventional column order` : "Loading…"}
          right={reg.data?.masked ? <span className="text-[12px] text-ink-3">Patient identity masked for your role</span> : undefined} />
        <div className="mt-3 overflow-x-auto">
          {reg.loading && !reg.data ? <div className="space-y-2 p-6">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
            : reg.error ? <div className="p-6"><InlineError msg={reg.error} /></div>
            : !reg.data?.rows.length ? <Empty title="No register entries for these filters" icon={ClipboardList}>Entries are created at billing for Schedule H1, X and NDPS items, or added manually here.</Empty>
            : <RegisterTable rows={reg.data.rows} />}
        </div>
        {reg.data && <Pager total={reg.data.total} offset={offset} limit={LIMIT} onChange={setOffset} />}
      </Card>

      {reg.data && <Disclaimer><b>Retention.</b> {reg.data.retention_note}</Disclaimer>}

      {adding && <AddEntryDialog onClose={closeAdd} onSaved={savedAdd} />}

      {printRows && typeof document !== "undefined" && createPortal(
        <div id="mf-register-print" aria-hidden>
          <style>{`@media screen { #mf-register-print { display: none; } }
            @media print { body > *:not(#mf-register-print) { display: none !important; }
              #mf-register-print { display: block; padding: 0; background: #fff; color: #000; font-size: 10pt; }
              #mf-register-print table { width: 100%; border-collapse: collapse; } #mf-register-print thead { display: table-header-group; }
              #mf-register-print tr { break-inside: avoid; }
              #mf-register-print th, #mf-register-print td { border: 1px solid #555; padding: 3px 5px; text-align: left; vertical-align: top; }
              @page { size: A4 landscape; margin: 10mm; } }`}</style>
          <h1 style={{ fontSize: "14pt", fontWeight: 600 }}>Register of sales — Schedule {sch === "all" ? "H1 / X / NDPS" : sch}</h1>
          <p style={{ margin: "4px 0 10px" }}>Store: {reg.data?.store_id ?? "All stores"} · Period: {dt(from)} to {dt(to)} (IST) · Printed {new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>
          {printTotal > printRows.length && <p style={{ margin: "0 0 8px", fontWeight: 600 }}>Showing the first {printRows.length} of {printTotal} entries. Narrow the date range and print again for the rest.</p>}
          <RegisterTable rows={printRows} print />
          <p style={{ marginTop: 10, fontSize: "8.5pt" }}>{reg.data?.retention_note}</p>
          <p style={{ marginTop: 18 }}>Signature of Registered Pharmacist: ______________________</p>
        </div>,
        document.body,
      )}
    </div>
  );
}

function RegisterTable({ rows, print = false }: { rows: Row[]; print?: boolean }) {
  const cell = print ? "" : td;
  const head = print ? "" : th;
  return (
    <table className={print ? "" : "w-full min-w-[980px] text-[13px]"}>
      <thead className={print ? "" : "border-b border-hairline"}>
        <tr>
          {["Date (IST)", "Patient name & address", "Prescriber & reg. no.", "Drug", "Qty", "Batch", "Invoice", "Sold by"].map((h) => <th key={h} scope="col" className={head}>{h}</th>)}
        </tr>
      </thead>
      <tbody className={print ? "" : "divide-y divide-[var(--hairline)]"}>
        {rows.map((r) => (
          <tr key={r.id} className={print ? "" : "hover:bg-[var(--surface-2)]"}>
            <td className={cell + " whitespace-nowrap tnum"}>{r.sold_at_ist ? istStamp(r.sold_at_ist) : dt(r.sold_at)}</td>
            <td className={cell}><span className="font-medium">{r.patient_name}</span>{r.patient_address && <span className="block text-[12px] text-ink-3">{r.patient_address}</span>}</td>
            <td className={cell}>{r.prescriber_name}{r.prescriber_address && <span className="block text-[12px] text-ink-3">{r.prescriber_address}</span>}{r.prescriber_reg_no && <span className="block text-[12px] text-ink-3">Reg. {r.prescriber_reg_no}</span>}</td>
            <td className={cell}><span className="font-medium">{r.medicine_name}</span>{!print && <span className="ml-1.5"><ScheduleBadge s={r.schedule} compact /></span>}{print && ` (${r.schedule})`}</td>
            <td className={cell + " tnum"}>{r.qty}</td>
            <td className={cell}>{r.batch_no ?? "—"}</td>
            <td className={cell + " whitespace-nowrap"}>{r.invoice_no}{r.rx_ref && <span className="block text-[12px] text-ink-3">Rx {r.rx_ref}</span>}</td>
            <td className={cell}>{r.sold_by_name || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GapsCard({ g, loading, error, day }: { g: GapResp | null; loading: boolean; error: string | null; day: string }) {
  return (
    <Card delay={30} className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Completeness check · {dt(day)}</h2>
          <p className="mt-1 text-[13px] text-ink-3">Every POS line for an H1, X or NDPS medicine needs a register entry.</p>
        </div>
        {g && g.pos_available && (g.gaps.length === 0
          ? <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-good"><CheckCircle2 className="h-4 w-4" aria-hidden />Complete · {g.checked_lines} line(s) checked</span>
          : <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-critical"><TriangleAlert className="h-4 w-4" aria-hidden />{g.gaps.length} missing entr{g.gaps.length === 1 ? "y" : "ies"}</span>)}
      </div>
      {loading && !g ? <Skeleton className="mt-4 h-10" /> : error ? <div className="mt-3"><InlineError msg={error} /></div> : g && (
        <>
          {!g.pos_available && <p className="mt-3 text-[13px] text-ink-2">{g.message}</p>}
          {g.gaps.length > 0 && (
            <ul className="mt-3 divide-y divide-[var(--hairline)] rounded-xl border border-hairline">
              {g.gaps.slice(0, 20).map((x, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                  <ScheduleBadge s={x.schedule} compact />
                  <span className="font-medium">{x.medicine_name}</span>
                  <span className="text-ink-3">× {x.qty} · invoice {x.invoice_no} · {x.store_id}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function AddEntryDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const meds = useApi<{ rows: Cls[] }>("/api/compliance/schedules?limit=500", { refetchOnStoreChange: false });
  const options = useMemo(() => (meds.data?.rows ?? []).filter((r) => r.needs_register), [meds.data]);
  const [f, setF] = useState({ medicine_id: "", invoice_no: "", qty: "1", batch_no: "", patient_name: "", patient_address: "", prescriber_name: "", prescriber_address: "", prescriber_reg_no: "", rx_ref: "", sold_at: today() });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await apiPost("/api/compliance/register", {
        ...f, qty: Number(f.qty), batch_no: f.batch_no || null, patient_address: f.patient_address || null,
        prescriber_reg_no: f.prescriber_reg_no || null, prescriber_address: f.prescriber_address || null, rx_ref: f.rx_ref || null,
      });
      onSaved();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Add register entry" sub="For a sale billed outside the POS. Saved to the selected store with you as the seller." width={560}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className={labelCls}>Medicine (H1 / X / NDPS)</span>
          <select required value={f.medicine_id} onChange={set("medicine_id")} className={selectCls + " w-full"}>
            <option value="">{meds.loading ? "Loading…" : "Choose…"}</option>
            {options.map((o) => <option key={o.medicine_id} value={o.medicine_id}>{o.medicine_name} ({o.schedule})</option>)}
          </select>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block"><span className={labelCls}>Invoice no.</span><input required maxLength={60} value={f.invoice_no} onChange={set("invoice_no")} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Quantity</span><input required type="number" min={1} max={100000} step={1} value={f.qty} onChange={set("qty")} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Date of sale</span><input required type="date" max={today()} value={f.sold_at} onChange={set("sold_at")} className={inputCls} /></label>
        </div>
        <label className="block"><span className={labelCls}>Batch no.</span><input maxLength={40} value={f.batch_no} onChange={set("batch_no")} className={inputCls} /></label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block"><span className={labelCls}>Patient name</span><input required minLength={2} maxLength={120} value={f.patient_name} onChange={set("patient_name")} className={inputCls} autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Patient address</span><input maxLength={300} value={f.patient_address} onChange={set("patient_address")} className={inputCls} autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Prescriber name</span><input required minLength={2} maxLength={120} value={f.prescriber_name} onChange={set("prescriber_name")} className={inputCls} /></label>
          <label className="block"><span className={labelCls}>Prescriber address</span><input maxLength={300} value={f.prescriber_address} onChange={set("prescriber_address")} className={inputCls} autoComplete="off" /></label>
          <label className="block"><span className={labelCls}>Prescriber reg. no.</span><input maxLength={60} value={f.prescriber_reg_no} onChange={set("prescriber_reg_no")} className={inputCls} /></label>
        </div>
        <label className="block"><span className={labelCls}>Prescription reference</span><input maxLength={100} value={f.rx_ref} onChange={set("rx_ref")} className={inputCls} /></label>
        <InlineError msg={err} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Saving…" : "Save entry"}</button>
        </div>
      </form>
    </Modal>
  );
}
