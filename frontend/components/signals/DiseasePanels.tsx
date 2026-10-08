"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Sparkline } from "@/components/charts";
import { Segmented } from "@/components/ui";
import { fmt } from "@/lib/format";
import { dayFmt, LevelBadge, type DiseaseResp, type DiseaseSeries } from "./model";

const REGIONS = ["EKM", "KERALA"] as const;
type Region = (typeof REGIONS)[number];

export function DiseasePanels({ data }: { data: DiseaseResp }) {
  const [region, setRegion] = useState<Region>("EKM");
  const ser = data.series[region] ?? {};
  const list = data.panel_diseases.map((d) => ser[d]).filter(Boolean) as DiseaseSeries[];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-4">
        <Segmented options={REGIONS} value={region} onChange={setRegion} render={(r) => (r === "EKM" ? "Ernakulam" : "Kerala (state)")} />
        <p className="text-[12px] text-ink-3">7-day totals to {data.as_of ? dayFmt(data.as_of) : "—"} · line = last {list[0]?.blocks.length ?? 12} weekly totals</p>
      </div>
      {list.length === 0 ? (
        <p className="px-6 py-10 text-center text-[13px] text-ink-3">No disease reports parsed yet. Refresh, or add counts manually below.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-4">
          {list.map((s) => <Panel key={s.disease} s={s} />)}
        </div>
      )}
    </div>
  );
}

function Panel({ s }: { s: DiseaseSeries }) {
  // Weeks with no report are left out of the line rather than drawn as zero cases.
  const spark = s.blocks.filter((b) => b.cases != null).map((b) => b.cases as number);
  const missing = s.blocks.length - spark.length;
  const estimated = s.blocks.some((b) => b.estimated);
  const g = s.growth_pct;
  const Icon = s.trend === "rising" ? ArrowUpRight : s.trend === "falling" ? ArrowDownRight : Minus;
  const scaled = s.blocks.some((b) => b.scaled);
  const manual = s.sources.some((x) => x.startsWith("manual"));
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-hairline bg-surface-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-semibold leading-tight">{s.label}</p>
        <LevelBadge level={s.level} />
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[26px] font-semibold leading-none tracking-[-0.02em] tnum">{s.last7 == null ? "—" : fmt.int(s.last7)}</p>
          <p className="mt-1.5 text-[11.5px] text-ink-3">last 7 days · typical {s.baseline_mean == null ? "—" : fmt.int(s.baseline_mean)}{s.baseline_blocks ? ` (${s.baseline_blocks}-wk mean)` : ""}</p>
        </div>
        {spark.length > 1 && <Sparkline data={spark} width={96} height={34} />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="inline-flex items-center rounded-md bg-sunken px-1.5 py-0.5 font-medium tnum" title="Standard score vs the previous 12 weeks (Poisson floor)">
          z {s.z == null ? "—" : `${s.z > 0 ? "+" : s.z < 0 ? "−" : ""}${Math.abs(s.z).toFixed(1)}`}
        </span>
        <span className="inline-flex items-center gap-0.5 rounded-md bg-sunken px-1.5 py-0.5 font-medium tnum" title="Week-over-week change">
          <Icon className="h-3 w-3" strokeWidth={2.4} aria-hidden />{g == null ? "—" : fmt.signedPct(g)} wk/wk
        </span>
      </div>
      <p className="mt-auto pt-3 text-[11px] leading-snug text-muted">
        {s.about}
        {manual ? " Includes manual entries." : " Source: DHS IDSP."}
        {scaled ? " Some weeks scaled from 5–6 reported days." : ""}
        {estimated ? " Some days estimated from weekly totals." : ""}
        {missing > 0 ? ` ${missing} week${missing > 1 ? "s" : ""} without reports left out of the line.` : ""}
      </p>
    </div>
  );
}
