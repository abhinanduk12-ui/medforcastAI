"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge, Card, CardHeader, PageSkeleton, Segmented, StatTile } from "@/components/ui";
import { Disclaimer, Empty, InlineError, inr2, td, th } from "./shared";

type Agg = { category?: string; supplier_id?: string; n: number; revenue: number; gross_margin: number; inventory_cost: number; margin_pct: number | null; gmroi: number | null; share: number };
type Med = { medicine_id: string; medicine_name: string; category: string; abc: string; supplier_id: string; price_source: string; cost_source: string; sell_ex_gst: number; unit_cost: number; margin_pct: number | null; units_52w: number; gross_margin: number; inventory_cost: number; gmroi: number | null };
type Cell = { abc: string; band: string; n: number; gross_margin: number; revenue: number };
type Resp = {
  store_id: string; scale: number; totals: { revenue_ex_gst: number; gross_margin: number; margin_pct: number | null; inventory_cost: number; gmroi: number | null; pos_priced: number; default_cost: number };
  by_category: Agg[]; by_supplier: Agg[]; matrix: Cell[]; bands: string[]; alerts: Med[]; medicines: Med[]; definitions: Record<string, string>;
};

const GROUPS = ["Category", "Supplier"] as const;

export function MarginsTab() {
  const r = useApi<Resp>("/api/compliance/margins?limit=60");
  const [g, setG] = useState<(typeof GROUPS)[number]>("Category");
  const [hover, setHover] = useState<Cell | null>(null);
  const maxGm = useMemo(() => Math.max(1, ...(r.data?.matrix ?? []).map((c) => Math.abs(c.gross_margin))), [r.data]);
  if (r.loading && !r.data) return <PageSkeleton />;
  if (r.error || !r.data) return <InlineError msg={r.error ?? "No data"} />;
  const d = r.data, t = d.totals;
  const rows = g === "Category" ? d.by_category : d.by_supplier;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Revenue ex-GST (52 wk)" value={fmt.inr(t.revenue_ex_gst)} hint={d.scale !== 1 ? `branch: ×${d.scale} of main shop (simulated)` : "main shop"} />
        <StatTile label="Gross margin" value={fmt.inr(t.gross_margin)} hint={`${fmt.pct(t.margin_pct, 1)} of revenue`} />
        <StatTile label="Inventory at cost" value={fmt.inr(t.inventory_cost)} hint="sellable on-hand today" />
        <StatTile label="GMROI" value={t.gmroi == null ? "—" : `${t.gmroi.toFixed(2)}×`} hint="gross margin ÷ inventory cost" />
      </div>

      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">ABC × margin</h2>
            <p className="mt-1 text-[13px] text-ink-3">Medicines by revenue class (rows) and margin band (columns). Shade = gross margin ₹; each cell shows count and ₹.</p>
          </div>
          <p className="min-h-[20px] text-[12.5px] text-ink-2" aria-live="polite">{hover ? `${hover.abc} · ${hover.band}: ${hover.n} medicine(s), ${fmt.inrFull(hover.gross_margin)} margin on ${fmt.inr(hover.revenue)} revenue` : "Hover or focus a cell for detail"}</p>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-separate [border-spacing:2px] text-[12.5px]" aria-label="ABC by margin band heatmap">
            <thead><tr><th className="w-12" />{d.bands.map((b) => <th key={b} scope="col" className="pb-1 text-center font-medium text-ink-3">{b}</th>)}</tr></thead>
            <tbody>
              {["A", "B", "C"].map((abc) => (
                <tr key={abc}>
                  <th scope="row" className="pr-2 text-left"><AbcBadge abc={abc} /></th>
                  {d.bands.map((b) => {
                    const c = d.matrix.find((x) => x.abc === abc && x.band === b) ?? { abc, band: b, n: 0, gross_margin: 0, revenue: 0 };
                    const neg = b === "Negative";
                    const a = c.n ? 0.08 + 0.82 * Math.abs(c.gross_margin) / maxGm : 0;
                    const dark = a > 0.5; // white text once the fill is dark enough (both the brand and the red ramp)
                    return (
                      <td key={b} tabIndex={0} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(c)} onBlur={() => setHover(null)}
                        aria-label={`${abc} ${b}: ${c.n} medicines, gross margin ${fmt.inrFull(c.gross_margin)}`}
                        className="focus-ring h-16 rounded-lg text-center align-middle"
                        style={{ background: c.n ? (neg ? `rgba(208,59,59,${Math.max(a, 0.12)})` : `color-mix(in srgb, var(--brand) ${Math.round(a * 100)}%, var(--surface-sunken))`) : "var(--surface-2)" }}>
                        <span className={`block font-semibold tnum ${dark ? "text-white" : "text-ink"}`}>{c.n || "·"}</span>
                        {c.n > 0 && <span className={`block text-[11px] tnum ${dark ? "text-white/85" : "text-ink-3"}`}>{fmt.inr(c.gross_margin)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card delay={40}>
        <CardHeader title={`Margin by ${g.toLowerCase()}`} sub="Sorted by gross margin ₹" right={<Segmented options={GROUPS} value={g} onChange={setG} />} />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="border-b border-hairline"><tr>{[g, "Items", "Revenue ex-GST", "Gross margin", "Margin %", "Share", "Inventory cost", "GMROI"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-[var(--hairline)]">
              {rows.map((x) => (
                <tr key={(x.category ?? x.supplier_id)!} className="hover:bg-[var(--surface-2)]">
                  <td className={td + " font-medium"}>{x.category ?? x.supplier_id}</td>
                  <td className={td + " tnum"}>{x.n}</td>
                  <td className={td + " tnum"}>{fmt.inr(x.revenue)}</td>
                  <td className={td + " tnum font-medium"}>{fmt.inr(x.gross_margin)}</td>
                  <td className={td + " tnum"}>{fmt.pct(x.margin_pct, 1)}</td>
                  <td className={td}><span className="flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken"><span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, Math.max(0, x.share * 100))}%` }} /></span><span className="tnum text-ink-3">{fmt.pct(x.share)}</span></span></td>
                  <td className={td + " tnum"}>{fmt.inr(x.inventory_cost)}</td>
                  <td className={td + " tnum"}>{x.gmroi == null ? "—" : `${x.gmroi.toFixed(2)}×`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card delay={80}>
          <CardHeader title="Low / negative margin" sub={d.definitions.low_margin} />
          <div className="mt-3 pb-3">
            {!d.alerts.length ? <Empty title="No low-margin sellers" icon={CheckCircle2}>Every medicine that sold in the last 52 weeks clears the threshold.</Empty> : (
              <ul className="divide-y divide-[var(--hairline)] border-t border-hairline">
                {d.alerts.slice(0, 15).map((m) => (
                  <li key={m.medicine_id} className="flex items-center justify-between gap-3 px-6 py-2.5 text-[13px]">
                    <span className="min-w-0"><span className="block truncate font-medium">{m.medicine_name}</span><span className="text-[12px] text-ink-3">sell {inr2(m.sell_ex_gst)} · cost {inr2(m.unit_cost)}</span></span>
                    <span className={`inline-flex items-center gap-1 whitespace-nowrap font-medium tnum ${(m.margin_pct ?? 0) < 0 ? "text-critical" : "text-[#a86a00]"}`}><TriangleAlert className="h-3.5 w-3.5" aria-hidden />{fmt.pct(m.margin_pct, 1)} {(m.margin_pct ?? 0) < 0 ? "loss" : "low"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card delay={120}>
          <CardHeader title="Top margin contributors" sub="Gross margin ₹ over the last 52 weeks" />
          <div className="mt-3 overflow-x-auto pb-2">
            <table className="w-full min-w-[460px] text-[13px]">
              <thead className="border-b border-hairline"><tr>{["Medicine", "Margin %", "Gross margin", "GMROI"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-[var(--hairline)]">
                {d.medicines.slice(0, 12).map((m) => (
                  <tr key={m.medicine_id}>
                    <td className={td}><span className="flex items-center gap-2"><AbcBadge abc={m.abc} /><span className="truncate font-medium">{m.medicine_name}</span></span></td>
                    <td className={td + " tnum"}>{fmt.pct(m.margin_pct, 1)}</td>
                    <td className={td + " tnum"}>{fmt.inr(m.gross_margin)}</td>
                    <td className={td + " tnum"}>{m.gmroi == null ? "—" : `${m.gmroi.toFixed(2)}×`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Disclaimer>
        <b>Definitions.</b> {d.definitions.selling_price} {d.definitions.unit_cost} {d.definitions.gmroi}
        {" "}{t.pos_priced > 0 ? `${t.pos_priced} medicine(s) priced from POS lines.` : "No POS data yet."} {t.default_cost} medicine(s) without stock use the default cost.
      </Disclaimer>
    </div>
  );
}
