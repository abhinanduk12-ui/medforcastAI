"use client";

import { useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircleDashed, History, RefreshCw, XCircle } from "lucide-react";
import { useApi } from "@/lib/api";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { ghostBtn } from "@/components/auth/Modal";
import { istDateTime, type HistoryResp } from "./types";

const ST: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  sent: { label: "Sent", icon: CheckCircle2, color: "var(--good)" },
  done: { label: "Run done", icon: CheckCircle2, color: "var(--good)" },
  failed: { label: "Failed", icon: XCircle, color: "var(--critical)" },
  invalid: { label: "Invalid", icon: CircleAlert, color: "var(--serious)" },
  no_delivery: { label: "Nothing delivered", icon: CircleAlert, color: "var(--serious)" },
  not_configured: { label: "Not configured", icon: CircleDashed, color: "var(--ink-3)" },
  claimed: { label: "Running", icon: CircleDashed, color: "var(--ink-3)" },
  skipped: { label: "Skipped", icon: CircleDashed, color: "var(--ink-3)" },
};
const PAGE = 25;
const CHANNEL: Record<string, string> = { run: "Daily run", email: "Email", whatsapp: "WhatsApp" };

export function HistoryCard({ reloadKey = 0, allStores }: { reloadKey?: number; allStores: boolean }) {
  const [offset, setOffset] = useState(0);
  // A new send (reloadKey) or a scope change shows the newest page again (adjusted during render,
  // so no request goes out with the stale offset).
  const scope = `${reloadKey}|${allStores}`;
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) { setSeenScope(scope); setOffset(0); }
  const { data, error, loading, reload } = useApi<HistoryResp>(
    `/api/brief/history?limit=${PAGE}&offset=${offset}${allStores ? "&store_id=all" : ""}&k=${reloadKey}`);
  const total = data?.total ?? 0;
  const from = data && data.rows.length ? data.offset + 1 : 0;
  const to = data ? data.offset + data.rows.length : 0;

  return (
    <Card className="no-print overflow-hidden" delay={90}>
      <CardHeader title="Send history"
        sub={data ? `${total} attempt${total === 1 ? "" : "s"} logged${data.store_id ? " for this store" : " across all stores"}${data.recipients_masked ? " · recipients partly hidden" : ""}` : "Every send attempt, scheduled or manual"}
        right={<History className="h-5 w-5 text-ink-3" aria-hidden />} />
      {error && !data ? (
        <div className="flex flex-wrap items-center gap-3 px-6 py-5 text-[13px]" role="alert">
          <CircleAlert className="h-4 w-4 shrink-0 text-critical" aria-hidden />
          <span className="min-w-0 flex-1 text-ink-2">The send history could not be loaded: {error}</span>
          <button className={ghostBtn} onClick={reload} disabled={loading}><RefreshCw className="h-4 w-4" aria-hidden />Retry</button>
        </div>
      ) : !data ? (
        <div className="px-6 py-5"><Skeleton className="h-24" /></div>
      ) : data.rows.length === 0 ? (
        <p className="px-6 pb-6 pt-4 text-[13px] text-ink-3">No briefs sent yet. Use “Send now” or set a daily schedule.</p>
      ) : (
        <>
          <div className={`mt-3 overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
            <table className="w-full min-w-[620px] text-[12.5px]">
              <thead>
                <tr className="border-y border-hairline text-left text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  <th scope="col" className="px-6 py-2 font-semibold">When (IST)</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Store</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Channel</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Recipient</th>
                  <th scope="col" className="px-6 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const s = ST[r.status] ?? { ...ST.skipped, label: r.status.replace(/_/g, " ") };
                  const Icon = s.icon;
                  return (
                    <tr key={r.id} className="border-b border-hairline align-top last:border-0">
                      <td className="whitespace-nowrap px-6 py-2.5 text-ink-2">
                        {istDateTime(r.created_at).replace(" IST", "")}
                        <span className="block text-[11px] text-ink-3">{r.trigger === "schedule" ? "Scheduled" : `Manual${r.username ? ` · ${r.username}` : ""}`}</span>
                      </td>
                      <td className="px-3 py-2.5">{r.store_name ?? r.store_id}</td>
                      <td className="px-3 py-2.5">{CHANNEL[r.channel] ?? r.channel}</td>
                      <td className="max-w-[200px] truncate px-3 py-2.5 text-ink-2" title={r.recipient ?? ""}>{r.recipient || "—"}</td>
                      <td className="px-6 py-2.5">
                        <span className="inline-flex items-center gap-1 font-medium"><Icon className="h-3.5 w-3.5 shrink-0" style={{ color: s.color }} aria-hidden />{s.label}</span>
                        {r.error && <span className="block max-w-[280px] break-words text-[11.5px] text-ink-3">{r.error}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > PAGE && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-6 py-3 text-[12.5px] text-ink-3">
              <span className="tnum">{from}–{to} of {total}</span>
              <div className="flex gap-2">
                <button className={ghostBtn} disabled={loading || offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))} aria-label="Newer attempts">
                  <ChevronLeft className="h-4 w-4" aria-hidden />Newer
                </button>
                <button className={ghostBtn} disabled={loading || to >= total} onClick={() => setOffset((o) => o + PAGE)} aria-label="Older attempts">
                  Older<ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
