"use client";

import { useCallback, useState } from "react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Card, ErrorState, PageHeader, Skeleton } from "@/components/ui";
import { UploadPanel } from "@/components/mlops/UploadPanel";
import { TrainPanel } from "@/components/mlops/TrainPanel";
import { VersionsPanel } from "@/components/mlops/VersionsPanel";
import { DriftCard } from "@/components/mlops/DriftCard";
import { Pill } from "@/components/mlops/bits";
import { shortDateTime, type Status } from "@/components/mlops/types";

export default function DataPage() {
  const { can } = useMe();
  const [k, setK] = useState(0);
  const bump = useCallback(() => setK((x) => x + 1), []);
  const status = useApi<Status>(`/api/mlops/status?k=${k}`, { refetchOnStoreChange: false });
  const s = status.data;
  const canManage = !!s?.can_manage && can("settings.edit");

  if (status.error && !s) return <ErrorState error={status.error} />;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Intelligence" title="Data & models"
        actions={s ? (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <Pill tone="brand">Live model {s.serving_version ?? s.active_version ?? "ml/artifacts"}</Pill>
            <span className="text-ink-3">trained {shortDateTime(s.generated_at)}</span>
          </div>
        ) : undefined}>
        Teach the forecast with your own sales: upload exports, include what you bill through the app, retrain a candidate
        model, and promote it only when it forecasts at least as well as the current one.
      </PageHeader>
      {!s ? (
        <div className="space-y-6"><Skeleton className="h-56" /><Skeleton className="h-80" /></div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <UploadPanel canManage={canManage} maxMb={s.max_upload_mb} onChange={bump} />
            <DriftCard refreshKey={k} />
          </div>
          <TrainPanel canManage={canManage} runningJobId={s.running_job?.id ?? null} refreshKey={k} onJobChange={bump} />
          <VersionsPanel canManage={canManage} refreshKey={k} onChange={bump} runningVersion={s.running_job?.version ?? null} />
          <Card className="p-5 text-[12px] leading-relaxed text-ink-3" delay={300}>
            The base history is a synthetic dataset; uploads and billed sales replace it day by day where they overlap.
            Billed (ledger) sales are priced at each medicine&apos;s usual selling price because the ledger records cost, not
            the billed price. Only the main store&apos;s billing is used for training; branch sales are simulated.
          </Card>
        </div>
      )}
    </div>
  );
}
