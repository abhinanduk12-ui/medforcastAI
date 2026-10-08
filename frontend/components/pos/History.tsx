"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Ban, CloudOff, EyeOff, Printer, RotateCcw, Search, X } from "lucide-react";
import { ApiError, apiPost, useApi } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { Skeleton } from "@/components/ui";
import { ScheduleBadge, StatusBadge } from "./bits";
import { inr2, istDateTime, expiryLabel } from "./money";
import { PrintableReceipt } from "./Receipt";
import { PAYMENT_LABEL, type Invoice, type InvoiceList, type ReturnRec } from "./types";

/** Right-hand drawer: today's / recent invoices, detail, reprint, return (credit note) and same-day void. */
export function HistoryDrawer({ open, onClose, initialId, onChanged }: {
  open: boolean; onClose: () => void; initialId?: number | null; onChanged?: () => void;
}) {
  const { can } = useMe();
  const seesCustomers = can("sales.record");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [sel, setSel] = useState<number | null>(initialId ?? null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { if (open) setSel(initialId ?? null); }, [open, initialId]);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-labelledby="modal-title"]')) return; // a nested Modal handles its own keys
      if (e.key === "Escape") { if (sel != null && !initialId) setSel(null); else onClose(); return; }
      if (e.key === "Tab" && panel.current) { // keep focus inside the drawer
        const f = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!panel.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, sel, initialId, onClose]);
  // move focus into the drawer on open and give it back to the opener on close
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => { if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus(); }, 30);
    return () => { clearTimeout(t); prev?.focus?.(); };
  }, [open]);
  const list = useApi<InvoiceList>(open ? `/api/pos/invoices?limit=60${dq ? `&q=${encodeURIComponent(dq)}` : ""}` : null);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-[rgba(11,11,11,0.22)] backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Invoice history"
        className="rise relative flex h-full w-full max-w-[560px] flex-col border-l border-hairline bg-surface shadow-[0_30px_60px_-20px_rgba(11,11,11,0.35)]">
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
          {sel != null ? (
            <button onClick={() => setSel(null)} className="focus-ring -ml-1 inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[13px] font-medium text-ink-2 hover:bg-sunken">
              <ArrowLeft className="h-4 w-4" aria-hidden /> All invoices
            </button>
          ) : <h2 className="text-[16px] font-semibold tracking-tight">Invoices</h2>}
          <button onClick={onClose} aria-label="Close invoices" className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink"><X className="h-4 w-4" /></button>
        </div>
        {sel != null ? (
          <InvoiceDetail id={sel} onChanged={() => { list.reload(); onChanged?.(); }} />
        ) : (
          <>
            <div className="px-5 pt-4">
              <label className="relative block">
                <span className="sr-only">Search invoices</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={seesCustomers ? "Invoice no. or customer name" : "Invoice no."} className={`${inputCls} pl-9`} autoFocus />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {list.loading && !list.data ? (
                <div className="space-y-2 px-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
              ) : list.error ? (
                <p className="px-3 py-6 text-[13px] text-critical" role="alert">{list.error}</p>
              ) : !list.data?.items.length ? (
                <p className="px-3 py-10 text-center text-[13px] text-ink-3">No invoices {dq ? "match this search" : "yet in this store"}.</p>
              ) : (
                <>
                {list.data.items.some((r) => r.pii_redacted) && (
                  <p className="mx-3 mb-2 inline-flex items-center gap-1.5 text-[12px] text-ink-3"><EyeOff className="h-3.5 w-3.5" aria-hidden />Customer details are hidden for your role.</p>
                )}
                <ul className="space-y-1">
                  {list.data.items.map((r) => (
                    <li key={r.id}>
                      <button onClick={() => setSel(r.id)} className="focus-ring grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-sunken">
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-[12.5px] font-medium">{r.invoice_no}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-ink-3">
                            {istDateTime(r.created_at)} · {r.items} item{r.items === 1 ? "" : "s"} · {PAYMENT_LABEL[r.payment_mode]}
                            {r.customer_name ? ` · ${r.customer_name}` : ""}
                            {r.offline_created_at ? " · synced from offline" : ""}
                          </span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <span className="tnum text-[13.5px] font-semibold">{inr2(r.total)}</span>
                          <StatusBadge status={r.status} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                </>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function InvoiceDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { me, can } = useMe();
  const { data, error, loading, setData } = useApi<Invoice>(`/api/pos/invoices/${id}`);
  const [returnOpen, setReturnOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [printCn, setPrintCn] = useState<ReturnRec | null>(null);
  const [printing, setPrinting] = useState(false);
  const closeReturn = useCallback(() => setReturnOpen(false), []);
  const closeVoid = useCallback(() => setVoidOpen(false), []);

  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); setPrintCn(null); }, 60);
    return () => clearTimeout(t);
  }, [printing]);

  if (loading && !data) return <div className="space-y-3 p-5"><Skeleton className="h-20" /><Skeleton className="h-40" /></div>;
  if (error || !data) return <p className="p-5 text-[13px] text-critical" role="alert">{error ?? "Not found"}</p>;
  const inv = data;
  const mayVoid = can("sales.record") && inv.can_void_today && (me?.role === "owner" || me?.user.id === inv.user_id);
  const mayReturn = can("sales.record") && (inv.status === "paid" || inv.status === "partially_returned");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      {printing && <PrintableReceipt invoice={inv} creditNote={printCn} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[15px] font-semibold">{inv.invoice_no}</p>
          <p className="mt-1 text-[12.5px] text-ink-3">{istDateTime(inv.created_at)} · {inv.store.name} · by {inv.billed_by ?? "—"}</p>
          {inv.offline_created_at && <p className="mt-1 inline-flex items-center gap-1 text-[12px] text-ink-3"><CloudOff className="h-3.5 w-3.5" aria-hidden />Queued offline at {istDateTime(inv.offline_created_at)}</p>}
        </div>
        <StatusBadge status={inv.status} />
      </div>
      {inv.status === "void" && <p className="mt-3 rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-ink-2">Voided by {inv.voided_by_name ?? "—"}: {inv.void_reason}</p>}
      {inv.pii_redacted && <p className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-ink-3"><EyeOff className="h-3.5 w-3.5" aria-hidden />Customer details are hidden for your role.</p>}
      {(inv.customer_name || inv.prescriber_name) && (
        <p className="mt-3 text-[12.5px] text-ink-2">
          {inv.customer_name && <>Customer: <b className="font-medium">{inv.customer_name}</b>{inv.customer_phone_masked ? ` (${inv.customer_phone_masked})` : ""}</>}
          {inv.customer_name && inv.prescriber_name ? " · " : ""}
          {inv.prescriber_name && <>Prescriber: <b className="font-medium">{inv.prescriber_name}</b></>}
        </p>
      )}
      <ul className="mt-4 divide-y divide-[var(--hairline)] rounded-2xl border border-hairline">
        {inv.lines.map((l) => (
          <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-[13.5px] font-medium">{l.medicine_name} <ScheduleBadge schedule={l.schedule} compact /></p>
              <p className="mt-0.5 text-[12px] text-ink-3">
                Batch {l.batch_no} · exp {expiryLabel(l.expiry_date)} · {l.qty} × {inr2(l.mrp)}{l.discount_pct ? ` · −${l.discount_pct}%` : ""} · GST {l.gst_rate}%
                {l.qty_returned ? <span className="text-[#9a3b17]"> · {l.qty_returned} returned</span> : null}
              </p>
            </div>
            <p className="tnum text-[13.5px] font-semibold">{inr2(l.line_total)}</p>
          </li>
        ))}
      </ul>
      <dl className="mt-4 space-y-1.5 text-[13px]">
        <Row k="Taxable value" v={inr2(inv.subtotal_taxable)} />
        <Row k="CGST + SGST" v={`${inr2(inv.cgst)} + ${inr2(inv.sgst)}`} />
        {inv.discount_total > 0 && <Row k="Discount" v={`−${inr2(inv.discount_total)}`} />}
        <Row k="Round off" v={inr2(inv.round_off)} />
        <div className="flex items-center justify-between border-t border-hairline pt-2"><dt className="font-semibold">Total · {PAYMENT_LABEL[inv.payment_mode]}</dt><dd className="tnum text-[17px] font-semibold">{inr2(inv.total)}</dd></div>
      </dl>
      {inv.returns.length > 0 && (
        <div className="mt-5">
          <p className="eyebrow mb-2">Credit notes</p>
          <ul className="space-y-2">
            {inv.returns.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-3 py-2.5 text-[12.5px]">
                <span className="min-w-0">
                  <span className="block font-mono font-medium">{r.credit_note_no}</span>
                  <span className="block truncate text-ink-3">{istDateTime(r.created_at)} · {r.reason}
                    {r.lines.some((x) => x.disposition === "quarantined") ? " · expired units quarantined" : ""}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum font-semibold">{inr2(r.refund_total)}</span>
                  <button className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-surface hover:text-ink" aria-label={`Print credit note ${r.credit_note_no}`}
                    onClick={() => { setPrintCn(r); setPrinting(true); }}><Printer className="h-4 w-4" /></button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <button className={primaryBtn} onClick={() => { setPrintCn(null); setPrinting(true); }}><Printer className="h-4 w-4" aria-hidden />Reprint</button>
        {mayReturn && <button className={ghostBtn} onClick={() => setReturnOpen(true)}><RotateCcw className="h-4 w-4" aria-hidden />Return items</button>}
        {mayVoid && <button className={`${ghostBtn} text-critical`} onClick={() => setVoidOpen(true)}><Ban className="h-4 w-4" aria-hidden />Void</button>}
      </div>
      {!mayVoid && inv.status === "paid" && can("sales.record") && (
        <p className="mt-3 text-[12px] text-ink-3">{inv.can_void_today ? "Only the owner or the pharmacist who billed it can void this invoice." : "Older than today: use a return (credit note) instead of a void."}</p>
      )}
      <ReturnDialog open={returnOpen} inv={inv} onClose={closeReturn} onDone={(next) => { setData(next); onChanged(); }} />
      <VoidDialog open={voidOpen} inv={inv} onClose={closeVoid} onDone={(next) => { setData(next); onChanged(); }} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-center justify-between"><dt className="text-ink-3">{k}</dt><dd className="tnum">{v}</dd></div>;
}

function ReturnDialog({ open, inv, onClose, onDone }: { open: boolean; inv: Invoice; onClose: () => void; onDone: (i: Invoice) => void }) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { if (open) { setQty({}); setReason(""); setErr(null); setDone(null); } }, [open]);
  const lines = inv.lines.filter((l) => l.returnable_qty > 0);
  // the server's expiry rule uses the IST business date (expired = expiry_date <= today in IST), not UTC
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const chosen = useMemo(() => Object.entries(qty).filter(([, q]) => q > 0).map(([id, q]) => ({ line_id: Number(id), qty: q })), [qty]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ credit_note_no: string; refund_total: number; note: string | null; invoice: Invoice }>(`/api/pos/invoices/${inv.id}/return`, { lines: chosen, reason });
      setDone(`${r.credit_note_no} · refund ${inr2(r.refund_total)}${r.note ? `. ${r.note}` : ""}`);
      onDone(r.invoice);
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Customer return" sub={`Against ${inv.invoice_no}. Unexpired units go back to the same batch; expired units are quarantined, never restocked.`} width={560}>
      {done ? (
        <div>
          <p className="rounded-xl bg-brand-wash px-3 py-3 text-[13px] text-brand-ink" role="status">Credit note issued: {done}</p>
          <div className="mt-4 flex justify-end"><button className={primaryBtn} onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {lines.map((l) => {
              const expired = l.expiry_date <= today;
              return (
                <li key={l.id} className="flex items-center justify-between gap-3 rounded-xl border border-hairline px-3 py-2.5">
                  <span className="min-w-0 text-[13px]">
                    <span className="block truncate font-medium">{l.medicine_name}</span>
                    <span className="block text-[12px] text-ink-3">Batch {l.batch_no} · {l.returnable_qty} returnable · {inr2(l.line_total / l.qty)}/unit
                      {expired && <span className="font-medium text-critical"> · expired: will be quarantined</span>}</span>
                  </span>
                  <input type="number" min={0} max={l.returnable_qty} inputMode="numeric" aria-label={`Return quantity for ${l.medicine_name} batch ${l.batch_no}`}
                    value={qty[l.id] ?? 0} onChange={(e) => setQty((s) => ({ ...s, [l.id]: Math.max(0, Math.min(l.returnable_qty, Math.floor(Number(e.target.value) || 0))) }))}
                    className={`${inputCls} w-20 text-right tnum`} />
                </li>
              );
            })}
          </ul>
          <label className="mt-4 block"><span className={labelCls}>Reason</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={inputCls} placeholder="e.g. wrong strength dispensed" /></label>
          {err && <p className="mt-3 text-[13px] text-critical" role="alert">{err}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button className={ghostBtn} onClick={onClose}>Cancel</button>
            <button className={primaryBtn} disabled={busy || !chosen.length || reason.trim().length < 3} onClick={submit}>{busy ? "Issuing…" : "Issue credit note"}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function VoidDialog({ open, inv, onClose, onDone }: { open: boolean; inv: Invoice; onClose: () => void; onDone: (i: Invoice) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(""); setErr(null); } }, [open]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { onDone(await apiPost<Invoice>(`/api/pos/invoices/${inv.id}/void`, { reason })); onClose(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Void ${inv.invoice_no}?`} sub="Same-day only. All units go back to their batches; the invoice number stays on record as VOID.">
      <label className="block"><span className={labelCls}>Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={inputCls} placeholder="e.g. billed to wrong customer" /></label>
      {err && <p className="mt-3 text-[13px] text-critical" role="alert">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={ghostBtn} onClick={onClose}>Cancel</button>
        <button className={`${primaryBtn} bg-critical hover:bg-[#b02f2f]`} disabled={busy || reason.trim().length < 3} onClick={submit}>{busy ? "Voiding…" : "Void invoice"}</button>
      </div>
    </Modal>
  );
}
