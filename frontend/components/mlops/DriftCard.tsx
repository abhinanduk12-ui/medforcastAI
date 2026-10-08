"use client";

import { Activity } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C, MultiLine } from "@/components/charts";
import { Card, CardHeader, Legend, Skeleton } from "@/components/ui";
import { Notice, Pill, pct1 } from "./bits";
import type { Drift } from "./types";

export function DriftCard({ refreshKey }: { refreshKey: number }) {
  const { data: d, error, loading } = useApi<Drift>(`/api/mlops/drift?k=${refreshKey}`);
  return (
    <Card delay={240}>
      <CardHeader title="Forecast drift" sub="Sales billed through the app compared with what the active model forecast for the same weeks." />
      <div className="space-y-4 p-6 pt-4">
        {error ? <Notice tone="bad">{error}</Notice> : loading && !d ? <Skeleton className="h-40" /> : !d ? null : d.status !== "ok" ? (
          <div className="flex items-start gap-3 rounded-xl bg-sunken px-4 py-5 text-[13px] text-ink-2">
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <p>{d.message}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Store-week WAPE", pct1(d.store_week_wape)],
                ["Item-week WAPE", pct1(d.item_week_wape)],
                ["Forecast vs billed", d.bias == null ? "—" : fmt.signedPct(d.bias, 1)],
                ["Category mix PSI", d.psi_category_mix == null ? "—" : d.psi_category_mix.toFixed(3)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-sunken px-3 py-2"><p className="text-[11.5px] text-ink-3">{k}</p><p className="tnum mt-0.5 text-[15px] font-semibold">{v}</p></div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[12.5px]">
              {d.psi_category_mix == null ? null : d.psi_level === "stable" ? <Pill tone="good">Mix stable</Pill> : d.psi_level === "moderate shift" ? <Pill tone="warn">Moderate mix shift</Pill> : <Pill tone="bad">Large mix shift</Pill>}
              <span className="text-ink-3">{d.overlap_weeks.length} complete week{d.overlap_weeks.length === 1 ? "" : "s"} compared · store {d.store_id} · model {d.version ?? "—"}</span>
            </div>
            {d.weekly && d.weekly.length > 0 && (
              <div>
                <Legend items={[{ label: "Billed units", color: C.s1 }, { label: "Forecast units", color: C.s2, kind: "dash" }]} />
                <div role="img" aria-label="Weekly billed units versus forecast units">
                  <MultiLine data={d.weekly} x="week" height={200} xFormatter={(v) => fmt.week(v)} valueFormatter={(v) => fmt.int(v)}
                    series={[{ key: "actual", label: "Billed", color: C.s1 }, { key: "forecast", label: "Forecast", color: C.s2, dash: true }]} />
                </div>
              </div>
            )}
            {d.category_mix && d.category_mix.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-[12.5px]">
                  <thead className="text-ink-3"><tr><th className="py-1 font-medium">Category (largest share gaps)</th><th className="py-1 text-right font-medium">Billed share</th><th className="py-1 text-right font-medium">Forecast share</th></tr></thead>
                  <tbody>{d.category_mix.map((c) => (
                    <tr key={c.category} className="border-t border-hairline"><td className="py-1">{c.category}</td><td className="tnum py-1 text-right">{pct1(c.actual)}</td><td className="tnum py-1 text-right">{pct1(c.forecast)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {d.bias != null && (
              <p className="text-[11.5px] text-ink-3">
                Forecast vs billed: {d.bias > 0 ? "the model forecast more units than were billed" : d.bias < 0 ? "the model forecast fewer units than were billed" : "forecast and billed units match"}
                {d.actual_units != null && d.forecast_units != null ? ` (${fmt.int(d.forecast_units)} forecast vs ${fmt.int(d.actual_units)} billed)` : ""}.
              </p>
            )}
            {d.notes?.map((n) => <Notice key={n}>{n}</Notice>)}
            {d.method && <p className="text-[11.5px] leading-relaxed text-ink-3">{d.method}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
