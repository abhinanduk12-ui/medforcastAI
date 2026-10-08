"use client";

import { useCallback, useState } from "react";
import { CircleAlert, FileText, MessageCircle, Printer, RefreshCw, Send } from "lucide-react";
import { useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { ErrorState, PageSkeleton } from "@/components/ui";
import { ghostBtn, primaryBtn } from "@/components/auth/Modal";
import { BriefView } from "@/components/brief/BriefView";
import { SendDialog } from "@/components/brief/SendDialog";
import { SchedulePanel } from "@/components/brief/SchedulePanel";
import { HistoryCard } from "@/components/brief/HistoryCard";
import type { Brief, ShareResp } from "@/components/brief/types";

function LoadProblem({ error, status, onRetry }: { error: string; status: number | null; onRetry: () => void }) {
  // 0 / 5xx = the API is unreachable or broken (ErrorState explains how to start it); 4xx = a readable refusal.
  if (status == null || status === 0 || status >= 500) return <ErrorState error={error} />;
  return (
    <div className="card rise p-8 text-center" role="alert">
      <CircleAlert className="mx-auto h-7 w-7 text-ink-3" aria-hidden />
      <p className="mt-3 text-[15px] font-semibold">The morning brief could not be loaded</p>
      <p className="mt-2 text-[13px] text-ink-3">{error}</p>
      <button className={`${ghostBtn} mt-5`} onClick={onRetry}><RefreshCw className="h-4 w-4" aria-hidden />Try again</button>
    </div>
  );
}

export default function BriefPage() {
  const { me, can, error: meError } = useMe();
  const { data, error, loading, reload, status } = useApi<Brief>("/api/brief/today");
  const share = useApi<ShareResp>("/api/brief/share");
  const [sendOpen, setSendOpen] = useState(false);
  const [histKey, setHistKey] = useState(0);
  // Stable callbacks: the Modal re-runs its focus effect whenever onClose changes identity,
  // which would yank focus out of the dialog after every parent re-render (e.g. after a send).
  const closeSend = useCallback(() => setSendOpen(false), []);
  const onSent = useCallback(() => setHistKey((k) => k + 1), []);

  if (!data) {
    if (error) return <LoadProblem error={error} status={status} onRetry={reload} />;
    return <PageSkeleton />;
  }

  const isOwner = can("settings.edit");
  const sid = encodeURIComponent(data.store.id);
  const textUrl = `/api/brief/today.txt?store_id=${sid}`;
  const htmlUrl = `/api/brief/today.html?store_id=${sid}`;
  // Only offer the share link once it belongs to the store on screen (both refetch on a store switch).
  const shareOk = share.data && share.data.store_id === data.store.id && !share.loading ? share.data : null;

  const actions = (
    <>
      <button className={ghostBtn} onClick={reload} aria-label="Refresh the brief" disabled={loading}>
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />Refresh
      </button>
      <a className={ghostBtn} href={htmlUrl} target="_blank" rel="noopener noreferrer" title="The email version of this brief (opens in a new tab)">
        <FileText className="h-4 w-4" aria-hidden />Email view
      </a>
      <button className={ghostBtn} onClick={() => window.print()}>
        <Printer className="h-4 w-4" aria-hidden />Print
      </button>
      {shareOk ? (
        <a className={ghostBtn} href={shareOk.url} target="_blank" rel="noopener noreferrer"
          title={`Opens WhatsApp with the ${shareOk.chars}-character brief; you choose the chat`}>
          <MessageCircle className="h-4 w-4" aria-hidden />Share on WhatsApp
        </a>
      ) : (
        <button className={ghostBtn} disabled title={share.error ? `Share link unavailable: ${share.error}` : "Preparing the share link…"}>
          <MessageCircle className="h-4 w-4" aria-hidden />Share on WhatsApp
        </button>
      )}
      <button className={primaryBtn} onClick={() => setSendOpen(true)}>
        <Send className="h-4 w-4" aria-hidden />Send now
      </button>
    </>
  );

  return (
    <>
      {error && (
        <div className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px]" role="alert">
          <CircleAlert className="h-4 w-4 shrink-0 text-critical" aria-hidden />
          <span className="min-w-0 flex-1"><b className="font-semibold">Refresh failed.</b> Showing the brief loaded earlier. {error}</span>
          <button className={ghostBtn} onClick={reload}>Try again</button>
        </div>
      )}

      <div className={`transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
        <BriefView b={data} actions={actions} />
      </div>

      <div className="no-print mt-10 grid gap-6">
        {isOwner && <SchedulePanel />}
        {(me || meError) && <HistoryCard reloadKey={histKey} allStores={!!me?.all_stores} />}
        <p className="text-[12px] text-ink-3">
          Plain-text version for WhatsApp or SMS: <a className="focus-ring rounded underline" href={textUrl} target="_blank" rel="noopener noreferrer">today.txt</a>.
          {" "}“Share on WhatsApp” uses a wa.me link and needs no API: WhatsApp opens with the text filled in and you choose who to send it to.
        </p>
      </div>

      <SendDialog open={sendOpen} onClose={closeSend} storeId={data.store.id} storeName={data.store.name}
        shareUrl={shareOk?.url ?? null} onSent={onSent} canSeeSchedule={isOwner} />
    </>
  );
}
