import type { CartLine, GstRow, Totals } from "./types";

/**
 * Client-side mirror of backend/pos.py pricing, used only for the instant/offline estimate.
 * The server recomputes everything when the bill is charged (it is the source of truth).
 * MRP is GST-inclusive; discount applies before tax extraction; CGST = SGST (intra-state).
 */
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const paise = (x: number) => Math.round(x * 100);

export function priceLine(mrp: number, qty: number, discountPct: number, rate: number) {
  const gross = paise(mrp * qty);
  const discount = Math.round((gross * discountPct) / 100);
  const lineTotal = gross - discount;
  const taxable = Math.round(lineTotal / (1 + rate / 100));
  const tax = lineTotal - taxable;
  const cgst = Math.round(tax / 2);
  return { gross: gross / 100, discount: discount / 100, line_total: lineTotal / 100, taxable: taxable / 100, cgst: cgst / 100, sgst: (tax - cgst) / 100 };
}

export function estimate(cart: CartLine[]): { totals: Totals; gst: GstRow[] } {
  let g = 0, d = 0, lt = 0, tx = 0, c = 0, s = 0;
  const by = new Map<number, GstRow>();
  for (const l of cart) {
    const p = priceLine(l.item.mrp ?? 0, l.qty, l.discount_pct, l.item.gst_rate);
    g += p.gross; d += p.discount; lt += p.line_total; tx += p.taxable; c += p.cgst; s += p.sgst;
    const row = by.get(l.item.gst_rate) ?? { rate: l.item.gst_rate, taxable: 0, cgst: 0, sgst: 0, total: 0 };
    row.taxable = r2(row.taxable + p.taxable); row.cgst = r2(row.cgst + p.cgst); row.sgst = r2(row.sgst + p.sgst); row.total = r2(row.total + p.line_total);
    by.set(l.item.gst_rate, row);
  }
  lt = r2(lt);
  const total = Math.round(lt);
  return {
    totals: { gross_total: r2(g), discount_total: r2(d), net_before_round: lt, subtotal_taxable: r2(tx), cgst: r2(c), sgst: r2(s), round_off: r2(total - lt), total },
    gst: [...by.values()].sort((a, b) => a.rate - b.rate),
  };
}

const inr2f = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const inr2 = (n: number | null | undefined) => (n == null ? "—" : `₹${inr2f.format(n)}`);
export const num2 = (n: number | null | undefined) => (n == null ? "—" : inr2f.format(n));

export function istDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function expiryLabel(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}
