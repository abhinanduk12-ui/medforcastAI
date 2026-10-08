"use client";

import { useCallback, useRef, useState } from "react";
import { CheckCircle2, CloudDownload, Download, FileSpreadsheet, IndianRupee, RefreshCw, TrendingUp, TriangleAlert, Upload, XCircle } from "lucide-react";
import { ApiError, apiPost, apiSend, useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { fmt } from "@/lib/format";
import { Card, CardHeader, Segmented, Skeleton, StatTile } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { Disclaimer, Empty, InlineError, dt, inr2, selectCls, td, th } from "./shared";

type Ceil = { id: number; formulation: string; strength: string | null; dosage_form: string | null; unit: string | null; ceiling_price: number; notification_ref: string | null; effective_date: string | null };
type Cand = { ceiling_id: number; confidence: number; reasons: string[]; formulation: string; strength: string | null; dosage_form: string | null; ceiling_price: number; unit: string | null };
type Match = { medicine_id: string; medicine_name: string; generic_name: string; form: string; status: "auto" | "review" | "confirmed" | "rejected"; ceiling_id: number | null; confidence: number | null; units_per_sale: number; ceiling: Ceil | null; candidates: Cand[]; note: string | null };
type Fetch = { ok?: boolean; status?: string; message?: string; attempted_at?: string; imported?: number; url?: string };
type Status = { total: number; sources: { source: string; n: number; uploaded_at: string }[]; last_fetch: Fetch | null; nppa_url: string; note: string; gst: { default: number; note: string } };
type Viol = { medicine_id: string; medicine_name: string; match_status: string; formulation: string; notification_ref: string | null; ceiling_per_unit: number; units_per_sale: number; gst: number; allowed_mrp: number; mrp: number; excess_pct: number; units_52w: number; exposure: number };
type VResp = { checked: number; violations: Viol[]; total_exposure: number; rule: string; price_note: string };
type PI = { available: boolean; message: string; rows: { medicine_id: string; medicine_name: string; price_start: number; price_end: number; annualised: number }[]; window?: string[] };

const MF = ["review", "auto", "confirmed", "rejected"] as const;
const MF_LABEL: Record<(typeof MF)[number], string> = { review: "Needs review", auto: "Auto-matched", confirmed: "Confirmed", rejected: "Rejected" };

export function CeilingsTab({ onChanged }: { onChanged?: () => void } = {}) {
  const { can } = useMe();
  const edit = can("settings.edit");
  const st = useApi<Status>("/api/compliance/ceilings?limit=1", { refetchOnStoreChange: false });
  const [mf, setMf] = useState<(typeof MF)[number]>("review");
  const m = useApi<{ rows: Match[]; counts: Record<string, number> }>(`/api/compliance/ceilings/matches?status=${mf}`, { refetchOnStoreChange: false });
  const v = useApi<VResp>("/api/compliance/ceilings/violations");
  const pi = useApi<PI>("/api/compliance/price-increases", { refetchOnStoreChange: false });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchRes, setFetchRes] = useState<Fetch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { reload: rSt } = st, { reload: rM } = m, { reload: rV } = v, { reload: rPi } = pi;
  const refresh = useCallback(() => { rSt(); rM(); rV(); rPi(); onChanged?.(); }, [rSt, rM, rV, rPi, onChanged]);
  const closeUpload = useCallback(() => setUploadOpen(false), []);
  const uploaded = useCallback(() => { setUploadOpen(false); refresh(); }, [refresh]);

  const fetchNppa = async () => {
    setFetching(true); setErr(null);
    try { const r = await apiPost<Fetch>("/api/compliance/ceilings/fetch", {}); setFetchRes(r); refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setFetching(false); }
  };
  const lf = fetchRes ?? st.data?.last_fetch ?? null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Ceiling rows loaded" value={st.data ? fmt.int(st.data.total) : "…"} hint={st.data?.sources[0] ? `from ${st.data.sources[0].source}` : "none yet"} />
        <StatTile label="Medicines matched" value={m.data ? fmt.int((m.data.counts.auto ?? 0) + (m.data.counts.confirmed ?? 0)) : "…"} hint={m.data ? `${m.data.counts.review ?? 0} to review` : undefined} />
        <StatTile label="Possible violations" value={v.data ? fmt.int(v.data.violations.length) : "…"} hint={v.data ? `of ${v.data.checked} checked` : undefined} />
        <StatTile label="Exposure (52 wk)" value={v.data ? fmt.inr(v.data.total_exposure) : "…"} hint="illustrative: synthetic prices" />
      </div>

      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-[15px] font-semibold tracking-tight">NPPA ceiling-price list</h2>
            {st.error && !st.data ? <div className="mt-2"><InlineError msg={st.error} /></div> : <p className="mt-1 text-[13px] text-ink-2">{st.data?.note ?? "Loading…"}</p>}
            {lf && (
              <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-ink-3">
                {lf.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-good" aria-hidden /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 text-[#a86a00]" aria-hidden />}
                <span>Last NPPA fetch {dt(lf.attempted_at)}: {lf.ok ? `imported ${lf.imported} rows` : lf.message}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <a className={ghostBtn} href="/api/compliance/ceilings/template.csv" download><Download className="h-4 w-4" aria-hidden />CSV template</a>
            {edit && <button className={ghostBtn} onClick={fetchNppa} disabled={fetching}><CloudDownload className="h-4 w-4" aria-hidden />{fetching ? "Trying NPPA (≤10 s)…" : "Try NPPA fetch"}</button>}
            {edit && <button className={primaryBtn} onClick={() => setUploadOpen(true)}><Upload className="h-4 w-4" aria-hidden />Upload list</button>}
          </div>
        </div>
        <div className="mt-3"><InlineError msg={err} /></div>
        {!edit && <p className="mt-2 text-[12.5px] text-ink-3">Only the owner can upload lists and confirm matches.</p>}
      </Card>

      <Card delay={40}>
        <CardHeader title="Match review" sub="Medicine ↔ ceiling row by molecule, strength and dosage form. ≥ 85% confidence is used automatically; everything else waits for you."
          right={<div className="max-w-full overflow-x-auto"><Segmented options={MF} value={mf} onChange={setMf} render={(x) => <span className="whitespace-nowrap">{MF_LABEL[x]}{m.data && <span className="tnum text-ink-3"> {m.data.counts[x] ?? 0}</span>}</span>} /></div>} />
        <div className="mt-3">
          {m.loading && !m.data ? <div className="space-y-2 p-6"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
            : m.error ? <div className="p-6"><InlineError msg={m.error} /></div>
            : !m.data?.rows.length ? <Empty title={st.data?.total ? `Nothing in “${MF_LABEL[mf]}”` : "No ceiling list loaded yet"} icon={FileSpreadsheet}>
                {st.data?.total ? null : "Upload the current NPPA ceiling-price list using the CSV template to start matching."}</Empty>
            : <ul className="divide-y divide-[var(--hairline)] border-t border-hairline">{m.data.rows.map((r) => <MatchRow key={r.medicine_id} r={r} edit={edit} onDone={refresh} />)}</ul>}
        </div>
      </Card>

      <Card delay={80}>
        <CardHeader title="Possible ceiling violations" sub={v.data?.rule} />
        <div className="mt-3 overflow-x-auto">
          {v.loading && !v.data ? <div className="p-6"><Skeleton className="h-24" /></div>
            : v.error ? <div className="p-6"><InlineError msg={v.error} /></div>
            : !v.data?.violations.length ? <Empty title={v.data?.checked ? "No MRP above the allowed ceiling" : "Nothing to check yet"} icon={CheckCircle2}>{v.data?.checked ? `${v.data.checked} matched medicine(s) checked.` : "Violations appear once ceiling rows are matched."}</Empty>
            : (
              <table className="w-full min-w-[860px] text-[13px]">
                <thead className="border-b border-hairline"><tr>{["Medicine", "Ceiling row", "Allowed MRP", "MRP (dataset)", "Excess", "Units 52 wk", "₹ exposure"].map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-[var(--hairline)]">
                  {v.data.violations.map((x) => (
                    <tr key={x.medicine_id}>
                      <td className={td}><span className="font-medium">{x.medicine_name}</span><span className="block text-[12px] text-ink-3">{x.match_status === "auto" ? "auto-matched" : "confirmed"}</span></td>
                      <td className={td}>{x.formulation}<span className="block text-[12px] text-ink-3">{inr2(x.ceiling_per_unit)}/unit{x.units_per_sale !== 1 ? ` × ${x.units_per_sale}` : ""} · {x.notification_ref ?? "no ref"}</span></td>
                      <td className={td + " tnum"}>{inr2(x.allowed_mrp)}<span className="block text-[12px] text-ink-3">incl. {fmt.pct(x.gst)} GST</span></td>
                      <td className={td + " tnum"}>{inr2(x.mrp)}</td>
                      <td className={td + " tnum font-medium text-critical"}><span className="inline-flex items-center gap-1"><TriangleAlert className="h-3.5 w-3.5" aria-hidden />+{fmt.pct(x.excess_pct, 1)}</span></td>
                      <td className={td + " tnum"}>{fmt.int(x.units_52w)}</td>
                      <td className={td + " tnum font-semibold"}>{fmt.inrFull(x.exposure)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </Card>

      <Card delay={120}>
        <CardHeader title="Non-scheduled price rises (informational)" sub={pi.data?.message} />
        <div className="mt-3 px-6 pb-6">
          {pi.error && !pi.data ? <InlineError msg={pi.error} /> : !pi.data ? <Skeleton className="h-16" /> : !pi.data.available ? (
              <div className="flex flex-wrap items-center gap-3"><p className="text-[13px] text-ink-3">{pi.data.message}</p>
                <button className={ghostBtn} onClick={rPi} disabled={pi.loading}><RefreshCw className={`h-3.5 w-3.5 ${pi.loading ? "animate-spin" : ""}`} aria-hidden />Check again</button></div>)
            : !pi.data.rows.length ? <p className="text-[13px] text-ink-3">No item rose more than 10% a year.</p> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {pi.data.rows.slice(0, 12).map((r) => (
                  <li key={r.medicine_id} className="flex items-center justify-between gap-3 rounded-xl border border-hairline px-3.5 py-2.5 text-[13px]">
                    <span className="min-w-0 truncate font-medium">{r.medicine_name}</span>
                    <span className="tnum whitespace-nowrap text-ink-2"><TrendingUp className="mr-1 inline h-3.5 w-3.5" aria-hidden />{inr2(r.price_start)} → {inr2(r.price_end)} · <b>{fmt.signedPct(r.annualised)}/yr</b></span>
                  </li>
                ))}
              </ul>
            )}
          {pi.data?.available && pi.data.rows.length > 12 && <p className="mt-2 text-[12px] text-ink-3">+{pi.data.rows.length - 12} more.</p>}
        </div>
      </Card>

      <Disclaimer>
        <b>How the check works.</b> NPPA ceiling prices exclude GST, so the allowed MRP is ceiling × (1 + GST) (default {st.data ? fmt.pct(st.data.gst.default) : "5%"}; {st.data?.gst.note}) {v.data?.price_note} Not legal advice — confirm the applicable notification and price with NPPA / your State Drugs Control authority before acting.
      </Disclaimer>

      {uploadOpen && <UploadDialog onClose={closeUpload} onDone={uploaded} />}
    </div>
  );
}

function MatchRow({ r, edit, onDone }: { r: Match; edit: boolean; onDone: () => void }) {
  const [cid, setCid] = useState<number | null>(r.ceiling_id ?? r.candidates[0]?.ceiling_id ?? null);
  const [ups, setUps] = useState(String(r.units_per_sale ?? 1));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const cand = r.candidates.find((c) => c.ceiling_id === cid) ?? null;
  const act = async (status: "confirmed" | "rejected") => {
    const n = Number(ups);
    if (status === "confirmed" && !(Number.isFinite(n) && n > 0 && n <= 100000)) { setErr("Ceiling units per unit sold must be a number above 0 (e.g. 1, or 60 for a 60 ml bottle priced per ml)."); return; }
    setBusy(true); setErr(null);
    try { await apiSend("PUT", `/api/compliance/ceilings/matches/${r.medicine_id}`, { status, ceiling_id: status === "confirmed" ? cid : null, units_per_sale: status === "confirmed" ? n : 1 }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const reset = async () => { setBusy(true); setErr(null); try { await apiSend("DELETE", `/api/compliance/ceilings/matches/${r.medicine_id}`); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const liquid = /syrup|suspension|solution|drop|cream|gel|lotion/i.test(r.form);
  return (
    <li className="grid grid-cols-1 gap-3 px-6 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] lg:items-center">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-semibold">{r.medicine_name}</p>
        <p className="text-[12px] text-ink-3">{r.generic_name} · {r.form}{r.confidence != null && <> · <span className="tnum">{fmt.pct(r.confidence)}</span> match</>}</p>
        {liquid && <p className="mt-0.5 text-[12px] text-[#7a5200]">Check the unit: ceiling may be per ml / g while the dataset price is per pack.</p>}
      </div>
      <div className="min-w-0 text-[13px]">
        {edit && r.status !== "confirmed" && r.candidates.length > 1 ? (
          <select aria-label="Ceiling row" value={cid ?? ""} onChange={(e) => setCid(Number(e.target.value))} className={selectCls + " w-full"}>
            {r.candidates.map((c) => <option key={c.ceiling_id} value={c.ceiling_id}>{c.formulation} {c.strength ?? ""} {c.dosage_form ?? ""} · ₹{c.ceiling_price}/{c.unit ?? "unit"} ({Math.round(c.confidence * 100)}%)</option>)}
          </select>
        ) : (r.ceiling || cand) ? (
          <p>{(r.ceiling ?? cand)!.formulation} {(r.ceiling ?? cand)!.strength ?? ""} {(r.ceiling ?? cand)!.dosage_form ?? ""} · <span className="tnum">{inr2((r.ceiling ?? cand)!.ceiling_price)}</span>/{(r.ceiling ?? cand)!.unit ?? "unit"}</p>
        ) : <p className="text-ink-3">No ceiling row (rejected)</p>}
        {cand && r.status !== "confirmed" && <p className="mt-0.5 text-[12px] text-ink-3">Matched on {cand.reasons.join(", ")}</p>}
        {r.status === "confirmed" && r.units_per_sale !== 1 && <p className="mt-0.5 text-[12px] text-ink-3">× {r.units_per_sale} ceiling units per unit sold</p>}
        <InlineError msg={err} />
      </div>
      {edit && (
        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          {r.status === "confirmed" || r.status === "rejected" ? (
            <button className={ghostBtn} disabled={busy} onClick={reset}>Undo decision</button>
          ) : (
            <>
              <label className="flex items-center gap-1 text-[12px] text-ink-3" title="How many ceiling units make one unit as sold (e.g. 60 for a 60 ml bottle priced per ml)">
                ×<input aria-label="Ceiling units per unit sold" type="number" min={0.001} step="any" value={ups} onChange={(e) => setUps(e.target.value)} className={inputCls + " h-9 w-16 px-2"} />
              </label>
              <button className={primaryBtn} disabled={busy || cid == null} onClick={() => act("confirmed")}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Confirm</button>
              <button className={ghostBtn} disabled={busy} onClick={() => act("rejected")}><XCircle className="h-3.5 w-3.5" aria-hidden />Not a match</button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [mode, setMode] = useState<"replace" | "append">("replace");
  const [check, setCheck] = useState<{ valid_rows: number } | null>(null);
  const [errors, setErrors] = useState<{ line: number; error: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    setCheck(null); setErrors([]); setErr(null);
    if (!f) return;
    if (f.size > 2_000_000) { setErr("File is larger than 2 MB"); return; }
    if (/\.(xlsx?|pdf|ods)$/i.test(f.name)) { setErr("Save the sheet as CSV (UTF-8) using the template columns first; spreadsheets and PDFs are not imported directly."); return; }
    let text: string;
    try { text = await f.text(); } catch { setErr("Could not read the file."); return; }
    setFile({ name: f.name, text });
    setBusy(true);
    try { setCheck(await apiPost<{ valid_rows: number }>("/api/compliance/ceilings/upload", { content: text, filename: f.name, dry_run: true })); }
    catch (e) {
      const d = (e as ApiError).detail as { errors?: { line: number; error: string }[] } | undefined;
      setErrors(d?.errors ?? []); setErr((e as Error).message);
    } finally { setBusy(false); }
  };
  const doImport = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { await apiPost("/api/compliance/ceilings/upload", { content: file.text, filename: file.name, mode }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Upload ceiling-price list" sub="CSV with the template columns. Prices per unit, excluding GST, from the official NPPA notification." width={520}>
      <div className="space-y-3">
        <input ref={input} type="file" accept=".csv,text/csv,text/plain" className="hidden" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; pick(f); }} />
        <button className={ghostBtn + " w-full"} disabled={busy} onClick={() => input.current?.click()}><FileSpreadsheet className="h-4 w-4" aria-hidden />{file ? file.name : "Choose CSV file…"}</button>
        {busy && !check && <Skeleton className="h-8" />}
        {check && <p className="flex items-center gap-1.5 text-[13px] text-good"><CheckCircle2 className="h-4 w-4" aria-hidden />{check.valid_rows} valid row(s), ready to import.</p>}
        {errors.length > 0 && (
          <ul className="max-h-40 overflow-auto rounded-xl border border-hairline p-2 text-[12px] text-ink-2">
            {errors.map((x, i) => <li key={i}>Line {x.line}: {x.error}</li>)}
          </ul>
        )}
        <InlineError msg={err} />
        <label className="block"><span className={labelCls}>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as "replace" | "append")} className={selectCls + " w-full"}>
            <option value="replace">Replace the current list (confirmed matches must be reviewed again)</option>
            <option value="append">Add to the current list</option>
          </select>
        </label>
        <div className="flex justify-end gap-2"><button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} disabled={!check || busy} onClick={doImport}><IndianRupee className="h-4 w-4" aria-hidden />Import</button></div>
      </div>
    </Modal>
  );
}
