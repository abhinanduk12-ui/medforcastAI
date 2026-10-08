"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, History as HistoryIcon, Loader2, X } from "lucide-react";
import { apiPost, ApiError, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Skeleton } from "@/components/ui";
import { ghostBtn, primaryBtn } from "@/components/auth/Modal";
import type { HistoryResp, RequestsResp } from "./types";
import { when } from "./types";

const PAGE = 15;

export function TransferHistory({ names, version }: { names: Record<string, string>; version: number }) {
  const [page, setPage] = useState(0);
  const { data, error, loading } = useApi<HistoryResp>(`/api/stores/transfers?limit=${PAGE}&offset=${page * PAGE}&v=${version}`);
  if (error && !data) return <p className="px-6 py-6 text-[13px] text-ink-3">Could not load transfer history: {error}</p>;
  if (!data) return <div className="space-y-2 px-6 py-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (data.total === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-10 text-center">
        <HistoryIcon className="h-8 w-8 text-ink-3" strokeWidth={1.6} aria-hidden />
        <p className="mt-3 text-[14px] font-semibold">No transfers yet</p>
        <p className="mt-1 text-[13px] text-ink-3">Approved suggestions and manual transfers appear here with their ledger reference.</p>
      </div>
    );
  }
  const pages = Math.ceil(data.total / PAGE);
  return (
    <div className={loading ? "opacity-70 transition-opacity" : ""}>
      <p className="px-6 pt-3 text-[12px] text-ink-3">{data.last30.count} transfers ({fmt.int(data.last30.units)} units) in the last 30 days · {data.total} in total</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
              <th scope="col" className="px-6 py-2.5 font-medium">Ref</th>
              <th scope="col" className="px-3 py-2.5 font-medium">When</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Medicine</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Route</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium">Units</th>
              <th scope="col" className="px-3 py-2.5 text-right font-medium" title="Units × median price × 0.8 (assumed cost)">Est. value*</th>
              <th scope="col" className="px-6 py-2.5 font-medium">By · reason</th>
            </tr>
          </thead>
          <tbody>
            {data.transfers.map((t) => (
              <tr key={t.id} className="border-t border-hairline hover:bg-surface-2">
                <td className="px-6 py-2.5 font-mono text-[12px] text-ink-2">TR-{t.id}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{when(t.created_at)}</td>
                <td className="max-w-[220px] px-3 py-2.5"><Link href={`/medicines/${t.medicine_id}`} className="focus-ring block truncate rounded font-medium hover:underline">{t.medicine_name ?? t.medicine_id}</Link></td>
                <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">
                  {names[t.from_store] ?? t.from_store} <ArrowRight className="inline h-3 w-3 text-ink-3" aria-label="to" /> {names[t.to_store] ?? t.to_store}
                </td>
                <td className="px-3 py-2.5 text-right font-medium tnum">{fmt.int(t.qty)}</td>
                <td className="px-3 py-2.5 text-right tnum text-ink-2">{fmt.inrFull(t.est_value)}</td>
                <td className="max-w-[260px] px-6 py-2.5 text-ink-2">
                  <span className="block truncate">{t.created_by_username ?? "dev user"}</span>
                  {t.reason && <span className="block truncate text-[11.5px] text-ink-3" title={t.reason}>{t.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-6 pt-2 text-[11.5px] text-ink-3">* Estimated at cost: units × median price × 0.8 (assumed; the data has no purchase prices).</p>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-between border-t border-hairline px-6 py-3 text-[12.5px] text-ink-3">
          <span aria-live="polite">Page {page + 1} of {pages}</span>
          <div className="flex gap-2">
            <button disabled={page === 0 || loading} onClick={() => setPage(Math.max(0, page - 1))} className={ghostBtn}>Previous</button>
            <button disabled={page >= pages - 1 || loading} onClick={() => setPage(Math.min(pages - 1, page + 1))} className={ghostBtn}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_TONE = {
  pending: "bg-[#fff7e6] text-[#7a5200]", approved: "bg-brand-wash text-brand-ink",
  rejected: "bg-[#fdf0f0] text-[#9c2b2b]", cancelled: "bg-sunken text-ink-3",
} as const;

export function TransferRequests({ version, myUserId, onChanged }: { version: number; myUserId: number | null; onChanged: () => void }) {
  const { data, error } = useApi<RequestsResp>(`/api/stores/transfers/requests?limit=30&v=${version}`);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (error && !data) return <p className="px-6 py-6 text-[13px] text-ink-3">Could not load requests: {error}</p>;
  if (!data) return <div className="px-6 py-5"><Skeleton className="h-10" /></div>;
  if (data.requests.length === 0) {
    return (
      <div className="px-6 py-6">
        {msg && <p role="status" className={`mb-3 rounded-xl px-3.5 py-2 text-[13px] ${msg.ok ? "bg-brand-wash text-brand-ink" : "bg-[#fdf0f0] text-[#9c2b2b]"}`}>{msg.text}</p>}
        <p className="text-[13px] text-ink-3">No transfer requests. Pharmacists can request a move from a suggestion or with “Request transfer”.</p>
      </div>
    );
  }

  const act = async (id: number, action: "approve" | "reject") => {
    if (busy !== null) return;
    setBusy(id);
    setMsg(null);
    try {
      const r = await apiPost<{ request: { status: string }; transfer?: { ref: string; moved: number } }>(
        `/api/stores/transfers/requests/${id}/${action}`, {});
      setMsg({ ok: true, text: r.transfer
        ? `Request #${id} approved: ${r.transfer.ref}, ${fmt.int(r.transfer.moved)} units moved.`
        : `Request #${id} ${r.request.status}.` });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {msg && <p role="status" className={`mx-6 mt-3 rounded-xl px-3.5 py-2 text-[13px] ${msg.ok ? "bg-brand-wash text-brand-ink" : "bg-[#fdf0f0] text-[#9c2b2b]"}`}>{msg.text}</p>}
      {data.pending > 0 && <p className="px-6 pt-3 text-[12px] text-ink-3">{data.pending} pending</p>}
      <ul className="divide-y divide-[var(--hairline)]">
        {data.requests.map((r) => {
          const mine = myUserId != null && r.requested_by === myUserId;
          const canDecide = r.can_approve ?? data.can_approve;
          return (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="text-[13.5px]">
                  <span className="font-medium">{r.medicine_name ?? r.medicine_id}</span>
                  <span className="text-ink-3"> · {fmt.int(r.qty)} units · </span>
                  <span className="text-ink-2">{r.from_name ?? r.from_store} → {r.to_name ?? r.to_store}</span>
                </p>
                <p className="mt-0.5 text-[11.5px] text-ink-3">
                  #{r.id} by {r.requested_by_username ?? "dev user"} · {when(r.created_at)}{r.reason ? ` · “${r.reason}”` : ""}
                  {r.decided_by_username && ` · ${r.status} by ${r.decided_by_username}`}{r.transfer_id ? ` · TR-${r.transfer_id}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ${STATUS_TONE[r.status]}`}>{r.status}</span>
                {r.status === "pending" && canDecide && (
                  <>
                    <button onClick={() => act(r.id, "reject")} disabled={busy !== null} className={ghostBtn} aria-label={`${mine ? "Cancel" : "Reject"} request ${r.id}`}>
                      <X className="h-4 w-4" aria-hidden />{mine ? "Cancel" : "Reject"}
                    </button>
                    <button onClick={() => act(r.id, "approve")} disabled={busy !== null} className={primaryBtn} aria-label={`Approve request ${r.id}: move ${r.qty} units`}>
                      {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Approve
                    </button>
                  </>
                )}
                {r.status === "pending" && !canDecide && mine && (
                  <button onClick={() => act(r.id, "reject")} disabled={busy !== null} className={ghostBtn} aria-label={`Cancel request ${r.id}`}>
                    {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}Cancel
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
