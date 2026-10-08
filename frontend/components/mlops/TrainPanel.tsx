"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Play, Square, Terminal } from "lucide-react";
import { ApiError, apiFetch, apiPost, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Card, CardHeader, Legend, Skeleton } from "@/components/ui";
import { ghostBtn, primaryBtn } from "@/components/auth/Modal";
import { ConfirmDialog } from "@/components/auth/UserDialogs";
import { GatePill, JobStatusPill, Notice } from "./bits";
import { shortDate, shortDateTime, type Job, type Preview, type Upload } from "./types";

// Fixed source -> colour mapping (base, ledger, then uploads in order); never re-coloured by rank and never
// cycled: uploads past the fourth fold into one "Other uploads" series.
const UPLOAD_COLORS = [C.s3, C.s4, C.s5, C.s7];
const OTHER_KEY = "__other_uploads";

const ACTIVE = ["queued", "preparing", "training", "explaining"];

function CoverageChart({ preview }: { preview: Preview }) {
  const { series, data } = useMemo(() => {
    let ui = 0;
    const folded: string[] = [];
    const out: { key: string; label: string; color: string }[] = [];
    for (const s of preview.sources) {
      if (s.rows_used <= 0) continue;
      if (s.kind === "base") out.push({ key: s.key, label: "Base history", color: C.s1 });
      else if (s.kind === "ledger") out.push({ key: s.key, label: "Billing ledger", color: C.s2 });
      else if (ui < UPLOAD_COLORS.length) out.push({ key: s.key, label: s.label, color: UPLOAD_COLORS[ui++] });
      else folded.push(s.key);
    }
    if (folded.length) out.push({ key: OTHER_KEY, label: `Other uploads (${folded.length})`, color: C.muted });
    const rows = folded.length
      ? preview.timeline.map((r) => ({ ...r, [OTHER_KEY]: folded.reduce((t, k) => t + Number(r[k] ?? 0), 0) }))
      : preview.timeline;
    return { series: out, data: rows };
  }, [preview]);
  return (
    <div>
      <div className="mb-2"><Legend items={series.map((s) => ({ label: s.label, color: s.color, kind: "dot" as const }))} /></div>
      <div role="img" aria-label={`Weekly units by data source, ${preview.weeks} weeks from ${preview.start} to ${preview.end}`}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap="12%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="week" tickFormatter={(v) => fmt.week(v)} tickLine={false} axisLine={{ stroke: C.axis }} minTickGap={28} />
            <YAxis tickFormatter={(v) => fmt.compact(v)} tickLine={false} axisLine={false} width={38} />
            <Tooltip
              cursor={{ fill: "rgba(11,11,11,0.04)" }}
              content={({ active, payload, label }) => active && payload?.length ? (
                <div className="min-w-[180px] rounded-xl border border-hairline bg-white/95 px-3.5 py-3 text-[12px] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]">
                  <p className="mb-2 font-medium">Week of {fmt.weekYear(String(label))}</p>
                  {series.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-4">
                      <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
                      <span className="tnum font-medium">{fmt.int(Number(payload[0].payload[s.key] ?? 0))} units</span>
                    </div>
                  ))}
                </div>
              ) : null}
            />
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke="#fff" strokeWidth={1}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function JobProgress({ jobId, onFinished, canCancel = false }: { jobId: string; onFinished: () => void; canCancel?: boolean }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const tick = async () => {
      try {
        const j = await apiFetch<Job>(`/api/mlops/jobs/${jobId}`);
        if (!alive) return;
        setJob(j); setErr(null);
        if (!ACTIVE.includes(j.status)) { if (!done) { done = true; onFinished(); } return; }
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
        if ((e as ApiError).status === 404 || (e as ApiError).status === 403) return; // job gone: stop polling
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [jobId, onFinished]);
  if (!job) return err ? <Notice tone="bad">{err}</Notice> : <Skeleton className="h-24" />;
  const running = ACTIVE.includes(job.status);
  return (
    <div className="space-y-3 rounded-2xl border border-hairline p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <JobStatusPill status={job.status} />
          <span className="text-[13px] font-medium">Candidate {job.version}</span>
          <span className="text-[12px] text-ink-3">started {shortDateTime(job.started_at ?? job.created_at)} by {job.user}</span>
        </div>
        {running && canCancel && (
          <button className={`${ghostBtn} !py-1.5 !text-[12px]`} onClick={() => setConfirm(true)}>
            <Square className="h-3.5 w-3.5" aria-hidden /> Cancel
          </button>
        )}
      </div>
      <div>
        <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)} aria-label="Training progress">
          <div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.max(2, job.progress)}%` }} />
        </div>
        <p className="tnum mt-1.5 text-[12.5px] text-ink-2">{Math.round(job.progress)}% · {job.message}</p>
      </div>
      {job.error && <Notice tone="bad">{job.error}</Notice>}
      {job.status === "succeeded" && job.gate && (
        <div className="flex flex-wrap items-start gap-2 text-[12.5px] text-ink-2"><GatePill verdict={job.gate.verdict} /><span className="flex-1">{job.gate.explanation}</span></div>
      )}
      {job.log_tail && job.log_tail.length > 0 && (
        <details>
          <summary className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded text-[12px] text-ink-3"><Terminal className="h-3.5 w-3.5" aria-hidden /> Log</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-xl bg-[#111] p-3 font-mono text-[11px] leading-relaxed text-[#e8e6df]">{job.log_tail.slice(-25).join("\n")}</pre>
        </details>
      )}
      <ConfirmDialog open={confirm} danger title="Cancel training?" confirm="Cancel job"
        body="The training process is stopped and the candidate is marked cancelled. The active model is not affected."
        onClose={() => setConfirm(false)} onConfirm={async () => { await apiPost(`/api/mlops/jobs/${job.id}/cancel`); }} />
    </div>
  );
}

export function TrainPanel({ canManage, runningJobId, refreshKey, onJobChange }: {
  canManage: boolean; runningJobId: string | null; refreshKey: number; onJobChange: () => void;
}) {
  const uploads = useApi<{ uploads: Upload[] }>(`/api/mlops/uploads?k=${refreshKey}`, { refetchOnStoreChange: false });
  const accepted = useMemo(() => (uploads.data?.uploads ?? []).filter((u) => u.status === "accepted"), [uploads.data]);
  const [sel, setSel] = useState<string[]>([]);
  const [ledger, setLedger] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(runningJobId);
  useEffect(() => { if (runningJobId) setJobId(runningJobId); }, [runningJobId]);
  useEffect(() => { setSel((s) => s.filter((id) => accepted.some((u) => u.id === id))); }, [accepted]);
  const q = `/api/mlops/datasets/preview?include_ledger=${ledger}${sel.length ? `&uploads=${sel.join(",")}` : ""}&k=${refreshKey}`;
  const preview = useApi<Preview>(q, { refetchOnStoreChange: false });
  const p = preview.data;
  const running = !!runningJobId;

  useEffect(() => {
    if (p && !p.ready) { const t = setTimeout(preview.reload, 5000); return () => clearTimeout(t); }
  }, [p, preview.reload]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ job: Job }>("/api/mlops/train", { uploads: sel, include_ledger_sales: ledger });
      setJobId(r.job.id); onJobChange();
    } catch (e) {
      setErr((e as ApiError).message);
      if ((e as ApiError).status === 409) onJobChange(); // another job is running: pick it up from /status
    } finally { setBusy(false); }
  };

  return (
    <Card delay={120}>
      <CardHeader title="Training data & retraining" sub="What a new training run would learn from. A full retrain usually takes 10–20 minutes (longer while the machine is busy) and never changes the live model until you promote it." />
      <div className="space-y-5 p-6 pt-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Sources</legend>
          <label className="flex items-center gap-2 text-[13px] text-ink-3"><input type="checkbox" checked disabled /> Base history (data/raw/pharma_dataset.xlsx, synthetic Kerala sales)</label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="focus-ring" checked={ledger} onChange={(e) => setLedger(e.target.checked)} />
            Sales billed through the app (main store ledger, returns excluded)
          </label>
          {accepted.map((u) => (
            <label key={u.id} className="flex min-w-0 items-center gap-2 text-[13px]">
              <input type="checkbox" className="focus-ring" checked={sel.includes(u.id)}
                onChange={(e) => setSel((s) => e.target.checked ? [...s, u.id] : s.filter((x) => x !== u.id))} />
              <span className="min-w-0 truncate">{u.filename}</span>
              <span className="tnum text-[12px] text-ink-3">{fmt.int(u.rows)} rows</span>
            </label>
          ))}
          {accepted.length === 0 && <p className="text-[12px] text-ink-3">Accepted uploads appear here.</p>}
        </fieldset>

        {preview.error ? <Notice tone="bad">{preview.error}</Notice> : !p ? <Skeleton className="h-56" /> : !p.ready ? (
          <Notice tone="info">{p.message}</Notice>
        ) : (
          <div className={`space-y-5 transition-opacity ${preview.loading ? "opacity-60" : ""}`} aria-busy={preview.loading}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[["Sales lines", fmt.int(p.rows)], ["Units", fmt.compact(p.units)], ["Weeks", fmt.int(p.weeks)], ["Range", `${shortDate(p.start)} – ${shortDate(p.end)}`]].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-sunken px-3 py-2"><p className="text-[11.5px] text-ink-3">{k}</p><p className="tnum mt-0.5 text-[13.5px] font-semibold">{v}</p></div>
              ))}
            </div>
            <CoverageChart preview={p} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[12.5px]">
                <thead className="text-ink-3"><tr><th className="py-1.5 font-medium">Source</th><th className="py-1.5 text-right font-medium">Rows used</th><th className="py-1.5 text-right font-medium">Weeks</th><th className="py-1.5 font-medium pl-4">Dates</th><th className="py-1.5 text-right font-medium">Dropped</th></tr></thead>
                <tbody>
                  {p.sources.map((s) => (
                    <tr key={s.key} className="border-t border-hairline">
                      <td className="py-1.5">{s.label}</td>
                      <td className="tnum py-1.5 text-right">{fmt.int(s.rows_used)}</td>
                      <td className="tnum py-1.5 text-right">{fmt.int(s.weeks)}</td>
                      <td className="tnum py-1.5 pl-4">{s.start ? `${shortDate(s.start)} – ${shortDate(s.end)}` : "—"}</td>
                      <td className="tnum py-1.5 text-right" title="duplicate transaction ids + rows on days a newer source covers">{fmt.int(s.dropped_duplicate_ids + s.dropped_overlap_rows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.warnings.map((w) => <Notice key={w}>{w}</Notice>)}
            <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-ink-3">{p.rules.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        )}

        {err && <Notice tone="bad">{err}</Notice>}
        {jobId && <JobProgress jobId={jobId} onFinished={onJobChange} canCancel={canManage} />}
        {canManage && (
          <div className="flex justify-end">
            <button className={primaryBtn} disabled={busy || running || !p?.ready} onClick={start}>
              <Play className="h-4 w-4" aria-hidden /> {running ? "Training in progress" : busy ? "Starting…" : "Train a candidate model"}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
