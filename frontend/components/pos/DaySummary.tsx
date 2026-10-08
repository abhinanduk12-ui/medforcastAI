"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { useApi } from "@/lib/api";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { Skeleton } from "@/components/ui";
import { inr2, num2 } from "./money";
import { PrintPortal } from "./Receipt";
import { PAYMENT_LABEL, type DaySummary } from "./types";

function todayIst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Z-report dialog: totals by payment mode, GST by rate, returns, voids, first/last invoice number. */
export function DaySummaryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [day, setDay] = useState(todayIst());
  const { data, error, loading } = useApi<DaySummary>(open ? `/api/pos/day-summary?date=${day}` : null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 60);
    return () => clearTimeout(t);
  }, [printing]);
  return (
    <Modal open={open} onClose={onClose} title="Day summary (Z report)" sub="Totals for one IST calendar day in the selected store. Void invoices are excluded from sales." width={620}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label><span className={labelCls}>Date</span>
          <input type="date" value={day} max={todayIst()} onChange={(e) => e.target.value && setDay(e.target.value)} className={`${inputCls} w-44`} /></label>
        <button className={ghostBtn} onClick={() => setPrinting(true)} disabled={!data}><Printer className="h-4 w-4" aria-hidden />Print</button>
      </div>
      {loading && !data ? <div className="mt-4 space-y-2"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>
        : error ? <p className="mt-4 text-[13px] text-critical" role="alert">{error}</p>
        : data && (
          <div className="z-report mt-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Net sales" value={inr2(data.net_total)} strong />
              <Tile label="Sales" value={inr2(data.sales_total)} />
              <Tile label="Returns" value={inr2(data.returns_total)} />
              <Tile label="Invoices" value={`${data.paid_count}${data.void_count ? ` (+${data.void_count} void)` : ""}`} />
            </div>
            <p className="mt-3 text-[12.5px] text-ink-3">
              {data.first_invoice_no ? <>Numbers <span className="font-mono">{data.first_invoice_no}</span> → <span className="font-mono">{data.last_invoice_no}</span></> : "No invoices on this day."}
              {data.discount_total > 0 && <> · discounts {inr2(data.discount_total)}</>} · round-off {inr2(data.round_off_total)}
            </p>
            <h3 className="eyebrow mb-2 mt-5">By payment mode</h3>
            <table className="w-full text-[13px]">
              <thead><tr className="text-left text-[12px] text-ink-3"><th className="py-1 font-medium">Mode</th><th className="py-1 text-right font-medium">Bills</th><th className="py-1 text-right font-medium">Sales</th><th className="py-1 text-right font-medium">Refunds</th><th className="py-1 text-right font-medium">Net</th></tr></thead>
              <tbody>
                {data.by_payment_mode.map((m) => (
                  <tr key={m.mode} className="border-t border-hairline"><td className="py-1.5">{PAYMENT_LABEL[m.mode]}</td><td className="tnum py-1.5 text-right">{m.count}</td>
                    <td className="tnum py-1.5 text-right">{num2(m.total)}</td><td className="tnum py-1.5 text-right">{num2(m.refunds)}</td><td className="tnum py-1.5 text-right font-medium">{num2(m.net)}</td></tr>
                ))}
              </tbody>
            </table>
            <h3 className="eyebrow mb-2 mt-5">GST on sales (by rate)</h3>
            <GstTable rows={data.gst_sales} />
            {data.gst_returns.length > 0 && <><h3 className="eyebrow mb-2 mt-5">GST reversed by credit notes</h3><GstTable rows={data.gst_returns} /></>}
            {(data.returns.length > 0 || data.voids.length > 0) && (
              <ul className="mt-5 space-y-1 text-[12.5px] text-ink-2">
                {data.returns.map((r) => <li key={r.credit_note_no}><span className="font-mono">{r.credit_note_no}</span> · refund {inr2(r.refund_total)} · {r.reason}</li>)}
                {data.voids.map((v) => <li key={v.invoice_no}><span className="font-mono">{v.invoice_no}</span> · VOID {inr2(v.total)} · {v.reason}</li>)}
              </ul>
            )}
            <p className="mt-5 text-[11.5px] leading-relaxed text-ink-3">{data.notes.gst}{data.notes.simulated ? ` ${data.notes.simulated}` : ""}</p>
          </div>
        )}
      <div className="mt-5 flex justify-end"><button className={primaryBtn} onClick={onClose}>Close</button></div>
      {printing && data && <ZPrint d={data} />}
    </Modal>
  );
}

function Tile({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl border border-hairline px-3 py-2.5 ${strong ? "bg-ink text-white" : "bg-surface-2"}`}>
      <p className={`text-[11.5px] ${strong ? "text-white/70" : "text-ink-3"}`}>{label}</p>
      <p className="tnum mt-1 text-[16px] font-semibold">{value}</p>
    </div>
  );
}

function GstTable({ rows }: { rows: DaySummary["gst_sales"] }) {
  if (!rows.length) return <p className="text-[12.5px] text-ink-3">Nothing to report.</p>;
  return (
    <table className="w-full text-[13px]">
      <thead><tr className="text-left text-[12px] text-ink-3"><th className="py-1 font-medium">Rate</th><th className="py-1 text-right font-medium">Taxable</th><th className="py-1 text-right font-medium">CGST</th><th className="py-1 text-right font-medium">SGST</th><th className="py-1 text-right font-medium">Total</th></tr></thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.rate} className="border-t border-hairline"><td className="py-1.5">{g.rate}%</td><td className="tnum py-1.5 text-right">{num2(g.taxable)}</td>
            <td className="tnum py-1.5 text-right">{num2(g.cgst)}</td><td className="tnum py-1.5 text-right">{num2(g.sgst)}</td><td className="tnum py-1.5 text-right font-medium">{num2(g.total)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function ZPrint({ d }: { d: DaySummary }) {
  return (
    <PrintPortal>
      <h1>Z REPORT</h1>
      <p className="c">{d.store.name} · {d.date}</p>
      <div className="hr" />
      <p>Invoices: {d.paid_count} (void {d.void_count})</p>
      <p>From {d.first_invoice_no ?? "—"}</p>
      <p>To {d.last_invoice_no ?? "—"}</p>
      <div className="hr" />
      <table><tbody>
        {d.by_payment_mode.map((m) => <tr key={m.mode}><td>{PAYMENT_LABEL[m.mode]} ({m.count})</td><td className="r">{num2(m.net)}</td></tr>)}
        <tr><td>Sales</td><td className="r">{num2(d.sales_total)}</td></tr>
        <tr><td>Returns</td><td className="r">-{num2(d.returns_total)}</td></tr>
        <tr><td className="big">NET</td><td className="r big">{num2(d.net_total)}</td></tr>
      </tbody></table>
      <div className="hr" />
      <table>
        <thead><tr><th>GST%</th><th className="r">Taxable</th><th className="r">CGST</th><th className="r">SGST</th></tr></thead>
        <tbody>{d.gst_sales.map((g) => <tr key={g.rate}><td>{g.rate}%</td><td className="r">{num2(g.taxable)}</td><td className="r">{num2(g.cgst)}</td><td className="r">{num2(g.sgst)}</td></tr>)}</tbody>
      </table>
      <div className="hr" />
      <p className="s">Printed {new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
    </PrintPortal>
  );
}
