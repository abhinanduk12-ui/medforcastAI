"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CalendarClock, Table2, BarChart3 } from "lucide-react";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Legend } from "@/components/ui";
import { CLASS_META, CLASS_ORDER, type AgeRow, type Deadline, OPTION_LABEL } from "./types";

/** Stacked columns: stock value (₹ cost) by days on hand, split by class. Healthy stock is shown in the table only. */
export function AgeingChart({ rows }: { rows: AgeRow[] }) {
  const [table, setTable] = useState(false);
  const has = rows.some((r) => CLASS_ORDER.some((c) => r[c] > 0));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Legend items={CLASS_ORDER.map((c) => ({ label: CLASS_META[c].label, color: CLASS_META[c].color, kind: "dot" as const }))} />
        <button onClick={() => setTable((t) => !t)} aria-pressed={table}
          className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-ink-3 hover:bg-sunken hover:text-ink">
          {table ? <BarChart3 className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}{table ? "Chart" : "Table"}
        </button>
      </div>
      {table || !has ? (
        <div className="overflow-x-auto">
          {!has && <p className="mb-2 text-[13px] text-ink-3">No problem stock in any age bucket.</p>}
          <table className="w-full text-[12.5px]">
            <thead><tr className="text-left text-ink-3">
              <th className="py-1.5 pr-3 font-medium">Days on hand</th>
              {CLASS_ORDER.map((c) => <th key={c} className="py-1.5 pr-3 text-right font-medium">{CLASS_META[c].label}</th>)}
              <th className="py-1.5 text-right font-medium">Healthy</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bucket} className="border-t border-hairline">
                  <td className="py-1.5 pr-3">{r.bucket}</td>
                  {CLASS_ORDER.map((c) => <td key={c} className="py-1.5 pr-3 text-right tnum">{fmt.inrFull(r[c])}</td>)}
                  <td className="py-1.5 text-right tnum text-ink-3">{fmt.inrFull(r.healthy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="img" aria-label="Problem stock value by days on hand, stacked by class">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} />
              <XAxis dataKey="bucket" tickLine={false} axisLine={{ stroke: C.axis }} />
              <YAxis tickFormatter={(v) => fmt.inr(v)} tickLine={false} axisLine={false} width={48} />
              <Tooltip cursor={{ fill: "rgba(11,11,11,0.04)" }} content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as AgeRow;
                return (
                  <div className="min-w-[190px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]">
                    <p className="mb-2 font-medium">{label} on hand</p>
                    {CLASS_ORDER.map((c) => (
                      <div key={c} className="flex items-center justify-between gap-4 py-0.5">
                        <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: CLASS_META[c].color }} />{CLASS_META[c].label}</span>
                        <span className="tnum font-medium">{fmt.inrFull(r[c])}</span>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between gap-4 border-t border-hairline pt-1 text-ink-3"><span>Healthy</span><span className="tnum">{fmt.inrFull(r.healthy)}</span></div>
                  </div>
                );
              }} />
              {CLASS_ORDER.map((c, i) => (
                <Bar key={c} dataKey={c} stackId="a" fill={CLASS_META[c].color} stroke="#fff" strokeWidth={2} maxBarSize={44}
                  radius={i === CLASS_ORDER.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** "Return before" dates, soonest first, with a countdown and a proportional runway bar (0–180 days). */
export function DeadlineTimeline({ items, onOpen }: { items: Deadline[]; onOpen: (batchId: number) => void }) {
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-dashed border-hairline px-5 py-8 text-center">
        <CalendarClock className="mx-auto h-5 w-5 text-ink-3" />
        <p className="mt-2 text-[13.5px] font-medium">No open return windows</p>
        <p className="mt-1 text-[12.5px] text-ink-3">No problem batch is both returnable under its supplier policy and worth returning.</p>
      </div>
    );
  }
  return (
    <ol className="space-y-1.5">
      {items.map((d) => {
        const urgent = d.days_to_deadline <= 14, soon = d.days_to_deadline <= 45;
        const w = Math.max(3, Math.min(100, (d.days_to_deadline / 180) * 100));
        return (
          <li key={d.batch_id}>
            <button onClick={() => onOpen(d.batch_id)} aria-label={`${d.medicine_name} batch ${d.batch_no}: return before ${d.deadline}, ${d.days_to_deadline} days left`}
              className="focus-ring group grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 rounded-xl px-3 py-2.5 text-left hover:bg-sunken">
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{d.medicine_name}</span>
                <span className="block truncate text-[12px] text-ink-3">
                  Batch {d.batch_no} · {d.qty} u · {d.supplier_id ?? "unknown supplier"} · best: {OPTION_LABEL[d.best]}
                </span>
              </span>
              <span className="text-right">
                <span className={`inline-flex items-center gap-1 text-[12.5px] font-semibold tnum ${urgent ? "text-critical" : "text-ink"}`}>
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                  {d.days_to_deadline <= 0 ? "Today" : `${d.days_to_deadline} d`}
                </span>
                <span className="block text-[11.5px] text-ink-3 tnum">by {fmt.weekYear(d.deadline)}</span>
              </span>
              <span className="col-span-2 flex items-center gap-3">
                <span className="h-1.5 flex-1 rounded-full bg-sunken">
                  <span className="block h-1.5 rounded-full" style={{ width: `${w}%`, background: urgent ? "var(--critical)" : soon ? "var(--serious)" : C.s1 }} />
                </span>
                <span className="shrink-0 text-[12px] text-ink-2 tnum">{fmt.inrFull(d.expected_credit)} back</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Horizontal comparison bars for the five options of one batch. */
export function OptionBars({ options }: { options: { key: string; label: string; recovery: number; eligible: boolean; best: boolean }[] }) {
  const max = Math.max(1, ...options.map((o) => o.recovery));
  return (
    <div className="space-y-2" role="list">
      {options.map((o) => (
        <div key={o.key} role="listitem" className="grid grid-cols-[120px_1fr_88px] items-center gap-3 text-[12.5px] max-[480px]:grid-cols-[96px_1fr_76px] md:grid-cols-[200px_1fr_88px]">
          <span title={o.label} className={`truncate ${o.best ? "font-semibold text-ink" : o.eligible ? "text-ink-2" : "text-muted line-through"}`}>{o.label}</span>
          <span className="h-2 rounded-full bg-sunken">
            {o.eligible && <span className="block h-2 rounded-full" style={{ width: `${Math.max(1.5, (o.recovery / max) * 100)}%`, background: o.best ? "var(--brand)" : "#b9b8b0" }} />}
          </span>
          <span className={`text-right tnum ${o.best ? "font-semibold" : "text-ink-2"}`}>{o.eligible ? fmt.inrFull(o.recovery) : "n/a"}</span>
        </div>
      ))}
    </div>
  );
}
