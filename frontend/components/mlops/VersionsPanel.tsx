"use client";

import { useState } from "react";
import { History, RotateCcw, ShieldCheck } from "lucide-react";
import { ApiError, apiPost, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { GatePill, Notice, Pill, delta1, pct1 } from "./bits";
import { shortDate, shortDateTime, type Version, type VersionsResp } from "./types";

function StatusCell({ v, runningVersion }: { v: Version; runningVersion?: string | null }) {
  if (v.active) return <Pill tone="brand">Champion</Pill>;
  if (v.status === "ready") return <Pill tone="good">Ready</Pill>;
  // A "training" manifest with no live job behind it was interrupted (e.g. the API restarted mid-run).
  if (v.status === "training" && runningVersion !== undefined && runningVersion !== v.version) return <Pill tone="neutral">Interrupted</Pill>;
  if (v.status === "training") return <Pill tone="info" spin>Training</Pill>;
  if (v.status === "failed") return <Pill tone="bad">Failed</Pill>;
  return <Pill tone="neutral">{v.status === "cancelled" ? "Cancelled" : v.status}</Pill>;
}

function PromoteDialog({ v, champion, onClose, onDone }: { v: Version | null; champion: Version | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsOverride = !!v && v.gate?.verdict !== "pass";
  const go = async () => {
    if (!v) return;
    setBusy(true); setErr(null);
    try {
      await apiPost(`/api/mlops/versions/${v.version}/promote`, { override: needsOverride, reason });
      onDone(); onClose(); setReason("");
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const g = v?.gate;
  return (
    <Modal open={!!v} onClose={onClose} title={v ? `Promote ${v.version}?` : ""} sub="The app switches to this model immediately for everyone. You can roll back afterwards." width={520}>
      {v && (
        <div className="space-y-3 text-[13px] text-ink-2">
          <div className="flex items-start gap-2"><GatePill verdict={g?.verdict} /><span className="flex-1 leading-relaxed">{g?.explanation}</span></div>
          {g?.candidate_scores && g?.champion_scores && (
            <table className="w-full text-[12.5px]">
              <thead className="text-ink-3"><tr><th className="py-1 text-left font-medium">Holdout WAPE</th><th className="py-1 text-right font-medium">{v.version}</th><th className="py-1 text-right font-medium">{champion?.version ?? "champion"}</th><th className="py-1 text-right font-medium">Change</th></tr></thead>
              <tbody>
                {(["item_week_wape", "category_week_wape"] as const).map((k) => (
                  <tr key={k} className="border-t border-hairline">
                    <td className="py-1">{k === "item_week_wape" ? "Item-week" : "Category-week"}</td>
                    <td className="tnum py-1 text-right">{pct1(g.candidate_scores?.[k])}</td>
                    <td className="tnum py-1 text-right">{pct1(g.champion_scores?.[k])}</td>
                    <td className="tnum py-1 text-right">{delta1(g.deltas?.[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {needsOverride && <Notice tone="bad">This promotion overrides the champion/challenger gate. It is recorded in the model history with your reason.</Notice>}
          <div>
            <label className={labelCls} htmlFor="promote-reason">Reason {needsOverride ? "(required, at least 5 characters)" : "(optional)"}</label>
            <input id="promote-reason" className={inputCls} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. retrained with September billing data" />
          </div>
        </div>
      )}
      {err && <p role="alert" className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={ghostBtn} onClick={onClose}>Cancel</button>
        <button className={needsOverride ? `${primaryBtn} !bg-[#b42f2f] hover:!bg-[#982626]` : primaryBtn}
          disabled={busy || (needsOverride && reason.trim().length < 5)} onClick={go}>
          {busy ? "Switching…" : needsOverride ? "Override and promote" : "Promote"}
        </button>
      </div>
    </Modal>
  );
}

function RollbackDialog({ open, target, current, onClose, onDone }: { open: boolean; target: string | null; current: string | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Roll back the model?" sub={`Switch from ${current ?? "?"} back to ${target ?? "?"}, the previous champion.`} width={460}>
      <label className={labelCls} htmlFor="rb-reason">Reason (optional)</label>
      <input id="rb-reason" className={inputCls} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      {err && <p role="alert" className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={ghostBtn} onClick={onClose}>Cancel</button>
        <button className={primaryBtn} disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await apiPost("/api/mlops/rollback", { reason }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Switching…" : `Roll back to ${target}`}</button>
      </div>
    </Modal>
  );
}

/** runningVersion (optional): the version of the job /api/mlops/status reports as running, or null when none runs. */
export function VersionsPanel({ canManage, refreshKey, onChange, runningVersion }: { canManage: boolean; refreshKey: number; onChange: () => void; runningVersion?: string | null }) {
  const { data, error, loading, reload } = useApi<VersionsResp>(`/api/mlops/versions?k=${refreshKey}`, { refetchOnStoreChange: false });
  const [promote, setPromote] = useState<Version | null>(null);
  const [rb, setRb] = useState(false);
  const done = () => { reload(); onChange(); };
  const champion = data?.versions.find((v) => v.active) ?? null;
  return (
    <Card delay={180}>
      <CardHeader title="Model registry" sub={data ? `Champion/challenger gate: a candidate may be at most ${fmt.one(data.tolerance * 100)} WAPE points worse than the champion on the same holdout weeks.` : undefined}
        right={canManage && data?.rollback_target ? (
          <button className={`${ghostBtn} !py-1.5 !text-[12px]`} onClick={() => setRb(true)}><RotateCcw className="h-3.5 w-3.5" aria-hidden /> Roll back to {data.rollback_target}</button>
        ) : undefined} />
      <div className="p-6 pt-4">
        {error ? <Notice tone="bad">{error}</Notice> : loading && !data ? <Skeleton className="h-40" /> : !data?.versions.length ? (
          <p className="rounded-xl bg-sunken px-4 py-6 text-center text-[13px] text-ink-3">No registered models yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[12.5px]">
              <thead className="text-ink-3">
                <tr>
                  <th className="py-2 font-medium">Version</th><th className="py-2 font-medium">Status</th>
                  <th className="py-2 pl-4 text-right font-medium" title="Weighted absolute % error per medicine per week (lower is better)">Item-week WAPE</th>
                  <th className="py-2 pl-4 text-right font-medium" title="Error after summing medicines to category per week">Category-week</th>
                  <th className="py-2 pl-4 text-right font-medium">Bias</th><th className="py-2 pl-4 text-right font-medium">90% interval cover</th>
                  <th className="py-2 pl-4 font-medium">Holdout · data</th><th className="py-2 font-medium">Gate</th><th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => {
                  const s = v.summary;
                  return (
                    <tr key={v.version} className={`border-t border-hairline align-top ${v.active ? "bg-brand-wash/40" : ""}`}>
                      <td className="py-2.5">
                        <p className="font-semibold">{v.version}</p>
                        <p className="text-[11px] text-ink-3">{shortDateTime(v.finished_at ?? v.created_at)}</p>
                        <p className="font-mono text-[10.5px] text-muted" title="hash of ml/*.py at training time">code {v.code_hash ?? "—"}</p>
                      </td>
                      <td className="py-2.5"><StatusCell v={v} runningVersion={runningVersion} />{v.explain_ok === false && <p className="mt-1 text-[11px] text-ink-3">no explanations</p>}</td>
                      <td className="tnum py-2.5 pl-4 text-right">{pct1(s?.item_week_wape)}</td>
                      <td className="tnum py-2.5 pl-4 text-right">{pct1(s?.category_week_wape)}</td>
                      <td className="tnum py-2.5 pl-4 text-right">{s?.bias == null ? "—" : fmt.signedPct(s.bias, 1)}</td>
                      <td className="tnum py-2.5 pl-4 text-right">{pct1(s?.coverage_90)}</td>
                      <td className="py-2.5 pl-4 text-[11.5px] text-ink-2">
                        {s?.holdout_window ? <p className="tnum">{shortDate(s.holdout_window[0])} – {shortDate(s.holdout_window[1])}</p> : <p>—</p>}
                        <p className="text-ink-3">{v.data_sources.length ? v.data_sources.map((d) => d.kind === "base" ? "base" : d.kind === "ledger" ? `ledger (${fmt.int(d.rows_used ?? 0)})` : d.label).join(" + ") : v.source ?? "—"}</p>
                        {v.error && <p className="text-[#8f2626]">{v.error}</p>}
                      </td>
                      <td className="max-w-[260px] py-2.5">
                        {v.gate ? (
                          <details>
                            <summary className="focus-ring cursor-pointer list-none rounded"><GatePill verdict={v.gate.verdict} /></summary>
                            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">{v.gate.explanation}</p>
                          </details>
                        ) : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {canManage && !v.active && v.status === "ready" && (
                          <button className={`${ghostBtn} !px-2.5 !py-1.5 !text-[12px]`} onClick={() => setPromote(v)}>
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Promote
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.history.length > 0 && (
          <details className="mt-4">
            <summary className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded text-[12.5px] font-medium text-ink-2"><History className="h-3.5 w-3.5" aria-hidden /> Promotion history</summary>
            <ul className="mt-2 space-y-1 text-[12px] text-ink-2">
              {data.history.map((h, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="tnum text-ink-3">{shortDateTime(h.at)}</span>
                  <span>{h.action === "promote" ? "Promoted" : h.action === "rollback" ? "Rolled back to" : "Registered"} <b>{h.version}</b>{h.previous ? ` (from ${h.previous})` : ""} by {h.user}</span>
                  {h.override && <Pill tone="warn">Gate overridden</Pill>}
                  {h.reason && <span className="text-ink-3">“{h.reason}”</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <PromoteDialog key={promote?.version ?? "none"} v={promote} champion={champion} onClose={() => setPromote(null)} onDone={done} />
      <RollbackDialog key={rb ? "open" : "closed"} open={rb} target={data?.rollback_target ?? null} current={data?.active ?? null} onClose={() => setRb(false)} onDone={done} />
    </Card>
  );
}
