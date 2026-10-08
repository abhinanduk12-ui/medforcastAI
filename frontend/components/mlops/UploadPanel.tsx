"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, FileUp, Trash2, UploadCloud } from "lucide-react";
import { ApiError, apiFetch, apiPost, apiSend, errorMessage, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { ConfirmDialog } from "@/components/auth/UserDialogs";
import { Notice, UploadStatusPill, ValidationPill } from "./bits";
import { shortDate, shortDateTime, type Report, type Upload } from "./types";

async function sendFile(file: File): Promise<{ upload: Upload; report: Report }> {
  // Raw body + ?filename= (the API also accepts multipart/form-data).
  return apiFetch(`/api/mlops/uploads?filename=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
  });
}

export function ReportView({ report }: { report: Report }) {
  const errors = report.issues.filter((i) => i.severity !== "warning");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Rows in file", fmt.int(report.rows_total)],
          ["Rows accepted", fmt.int(report.rows_accepted)],
          ["Rows dropped", fmt.int(report.rows_rejected)],
          ["Dates", report.date_range ? `${shortDate(report.date_range[0])} – ${shortDate(report.date_range[1])}` : "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-sunken px-3 py-2">
            <p className="text-[11.5px] text-ink-3">{k}</p>
            <p className="tnum mt-0.5 text-[14px] font-semibold">{v}</p>
          </div>
        ))}
      </div>
      {report.issues.length === 0 && <Notice tone="info">No problems found. Every row matches the expected schema.</Notice>}
      {[["Errors (rows dropped)", errors], ["Warnings (rows kept)", warnings]].map(([title, list]) =>
        (list as Report["issues"]).length ? (
          <div key={title as string}>
            <p className="mb-2 text-[13px] font-semibold">{title as string}</p>
            <div className="space-y-2">
              {(list as Report["issues"]).map((i) => (
                <details key={i.code} className="group rounded-xl border border-hairline">
                  <summary className="focus-ring flex cursor-pointer list-none items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-[12.5px]">
                    <span className="text-ink-2">{i.message}</span>
                    <span className="tnum shrink-0 rounded-md bg-sunken px-1.5 py-0.5 font-medium">{fmt.int(i.count)}</span>
                  </summary>
                  {i.sample.length > 0 && (
                    <div className="overflow-x-auto border-t border-hairline">
                      <table className="w-full text-left text-[12px]">
                        <thead className="text-ink-3">
                          <tr>{Object.keys(i.sample[0]).map((k) => <th key={k} className="px-3 py-1.5 font-medium">{k === "row" ? "Row" : k}</th>)}</tr>
                        </thead>
                        <tbody>
                          {i.sample.map((r, n) => (
                            <tr key={n} className="border-t border-hairline">
                              {Object.values(r).map((v, k) => <td key={k} className="tnum whitespace-nowrap px-3 py-1.5">{v ?? "—"}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              ))}
            </div>
          </div>
        ) : null)}
      {report.columns_missing_optional?.length > 0 && report.status !== "fatal" && (
        <p className="text-[12px] text-ink-3">Optional columns not in the file (filled from the medicine master or defaults): {report.columns_missing_optional.join(", ")}.</p>
      )}
    </div>
  );
}

function ReviewDialog({ upload, report, canManage, onClose, onDone }: {
  upload: Upload | null; report: Report | null; canManage: boolean; onClose: () => void; onDone: () => void;
}) {
  const [addNew, setAddNew] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (what: "accept" | "reject") => {
    if (!upload) return;
    setBusy(true); setErr(null);
    try {
      await apiPost(`/api/mlops/uploads/${upload.id}/${what}`, what === "accept" ? { add_new_medicines: addNew } : { reason: reason || null });
      onDone(); onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!upload} onClose={onClose} title={upload ? upload.filename : ""} sub={upload ? `Uploaded ${shortDateTime(upload.created_at)}${upload.uploaded_by ? ` by ${upload.uploaded_by}` : ""}` : ""} width={760}>
      {upload && !report && <Skeleton className="h-40" />}
      {upload && report && (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center gap-2"><ValidationPill status={report.status} /><UploadStatusPill status={upload.status} /></div>
          <ReportView report={report} />
          {canManage && upload.status === "pending" && report.status !== "fatal" && (
            <div className="space-y-3 rounded-xl border border-hairline p-3">
              {upload.new_medicines > 0 && (
                <label className="flex items-start gap-2 text-[13px]">
                  <input type="checkbox" className="focus-ring mt-0.5" checked={addNew} onChange={(e) => setAddNew(e.target.checked)} />
                  <span>Add {upload.new_medicines} new medicine{upload.new_medicines > 1 ? "s" : ""} from this file&apos;s Medicine Master (otherwise their rows are left out).</span>
                </label>
              )}
              <div>
                <label className={labelCls} htmlFor="reject-reason">Reason if rejecting (optional)</label>
                <input id="reject-reason" className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      )}
      {err && <p role="alert" className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{err}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className={ghostBtn} onClick={onClose}>Close</button>
        {canManage && upload?.status === "pending" && report && report.status !== "fatal" && (
          <>
            <button className={ghostBtn} disabled={busy} onClick={() => act("reject")}>Reject</button>
            <button className={primaryBtn} disabled={busy} onClick={() => act("accept")}>{busy ? "Working…" : `Accept ${fmt.int(upload.rows)} rows`}</button>
          </>
        )}
      </div>
    </Modal>
  );
}

export function UploadPanel({ canManage, maxMb, onChange }: { canManage: boolean; maxMb: number; onChange: () => void }) {
  const list = useApi<{ uploads: Upload[]; base_ready: boolean }>("/api/mlops/uploads", { refetchOnStoreChange: false });
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ upload: Upload; report: Report | null } | null>(null);
  const [del, setDel] = useState<Upload | null>(null);

  const handle = async (file?: File | null) => {
    if (!file || busy) return; // one upload at a time (a drop while validating is ignored)
    setErr(null);
    if (!/\.(xlsx|xlsm|csv)$/i.test(file.name)) { setErr("Only .xlsx and .csv files are accepted."); return; }
    if (file.size > maxMb * 1024 * 1024) { setErr(`File is larger than ${maxMb} MB.`); return; }
    setBusy(true);
    try {
      const r = await sendFile(file);
      list.reload(); onChange();
      setOpen({ upload: r.upload, report: r.report });
    } catch (e) {
      const a = e as ApiError;
      setErr(a.status === 413 ? `File is larger than ${maxMb} MB.` : errorMessage(a.detail, a.message));
    } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  const openReport = async (u: Upload) => {
    setOpen({ upload: u, report: null });
    try {
      const r = await apiFetch<{ upload: Upload; report: Report }>(`/api/mlops/uploads/${u.id}/report`);
      setOpen({ upload: r.upload, report: r.report });
    } catch (e) { setOpen(null); setErr((e as Error).message); list.reload(); }
  };
  const uploads = list.data?.uploads ?? [];

  return (
    <Card delay={60}>
      <CardHeader title="Sales data uploads" sub="Same layout as the original workbook: a 'Sales Data' sheet (and optionally 'Medicine Master'), or a .csv." />
      <div className="space-y-4 p-6 pt-4">
        {canManage ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files?.[0]); }}
            className={`flex flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-8 text-center transition ${drag ? "border-brand bg-brand-wash" : "border-[var(--hairline-strong)] bg-surface-2"}`}
          >
            <UploadCloud className="h-7 w-7 text-ink-3" strokeWidth={1.6} aria-hidden />
            <p className="mt-2 text-[14px] font-medium">{busy ? "Validating…" : "Drop a sales file here"}</p>
            <p className="mt-1 text-[12px] text-ink-3">.xlsx or .csv, up to {maxMb} MB. Required: transaction_id, sale_date, medicine_id, quantity_sold, unit_price.</p>
            <button type="button" className={`${ghostBtn} mt-3`} disabled={busy} onClick={() => input.current?.click()}>
              <FileUp className="h-4 w-4" aria-hidden /> Choose file
            </button>
            <input ref={input} type="file" accept=".xlsx,.xlsm,.csv" className="sr-only" aria-label="Choose a sales file to upload" onChange={(e) => handle(e.target.files?.[0])} />
          </div>
        ) : (
          <Notice tone="info">Only the owner can upload data and retrain models. You can review uploads and model results.</Notice>
        )}
        {err && <Notice tone="bad">{err}</Notice>}
        {list.loading && !list.data ? <Skeleton className="h-24" /> : uploads.length === 0 ? (
          <p className="rounded-xl bg-sunken px-4 py-6 text-center text-[13px] text-ink-3">No uploads yet. Training uses the base history{canManage ? " plus anything billed through the app" : ""}.</p>
        ) : (
          <ul className="divide-y divide-[var(--hairline)] rounded-xl border border-hairline">
            {uploads.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{u.filename}</p>
                  <p className="tnum text-[11.5px] text-ink-3">
                    {fmt.int(u.rows)} rows · {u.date_range ? `${shortDate(u.date_range[0])} – ${shortDate(u.date_range[1])}` : "no valid rows"} · {shortDateTime(u.created_at)}
                  </p>
                </div>
                <ValidationPill status={u.validation} />
                <UploadStatusPill status={u.status} />
                <button className={`${ghostBtn} !px-2.5 !py-1.5 !text-[12px]`} onClick={() => openReport(u)}>{canManage && u.status === "pending" ? "Review" : "Report"}</button>
                {canManage && (
                  <button className={`${ghostBtn} !px-2 !py-1.5`} aria-label={`Delete ${u.filename}`} onClick={() => setDel(u)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ReviewDialog key={open?.upload.id ?? "none"} upload={open?.upload ?? null} report={open?.report ?? null} canManage={canManage} onClose={() => setOpen(null)} onDone={() => { list.reload(); onChange(); }} />
      <ConfirmDialog open={!!del} danger title="Delete upload?" confirm="Delete"
        body={<>This removes <b>{del?.filename}</b> and its validation report. Models already trained on it keep their copy of the training data.</>}
        onClose={() => setDel(null)}
        onConfirm={async () => { if (del) { await apiSend("DELETE", `/api/mlops/uploads/${del.id}`); list.reload(); onChange(); } }} />
    </Card>
  );
}
