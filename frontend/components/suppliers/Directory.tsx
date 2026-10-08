"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, Mail, Phone, Plus, Search, Undo2 } from "lucide-react";
import { apiPost, apiSend, useApi, type ApiError } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Sparkline, C } from "@/components/charts";
import { Skeleton } from "@/components/ui";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { LeadBadge, Notice, StatusBadge, days, num, shortDate } from "./bits";
import type { Policy, Scorecard, Supplier, SupplierDetail, SuppliersResp } from "./types";

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11.5px] text-ink-3">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tracking-tight tnum">{value}</p>
      {sub && <p className="text-[11px] text-muted tnum">{sub}</p>}
    </div>
  );
}

function priceLabel(pi: number | null) {
  if (pi == null) return "—";
  const d = pi - 1;
  return `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d * 100).toFixed(1)}%`;
}

function ScoreGrid({ sc }: { sc: Scorecard }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Metric label="Lead time (mean)" value={days(sc.lead.mean_days)} sub={`p90 ${days(sc.lead.p90_days)} · n ${sc.lead.n}`} />
      <Metric label="On time" value={fmt.pct(sc.on_time_pct)} sub={sc.on_time_n ? `${sc.on_time_n} POs` : "no POs due yet"} />
      <Metric label="Fill rate" value={fmt.pct(sc.fill_rate)} sub={sc.fill_n ? `${sc.fill_n} closed POs` : "no closed POs"} />
      <Metric label="Price vs median" value={priceLabel(sc.price_index)} sub={sc.price_n ? `${sc.price_n} shared medicines` : "needs 2+ suppliers"} />
    </div>
  );
}

export function SupplierCard({ s, onOpen, delay }: { s: Supplier; onOpen: () => void; delay: number }) {
  const sc = s.scorecard;
  const hist = sc?.lead_history.map((h) => h.days) ?? [];
  return (
    <button type="button" onClick={onOpen}
      className={`card rise focus-ring flex w-full flex-col gap-4 p-5 text-left transition hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.18)] ${s.active ? "" : "opacity-60"}`}
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold tracking-tight">{s.name}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">{s.id}{s.preferred_medicines ? ` · preferred for ${s.preferred_medicines} medicine${s.preferred_medicines === 1 ? "" : "s"}` : ""}{!s.active ? " · inactive" : ""}</p>
        </div>
        {hist.length >= 2 ? <Sparkline data={hist} width={84} height={28} color={C.s1} /> : sc && <LeadBadge lead={sc.lead} />}
      </div>
      {sc ? (
        <div className="grid grid-cols-3 gap-2">
          <Metric label="Lead" value={days(sc.lead.mean_days)} sub={sc.lead.status === "default" ? "default" : `p90 ${days(sc.lead.p90_days)}`} />
          <Metric label="On time" value={fmt.pct(sc.on_time_pct)} sub={sc.on_time_n ? `n ${sc.on_time_n}` : "no POs yet"} />
          <Metric label="Fill" value={fmt.pct(sc.fill_rate)} sub={sc.fill_n ? `n ${sc.fill_n}` : "no POs yet"} />
        </div>
      ) : <Skeleton className="h-12" />}
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        {sc && hist.length >= 2 && <LeadBadge lead={sc.lead} />}
        {sc && sc.open_pos > 0 && <span className="rounded-md bg-[#eef5fd] px-1.5 py-0.5 font-medium text-[#1c5cab]">{sc.open_pos} open · {fmt.inr(sc.open_value)}</span>}
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium ${s.return_policy.accepts_returns ? "bg-sunken text-ink-2" : "bg-[#fdf5f5] text-critical"}`}>
          <Undo2 className="h-3 w-3" aria-hidden /> {s.return_policy.accepts_returns ? `Returns ≥${s.return_policy.min_days_before_expiry} d` : "No returns"}
        </span>
      </div>
    </button>
  );
}

export function SupplierDirectory({ data, loading, error, onOpen, onNew, onPolicy }: {
  data: SuppliersResp | null; loading: boolean; error?: string | null; onOpen: (id: string) => void; onNew: () => void; onPolicy: () => void;
}) {
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const list = (data?.suppliers ?? []).filter((s) => (showInactive || s.active) &&
    (!q.trim() || `${s.name} ${s.id} ${s.contact ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden />
          <input className={`${inputCls} pl-9`} placeholder="Search suppliers" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search suppliers" />
        </div>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="focus-ring h-4 w-4 accent-[#0e5c4f]" /> Show inactive
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className={ghostBtn} onClick={onPolicy}><Undo2 className="h-4 w-4" aria-hidden /> Default return policy</button>
          {data?.can.edit && <button className={primaryBtn} onClick={onNew}><Plus className="h-4 w-4" aria-hidden /> New supplier</button>}
        </div>
      </div>
      {error && !data ? (
        <Notice tone="error">Could not load suppliers: {error}</Notice>
      ) : loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-44" />)}</div>
      ) : list.length === 0 ? (
        <div className="card p-10 text-center text-[13px] text-ink-3">{q.trim() ? "No suppliers match your search." : showInactive ? "No suppliers yet." : "No active suppliers. Tick “Show inactive” to see the rest."}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((s, i) => <SupplierCard key={s.id} s={s} delay={Math.min(i, 12) * 25} onOpen={() => onOpen(s.id)} />)}
        </div>
      )}
      {data && !data.history_ready && <div className="mt-4"><Notice>Sales history is still loading, so preferred-medicine counts may show 0 for a few seconds.</Notice></div>}
    </div>
  );
}

type Form = { name: string; gstin: string; contact: string; phone: string; email: string; default_lead_days: string; payment_terms: string; notes: string; active: boolean;
  custom_policy: boolean; accepts_returns: boolean; min_days: string; credit_pct: string };

function toForm(s: Supplier | null, d: Policy): Form {
  const p = s?.return_policy ?? d;
  return {
    name: s?.name ?? "", gstin: s?.gstin ?? "", contact: s?.contact ?? "", phone: s?.phone ?? "", email: s?.email ?? "",
    default_lead_days: String(s?.default_lead_days ?? 7), payment_terms: s?.payment_terms ?? "", notes: s?.notes ?? "", active: s?.active ?? true,
    custom_policy: !!s?.return_policy_override, accepts_returns: p.accepts_returns, min_days: String(p.min_days_before_expiry), credit_pct: String(Math.round(p.credit_pct * 100)),
  };
}

/** Supplier detail: scorecard, lead-time history, preferred medicines, POs, and (purchase.plan) the edit form. */
export function SupplierDialog({ id, open, onClose, policyDefault, onSaved, onOpenPO }: {
  id: string | null; open: boolean; onClose: () => void; policyDefault: Policy; onSaved: (msg: string) => void; onOpenPO: (id: number) => void;
}) {
  const isNew = id === "new";
  const api = useApi<SupplierDetail>(open && id && !isNew ? `/api/suppliers/${encodeURIComponent(id)}` : null);
  const { reload, loading } = api;
  // useApi keeps the previous supplier's payload while the next one loads; never show or edit it.
  const data = api.data && api.data.supplier.id === id ? api.data : null;
  const error = !loading && !data ? api.error : null;
  const policyRef = useRef(policyDefault);
  policyRef.current = policyDefault;
  const [f, setF] = useState<Form>(toForm(null, policyDefault));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    // policyDefault is read via a ref: a background reload of the directory must not wipe an edit in progress.
    if (isNew) { setF(toForm(null, policyRef.current)); setEditing(true); }
    else { setEditing(false); if (data) setF(toForm(data.supplier, policyRef.current)); }
  }, [open, isNew, id, data]);

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const lead = num(f.default_lead_days), md = num(f.min_days), cp = num(f.credit_pct);
    if (!f.name.trim()) return setErr("Name is required");
    if (!(lead > 0 && lead <= 120)) return setErr("Default lead time must be 1–120 days");
    if (f.custom_policy && (!Number.isInteger(md) || md < 0 || md > 730 || !(cp >= 0 && cp <= 100))) return setErr("Return policy: days 0–730, credit 0–100%");
    const body: Record<string, unknown> = {
      name: f.name.trim(), gstin: f.gstin.trim() || null, contact: f.contact.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null,
      default_lead_days: lead, payment_terms: f.payment_terms.trim() || null, notes: f.notes.trim() || null, active: f.active,
    };
    if (f.custom_policy) body.return_policy = { accepts_returns: f.accepts_returns, min_days_before_expiry: md, credit_pct: cp / 100 };
    else body.reset_return_policy = true;
    setBusy(true); setErr(null);
    try {
      const r = isNew ? await apiPost<Supplier>("/api/suppliers", body) : await apiSend<Supplier>("PUT", `/api/suppliers/${encodeURIComponent(id!)}`, body);
      onSaved(`${r.name} saved.`);
      if (isNew) onClose(); else { setEditing(false); reload(); }
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };

  const s = data?.supplier;
  const sc = data?.scorecard;
  const title = isNew ? "New supplier" : s?.name ?? "Supplier";
  return (
    <Modal open={open} onClose={onClose} title={title} width={760}
      sub={isNew ? "Ids are assigned automatically (SUP016, …)." : s ? `${s.id}${s.gstin ? ` · GSTIN ${s.gstin}` : ""}` : undefined}>
      {!isNew && error && <Notice tone="error">{error}</Notice>}
      {!isNew && loading && !data && <Skeleton className="h-64" />}
      {!isNew && s && sc && !editing && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
            {s.contact && <span className="inline-flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-ink-3" aria-hidden />{s.contact}</span>}
            {s.phone && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 text-ink-3" aria-hidden />{s.phone}</span>}
            {s.email && <span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 text-ink-3" aria-hidden />{s.email}</span>}
            {s.payment_terms && <span>Terms: {s.payment_terms}</span>}
            {!s.contact && !s.phone && !s.email && <span className="text-ink-3">No contact details yet.</span>}
          </div>
          <ScoreGrid sc={sc} />
          <div className="rounded-2xl border border-hairline p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">Lead time</p>
              <LeadBadge lead={sc.lead} />
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
              {sc.lead.status === "default"
                ? `No deliveries recorded yet, so plans use the default of ${days(sc.lead.default_days)}. Each PO you mark as sent and receive here teaches the model.`
                : `Default ${days(sc.lead.default_days)} blended with ${sc.lead.n} deliveries (sample mean ${days(sc.lead.sample_mean_days)}); data weight ${fmt.pct(sc.lead.weight_on_data)}.`}
            </p>
            {sc.lead_history.length > 0 && (
              <div className="mt-3 flex items-end gap-4">
                <Sparkline data={sc.lead_history.map((h) => h.days)} width={220} height={44} color={C.s1} />
                <p className="text-[11.5px] text-ink-3">Last {sc.lead_history.length} deliveries, days from sent to received</p>
              </div>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-hairline p-4">
              <p className="text-[13px] font-semibold">Returns policy <span className="font-normal text-ink-3">({s.return_policy.source === "supplier" ? "supplier-specific" : "shop default"})</span></p>
              <p className="mt-1 text-[12.5px] text-ink-2">{s.return_policy.accepts_returns
                ? `Accepts returns of stock with at least ${s.return_policy.min_days_before_expiry} days to expiry, credited at ${fmt.pct(s.return_policy.credit_pct)} of cost.`
                : "Does not accept returns."}</p>
              <p className="mt-1 text-[11.5px] text-muted">{data.notes.policy}</p>
            </div>
            <div className="rounded-2xl border border-hairline p-4">
              <p className="text-[13px] font-semibold">{data.history_ready ? `Preferred for ${data.medicine_count} medicine${data.medicine_count === 1 ? "" : "s"}` : "Preferred medicines"}</p>
              <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto text-[12.5px] text-ink-2">
                {data.medicines.slice(0, 40).map((m) => <li key={m.medicine_id} className="flex justify-between gap-2"><span className="truncate">{m.medicine_name}</span><span className="shrink-0 text-ink-3">{m.source === "override" ? "set manually" : m.share != null ? `${fmt.pct(m.share)} of lines` : ""}</span></li>)}
                {!data.medicines.length && <li className="text-ink-3">{data.history_ready ? "None." : "Sales history is still loading; reopen in a few seconds."}</li>}
              </ul>
            </div>
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold">Purchase orders</p>
            {data.pos.length ? (
              <ul className="divide-y divide-[var(--hairline)] rounded-2xl border border-hairline">
                {data.pos.slice(0, 12).map((p) => (
                  <li key={p.id}><button onClick={() => onOpenPO(p.id)} className="focus-ring flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-sunken">
                    <span className="font-medium tnum">{p.po_no}</span><StatusBadge status={p.status} overdue={p.overdue} />
                    <span className="text-ink-3 tnum">{fmt.inrFull(p.total_value)} · {shortDate(p.created_at)}</span>
                  </button></li>
                ))}
              </ul>
            ) : <p className="text-[12.5px] text-ink-3">No purchase orders yet.</p>}
          </div>
          {data.can.edit && <div className="flex justify-end"><button className={primaryBtn} onClick={() => setEditing(true)}>Edit supplier</button></div>}
        </div>
      )}
      {editing && (
        <form className="space-y-4" onSubmit={save} noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block"><span className={labelCls}>Name</span><input className={inputCls} value={f.name} onChange={set("name")} maxLength={80} required /></label>
            <label className="block"><span className={labelCls}>GSTIN (optional)</span><input className={inputCls} value={f.gstin} onChange={set("gstin")} maxLength={15} placeholder="15 characters" /></label>
            <label className="block"><span className={labelCls}>Contact person</span><input className={inputCls} value={f.contact} onChange={set("contact")} maxLength={80} /></label>
            <label className="block"><span className={labelCls}>Phone / WhatsApp</span><input className={inputCls} value={f.phone} onChange={set("phone")} maxLength={20} inputMode="tel" placeholder="+91 …" /></label>
            <label className="block"><span className={labelCls}>Email (for POs)</span><input className={inputCls} value={f.email} onChange={set("email")} maxLength={120} inputMode="email" /></label>
            <label className="block"><span className={labelCls}>Default lead time (days)</span><input className={inputCls} value={f.default_lead_days} onChange={set("default_lead_days")} inputMode="decimal" /></label>
            <label className="block"><span className={labelCls}>Payment terms</span><input className={inputCls} value={f.payment_terms} onChange={set("payment_terms")} maxLength={80} placeholder="e.g. 30 days credit" /></label>
            <label className="mt-6 inline-flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.active} onChange={(e) => setF((x) => ({ ...x, active: e.target.checked }))} className="h-4 w-4 accent-[#0e5c4f]" /> Active</label>
          </div>
          <label className="block"><span className={labelCls}>Notes</span><textarea className={`${inputCls} h-16 py-2`} value={f.notes} onChange={set("notes")} maxLength={500} /></label>
          <fieldset className="rounded-2xl border border-hairline p-4">
            <legend className="px-1 text-[12.5px] font-medium text-ink-2">Returns policy</legend>
            <label className="inline-flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.custom_policy} onChange={(e) => setF((x) => ({ ...x, custom_policy: e.target.checked }))} className="h-4 w-4 accent-[#0e5c4f]" /> Supplier-specific policy (otherwise the shop default)</label>
            {f.custom_policy && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="inline-flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.accepts_returns} onChange={(e) => setF((x) => ({ ...x, accepts_returns: e.target.checked }))} className="h-4 w-4 accent-[#0e5c4f]" /> Accepts returns</label>
                <label className="block"><span className={labelCls}>Min days to expiry</span><input className={inputCls} value={f.min_days} onChange={set("min_days")} inputMode="numeric" /></label>
                <label className="block"><span className={labelCls}>Credit % of cost</span><input className={inputCls} value={f.credit_pct} onChange={set("credit_pct")} inputMode="decimal" /></label>
              </div>
            )}
          </fieldset>
          {err && <Notice tone="error">{err}</Notice>}
          <div className="flex justify-end gap-2">
            <button type="button" className={ghostBtn} onClick={() => (isNew ? onClose() : setEditing(false))}>Cancel</button>
            <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function PolicyDialog({ open, onClose, policy, canEdit, onSaved }: { open: boolean; onClose: () => void; policy: Policy; canEdit: boolean; onSaved: (msg: string) => void }) {
  const [acc, setAcc] = useState(policy.accepts_returns);
  const [md, setMd] = useState(String(policy.min_days_before_expiry));
  const [cp, setCp] = useState(String(Math.round(policy.credit_pct * 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setAcc(policy.accepts_returns); setMd(String(policy.min_days_before_expiry)); setCp(String(Math.round(policy.credit_pct * 100))); setErr(null); } }, [open, policy]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !canEdit) return;
    const d = num(md), c = num(cp);
    if (!Number.isInteger(d) || d < 0 || d > 730 || !(c >= 0 && c <= 100)) return setErr("Days 0–730, credit 0–100%");
    setBusy(true); setErr(null);
    try { await apiSend("PUT", "/api/suppliers/settings/return-policy", { accepts_returns: acc, min_days_before_expiry: d, credit_pct: c / 100 }); onSaved("Default return policy saved."); onClose(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Default return policy" sub="Used for every supplier without its own policy (and by the dead-stock returns planner).">
      <form className="space-y-4" onSubmit={save}>
        <label className="inline-flex items-center gap-2 text-[13px]"><input type="checkbox" disabled={!canEdit} checked={acc} onChange={(e) => setAcc(e.target.checked)} className="h-4 w-4 accent-[#0e5c4f]" /> Suppliers accept returns</label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className={labelCls}>Min days to expiry</span><input disabled={!canEdit} className={inputCls} value={md} onChange={(e) => setMd(e.target.value)} inputMode="numeric" /></label>
          <label className="block"><span className={labelCls}>Credit % of cost</span><input disabled={!canEdit} className={inputCls} value={cp} onChange={(e) => setCp(e.target.value)} inputMode="decimal" /></label>
        </div>
        <Notice>Record what your distributors actually agree to; confirm terms in writing.</Notice>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ghostBtn} onClick={onClose}>{canEdit ? "Cancel" : "Close"}</button>
          {canEdit ? <button type="submit" className={primaryBtn} disabled={busy}>{busy ? "Saving…" : "Save"}</button> : <span className="self-center text-[12px] text-ink-3">Only the owner can change this.</span>}
        </div>
      </form>
    </Modal>
  );
}
