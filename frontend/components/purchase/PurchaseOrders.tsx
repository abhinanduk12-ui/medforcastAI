"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, Printer, Truck } from "lucide-react";
import { fmt } from "@/lib/format";
import { downloadCsv, type PurchaseOrder } from "./types";

const poNumber = (sid: string, date: string) => `PO-${date.replaceAll("-", "")}-${sid}`;

function exportPo(po: PurchaseOrder, date: string) {
  downloadCsv(`${poNumber(po.supplier_id, date)}.csv`, [
    ["po_number", "supplier_id", "medicine_id", "medicine_name", "form", "qty", "est_unit_cost", "est_line_cost"],
    ...po.items.map((it) => [poNumber(po.supplier_id, date), po.supplier_id, it.medicine_id, it.medicine_name, it.form, it.qty, it.unit_cost.toFixed(2), it.cost.toFixed(2)]),
    ["", "", "", "TOTAL", "", po.units, "", po.total.toFixed(2)],
  ]);
}

/** Print-only document, portalled to <body>; @media print rules below hide the rest of the app while it prints. */
function PrintablePo({ po, date, assumptions }: { po: PurchaseOrder; date: string; assumptions: string }) {
  return createPortal(
    <div className="po-print">
      <style>{`
        @media screen { .po-print { display: none; } }
        @media print {
          @page { margin: 16mm; }
          html, body { background: #fff !important; }
          body > *:not(.po-print) { display: none !important; }
          .po-print { display: block; color: #000; font-size: 11pt; font-family: system-ui, sans-serif; }
          .po-print table { width: 100%; border-collapse: collapse; }
          .po-print th, .po-print td { border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; }
          .po-print .r { text-align: right; }
        }
      `}</style>
      <h1 style={{ fontSize: "18pt", fontWeight: 600 }}>Purchase order {poNumber(po.supplier_id, date)}</h1>
      <p style={{ marginTop: 6 }}>Supplier: <b>{po.supplier_id}</b> · Date: {fmt.weekYear(date)} · {po.lines} lines · {fmt.int(po.units)} units</p>
      <table style={{ marginTop: 16 }}>
        <thead>
          <tr><th>#</th><th>Medicine ID</th><th>Medicine</th><th>Form</th><th className="r">Qty</th><th className="r">Est. unit cost</th><th className="r">Est. line total</th></tr>
        </thead>
        <tbody>
          {po.items.map((it, i) => (
            <tr key={it.medicine_id}><td>{i + 1}</td><td>{it.medicine_id}</td><td>{it.medicine_name}</td><td>{it.form}</td>
              <td className="r">{it.qty}</td><td className="r">₹{it.unit_cost.toFixed(2)}</td><td className="r">₹{it.cost.toFixed(2)}</td></tr>
          ))}
          <tr><td colSpan={4}><b>Total</b></td><td className="r"><b>{po.units}</b></td><td /><td className="r"><b>₹{po.total.toFixed(2)}</b></td></tr>
        </tbody>
      </table>
      <p style={{ marginTop: 18, fontSize: "9pt", color: "#444" }}>{assumptions}</p>
      <div style={{ marginTop: 48, display: "flex", justifyContent: "space-between", fontSize: "10pt" }}>
        <span>Prepared by: ____________________</span><span>Approved by: ____________________</span>
      </div>
    </div>,
    document.body,
  );
}

export function PurchaseOrders({ orders, date, assumptions }: { orders: PurchaseOrder[]; date: string; assumptions: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [printing, setPrinting] = useState<PurchaseOrder | null>(null);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 30);   // let the print view render first
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [printing]);

  if (!orders.length)
    return <p className="px-6 pb-6 text-[13px] text-ink-3">Nothing to order at this budget. Raise the budget or check the on-hand stock file.</p>;

  const max = Math.max(...orders.map((o) => o.total));
  return (
    <div className="space-y-3 px-4 pb-4 sm:px-6 sm:pb-6">
      {orders.map((po, i) => {
        const isOpen = open === po.supplier_id;
        return (
          <div key={po.supplier_id} className="rise overflow-hidden rounded-2xl border border-hairline bg-surface" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
            <div className="flex flex-wrap items-center gap-3 p-4">
              <button onClick={() => setOpen(isOpen ? null : po.supplier_id)} aria-expanded={isOpen} aria-controls={`po-${po.supplier_id}`}
                className="focus-ring flex min-w-0 flex-1 basis-[300px] items-center gap-3 rounded-lg text-left">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-wash text-brand-ink"><Truck className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{po.supplier_id}</span>
                  <span className="block text-[12px] text-ink-3">{po.lines} {po.lines === 1 ? "line" : "lines"} · {fmt.int(po.units)} units · exp. profit {fmt.inr(po.expected_profit)}</span>
                  <span className="mt-2 block h-1.5 max-w-[240px] rounded-full bg-sunken"><span className="block h-1.5 rounded-full bg-ink" style={{ width: `${Math.max(2, (po.total / max) * 100)}%` }} /></span>
                </span>
                <span className="text-right">
                  <span className="block text-[18px] font-semibold tnum">{fmt.inrFull(po.total)}</span>
                  <span className="block text-[11px] text-ink-3">est. cost</span>
                </span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-ink-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              <div className="flex gap-2">
                <button onClick={() => exportPo(po, date)} aria-label={`CSV for ${po.supplier_id} purchase order`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 text-[12px] font-medium text-ink-2 hover:bg-sunken">
                  <Download className="h-3.5 w-3.5" /> CSV
                </button>
                <button onClick={() => setPrinting(po)} aria-label={`Print PO for ${po.supplier_id}`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 text-[12px] font-medium text-ink-2 hover:bg-sunken">
                  <Printer className="h-3.5 w-3.5" /> Print PO
                </button>
              </div>
            </div>
            {isOpen && (
              <div id={`po-${po.supplier_id}`} className="overflow-x-auto border-t border-hairline">
                <table className="w-full min-w-[620px] text-[13px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                      <th className="px-4 py-2.5 font-medium">Medicine</th>
                      <th className="px-3 py-2.5 text-right font-medium">Qty</th>
                      <th className="px-3 py-2.5 text-right font-medium">Unit cost</th>
                      <th className="px-3 py-2.5 text-right font-medium">Line total</th>
                      <th className="px-4 py-2.5 text-right font-medium" title="Share of this medicine's sales lines whose stock came from this supplier">Supplier share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((it) => (
                      <tr key={it.medicine_id} className="border-t border-hairline hover:bg-surface-2">
                        <td className="px-4 py-2">
                          <Link href={`/medicines/${it.medicine_id}`} className="focus-ring rounded font-medium hover:underline">{it.medicine_name}</Link>
                          <span className="block text-[12px] text-ink-3">{it.medicine_id} · {it.form}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tnum">{fmt.int(it.qty)}</td>
                        <td className="px-3 py-2 text-right tnum text-ink-2">₹{it.unit_cost.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right tnum">{fmt.inrFull(it.cost)}</td>
                        <td className="px-4 py-2 text-right tnum text-ink-3">{fmt.pct(it.supplier_share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {printing && <PrintablePo po={printing} date={date} assumptions={assumptions} />}
    </div>
  );
}
