"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader, PageSkeleton } from "@/components/ui";
import OverviewTab from "@/components/seasonal/OverviewTab";
import CurvesTab from "@/components/seasonal/CurvesTab";
import TimingTab from "@/components/seasonal/TimingTab";
import ImpactTab from "@/components/seasonal/ImpactTab";
import ReadinessTab from "@/components/seasonal/ReadinessTab";
import ArchetypesTab from "@/components/seasonal/ArchetypesTab";
import FourSeasonsTab from "@/components/seasonal/FourSeasonsTab";
import EvidenceTab from "@/components/seasonal/EvidenceTab";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "curves", label: "Seasonal curves" },
  { key: "timing", label: "Timing & orders" },
  { key: "impact", label: "Forecast impact" },
  { key: "readiness", label: "Season readiness" },
  { key: "archetypes", label: "Archetypes" },
  { key: "four", label: "Four seasons" },
  { key: "evidence", label: "Evidence" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function SeasonsInner() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: TabKey = (TABS.find((t) => t.key === raw)?.key ?? (params.get("season") ? "four" : "overview"));
  const go = useCallback((key: TabKey, extra = "") => {
    router.replace(`/seasons?tab=${key}${extra}`, { scroll: false });
  }, [router]);

  return (
    <>
      <PageHeader eyebrow="Seasonal intelligence" title="When demand turns, how sure we are, and when to order">
        Week-by-week seasonal curves for every medicine and category, tested for significance, timed against
        supplier lead times, and connected to the forecast and to the stock on your shelves.
      </PageHeader>

      <nav aria-label="Seasonal views" className="rise -mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="inline-flex min-w-max gap-1 rounded-2xl border border-hairline bg-surface p-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)]" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={t.key === tab} onClick={() => go(t.key)}
              className={`focus-ring whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] transition-colors ${
                t.key === tab ? "bg-ink font-medium text-white shadow-sm" : "text-ink-2 hover:bg-sunken"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <div role="tabpanel">
        {tab === "overview" && <OverviewTab onOpenCurve={(id) => go("curves", `&ids=${encodeURIComponent(id)}`)} onOpenTab={(k) => go(k as TabKey)} />}
        {tab === "curves" && <CurvesTab />}
        {tab === "timing" && <TimingTab />}
        {tab === "impact" && <ImpactTab />}
        {tab === "readiness" && <ReadinessTab />}
        {tab === "archetypes" && <ArchetypesTab />}
        {tab === "four" && <FourSeasonsTab />}
        {tab === "evidence" && <EvidenceTab />}
      </div>
    </>
  );
}

export default function SeasonsPage() {
  return <Suspense fallback={<PageSkeleton />}><SeasonsInner /></Suspense>;
}
