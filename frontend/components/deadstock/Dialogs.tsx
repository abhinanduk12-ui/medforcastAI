"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Printer } from "lucide-react";
import { ApiError, apiPost, errorMessage, useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { Skeleton } from "@/components/ui";
import type { BatchOptions, RtvDetail } from "./types";

function errText(e: unknown) {
  return e instanceof ApiError ? errorMessage(e.detail, e.message) : e instanceof Error ? e.message : "Request failed";
}

/** Whole units in [1, max] from a free-typed field; null while the field is blank or invalid. */
function parseQty(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= max ? n : null;
}

function ErrLine({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="alert" className="mt-3 flex items-start gap-1.5 rounded-xl bg-[#fdecea] px-3 py-2 text-[12.5px] text-[#a8302f]">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{msg}</span>
    </p>
  );
}

/* ───────────────── Return to vendor ───────────────── */
export function RtvDialog({ batch, open, onClose, onDone, limit }: {
  batch: BatchOptions | null; open: boolean; onClose: () => void; onDone: (noteId: number, ref: string) => void; limit: number | null;
}) {
  const rtv = batch?.options.find((o) => o.key === "rtv");
  const suggested = Math.max(1, Math.min(batch?.qty ?? 1, Math.round(rtv?.units_returned || batch?.qty || 1)));
  const [raw, setRaw] = useState(String(suggested));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setRaw(String(limit != null ? Math.min(suggested, limit) : suggested)); setNote(""); setErr(null); } }, [open, suggested, limit]);
  if (!batch) return null;
  const credit = rtv?.credit_pct ?? 0.8;
  const max = limit != null ? Math.min(limit, batch.qty) : batch.qty;
  const qty = parseQty(raw, max);
  const submit = async () => {
    if (qty == null || inFlight.current) return; // no duplicate notes from a double click or Enter
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      const r = await apiPost<RtvDetail>("/api/deadstock/rtv", { store_id: batch.store_id, lines: [{ batch_id: batch.batch_id, qty }], note: note.trim() || null, credit_pct: credit });
      onDone(r.id, r.ref);
    } catch (e) { setErr(errText(e)); } finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create return-to-vendor note" sub={`${batch.medicine_name} · batch ${batch.batch_no} · ${batch.supplier_id ?? "unknown supplier"}`}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-sunken p-3 text-[12px]">
          <div><p className="text-ink-3">On hand</p><p className="font-semibold tnum">{batch.qty}</p></div>
          <div><p className="text-ink-3">Unit cost</p><p className="font-semibold tnum">₹{batch.unit_cost.toFixed(2)}</p></div>
          <div><p className="text-ink-3">Return by</p><p className="font-semibold tnum">{rtv?.deadline ? fmt.weekYear(rtv.deadline) : "—"}</p></div>
        </div>
        <div>
          <label htmlFor="rtv-qty" className={labelCls}>Units to return {limit != null && <span className="text-ink-3">(max {limit} for your role)</span>}</label>
          <input id="rtv-qty" type="number" inputMode="numeric" min={1} max={max} step={1} value={raw} className={inputCls}
            aria-invalid={qty == null} aria-describedby="rtv-qty-help" onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          <p id="rtv-qty-help" className={`mt-1.5 text-[12px] ${qty == null ? "text-critical" : "text-ink-3"}`}>
            {qty == null ? `Enter a whole number from 1 to ${max}.` : <>Suggested {suggested} (projected unsold or not worth holding). Expected credit {fmt.inrFull(qty * batch.unit_cost * credit)} at {fmt.pct(credit)}.</>}
          </p>
        </div>
        <div>
          <label htmlFor="rtv-note" className={labelCls}>Note (optional)</label>
          <input id="rtv-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="e.g. collected by rep on Monday" />
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          Removes the units from stock now (ledger reason “RTV &lt;ref&gt;”). Credit is an estimate until the supplier issues a credit note; verify GST treatment with your CA.
        </p>
        <ErrLine msg={err} />
        <div className="flex justify-end gap-2">
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} onClick={submit} disabled={busy || qty == null}>{busy ? "Creating…" : qty == null ? "Return" : `Return ${qty} unit${qty === 1 ? "" : "s"}`}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────── Markdown ───────────────── */
export function MarkdownDialog({ batch, open, onClose, onDone }: { batch: BatchOptions | null; open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const md = batch?.options.find((o) => o.key === "markdown");
  // The slider runs 5-50 % in 5 % steps; the grid's best can be missing (no price data) or outside that range.
  const best = Math.min(50, Math.max(5, Math.round(((md?.discount ?? 0.1) * 100) / 5) * 5));
  const [pct, setPct] = useState(best);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setPct(best); setNote(""); setErr(null); } }, [open, best]);
  if (!batch) return null;
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      await apiPost("/api/deadstock/markdowns", { store_id: batch.store_id, batch_id: batch.batch_id, discount_pct: pct / 100, note: note.trim() || null });
      onDone(`Markdown ${pct}% noted for ${batch.medicine_name} (batch ${batch.batch_no})`);
    } catch (e) { setErr(errText(e)); } finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Mark down this batch" sub={`${batch.medicine_name} · batch ${batch.batch_no}`}>
      <div className="space-y-4">
        <div>
          <label htmlFor="md-pct" className={labelCls}>Discount: {pct}% → ₹{(batch.price * (1 - pct / 100)).toFixed(2)} (from ₹{batch.price.toFixed(2)})</label>
          <input id="md-pct" type="range" min={5} max={50} step={5} value={pct} onChange={(e) => setPct(Number(e.target.value))}
            aria-valuetext={`${pct}% off`} className="w-full accent-[var(--brand)]" />
          <p className="mt-1 text-[12px] text-ink-3">
            {md?.discount != null ? `Model's best on the grid: ${best}%.` : "No model suggestion for this batch (no price history)."}
            {md && !md.eligible ? " The model does not expect a markdown to beat holding here." : ""}
          </p>
        </div>
        <div>
          <label htmlFor="md-note" className={labelCls}>Note (optional)</label>
          <input id="md-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          Saves a markdown note valid until the day before expiry (replacing any earlier note for this batch). It does not change prices by itself; the counter / POS reads it. Never sell above MRP.
        </p>
        <ErrLine msg={err} />
        <div className="flex justify-end gap-2">
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save markdown"}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────── Transfer ───────────────── */
export function TransferDialog({ batch, open, onClose, onDone, execute }: {
  batch: BatchOptions | null; open: boolean; onClose: () => void; onDone: (msg: string) => void; execute: boolean;
}) {
  const t = batch?.options.find((o) => o.key === "transfer");
  const suggested = Math.max(1, Math.min(batch?.qty ?? 1, Math.round(t?.units_moved ?? 1)));
  const [raw, setRaw] = useState(String(suggested));
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setRaw(String(suggested)); setErr(null); } }, [open, suggested]);
  if (!batch || !t?.to_store) return null;
  const qty = parseQty(raw, batch.qty);
  const submit = async () => {
    if (qty == null || inFlight.current) return;
    inFlight.current = true; setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ mode: string; result?: { moved?: number; allocation?: { batch_no: string; qty: number }[] } }>(
        "/api/deadstock/transfer", { store_id: batch.store_id, batch_id: batch.batch_id, to_store: t.to_store, qty });
      if (r.mode === "executed") {
        const moved = r.result?.moved ?? qty;
        const from = (r.result?.allocation ?? []).map((a) => `${a.batch_no} × ${a.qty}`).join(", ");
        onDone(`Moved ${moved} unit${moved === 1 ? "" : "s"} to ${t.to_store_name}${from ? ` (batches ${from})` : ""}`);
      } else {
        onDone(`Transfer request sent for approval (${qty} unit${qty === 1 ? "" : "s"} to ${t.to_store_name})`);
      }
    } catch (e) { setErr(errText(e)); } finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={execute ? "Transfer to a branch" : "Request a transfer"} sub={`${batch.medicine_name} → ${t.to_store_name}`}>
      <div className="space-y-4">
        <div>
          <label htmlFor="tr-qty" className={labelCls}>Units</label>
          <input id="tr-qty" type="number" inputMode="numeric" min={1} max={batch.qty} step={1} value={raw} className={inputCls}
            aria-invalid={qty == null} aria-describedby="tr-qty-help" onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          <p id="tr-qty-help" className={`mt-1.5 text-[12px] ${qty == null ? "text-critical" : "text-ink-3"}`}>
            {qty == null ? `Enter a whole number from 1 to ${batch.qty} (this batch's stock).` : `Suggested ${suggested}: what ${t.to_store_name} is projected to sell before expiry.`}
          </p>
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          {execute
            ? "Moves stock now through the Branches ledger, earliest-expiry first (normally this batch)."
            : "Your role files a request; an owner or buyer approves it on the Branches page."}{" "}
          Branch demand is simulated from the main shop until real branch sales exist.
        </p>
        <ErrLine msg={err} />
        <div className="flex justify-end gap-2">
          <button className={ghostBtn} onClick={onClose}>Cancel</button>
          <button className={primaryBtn} onClick={submit} disabled={busy || qty == null}>{busy ? "Sending…" : execute ? "Transfer now" : "Send request"}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────── RTV note (view + print) ───────────────── */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Opens a print-only window (its own styles, so nothing leaks into the app). Returns false if a pop-up blocker stopped it. */
function printNote(n: RtvDetail): boolean {
  const w = window.open("", "_blank", "width=820,height=900");
  if (!w) return false;
  const rows = n.lines.map((l) => `<tr><td>${esc(l.medicine_name ?? l.medicine_id)}<div class="s">${esc(l.generic_name ?? "")}</div></td><td>${esc(l.batch_no)}</td><td>${esc(l.expiry_date)}</td><td class="r">${l.qty}</td><td class="r">₹${l.unit_cost.toFixed(2)}</td><td class="r">₹${(l.qty * l.unit_cost).toFixed(2)}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(n.ref)}</title><style>
    body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b0b0b;margin:32px}
    h1{font-size:20px;margin:0 0 4px}.s{color:#6b6a65;font-size:11.5px}table{width:100%;border-collapse:collapse;margin-top:18px}
    th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left;vertical-align:top}th{font-size:11.5px;color:#6b6a65}.r{text-align:right}
    .grid{display:flex;gap:40px;margin-top:16px}.tot td{font-weight:600;border-bottom:none}.sig{display:flex;gap:60px;margin-top:56px}.sig div{border-top:1px solid #999;padding-top:6px;width:200px;font-size:11.5px;color:#6b6a65}
    @media print{body{margin:12mm}}</style></head><body>
    <h1>Return to vendor note</h1><div class="s">${esc(n.ref)} · ${esc(new Date(n.created_at).toLocaleString("en-IN"))}</div>
    <div class="grid"><div><div class="s">From</div><b>${esc(n.store_name)}</b><div>${esc(n.store_city ?? "")}</div></div>
    <div><div class="s">To supplier</div><b>${esc(n.supplier_id ?? "(not recorded)")}</b></div>
    <div><div class="s">Prepared by</div>${esc(n.created_by_name ?? "—")}</div></div>
    ${n.note ? `<p><span class="s">Note:</span> ${esc(n.note)}</p>` : ""}
    <table><thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th class="r">Qty</th><th class="r">Unit cost</th><th class="r">Value</th></tr></thead>
    <tbody>${rows}<tr class="tot"><td colspan="3">Total</td><td class="r">${n.total_units}</td><td></td><td class="r">₹${n.total_cost.toFixed(2)}</td></tr></tbody></table>
    <p class="s" style="margin-top:14px">Expected credit (estimate): ₹${n.expected_credit.toFixed(2)}. ${esc(n.disclaimer)}</p>
    <div class="sig"><div>Pharmacist / store signature</div><div>Received by (supplier)</div></div>
    <script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
  return true;
}

export function RtvNoteDialog({ id, onClose, onPrintBlocked }: { id: number | null; onClose: () => void; onPrintBlocked?: () => void }) {
  const { data, error, loading } = useApi<RtvDetail>(id ? `/api/deadstock/rtv/${id}` : null, { refetchOnStoreChange: false });
  return (
    <Modal open={id != null} onClose={onClose} title={data?.ref ?? "Return note"} sub={data ? `${data.store_name} → ${data.supplier_id ?? "supplier not recorded"}` : undefined} width={620}>
      {loading && !data ? <Skeleton className="h-40" /> : error ? <ErrLine msg={error} /> : data ? (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead><tr className="text-left text-ink-3"><th className="py-1.5 pr-3 font-medium">Medicine</th><th className="py-1.5 pr-3 font-medium">Batch</th><th className="py-1.5 pr-3 font-medium">Expiry</th><th className="py-1.5 pr-3 text-right font-medium">Qty</th><th className="py-1.5 text-right font-medium">Credit (est.)</th></tr></thead>
              <tbody>{data.lines.map((l) => (
                <tr key={l.id} className="border-t border-hairline">
                  <td className="py-1.5 pr-3">{l.medicine_name ?? l.medicine_id}{!l.eligible && <span className="ml-1.5 text-[11px] text-critical">past policy window</span>}</td>
                  <td className="py-1.5 pr-3 font-mono text-[12px]">{l.batch_no}</td>
                  <td className="py-1.5 pr-3 tnum">{l.expiry_date}</td>
                  <td className="py-1.5 pr-3 text-right tnum">{l.qty}</td>
                  <td className="py-1.5 text-right tnum">{fmt.inrFull(l.expected_credit)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-6 text-[12.5px]">
            <span><span className="text-ink-3">Units </span><b className="tnum">{data.total_units}</b></span>
            <span><span className="text-ink-3">Cost value </span><b className="tnum">{fmt.inrFull(data.total_cost)}</b></span>
            <span><span className="text-ink-3">Expected credit </span><b className="tnum">{fmt.inrFull(data.expected_credit)}</b></span>
          </div>
          <p className="text-[11.5px] text-ink-3">{data.disclaimer}</p>
          <div className="flex justify-end gap-2">
            <button className={ghostBtn} onClick={onClose}>Close</button>
            <button className={primaryBtn} onClick={() => { if (!printNote(data)) onPrintBlocked?.(); }}><Printer className="h-4 w-4" aria-hidden /> Print note</button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
