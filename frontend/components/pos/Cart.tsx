"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRightLeft, Layers, Minus, Plus, Trash2 } from "lucide-react";
import { inputCls, labelCls } from "@/components/auth/Modal";
import { ScheduleBadge } from "./bits";
import { expiryLabel, inr2, priceLine } from "./money";
import type { CartLine, QuoteLine, QuoteResp, RegisterDetails, SubsHint } from "./types";

export function CartRow({ line, index, quote, shortage, onQty, onDisc, onRemove, onSwap }: {
  line: CartLine; index: number; quote: QuoteLine | null; shortage: (SubsHint & { available: number }) | null;
  onQty: (q: number) => void; onDisc: (d: number) => void; onRemove: () => void; onSwap: (medicineId: string) => void;
}) {
  const it = line.item;
  const est = priceLine(it.mrp ?? 0, line.qty, line.discount_pct, it.gst_rate);
  const total = quote?.line_total ?? est.line_total;
  const max = 10000;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold leading-snug">
            <span className="min-w-0 truncate">{it.medicine_name}</span>
            <ScheduleBadge schedule={it.schedule} compact />
          </p>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{it.generic_name} · {it.form} · MRP {inr2(it.mrp)} · GST {it.gst_rate}% · HSN {it.hsn}</p>
        </div>
        <p className="tnum text-right text-[15px] font-semibold">{inr2(total)}</p>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex items-center rounded-xl border border-hairline bg-surface" role="group" aria-label={`Quantity of ${it.medicine_name}`}>
          <button className="focus-ring grid h-8 w-8 place-items-center rounded-l-xl text-ink-2 hover:bg-sunken disabled:opacity-40" aria-label="Decrease quantity"
            onClick={() => onQty(Math.max(1, line.qty - 1))} disabled={line.qty <= 1}><Minus className="h-3.5 w-3.5" /></button>
          <NumField value={line.qty} aria-label={`Quantity of ${it.medicine_name}`} data-qty-index={index} inputMode="numeric"
            parse={(s) => { const v = Number(s.replace(/\D/g, "")); return s.trim() && v >= 1 ? Math.min(max, Math.floor(v)) : null; }}
            sanitize={(s) => s.replace(/\D/g, "").slice(0, 5)} onCommit={onQty}
            onKeyDown={(e) => { if (e.key === "ArrowUp") { e.preventDefault(); onQty(Math.min(max, line.qty + 1)); } if (e.key === "ArrowDown") { e.preventDefault(); onQty(Math.max(1, line.qty - 1)); } }}
            className="focus-ring tnum h-8 w-12 border-x border-hairline bg-transparent text-center text-[13.5px] font-medium" />
          <button className="focus-ring grid h-8 w-8 place-items-center rounded-r-xl text-ink-2 hover:bg-sunken" aria-label="Increase quantity"
            onClick={() => onQty(Math.min(max, line.qty + 1))}><Plus className="h-3.5 w-3.5" /></button>
        </div>
        <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
          Disc
          <NumField value={line.discount_pct} inputMode="decimal" aria-label={`Discount percent for ${it.medicine_name}`}
            sanitize={(s) => { const t = s.replace(/[^\d.]/g, ""); const i = t.indexOf("."); return (i < 0 ? t : t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, "").slice(0, 2)).slice(0, 6); }}
            parse={(s) => { if (!s.trim()) return 0; const v = Number(s); return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 100) / 100)) : null; }}
            onCommit={onDisc}
            className="focus-ring tnum h-8 w-14 rounded-xl border border-hairline bg-surface px-2 text-right text-[13px] text-ink" />%
        </label>
        <span className="text-[12px] text-ink-3">{it.on_hand} in stock</span>
        <button className="focus-ring ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-3 hover:bg-sunken hover:text-critical" onClick={onRemove} aria-label={`Remove ${it.medicine_name}`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden />Remove
        </button>
      </div>
      {quote && quote.allocation.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
          <Layers className="h-3.5 w-3.5 text-ink-3" aria-hidden /><span className="text-ink-3">FEFO:</span>
          {quote.allocation.map((a) => (
            <span key={a.batch_id} className={`rounded-md px-1.5 py-0.5 font-mono text-[11.5px] ${a.days_left <= 90 ? "bg-[#fdf5e3] text-[#7a5200]" : "bg-sunken"}`}
              title={`${a.days_left} days to expiry`}>
              {a.batch_no} · exp {expiryLabel(a.expiry_date)} × {a.qty}{a.days_left <= 90 ? " · near expiry" : ""}
            </span>
          ))}
        </p>
      )}
      {shortage && (
        <div className="mt-2.5 rounded-xl border border-[#f1b9b9] bg-[#fdf3f3] px-3 py-2.5 text-[12.5px]" role="alert">
          <p className="flex items-center gap-1.5 font-medium text-critical"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Only {shortage.available} sellable here (expired stock excluded)</p>
          {shortage.substitutes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {shortage.substitutes.map((s) => (
                <button key={s.medicine_id} onClick={() => onSwap(s.medicine_id)}
                  className="focus-ring inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface px-2 py-1 text-[12px] hover:border-[var(--hairline-strong)]">
                  <ArrowRightLeft className="h-3 w-3 text-ink-3" aria-hidden />{s.medicine_name}
                  <span className="text-ink-3">· {s.tier === "exact" ? "exact" : "dose review"} · {s.on_hand} in stock</span>
                </button>
              ))}
            </div>
          )}
          {shortage.transfer_hint && <p className="mt-1.5 text-ink-2">{shortage.transfer_hint}</p>}
          {shortage.note && <p className="mt-1.5 text-[11.5px] text-ink-3">{shortage.note}</p>}
        </div>
      )}
    </li>
  );
}

/**
 * Numeric text field that keeps the raw text while the user types (so "", "2." and "0.5" are
 * possible) and commits every parseable value; on blur it snaps back to the committed value.
 */
function NumField({ value, parse, sanitize, onCommit, ...rest }: {
  value: number; parse: (s: string) => number | null; sanitize: (s: string) => string; onCommit: (v: number) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { "data-qty-index"?: number }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value)); }, [value, focused]);
  // external changes while focused (+/- buttons, arrow keys) still show up
  useEffect(() => { if (focused && parse(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input {...rest} value={text}
      onFocus={(e) => { setFocused(true); e.currentTarget.select(); rest.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); setText(String(value)); rest.onBlur?.(e); }}
      onChange={(e) => { const s = sanitize(e.target.value); setText(s); const v = parse(s); if (v != null && v !== value) onCommit(v); }} />
  );
}

export function RegisterPanel({ needRx, needRegister, reg, setReg, missing }: {
  needRx: boolean; needRegister: boolean; reg: RegisterDetails; setReg: (r: RegisterDetails) => void; missing: Set<string>;
}) {
  if (!needRx && !needRegister) return null;
  const field = (k: keyof RegisterDetails, label: string, req: boolean, ph?: string) => (
    <label className="block">
      <span className={labelCls}>{label}{req && <span className="text-critical"> *</span>}</span>
      <input value={reg[k]} onChange={(e) => setReg({ ...reg, [k]: e.target.value })} maxLength={k === "patient_address" ? 300 : 120}
        aria-invalid={missing.has(k)} placeholder={ph}
        className={`${inputCls} ${missing.has(k) ? "border-[var(--critical)]" : ""}`} />
    </label>
  );
  return (
    <section className="rounded-2xl border border-[#f5c6b4] bg-[#fffaf7] p-4" aria-label="Prescription and register details">
      <p className="text-[13px] font-semibold">{needRegister ? "Register entry required (Schedule H1 / X / NDPS)" : "Prescription required (Schedule H)"}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
        {needRegister ? "These details are written to the statutory sales register with this bill." : "Record the prescriber for prescription-only items."}
        {" "}Classification is a conservative seed list: verify with your State Drugs Control authority.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {field("prescriber_name", "Prescriber name", true, "Dr …")}
        {field("prescriber_reg_no", "Prescriber reg. no.", needRegister, "e.g. TCMC 12345")}
        {needRegister && field("patient_name", "Patient name", true)}
        {needRegister && field("patient_address", "Patient address", true)}
        {field("rx_ref", "Prescription ref.", false, "optional")}
      </div>
    </section>
  );
}

export function TotalsBlock({ q }: { q: Pick<QuoteResp, "totals" | "gst_breakup"> }) {
  const t = q.totals;
  return (
    <dl className="space-y-1.5 text-[13px]">
      <Row k="Gross (MRP)" v={inr2(t.gross_total)} />
      {t.discount_total > 0 && <Row k="Discount" v={`−${inr2(t.discount_total)}`} />}
      <Row k="Taxable value" v={inr2(t.subtotal_taxable)} />
      {q.gst_breakup.map((g) => (
        <Row key={g.rate} k={`GST ${g.rate}% (CGST ${g.rate / 2}% + SGST ${g.rate / 2}%)`} v={inr2(g.cgst + g.sgst)} muted />
      ))}
      <Row k="Round off" v={`${t.round_off >= 0 ? "+" : "−"}${inr2(Math.abs(t.round_off))}`} muted />
    </dl>
  );
}

function Row({ k, v, muted = false }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={muted ? "text-[12px] text-ink-3" : "text-ink-2"}>{k}</dt>
      <dd className={`tnum ${muted ? "text-[12px] text-ink-3" : ""}`}>{v}</dd>
    </div>
  );
}
