"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PAYMENT_LABEL, type Invoice, type ReturnRec } from "./types";
import { istDateTime, num2 } from "./money";

/**
 * 80 mm thermal receipt (≈72 mm printable). Portalled to <body>; the scoped @media print rules hide the
 * rest of the app only while a .pos-print node exists. Print with window.print().
 */
export function PrintableReceipt({ invoice, creditNote }: { invoice: Invoice; creditNote?: ReturnRec | null }) {
  const s = invoice.shop;
  const rows = creditNote ? creditNote.lines.map((rl) => {
    const l = invoice.lines.find((x) => x.id === rl.line_id);
    return { key: rl.id, name: rl.medicine_name, batch: rl.batch_no, exp: l?.expiry_date ?? "", qty: rl.qty, mrp: l?.mrp ?? 0, amount: rl.amount, gst: l?.gst_rate ?? 0, hsn: l?.hsn ?? "" };
  }) : invoice.lines.map((l) => ({ key: l.id, name: l.medicine_name, batch: l.batch_no, exp: l.expiry_date, qty: l.qty, mrp: l.mrp, amount: l.line_total, gst: l.gst_rate, hsn: l.hsn }));
  return (
    <PrintPortal>
      <h1>{s.legal_name || invoice.store.name}</h1>
      <p className="c">{s.address || invoice.store.city}</p>
      {s.phone && <p className="c">Ph: {s.phone}</p>}
      <p className="c">GSTIN: {s.gstin || "NOT SET (owner: POS settings)"}</p>
      {s.dl_numbers && <p className="c s">DL No: {s.dl_numbers}</p>}
      <div className="hr" />
      <p className="c big">{creditNote ? "CREDIT NOTE" : invoice.status === "void" ? "TAX INVOICE (VOID)" : "TAX INVOICE"}</p>
      <p>{creditNote ? `CN: ${creditNote.credit_note_no}` : `Inv: ${invoice.invoice_no}`}</p>
      {creditNote && <p>Against: {invoice.invoice_no}</p>}
      <p>Date: {istDateTime(creditNote ? creditNote.created_at : invoice.created_at)}</p>
      {invoice.customer_name && <p>Customer: {invoice.customer_name}{invoice.customer_phone_masked ? ` (${invoice.customer_phone_masked})` : ""}</p>}
      {invoice.prescriber_name && <p>Dr: {invoice.prescriber_name}{invoice.prescriber_reg_no ? ` Reg ${invoice.prescriber_reg_no}` : ""}</p>}
      <div className="hr" />
      <table>
        <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">MRP</th><th className="r">Amt</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.name}<br /><span className="s">B:{r.batch} E:{r.exp.slice(0, 7)} HSN {r.hsn} GST {r.gst}%</span></td>
              <td className="r">{r.qty}</td><td className="r">{num2(r.mrp)}</td><td className="r">{num2(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hr" />
      {creditNote ? (
        <table><tbody>
          {creditNote.taxable != null && <tr><td>Taxable value</td><td className="r">{num2(creditNote.taxable)}</td></tr>}
          {cnGst(creditNote).map((g) => (
            <tr key={g.rate}><td>GST {g.rate}% (CGST+SGST)</td><td className="r">{num2(g.cgst)}+{num2(g.sgst)}</td></tr>
          ))}
          <tr><td>Amount</td><td className="r">{num2(creditNote.amount)}</td></tr>
          <tr><td>Round off</td><td className="r">{num2(creditNote.round_off)}</td></tr>
          <tr><td className="big">REFUND</td><td className="r big">₹{num2(creditNote.refund_total)}</td></tr>
          <tr><td colSpan={2} className="s">Reason: {creditNote.reason}</td></tr>
        </tbody></table>
      ) : (
        <>
          <table><tbody>
            <tr><td>Gross (MRP)</td><td className="r">{num2(invoice.gross_total)}</td></tr>
            {invoice.discount_total > 0 && <tr><td>Discount</td><td className="r">-{num2(invoice.discount_total)}</td></tr>}
            <tr><td>Taxable value</td><td className="r">{num2(invoice.subtotal_taxable)}</td></tr>
            <tr><td>CGST</td><td className="r">{num2(invoice.cgst)}</td></tr>
            <tr><td>SGST</td><td className="r">{num2(invoice.sgst)}</td></tr>
            <tr><td>Round off</td><td className="r">{num2(invoice.round_off)}</td></tr>
            <tr><td className="big">TOTAL</td><td className="r big">₹{num2(invoice.total)}</td></tr>
            <tr><td>Paid by</td><td className="r">{PAYMENT_LABEL[invoice.payment_mode]}</td></tr>
          </tbody></table>
          <div className="hr" />
          <table>
            <thead><tr><th>GST%</th><th className="r">Taxable</th><th className="r">CGST</th><th className="r">SGST</th></tr></thead>
            <tbody>
              {invoice.gst_breakup.map((g) => (
                <tr key={g.rate}><td>{g.rate}%</td><td className="r">{num2(g.taxable)}</td><td className="r">{num2(g.cgst)}</td><td className="r">{num2(g.sgst)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="hr" />
      <p className="s">Prices are MRP inclusive of GST. Billed by {invoice.billed_by ?? "—"}.</p>
      <p className="c s">{s.footer || "Get well soon. Check medicines before leaving the counter."}</p>
    </PrintPortal>
  );
}

/** GST reversed by a credit note, grouped by rate (from the per-line tax the API returns). */
function cnGst(cn: ReturnRec) {
  const by = new Map<number, { rate: number; cgst: number; sgst: number }>();
  for (const l of cn.lines) {
    if (l.gst_rate == null || l.cgst == null || l.sgst == null) continue;
    const r = by.get(l.gst_rate) ?? { rate: l.gst_rate, cgst: 0, sgst: 0 };
    r.cgst = Math.round((r.cgst + l.cgst) * 100) / 100; r.sgst = Math.round((r.sgst + l.sgst) * 100) / 100;
    by.set(l.gst_rate, r);
  }
  return [...by.values()].sort((a, b) => a.rate - b.rate);
}

/** Print-only 80 mm container portalled to <body> (hidden on screen; hides the app while printing). */
export function PrintPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="pos-print" aria-hidden>
      <style>{`
        @media screen { .pos-print { display: none; } }
        @media print {
          @page { size: 80mm auto; margin: 3mm 4mm; }
          html, body { background: #fff !important; }
          body > *:not(.pos-print) { display: none !important; }
          .pos-print { display: block; width: 72mm; color: #000; font: 9pt/1.3 ui-monospace, "Cascadia Mono", Consolas, monospace; }
          .pos-print h1 { font-size: 11pt; font-weight: 700; text-align: center; margin: 0; }
          .pos-print .c { text-align: center; }
          .pos-print .r { text-align: right; }
          .pos-print .hr { border-top: 1px dashed #000; margin: 4px 0; }
          .pos-print table { width: 100%; border-collapse: collapse; }
          .pos-print td, .pos-print th { padding: 1px 0; vertical-align: top; font-size: 8.5pt; }
          .pos-print th { text-align: left; font-weight: 700; }
          .pos-print .big { font-size: 11pt; font-weight: 700; }
          .pos-print .s { font-size: 7.5pt; }
        }
      `}</style>
      {children}
    </div>,
    document.body,
  );
}
