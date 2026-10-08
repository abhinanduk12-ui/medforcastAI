const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Signed percentage; the sign follows the ROUNDED value, so −0.3% at 0 digits prints "0%", never "−0%". */
export function signedPctText(n: number, digits = 0): string {
  const r = Number((n * 100).toFixed(digits));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(digits)}%`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00");

export const fmt = {
  compact: (n?: number | null) => (n == null ? "—" : compact.format(n)),
  int: (n?: number | null) => (n == null ? "—" : whole.format(Math.round(n))),
  one: (n?: number | null) => (n == null ? "—" : one.format(n)),
  /** Compact rupees (₹12.4K, ₹1.5Cr); whole rupees below ₹1,000 so values never show stray paise. */
  inr: (n?: number | null) => (n == null ? "—" : "₹" + (Math.abs(n) < 1000 ? whole.format(Math.round(n)) : compact.format(n))),
  inrFull: (n?: number | null) => (n == null ? "—" : "₹" + whole.format(Math.round(n))),
  pct: (n?: number | null, digits = 0) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`),
  signedPct: (n?: number | null, digits = 0) => (n == null ? "—" : signedPctText(n, digits)),
  // Fixed month abbreviations ("Sep", not en-IN's "Sept") so dates match month labels everywhere.
  week: (iso: string) => { const d = day(iso); return `${d.getDate()} ${MON[d.getMonth()]}`; },
  weekYear: (iso: string) => { const d = day(iso); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; },
  month: (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`,
};

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
