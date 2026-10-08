"use client";

import { useEffect, useState } from "react";
import { BadgeIndianRupee, ClipboardList, Percent, ShieldCheck } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { PageHeader, Segmented } from "@/components/ui";
import { Disclaimer, SCHEDULES, ScheduleBadge, type Schedule } from "@/components/compliance/shared";
import { RegistersTab } from "@/components/compliance/RegistersTab";
import { SchedulesTab } from "@/components/compliance/SchedulesTab";
import { CeilingsTab } from "@/components/compliance/CeilingsTab";
import { MarginsTab } from "@/components/compliance/MarginsTab";

const TABS = ["Registers", "Schedules", "Price ceilings", "Margins"] as const;
type Tab = (typeof TABS)[number];
const ICON = { Registers: ClipboardList, Schedules: ShieldCheck, "Price ceilings": BadgeIndianRupee, Margins: Percent } as const;
const KEY = "mf.compliance.tab";

type Summary = { schedule_counts: Record<Schedule, number>; overrides: number; low_confidence: number; register_entries_30d: number; ceiling_rows: number; disclaimer: string };

export default function CompliancePage() {
  const { store } = useMe();
  const [tab, setTab] = useState<Tab>("Registers");
  useEffect(() => {
    try { const t = localStorage.getItem(KEY) as Tab | null; if (t && TABS.includes(t)) setTab(t); } catch { /* storage blocked */ }
  }, []);
  const choose = (t: Tab) => { setTab(t); try { localStorage.setItem(KEY, t); } catch { /* ignore */ } };
  const s = useApi<Summary>("/api/compliance/summary");

  return (
    <div>
      <PageHeader eyebrow="Compliance & pricing" title="Registers, schedules, ceilings and margins">
        Statutory sales registers for Schedule H1, X and NDPS medicines, drug-schedule classification with owner overrides,
        DPCO/NPPA ceiling-price checks and margin analytics{store ? ` for ${store.name}` : ""}.
      </PageHeader>

      {s.data && (
        <div className="rise mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-ink-2">
          {SCHEDULES.map((k) => <span key={k} className="inline-flex items-center gap-1.5"><ScheduleBadge s={k} compact /><span className="tnum">{s.data!.schedule_counts[k] ?? 0}</span></span>)}
          <span className="text-ink-3">· {s.data.register_entries_30d} register entries in 30 days · {s.data.overrides} override(s) · {s.data.low_confidence} low-confidence labels</span>
        </div>
      )}

      <div className="mb-6 max-w-full overflow-x-auto">
        <Segmented options={TABS} value={tab} onChange={choose} render={(t) => { const I = ICON[t]; return <><I className="h-3.5 w-3.5" aria-hidden />{t}</>; }} />
      </div>

      <div role="tabpanel" aria-label={tab}>
        {tab === "Registers" && <RegistersTab onChanged={s.reload} />}
        {tab === "Schedules" && <SchedulesTab onChanged={s.reload} />}
        {tab === "Price ceilings" && <CeilingsTab onChanged={s.reload} />}
        {tab === "Margins" && <MarginsTab />}
      </div>

      <div className="mt-8">
        <Disclaimer>{s.data?.disclaimer ?? "Decision support only, not legal advice. Verify with your State Drugs Control authority, NPPA notifications and your CA."}</Disclaimer>
      </div>
    </div>
  );
}
