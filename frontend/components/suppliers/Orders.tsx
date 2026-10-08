"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Ban, CheckCheck, ExternalLink, PackageCheck, Pencil, Printer, Send, Trash2 } from "lucide-react";
import { apiPost, apiSend, useApi, type ApiError } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { MedicinePicker, Notice, StatusBadge, days, inr2, localDay, num, shortDate, type MedOption } from "./bits";
import type { ImportResp, PO, PODetailResp, POListResp, POStatus, Supplier } from "./types";
import { STATUS_LABEL, STATUS_ORDER } from "./types";

/* ───────────────── PO pipeline ───────────────── */

export function POBoard({ data, loading, error, filter, onFilter, onOpen }: {
  data: POListResp | null; loading: boolean; error: string | null; filter: POStatus | "open" | "all"; onFilter: (f: POStatus | "open" | "all") => void; onOpen: (id: number) => void;
}) {
  const counts = data?.counts;
  const openN = counts ? counts.draft + counts.sent + counts.partially_received : 0;
  const tabs: { key: POStatus | "open" | "all"; label: string; n?: number }[] = [
    { key: "open", label: "Open", n: openN },
    ...STATUS_ORDER.map((s) => ({ key: s, label: STATUS_LABEL[s], n: counts?.[s] })),
    { key: "all", label: "All" },
  ];
  const rows = (data?.items ?? []).filter((p) => filter === "all" || (filter === "open" ? ["draft", "sent", "partially_received"].includes(p.status) : p.status === filter));
  return (
    <div>
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-hairline bg-sunken p-1" role="tablist" aria-label="Purchase order status">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={filter === t.key} onClick={() => onFilter(t.key)}
            className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] transition ${filter === t.key ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3 hover:text-ink"}`}>
            {t.label}{t.n != null && <span className="rounded-md bg-sunken px-1.5 text-[11px] tnum text-ink-3">{t.n}</span>}
          </button>
        ))}
      </div>
      {error && !data && <Notice tone="error">{error}</Notice>}
      {loading && !data ? <Skeleton className="h-64" /> : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-[15px] font-semibold">No purchase orders here</p>
          <p className="mt-1 text-[13px] text-ink-3">Create one manually or import drafts from the stock planner / budget optimizer.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead><tr className="border-b border-hairline text-left text-[12px] text-ink-3">
              <th className="px-5 py-3 font-medium">PO</th><th className="px-3 py-3 font-medium">Supplier</th><th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 text-right font-medium">Lines</th><th className="px-3 py-3 text-right font-medium">Received</th>
              <th className="px-3 py-3 text-right font-medium">Value (ex-GST)</th><th className="px-5 py-3 font-medium">Expected</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer border-b border-hairline last:border-0 hover:bg-surface-2" onClick={() => onOpen(p.id)}>
                  <td className="px-5 py-3"><button className="focus-ring rounded font-medium tnum hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(p.id); }}>{p.po_no}</button>
                    <p className="text-[11.5px] text-ink-3">{shortDate(p.created_at)}{p.source !== "manual" ? ` · from ${p.source}` : ""}</p></td>
                  <td className="px-3 py-3"><span className="block max-w-[180px] truncate">{p.supplier_name ?? p.supplier_id}</span></td>
                  <td className="px-3 py-3"><StatusBadge status={p.status} overdue={p.overdue} /></td>
                  <td className="px-3 py-3 text-right tnum">{p.n_lines}</td>
                  <td className="px-3 py-3 text-right tnum">{fmt.int(p.units_received)} / {fmt.int(p.units_ordered)}</td>
                  <td className="px-3 py-3 text-right tnum">{fmt.inrFull(p.total_value)}</td>
                  <td className="px-5 py-3 tnum">{shortDate(p.expected_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ───────────────── PO editor (new / edit draft) ───────────────── */

type EdLine = { medicine_id: string; name: string; qty: string; cost: string; gst: string };

export function POEditor({ open, onClose, po, suppliers, storeName, onSaved }: {
  open: boolean; onClose: () => void; po: PO | null; suppliers: Supplier[]; storeName: string; onSaved: (msg: string, id: number) => void;
}) {
  const [sup, setSup] = useState("");
  const [lines, setLines] = useState<EdLine[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = useRef(false);
  // Reset only when the dialog opens or switches PO. A directory reload (new `suppliers` array, e.g. on a
  // store switch) must not wipe lines being typed.
  useEffect(() => {
    if (!open) return;
    setErr(null); dirty.current = false;
    if (po) {
      setSup(po.supplier_id); setNotes(po.notes ?? "");
      setLines(po.lines.map((l) => ({ medicine_id: l.medicine_id, name: l.medicine_name, qty: String(l.qty_ordered), cost: String(l.unit_cost), gst: String(l.gst_rate) })));
    } else { setSup(""); setLines([]); setNotes(""); }
  }, [open, po]);
  const firstActive = suppliers.find((s) => s.active)?.id ?? "";
  useEffect(() => { if (open && !po && !sup && firstActive) setSup(firstActive); }, [open, po, sup, firstActive]);

  // Escape / backdrop / Cancel ask before discarding typed lines (stable identity: Modal re-focuses on change).
  const guardedClose = useCallback(() => {
    if (dirty.current && !window.confirm("Discard the changes to this purchase order?")) return;
    onClose();
  }, [onClose]);

  const add = (m: MedOption) => { dirty.current = true; setLines((ls) => [...ls, { medicine_id: m.id, name: m.name, qty: "10", cost: m.price != null ? (m.price * 0.8).toFixed(2) : "", gst: "12" }]); };
  const upd = (i: number, k: keyof EdLine, v: string) => { dirty.current = true; setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); };
  const total = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
  const gst = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0) * (Number(l.gst) || 0) / 100, 0);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!sup) return setErr("Choose a supplier");
    if (!lines.length) return setErr("Add at least one medicine");
    for (const l of lines) {
      const q = num(l.qty), c = num(l.cost), g = num(l.gst);
      if (!Number.isInteger(q) || q < 1 || q > 100000) return setErr(`${l.name}: quantity must be a whole number 1–100,000`);
      if (!(c >= 0 && c <= 1e7)) return setErr(`${l.name}: enter the quoted unit cost (₹0–1,00,00,000)`);
      if (!(g >= 0 && g <= 28)) return setErr(`${l.name}: GST must be 0–28%`);
    }
    const body = { supplier_id: sup, notes: notes.trim() || null, lines: lines.map((l) => ({ medicine_id: l.medicine_id, qty_ordered: Number(l.qty), unit_cost: Number(l.cost), gst_rate: Number(l.gst) })) };
    setBusy(true); setErr(null);
    try {
      const r = po ? await apiSend<PO>("PUT", `/api/suppliers/po/${po.id}`, body) : await apiPost<PO>("/api/suppliers/po", body);
      dirty.current = false;
      onSaved(po ? `${r.po_no} updated.` : `Draft ${r.po_no} created.`, r.id);
      onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };

  const cell = "focus-ring h-9 w-full rounded-lg border border-hairline bg-surface px-2 text-right text-[13px] tnum";
  return (
    <Modal open={open} onClose={guardedClose} width={820} title={po ? `Edit ${po.po_no}` : "New purchase order"} sub={po ? "Only drafts can be edited." : `Draft for ${storeName}. Nothing is sent until you mark it as sent.`}>
      <form className="space-y-4" onSubmit={save} noValidate>
        <label className="block max-w-sm"><span className={labelCls}>Supplier</span>
          <select className={inputCls} value={sup} onChange={(e) => { dirty.current = true; setSup(e.target.value); }}>
            {!sup && <option value="">{suppliers.length ? "Choose a supplier" : "Loading suppliers…"}</option>}
            {suppliers.filter((s) => s.active || s.id === sup).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
          </select>
        </label>
        <MedicinePicker onPick={add} exclude={lines.map((l) => l.medicine_id)} />
        {lines.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-hairline">
            <table className="w-full min-w-[600px] text-[13px]">
              <thead><tr className="border-b border-hairline text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">Medicine</th><th className="w-24 px-2 py-2 text-right font-medium">Qty</th>
                <th className="w-28 px-2 py-2 text-right font-medium">Unit cost ₹</th><th className="w-20 px-2 py-2 text-right font-medium">GST %</th>
                <th className="w-28 px-2 py-2 text-right font-medium">Amount</th><th className="w-10" />
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.medicine_id} className="border-b border-hairline last:border-0">
                    <td className="px-3 py-1.5"><span className="block max-w-[220px] truncate font-medium">{l.name}</span><span className="text-[11px] text-ink-3">{l.medicine_id}</span></td>
                    <td className="px-2 py-1.5"><input className={cell} value={l.qty} onChange={(e) => upd(i, "qty", e.target.value)} inputMode="numeric" aria-label={`Quantity for ${l.name}`} /></td>
                    <td className="px-2 py-1.5"><input className={cell} value={l.cost} onChange={(e) => upd(i, "cost", e.target.value)} inputMode="decimal" aria-label={`Unit cost for ${l.name}`} /></td>
                    <td className="px-2 py-1.5"><input className={cell} value={l.gst} onChange={(e) => upd(i, "gst", e.target.value)} inputMode="decimal" aria-label={`GST rate for ${l.name}`} /></td>
                    <td className="px-2 py-1.5 text-right tnum">{fmt.inrFull((Number(l.qty) || 0) * (Number(l.cost) || 0))}</td>
                    <td className="px-1"><button type="button" onClick={() => { dirty.current = true; setLines((ls) => ls.filter((_, j) => j !== i)); }} aria-label={`Remove ${l.name}`} className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-critical"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="rounded-2xl border border-dashed border-hairline p-6 text-center text-[13px] text-ink-3">Search above to add medicines. Unit cost is prefilled at 80% of the median selling price; replace it with your quoted rate.</p>}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="block min-w-[240px] flex-1"><span className={labelCls}>Notes for the supplier</span><input className={inputCls} value={notes} onChange={(e) => { dirty.current = true; setNotes(e.target.value); }} maxLength={500} /></label>
          <p className="text-right text-[13px] text-ink-2 tnum">{inr2(total)} + GST {inr2(gst)}<br /><b className="text-[15px] text-ink">{inr2(total + gst)}</b></p>
        </div>
        <p className="text-[11.5px] text-muted">GST rates default to 12%; verify the HSN rate for each item with your CA. The supplier&apos;s tax invoice is authoritative.</p>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={guardedClose}>Cancel</button>
          <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Saving…" : po ? "Save draft" : "Create draft"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────── import drafts from planner / optimizer ───────────────── */

export function ImportDialog({ open, onClose, suppliers, onDone }: { open: boolean; onClose: () => void; suppliers: Supplier[]; onDone: (msg: string) => void }) {
  const [source, setSource] = useState<"planner" | "optimizer">("planner");
  const [budget, setBudget] = useState("50000");
  const [lead, setLead] = useState("1");
  const [review, setReview] = useState("2");
  const [prev, setPrev] = useState<ImportResp | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setPrev(null); setErr(null); } }, [open]);
  const names = useMemo(() => Object.fromEntries(suppliers.map((s) => [s.id, s.name])), [suppliers]);
  const body = () => ({ source, budget: Number(budget) || 0, lead_time: Number(lead) || 0, review: Number(review) || 1 });
  const preview = async () => {
    if (busy) return;
    const b = num(budget), l = num(lead), r = num(review);
    if (source === "optimizer" && !(b >= 0 && b <= 1e9)) return setErr("Budget must be 0–1,00,00,00,000");
    if (!Number.isInteger(l) || l < 0 || l > 8 || !Number.isInteger(r) || r < 1 || r > 8) return setErr("Lead time 0–8 weeks, review 1–8 weeks");
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<ImportResp>("/api/suppliers/po/import", { ...body(), preview: true });
      setPrev(res); setPick(new Set((res.groups ?? []).filter((g) => g.supplier_id !== "Unassigned").map((g) => g.supplier_id)));
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const create = async () => {
    if (busy) return;
    if (!pick.size) return setErr("Pick at least one supplier");
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<ImportResp>("/api/suppliers/po/import", { ...body(), preview: false, supplier_ids: [...pick] });
      const made = res.created ?? [], skip = (res.skipped ?? []).filter((x) => x.supplier_id !== "Unassigned");
      onDone(`Created ${made.length} draft PO${made.length === 1 ? "" : "s"}${made.length ? ": " + made.map((c) => c.po_no).join(", ") : ""}.`
        + (skip.length ? ` Skipped ${skip.map((x) => `${names[x.supplier_id] ?? x.supplier_id} (${x.reason})`).join("; ")}.` : ""));
      onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setPick((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal open={open} onClose={onClose} width={720} title="Import draft POs" sub="Group suggested quantities by each medicine's preferred supplier. Nothing is written until you create the drafts.">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="col-span-2 block sm:col-span-1"><span className={labelCls}>Source</span>
            <select className={inputCls} value={source} onChange={(e) => { setSource(e.target.value as "planner" | "optimizer"); setPrev(null); }}>
              <option value="planner">Stock planner</option><option value="optimizer">Budget optimizer</option>
            </select></label>
          {source === "optimizer" && <label className="block"><span className={labelCls}>Budget ₹</span><input className={inputCls} value={budget} onChange={(e) => { setBudget(e.target.value); setPrev(null); }} inputMode="numeric" /></label>}
          <label className="block"><span className={labelCls}>Lead (weeks)</span><input className={inputCls} value={lead} onChange={(e) => { setLead(e.target.value); setPrev(null); }} inputMode="numeric" /></label>
          <label className="block"><span className={labelCls}>Review (weeks)</span><input className={inputCls} value={review} onChange={(e) => { setReview(e.target.value); setPrev(null); }} inputMode="numeric" /></label>
        </div>
        {!prev && <div className="flex justify-end"><button type="button" className={primaryBtn} onClick={preview} disabled={busy}>{busy ? "Calculating…" : "Preview"}</button></div>}
        {prev && (
          <>
            <Notice>{prev.note}</Notice>
            {(prev.groups ?? []).length === 0 ? <p className="text-center text-[13px] text-ink-3">Nothing to order: stock already covers the plan.</p> : (
              <ul className="max-h-[42vh] space-y-2 overflow-y-auto">
                {(prev.groups ?? []).map((g) => {
                  const un = g.supplier_id === "Unassigned";
                  return (
                    <li key={g.supplier_id} className="rounded-2xl border border-hairline p-3">
                      <label className="flex cursor-pointer items-start gap-3">
                        <input type="checkbox" disabled={un} checked={pick.has(g.supplier_id)} onChange={() => toggle(g.supplier_id)} className="mt-1 h-4 w-4 accent-[#0e5c4f]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap justify-between gap-2 text-[13px]"><b className="font-semibold">{un ? "No supplier known" : `${names[g.supplier_id] ?? g.supplier_id}`}</b>
                            <span className="tnum text-ink-2">{g.lines.length} lines · {fmt.int(g.units)} units · {fmt.inrFull(g.value)}</span></span>
                          <span className="mt-0.5 block truncate text-[12px] text-ink-3">{g.lines.slice(0, 6).map((l) => `${l.medicine_name} ×${l.qty_ordered}`).join(", ")}{g.lines.length > 6 ? ", …" : ""}</span>
                          {un && <span className="mt-0.5 block text-[12px] text-critical">Set a preferred supplier for these medicines first.</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={ghostBtn} onClick={() => setPrev(null)}>Back</button>
              <button type="button" className={primaryBtn} onClick={create} disabled={busy || !pick.size}>{busy ? "Creating…" : `Create ${pick.size} draft${pick.size === 1 ? "" : "s"}`}</button>
            </div>
          </>
        )}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}

/* ───────────────── PO detail: print, send, receive, close, cancel ───────────────── */

const n2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function printPO(d: PODetailResp) {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  const p = d.po;
  const rows = p.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.medicine_name)}<br><small>${esc(l.medicine_id)}${l.form ? " · " + esc(l.form) : ""}</small></td><td class=r>${l.qty_ordered.toLocaleString("en-IN")}</td><td class=r>${n2(l.unit_cost)}</td><td class=r>${l.gst_rate}%</td><td class=r>${n2(l.amount)}</td></tr>`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.po_no)}</title><style>
    body{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b0b0b;margin:40px}h1{font-size:22px;margin:0 0 4px}
    .muted{color:#6b6a65}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border-bottom:1px solid #e5e4de;padding:7px 6px;text-align:left;vertical-align:top}
    th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b6a65}.r{text-align:right}.grid{display:flex;justify-content:space-between;gap:24px;margin-top:20px}
    .tot td{border:0}.big{font-size:16px;font-weight:600}small{color:#6b6a65}@media print{body{margin:16mm}}</style></head><body>
    <h1>Purchase order</h1><div class=muted>${esc(p.po_no)} · ${p.sent_at ? "Sent " + esc(shortDate(p.sent_at)) : "DRAFT — not yet sent"}</div>
    <div class=grid><div><b>From</b><br>${esc(d.store.name)}${d.store.city ? "<br>" + esc(d.store.city) : ""}</div>
    <div><b>To</b><br>${esc(d.supplier.name)} (${esc(d.supplier.id)})${d.supplier.gstin ? "<br>GSTIN " + esc(d.supplier.gstin) : ""}${d.supplier.contact ? "<br>" + esc(d.supplier.contact) : ""}${d.supplier.phone ? "<br>" + esc(d.supplier.phone) : ""}</div>
    <div><b>Expected by</b><br>${esc(p.expected_at ? shortDate(p.expected_at) : "to be confirmed")}${d.supplier.payment_terms ? "<br><b>Terms</b> " + esc(d.supplier.payment_terms) : ""}</div></div>
    <table><thead><tr><th>#</th><th>Item</th><th class=r>Qty</th><th class=r>Rate ₹</th><th class=r>GST</th><th class=r>Amount ₹</th></tr></thead><tbody>${rows}</tbody>
    <tfoot class=tot><tr><td colspan=5 class=r>Subtotal</td><td class=r>${n2(p.subtotal)}</td></tr><tr><td colspan=5 class=r>GST</td><td class=r>${n2(p.gst)}</td></tr>
    <tr><td colspan=5 class="r big">Total</td><td class="r big">${n2(p.grand_total)}</td></tr></tfoot></table>
    ${p.notes ? `<p><b>Notes:</b> ${esc(p.notes)}</p>` : ""}<p class=muted style="margin-top:28px">GST at the rates entered per line; the supplier's tax invoice is authoritative. Generated by MedForecast AI.</p>
    <script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
}

export function PODialog({ id, open, onClose, onChanged, onEdit }: {
  id: number | null; open: boolean; onClose: () => void; onChanged: (msg: string) => void; onEdit: (po: PO) => void;
}) {
  const api = useApi<PODetailResp>(open && id ? `/api/suppliers/po/${id}` : null, { refetchOnStoreChange: false });
  const { reload, loading } = api;
  // useApi keeps the previously opened PO while the next loads; never show or act on it.
  const data = api.data && api.data.po.id === id ? api.data : null;
  const error = !loading && !data ? api.error : null;
  const [mode, setMode] = useState<"view" | "send" | "receive">("view");
  const dirty = useRef(false);
  const toView = () => { dirty.current = false; setMode("view"); };
  // Escape / backdrop mid-receipt would silently drop typed batch numbers and expiries: ask first.
  const guardedClose = useCallback(() => {
    if (dirty.current && !window.confirm("Discard the delivery details you have entered?")) return;
    dirty.current = false;
    onClose();
  }, [onClose]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sendRes, setSendRes] = useState<{ message: string; wa_link: string; emailed: boolean; delivery: { status: string; error: string | null }[] } | null>(null);
  useEffect(() => { if (open) { dirty.current = false; setMode("view"); setErr(null); setSendRes(null); } }, [open, id]);

  const act = async (path: "close" | "cancel", msg: string) => {
    if (!data || busy) return;
    if (!window.confirm(path === "cancel" ? `Cancel ${data.po.po_no}?` : `Close ${data.po.po_no} short? The outstanding quantity will no longer be expected.`)) return;
    setBusy(true); setErr(null);
    try { await apiPost(`/api/suppliers/po/${data.po.id}/${path}`, {}); onChanged(msg); reload(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };

  const d = data;
  const p = d?.po;
  return (
    <Modal open={open} onClose={guardedClose} width={860} title={p ? p.po_no : "Purchase order"}
      sub={d ? `${d.supplier.name} → ${d.store.name}` : undefined}>
      {error && <Notice tone="error">{error}</Notice>}
      {loading && !d && <Skeleton className="h-72" />}
      {d && p && mode === "view" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            <StatusBadge status={p.status} overdue={p.overdue} />
            <span className="text-ink-3">Created {shortDate(p.created_at)}</span>
            {p.sent_at && <span className="text-ink-3">Sent {shortDate(p.sent_at)}</span>}
            <span className="text-ink-3">Expected {shortDate(p.expected_at)}</span>
            <span className="text-ink-3">Supplier lead {days(d.lead.mean_days)} (p90 {days(d.lead.p90_days)}, {d.lead.status})</span>
          </div>
          {sendRes && (
            <Notice tone={sendRes.emailed ? "info" : "warn"}>
              {sendRes.message}{sendRes.delivery.filter((x) => x.error).map((x, i) => <span key={i} className="block text-[12px] text-ink-3">{x.error}</span>)}{" "}
              <a href={sendRes.wa_link} target="_blank" rel="noreferrer" className="font-medium text-brand underline-offset-2 hover:underline">Share on WhatsApp</a>
            </Notice>
          )}
          <div className="overflow-x-auto rounded-2xl border border-hairline">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead><tr className="border-b border-hairline text-left text-[12px] text-ink-3">
                <th className="px-4 py-2 font-medium">Medicine</th><th className="px-2 py-2 text-right font-medium">Ordered</th><th className="px-2 py-2 text-right font-medium">Received</th>
                <th className="px-2 py-2 text-right font-medium">Rate</th><th className="px-2 py-2 text-right font-medium">GST</th><th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr></thead>
              <tbody>{p.lines.map((l) => (
                <tr key={l.id} className="border-b border-hairline last:border-0">
                  <td className="px-4 py-2"><span className="font-medium">{l.medicine_name}</span> <span className="text-[11.5px] text-ink-3">{l.medicine_id}</span></td>
                  <td className="px-2 py-2 text-right tnum">{fmt.int(l.qty_ordered)}</td>
                  <td className={`px-2 py-2 text-right tnum ${l.qty_received >= l.qty_ordered ? "text-good" : ""}`}>{fmt.int(l.qty_received)}</td>
                  <td className="px-2 py-2 text-right tnum">{inr2(l.unit_cost)}</td><td className="px-2 py-2 text-right tnum">{l.gst_rate}%</td>
                  <td className="px-4 py-2 text-right tnum">{inr2(l.amount)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <p className="text-right text-[13px] tnum text-ink-2">Subtotal {inr2(p.subtotal)} · GST {inr2(p.gst)} · <b className="text-ink">Total {inr2(p.grand_total)}</b></p>
          {p.notes && <p className="text-[13px] text-ink-2"><b className="font-medium">Notes:</b> {p.notes}</p>}
          {p.receipts.length > 0 && (
            <details className="rounded-2xl border border-hairline px-4 py-2 text-[12.5px]">
              <summary className="cursor-pointer font-medium">{p.receipts.length} receipt line{p.receipts.length === 1 ? "" : "s"}</summary>
              <ul className="mt-2 space-y-1 text-ink-2">{p.receipts.map((r) => <li key={r.id} className="tnum">{shortDate(r.received_at)} · {p.lines.find((l) => l.id === r.line_id)?.medicine_name ?? r.medicine_id} · batch {r.batch_no} · exp {shortDate(r.expiry_date)} · {r.qty.toLocaleString("en-IN")} units @ {inr2(r.unit_cost)}</li>)}</ul>
            </details>
          )}
          {err && <Notice tone="error">{err}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={ghostBtn} onClick={() => printPO(d)}><Printer className="h-4 w-4" aria-hidden /> Print / PDF</button>
            <a className={ghostBtn} href={d.wa_link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" aria-hidden /> WhatsApp text</a>
            {d.can.plan && p.status === "draft" && <button className={ghostBtn} onClick={() => onEdit(p)}><Pencil className="h-4 w-4" aria-hidden /> Edit</button>}
            {d.can.plan && (p.status === "draft" || p.status === "sent") && <button className={ghostBtn} disabled={busy} onClick={() => act("cancel", `${p.po_no} cancelled.`)}><Ban className="h-4 w-4" aria-hidden /> Cancel PO</button>}
            {d.can.plan && p.status === "partially_received" && <button className={ghostBtn} disabled={busy} onClick={() => act("close", `${p.po_no} closed short.`)}><CheckCheck className="h-4 w-4" aria-hidden /> Close short</button>}
            {d.can.plan && p.status === "draft" && <button className={primaryBtn} onClick={() => setMode("send")}><Send className="h-4 w-4" aria-hidden /> Mark as sent…</button>}
            {d.can.receive && (p.status === "sent" || p.status === "partially_received") && <button className={primaryBtn} onClick={() => setMode("receive")}><PackageCheck className="h-4 w-4" aria-hidden /> Receive goods</button>}
          </div>
        </div>
      )}
      {d && p && mode === "send" && <SendForm d={d} onBack={toView} onSent={(r) => { setSendRes(r); toView(); reload(); onChanged(r.message); }} />}
      {d && p && mode === "receive" && <ReceiveForm d={d} onBack={toView} onEdit={() => { dirty.current = true; }} onDone={(msg) => { toView(); reload(); onChanged(msg); }} />}
    </Modal>
  );
}

function SendForm({ d, onBack, onSent }: { d: PODetailResp; onBack: () => void; onSent: (r: { message: string; wa_link: string; emailed: boolean; delivery: { status: string; error: string | null }[] }) => void }) {
  const lead = Math.ceil(d.lead.mean_days);
  const today = localDay();
  const def = localDay(Date.now() + lead * 864e5);
  const [exp, setExp] = useState(def);
  const [email, setEmail] = useState(!!d.supplier.email);
  const [to, setTo] = useState(d.supplier.email ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (exp && exp < today) return setErr("Expected delivery can't be in the past");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) return setErr("Enter the supplier's email address, or untick \u201cAlso email the PO\u201d");
    setBusy(true); setErr(null);
    try { onSent(await apiPost(`/api/suppliers/po/${d.po.id}/send`, { expected_at: exp || null, email, email_to: email ? to.trim() || null : null })); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <Notice>Marking as sent starts the lead-time clock for this supplier. The app emails the PO only if email (SMTP) is configured on the server; otherwise it is just marked as sent and you share it yourself (WhatsApp text or print).</Notice>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block"><span className={labelCls}>Expected delivery</span><input type="date" className={inputCls} value={exp} min={today} onChange={(e) => setExp(e.target.value)} />
          <span className="mt-1 block text-[11.5px] text-ink-3">Default = today + learned lead time ({days(d.lead.mean_days)})</span></label>
        <div>
          <label className="mt-6 inline-flex items-center gap-2 text-[13px]"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} className="h-4 w-4 accent-[#0e5c4f]" /> Also email the PO</label>
          {email && <input className={`${inputCls} mt-2`} value={to} onChange={(e) => setTo(e.target.value)} placeholder="supplier@example.com" aria-label="Supplier email" inputMode="email" maxLength={120} />}
        </div>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onBack}>Back</button><button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Working…" : "Mark as sent"}</button></div>
    </form>
  );
}

type RLine = { line_id: number; name: string; outstanding: number; cost: number; qty: string; batch: string; expiry: string; ucost: string };

function ReceiveForm({ d, onBack, onDone, onEdit }: { d: PODetailResp; onBack: () => void; onDone: (msg: string) => void; onEdit: () => void }) {
  const [rows, setRows] = useState<RLine[]>(() => d.po.lines.filter((l) => l.outstanding > 0).map((l) => ({
    line_id: l.id, name: l.medicine_name, outstanding: l.outstanding, cost: l.unit_cost, qty: String(l.outstanding), batch: "", expiry: "", ucost: String(l.unit_cost),
  })));
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One id per dialog: a retried or double-submitted receive with the same id is a no-op on the server.
  const [requestId] = useState(() => `rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  const today = localDay();
  const soon = localDay(Date.now() + d.short_expiry_days * 864e5);
  const upd = (i: number, k: keyof RLine, v: string) => { onEdit(); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r))); };
  const active = rows.filter((r) => r.qty.trim() !== "" && Number(r.qty) > 0);
  const shortOnes = active.filter((r) => r.expiry && r.expiry < soon);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!active.length) return setErr("Enter a quantity for at least one line (leave 0 for items not delivered)");
    for (const r of active) {
      const q = Number(r.qty), c = num(r.ucost);
      if (!Number.isInteger(q) || q < 1) return setErr(`${r.name}: quantity must be a whole number`);
      if (q > r.outstanding) return setErr(`${r.name}: only ${r.outstanding} outstanding; raise a new PO for extra units`);
      if (!r.batch.trim()) return setErr(`${r.name}: batch number is required`);
      if (!r.expiry) return setErr(`${r.name}: expiry date is required`);
      if (r.expiry <= today) return setErr(`${r.name}: batch already expired — do not receive it`);
      if (!(c >= 0 && c <= 1e7)) return setErr(`${r.name}: enter the unit cost from the supplier's invoice (0 or more)`);
    }
    if (shortOnes.length && !accept) return setErr("Some batches have short expiry; tick the confirmation to accept them");
    setBusy(true); setErr(null);
    try {
      const res = await apiPost<{ po: PO; received: { qty: number }[]; duplicate?: boolean }>(`/api/suppliers/po/${d.po.id}/receive`, {
        accept_short_expiry: accept, request_id: requestId,
        lines: active.map((r) => ({ line_id: r.line_id, qty: Number(r.qty), batch_no: r.batch.trim(), expiry_date: r.expiry, unit_cost: Number(r.ucost) })),
      });
      const units = res.received.reduce((a, x) => a + x.qty, 0);
      onDone(res.duplicate ? `This delivery was already recorded on ${res.po.po_no}; nothing was booked twice.`
        : `Received ${units.toLocaleString("en-IN")} units on ${res.po.po_no} (${STATUS_LABEL[res.po.status].toLowerCase()}). Stock updated.`);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const cell = "focus-ring h-9 w-full rounded-lg border border-hairline bg-surface px-2 text-[13px]";
  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <p className="text-[13px] text-ink-2">Enter what actually arrived. Partial deliveries are fine; set 0 for lines not delivered. Each line becomes a stock batch at {d.store.name}, referenced to {d.po.po_no}.</p>
      <div className="overflow-x-auto rounded-2xl border border-hairline">
        <table className="w-full min-w-[700px] text-[13px]">
          <thead><tr className="border-b border-hairline text-left text-[12px] text-ink-3">
            <th className="px-3 py-2 font-medium">Medicine</th><th className="w-20 px-2 py-2 font-medium">Qty</th><th className="w-32 px-2 py-2 font-medium">Batch no.</th>
            <th className="w-40 px-2 py-2 font-medium">Expiry</th><th className="w-28 px-2 py-2 font-medium">Cost ₹ ex-GST</th>
          </tr></thead>
          <tbody>{rows.map((r, i) => {
            const short = r.expiry && r.expiry < soon;
            return (
              <tr key={r.line_id} className="border-b border-hairline last:border-0 align-top">
                <td className="px-3 py-2"><span className="block max-w-[200px] truncate font-medium">{r.name}</span><span className="text-[11.5px] text-ink-3 tnum">{r.outstanding} outstanding</span></td>
                <td className="px-2 py-2"><input className={`${cell} text-right tnum`} value={r.qty} onChange={(e) => upd(i, "qty", e.target.value)} inputMode="numeric" aria-label={`Quantity received for ${r.name}`} /></td>
                <td className="px-2 py-2"><input className={cell} value={r.batch} onChange={(e) => upd(i, "batch", e.target.value)} maxLength={40} aria-label={`Batch number for ${r.name}`} /></td>
                <td className="px-2 py-2"><input type="date" className={cell} value={r.expiry} min={today} onChange={(e) => upd(i, "expiry", e.target.value)} aria-label={`Expiry date for ${r.name}`} />
                  {short && <span className="mt-1 block text-[11px] font-medium text-[#a86b00]">Short expiry (&lt; 6 months)</span>}</td>
                <td className="px-2 py-2"><input className={`${cell} text-right tnum`} value={r.ucost} onChange={(e) => upd(i, "ucost", e.target.value)} inputMode="decimal" aria-label={`Unit cost for ${r.name}`} /></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {shortOnes.length > 0 && (
        <Notice tone="warn">
          {shortOnes.length} batch{shortOnes.length === 1 ? "" : "es"} expire within 6 months; check the supplier&apos;s return terms before accepting.
          <label className="mt-1.5 flex items-center gap-2 font-medium"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="h-4 w-4 accent-[#0e5c4f]" /> Accept short-expiry stock</label>
        </Notice>
      )}
      {err && <Notice tone="error">{err}</Notice>}
      <div className="flex justify-end gap-2"><button type="button" className={ghostBtn} onClick={onBack}>Back</button><button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Receiving…" : "Receive into stock"}</button></div>
    </form>
  );
}
