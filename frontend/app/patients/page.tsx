"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Search, UserPlus } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, Segmented, Skeleton, StatTile } from "@/components/ui";
import { primaryBtn } from "@/components/auth/Modal";
import { ConsentBadge, DueBadge, PrivacyBanner } from "@/components/patients/bits";
import { NewPatientDialog } from "@/components/patients/Dialogs";
import { DueList } from "@/components/patients/DueList";
import { PatientDetailDialog } from "@/components/patients/PatientDetailDialog";
import { AccessLogCard, SettingsCard } from "@/components/patients/OwnerPanels";
import type { CommittedResp, DueResp, Notice, PatientsResp, Settings } from "@/components/patients/types";
import { dateShort } from "@/components/patients/types";

const STATUSES = ["active", "withdrawn", "all"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABEL: Record<Status, string> = { active: "Consented", withdrawn: "Withdrawn", all: "All" };

function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function CommittedCard({ data, delay }: { data: CommittedResp | null; delay: number }) {
  return (
    <Card delay={delay}>
      <CardHeader title="Committed refill demand" sub={data?.basis ?? "Expected refill units from consented patients"} />
      <div className="px-6 pb-5 pt-3">
        {!data ? <Skeleton className="h-24" /> : data.medicines.length === 0 ? (
          <p className="py-4 text-[13px] text-ink-3">No refills expected in the next {data.weeks} weeks.</p>
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {data.medicines.slice(0, 8).map((m) => (
              <li key={m.medicine_id} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                <span className="min-w-0 truncate">{m.medicine_name}</span>
                <span className="shrink-0 tnum text-ink-2">{fmt.int(m.units)} units{m.patients != null ? ` · ${m.patients} patient${m.patients === 1 ? "" : "s"}` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11.5px] text-ink-3">Aggregated, no personal data. The purchase planner can add this to the forecast.</p>
      </div>
    </Card>
  );
}

export default function PatientsPage() {
  const { can, loading: meLoading, storeId } = useMe();
  const staff = can("sales.record");
  const owner = can("settings.edit");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const [status, setStatus] = useState<Status>("active");
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const notice = useApi<Notice>("/api/patients/notice", { refetchOnStoreChange: false });
  const committed = useApi<CommittedResp>(meLoading ? null : "/api/patients/committed-demand");
  const list = useApi<PatientsResp>(staff ? `/api/patients?status=${status}${dq ? `&q=${encodeURIComponent(dq.slice(0, 60))}` : ""}` : null);
  const due = useApi<DueResp>(staff ? "/api/patients/due?days=7" : null);
  const settings = useApi<Settings>(owner ? "/api/patients/settings" : null, { refetchOnStoreChange: false });

  const refresh = useCallback(() => { list.reload(); due.reload(); committed.reload(); }, [list, due, committed]);
  const closeDetail = useCallback(() => setOpenId(null), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  if (meLoading) return <PageSkeleton />;
  if (notice.error && !notice.data) return <ErrorState error={notice.error} />;

  const header = (
    <PageHeader eyebrow={`Patients · ${storeId ?? ""}`} title="Refill reminders"
      actions={staff ? <button className={primaryBtn} onClick={() => setAdding(true)} disabled={!notice.data}><UserPlus className="h-4 w-4" aria-hidden />Add patient</button> : undefined}>
      Remind chronic patients a few days before their medicine runs out, only with their consent.
    </PageHeader>
  );

  if (!staff) {
    return (
      <div>
        {header}
        <Card className="mb-6 px-6 py-5">
          <p className="text-[14px] font-semibold">Patient details are visible to pharmacists and the owner only</p>
          <p className="mt-1 text-[13px] text-ink-3">Your role sees the aggregated refill demand below, with no names or numbers.</p>
        </Card>
        <CommittedCard data={committed.data} delay={60} />
      </div>
    );
  }

  const patients = list.data?.patients ?? [];
  const reminders = due.data?.reminders ?? [];
  const overdue = reminders.filter((r) => r.days_to_due < 0).length;

  return (
    <div>
      {header}
      <PrivacyBanner notice={notice.data} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Consented patients" value={list.data && status === "active" && !dq ? (patients.length >= 200 ? "200+" : fmt.int(patients.length)) : "—"} hint={status === "active" && !dq ? "at this store" : "clear filters to count"} />
        <StatTile label="Refills due in 7 days" value={due.data ? fmt.int(reminders.length - overdue) : "—"} hint="reminders to send" />
        <StatTile label="Overdue refills" value={due.data ? fmt.int(overdue) : "—"} hint="up to 30 days late" />
        <StatTile label="Committed units, 4 wks" value={committed.data ? fmt.int(committed.data.total_units) : "—"} hint="feeds the planner" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Card delay={60}>
          <CardHeader title="Due this week" sub="One tap opens WhatsApp with the message filled in. Send it there, then mark it sent." />
          {due.error && !due.data ? <p role="alert" className="px-6 py-6 text-[13px] text-critical">{due.error}</p>
            : !due.data ? <div className="space-y-2 px-6 py-5"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
              : <DueList data={due.data} onChanged={refresh} onOpen={setOpenId} />}
        </Card>

        <Card delay={120}>
          <CardHeader title="Patients" sub="Phone numbers are masked. Opening a record is logged." />
          <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
            <label className="relative min-w-[180px] flex-1">
              <span className="sr-only">Search patients</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={60} placeholder="Name or last 4 digits"
                className="focus-ring h-9 w-full rounded-xl border border-hairline bg-surface pl-9 pr-3 text-[13px]" />
            </label>
            <Segmented options={STATUSES} value={status} onChange={setStatus} render={(s) => STATUS_LABEL[s]} />
          </div>
          {list.error && !list.data ? <p role="alert" className="px-6 py-6 text-[13px] text-critical">{list.error}</p>
            : !list.data ? <div className="space-y-2 px-6 py-5"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
              : patients.length === 0 ? (
                <p className="px-6 py-10 text-center text-[13px] text-ink-3">
                  {dq ? "No patients match." : status === "active" ? "No consented patients yet. Add one after the patient agrees to reminders." : "None."}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-[var(--hairline)]">
                  {patients.map((p) => (
                    <li key={p.id}>
                      <button onClick={() => setOpenId(p.id)} aria-haspopup="dialog"
                        className="focus-ring group flex w-full items-center gap-3 px-6 py-3 text-left transition hover:bg-[var(--surface-2)]">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-semibold">{p.display_name}</p>
                          <p className="mt-0.5 truncate text-[12px] text-ink-3 tnum">{p.masked_phone} · {p.n_medicines} medicine{p.n_medicines === 1 ? "" : "s"}{p.last_dispense ? ` · last ${dateShort(p.last_dispense)}` : ""}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {p.consent.active ? <DueBadge days={p.days_to_due} /> : <ConsentBadge consent={p.consent} />}
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-3 group-hover:text-ink" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          <div className="h-3" />
        </Card>
      </div>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
        <CommittedCard data={committed.data} delay={180} />
        {owner && (settings.data ? <SettingsCard settings={settings.data} onSaved={() => { settings.reload(); refresh(); }} delay={220} /> : (
          <Card delay={220}>
            <CardHeader title="Reminder & retention settings" sub="Owner only. Applies to every store." />
            {settings.error ? <p role="alert" className="px-6 py-5 text-[13px] text-critical">{settings.error}</p> : <div className="px-6 py-5"><Skeleton className="h-40" /></div>}
          </Card>
        ))}
      </div>
      {owner && <div className="mt-6"><AccessLogCard delay={260} /></div>}

      <NewPatientDialog open={adding} onClose={closeAdd} notice={notice.data} onCreated={(p) => { refresh(); setOpenId(p.id); }} />
      <PatientDetailDialog id={openId} notice={notice.data} onClose={closeDetail} onChanged={refresh} />
    </div>
  );
}
