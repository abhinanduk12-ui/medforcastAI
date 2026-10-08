"use client";

import { useCallback, useEffect, useState } from "react";
import { History, PencilLine, Search, Undo2 } from "lucide-react";
import { apiPost, apiSend, useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Card, CardHeader, Segmented, Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { ConfidencePill, Empty, InlineError, Pager, SCHEDULES, SCHEDULE_INFO, ScheduleBadge, dt, qs, selectCls, type Schedule } from "./shared";

type Cls = {
  medicine_id: string; medicine_name: string; generic_name: string; category: string; form: string;
  schedule: Schedule; rule_schedule: Schedule; source: "rule" | "override"; basis: string; confidence: string;
  also: string[]; note: string | null; override: { schedule: Schedule; reason: string; updated_at: string } | null;
};
type Resp = { total: number; rows: Cls[]; sources: { schedule: string; ref: string; uncertainty: string }[]; disclaimer: string };
type Log = { rows: { id: number; medicine_id: string; medicine_name: string | null; action: string; old_schedule: string; new_schedule: string; reason: string; username: string | null; created_at: string }[] };

const FILTERS = ["All", ...SCHEDULES] as const;
const LIMIT = 40;

export function SchedulesTab({ onChanged }: { onChanged?: () => void } = {}) {
  const { can } = useMe();
  const edit = can("settings.edit");
  const [q, setQ] = useState(""); const [dq, setDq] = useState("");
  const [f, setF] = useState<(typeof FILTERS)[number]>("All");
  const [src, setSrc] = useState<"" | "override" | "low">("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Cls | null>(null);
  const [clearing, setClearing] = useState<Cls | null>(null);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => setOffset(0), [dq, f, src]);
  const path = `/api/compliance/schedules?${qs({ q: dq || null, schedule: f === "All" ? null : f, source: src === "override" ? "override" : null, confidence: src === "low" ? "low" : null, limit: LIMIT, offset })}`;
  const list = useApi<Resp>(path, { refetchOnStoreChange: false });
  const log = useApi<Log>("/api/compliance/schedules/log?limit=20", { refetchOnStoreChange: false });
  const { reload: reloadList } = list, { reload: reloadLog } = log;
  const done = useCallback(() => { setEditing(null); setClearing(null); reloadList(); reloadLog(); onChanged?.(); }, [reloadList, reloadLog, onChanged]);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeClear = useCallback(() => setClearing(null), []);

  return (
    <div className="space-y-5">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-[200px] flex-1">
            <span className={labelCls}>Search medicine or molecule</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search medicines" placeholder="e.g. tramadol" className={inputCls + " pl-9"} />
            </span>
          </label>
          <div className="max-w-full overflow-x-auto"><span className={labelCls}>Schedule</span><Segmented options={FILTERS} value={f} onChange={setF} /></div>
          <label className="block"><span className={labelCls}>Show</span>
            <select value={src} onChange={(e) => setSrc(e.target.value as "" | "override" | "low")} className={selectCls}>
              <option value="">Everything</option><option value="override">Owner overrides</option><option value="low">Low confidence (needs review)</option>
            </select>
          </label>
        </div>
      </Card>

      <Card delay={40}>
        <CardHeader title="Classification" sub={list.data ? `${list.data.total} medicine(s) · strictest applicable regime shown` : "Loading…"} />
        <div className="mt-3">
          {list.loading && !list.data ? <div className="space-y-2 p-6">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
            : list.error ? <div className="p-6"><InlineError msg={list.error} /></div>
            : !list.data?.rows.length ? <Empty title="No medicines match" />
            : (
              <ul className="divide-y divide-[var(--hairline)] border-t border-hairline">
                {list.data.rows.map((r) => (
                  <li key={r.medicine_id} className="grid grid-cols-1 gap-2 px-6 py-3.5 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ScheduleBadge s={r.schedule} />
                        {r.also.map((a) => <span key={a} className="text-[11.5px] text-ink-3">also {a}</span>)}
                        {r.source === "override" && <span className="rounded-md bg-[#fff4d6] px-1.5 py-0.5 text-[11px] font-medium text-[#7a5200]">Override (rule: {r.rule_schedule})</span>}
                      </div>
                      <p className="mt-1 truncate text-[14px] font-semibold">{r.medicine_name}</p>
                      <p className="truncate text-[12px] text-ink-3">{r.generic_name} · {r.form} · {r.category}</p>
                    </div>
                    <div className="min-w-0 text-[12.5px] text-ink-2">
                      {r.override ? <p><span className="font-medium">Reason:</span> {r.override.reason} <span className="text-ink-3">({dt(r.override.updated_at)})</span></p> : <p>{r.basis}</p>}
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3">{r.source === "rule" && <ConfidencePill c={r.confidence} />}{r.note && <span className="text-ink-3">{r.note}</span>}</div>
                    </div>
                    {edit && (
                      <div className="flex gap-1.5 sm:justify-end">
                        <button className={ghostBtn} onClick={() => setEditing(r)} aria-label={`Override schedule of ${r.medicine_name}`}><PencilLine className="h-3.5 w-3.5" aria-hidden />Override</button>
                        {r.override && <button className={ghostBtn} onClick={() => setClearing(r)} aria-label={`Clear override of ${r.medicine_name}`}><Undo2 className="h-3.5 w-3.5" aria-hidden />Clear</button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </div>
        {list.data && <Pager total={list.data.total} offset={offset} limit={LIMIT} onChange={setOffset} />}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card delay={80}>
          <CardHeader title="Sources & uncertainty" sub="How each label was derived" />
          <ul className="mt-3 space-y-3 px-6 pb-6 text-[13px]">
            {!list.data && <li><Skeleton className="h-16" /></li>}
            {list.data?.sources.map((s) => (
              <li key={s.schedule}><p className="font-medium">{s.schedule}</p><p className="text-ink-2">{s.ref}</p><p className="text-ink-3">{s.uncertainty}</p></li>
            ))}
          </ul>
        </Card>
        <Card delay={120}>
          <CardHeader title="Override audit trail" sub="Every change, who made it and why" />
          <div className="mt-3 px-6 pb-6">
            {log.error && !log.data ? <InlineError msg={log.error} /> : !log.data ? <Skeleton className="h-20" /> : !log.data.rows.length ? <Empty title="No overrides yet" icon={History} /> : (
              <ul className="space-y-2.5 text-[13px]">
                {log.data.rows.map((l) => (
                  <li key={l.id} className="border-l-2 border-hairline pl-3">
                    <p><span className="font-medium">{l.medicine_name ?? l.medicine_id}</span> · {l.action === "set" ? "set" : "cleared"} {l.old_schedule} → {l.new_schedule}</p>
                    <p className="text-ink-3">{l.reason} · {l.username ?? "system"} · {dt(l.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {editing && <OverrideDialog row={editing} onClose={closeEdit} onDone={done} />}
      {clearing && <ClearDialog row={clearing} onClose={closeClear} onDone={done} />}
    </div>
  );
}

function OverrideDialog({ row, onClose, onDone }: { row: Cls; onClose: () => void; onDone: () => void }) {
  const [s, setS] = useState<Schedule>(row.schedule);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await apiSend("PUT", `/api/compliance/schedules/${row.medicine_id}/override`, { schedule: s, reason }); onDone(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Override schedule · ${row.medicine_name}`} sub={`Rule says ${row.rule_schedule}: ${row.basis}`}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className={labelCls}>Schedule</span>
          <select value={s} onChange={(e) => setS(e.target.value as Schedule)} className={selectCls + " w-full"}>
            {SCHEDULES.map((x) => <option key={x} value={x}>{SCHEDULE_INFO[x].label} — {SCHEDULE_INFO[x].blurb}</option>)}
          </select>
        </label>
        <label className="block"><span className={labelCls}>Reason (kept in the audit trail)</span>
          <textarea required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="e.g. State Drugs Control circular no. … dated …" className={inputCls + " h-auto py-2"} />
        </label>
        <p className="text-[12px] text-ink-3">Changing to H1, X or NDPS makes a register entry mandatory at billing from now on.</p>
        <InlineError msg={err} />
        <div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} disabled={busy || reason.trim().length < 5}>{busy ? "Saving…" : "Save override"}</button></div>
      </form>
    </Modal>
  );
}

function ClearDialog({ row, onClose, onDone }: { row: Cls; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await apiPost(`/api/compliance/schedules/${row.medicine_id}/override/clear`, { reason }); onDone(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Clear override · ${row.medicine_name}`} sub={`Returns to the rule-based label (${row.rule_schedule}).`}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className={labelCls}>Reason</span>
          <input required minLength={5} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} /></label>
        <InlineError msg={err} />
        <div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} disabled={busy || reason.trim().length < 5}>{busy ? "Clearing…" : "Clear override"}</button></div>
      </form>
    </Modal>
  );
}
