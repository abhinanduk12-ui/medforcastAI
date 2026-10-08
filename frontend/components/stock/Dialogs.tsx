"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRightLeft, CheckCircle2, FileDown, FileUp, Info, Loader2, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { ApiError, apiFetch, apiPost } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import { MedicineCombobox, type MedOption } from "./bits";
import { dateFmt, daysText, todayIso, type Allocation, type Batch, type StoreRef, type Substitute } from "./types";

function ErrorLine({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 rounded-xl bg-[#fbeaea] px-3 py-2 text-[12.5px] font-medium text-critical">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{msg}</span>
    </p>
  );
}

function StoreLine({ store }: { store: StoreRef | null | undefined }) {
  if (!store) return null;
  return <>{store.name}{store.simulated ? " (simulated branch)" : ""}</>;
}

/** Pin every write to the store the page is showing, so a store switch in another tab cannot redirect it. */
const storeBody = (store: StoreRef | null | undefined) => (store ? { store_id: store.id } : {});
const storeQuery = (store: StoreRef | null | undefined) => (store ? `&store_id=${encodeURIComponent(store.id)}` : "");

/* ───────────────────────── Receive ───────────────────────── */

export function ReceiveDialog({ open, onClose, onDone, options, store, initialMed }: {
  open: boolean; onClose: () => void; onDone: (msg: string) => void; options: MedOption[]; store: StoreRef | null; initialMed?: string | null;
}) {
  const [med, setMed] = useState<string | null>(null);
  const [batch, setBatch] = useState("");
  const [expiry, setExpiry] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [supplier, setSupplier] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMed(initialMed ?? null); setBatch(""); setExpiry(""); setQty(""); setCost(""); setSupplier(""); setRef(""); setErr(null);
  }, [open, initialMed]);
  const minExp = todayIso(1);
  const days = expiry ? Math.round((new Date(expiry + "T00:00:00").getTime() - new Date(todayIso() + "T00:00:00").getTime()) / 86400000) : null;
  const q = Number(qty);
  const costN = Number(cost);
  const costOk = cost === "" || (Number.isFinite(costN) && costN >= 0 && costN <= 10_000_000);
  const valid = med && batch.trim() && expiry && expiry >= minExp && Number.isInteger(q) && q > 0 && q <= 1_000_000 && costOk;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setErr(null);
    try {
      await apiPost("/api/stock/receive", {
        ...storeBody(store), medicine_id: med, batch_no: batch.trim(), expiry_date: expiry, qty: q,
        unit_cost: cost === "" ? null : costN, supplier_id: supplier.trim() || null, ref: ref.trim() || null,
      });
      const name = options.find((o) => o.medicine_id === med)?.medicine_name ?? med;
      onDone(`Received ${q} × ${name} (batch ${batch.trim()})`);
      onClose();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Receive stock" sub={<>Into <StoreLine store={store} />. Adds a batch, or tops up one with the same number and expiry.</>} width={540}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label htmlFor="rcv-med" className={labelCls}>Medicine</label>
          <MedicineCombobox id="rcv-med" options={options} value={med} onChange={setMed} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="rcv-batch" className={labelCls}>Batch number</label>
            <input id="rcv-batch" value={batch} maxLength={40} onChange={(e) => setBatch(e.target.value)} className={inputCls} placeholder="e.g. BX24-1187" />
          </div>
          <div>
            <label htmlFor="rcv-exp" className={labelCls}>Expiry date</label>
            <input id="rcv-exp" type="date" min={minExp} value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
            {days != null && days > 0 && days <= 180 && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] font-medium text-[#8a5a00]"><TriangleAlert className="h-3 w-3" aria-hidden /> Short-dated: {daysText(days)} of shelf life</p>
            )}
            {days != null && days <= 0 && <p className="mt-1 text-[11.5px] font-medium text-critical">Expired goods cannot be received.</p>}
          </div>
          <div>
            <label htmlFor="rcv-qty" className={labelCls}>Quantity (units)</label>
            <input id="rcv-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, "").slice(0, 7))} className={inputCls} placeholder="0" />
          </div>
          <div>
            <label htmlFor="rcv-cost" className={labelCls}>Unit cost (₹) <span className="font-normal text-ink-3">optional</span></label>
            <input id="rcv-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.]/g, "").slice(0, 10))} className={inputCls} placeholder="80% of median price" aria-invalid={!costOk} />
            {!costOk && <p className="mt-1 text-[11.5px] font-medium text-critical">Enter a cost between ₹0 and ₹1,00,00,000.</p>}
          </div>
          <div>
            <label htmlFor="rcv-sup" className={labelCls}>Supplier <span className="font-normal text-ink-3">optional</span></label>
            <input id="rcv-sup" value={supplier} maxLength={64} onChange={(e) => setSupplier(e.target.value)} className={inputCls} placeholder="SUP013" />
          </div>
          <div>
            <label htmlFor="rcv-ref" className={labelCls}>Invoice / GRN ref <span className="font-normal text-ink-3">optional</span></label>
            <input id="rcv-ref" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} className={inputCls} />
          </div>
        </div>
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={!valid || busy} className={primaryBtn}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Receive {q > 0 ? fmt.int(q) : ""} units</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── Sell ───────────────────────── */

const SUB_CAUTION = "Strength, form and brand can differ: a pharmacist must confirm equivalence, and prescription items need the prescriber's agreement before substituting.";

type Preview = { ok: boolean; available: number; requested: number; allocation: Allocation[]; substitutes: Substitute[]; substitute_note: string | null };
type ExternalSub = { medicine_id?: string; id?: string; medicine_name?: string; name?: string; reason?: string; note?: string; match_note?: string; on_hand?: number; on_hand_here?: number };

/** Best-effort read of the substitutes feature (/api/substitutes/{id}: exact[] then same_molecule[]); silent on failure. */
function useExternalSubs(medId: string | null, enabled: boolean, store: StoreRef | null) {
  const [subs, setSubs] = useState<ExternalSub[] | null>(null);
  const sid = store?.id ?? null;
  useEffect(() => {
    if (!medId || !enabled) { setSubs(null); return; }
    let alive = true;
    apiFetch<unknown>(`/api/substitutes/${encodeURIComponent(medId)}${sid ? `?store_id=${encodeURIComponent(sid)}` : ""}`, { redirectOn401: false })
      .then((d) => {
        if (!alive) return;
        const o = d as Record<string, unknown>;
        const tiers = [...(Array.isArray(o?.exact) ? o.exact : []), ...(Array.isArray(o?.same_molecule) ? o.same_molecule : [])];
        const arr = Array.isArray(d) ? d : tiers.length ? tiers : Array.isArray(o?.substitutes) ? o.substitutes : Array.isArray(o?.items) ? o.items : Array.isArray(o?.alternatives) ? o.alternatives : [];
        setSubs((arr as ExternalSub[]).filter((x) => x && (x.medicine_id || x.id))
          .map((x) => ({ ...x, note: x.note ?? x.match_note, on_hand: x.on_hand ?? x.on_hand_here })).slice(0, 6));
      })
      .catch(() => { if (alive) setSubs(null); });
    return () => { alive = false; };
  }, [medId, enabled, sid]);
  return subs;
}

export function SellDialog({ open, onClose, onDone, options, store, initialMed, onPickMedicine }: {
  open: boolean; onClose: () => void; onDone: (msg: string) => void; options: MedOption[]; store: StoreRef | null; initialMed?: string | null;
  onPickMedicine?: (id: string) => void;
}) {
  const [med, setMed] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  const [ref, setRef] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [loadingPrev, setLoadingPrev] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setMed(initialMed ?? null); setQty("1"); setRef(""); setPrev(null); setErr(null); } }, [open, initialMed]);
  const q = Number(qty);
  const qOk = Number.isInteger(q) && q > 0 && q <= 100_000;

  useEffect(() => {
    setPrev(null);
    if (!open || !med || !qOk) { setLoadingPrev(false); return; }
    let alive = true;
    setLoadingPrev(true);
    const t = setTimeout(() => {
      apiPost<Preview>("/api/stock/sell", { ...storeBody(store), medicine_id: med, qty: q, dry_run: true })
        .then((p) => { if (alive) { setPrev(p); setErr(null); } })
        .catch((e: ApiError) => { if (alive) setErr(e.message); })
        .finally(() => { if (alive) setLoadingPrev(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, med, q, qOk, store]);

  const short = prev && !prev.ok;
  const ext = useExternalSubs(med, !!short, store);
  const extOnly = ext?.filter((x) => !prev?.substitutes.some((s) => s.medicine_id === (x.medicine_id ?? x.id))) ?? null;
  const name = options.find((o) => o.medicine_id === med)?.medicine_name ?? med;

  const submit = async () => {
    if (!med || !qOk || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ sold: number; allocation: Allocation[] }>("/api/stock/sell", { ...storeBody(store), medicine_id: med, qty: q, ref: ref.trim() || null });
      onDone(`Sold ${r.sold} × ${name} from ${r.allocation.length} batch${r.allocation.length === 1 ? "" : "es"} (FEFO)`);
      onClose();
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 409 && ae.detail && typeof ae.detail === "object") {
        const d = ae.detail as { available?: number; substitutes?: Substitute[]; substitute_note?: string };
        setPrev((p) => ({ ok: false, available: d.available ?? 0, requested: q, allocation: p?.allocation ?? [], substitutes: d.substitutes ?? [], substitute_note: d.substitute_note ?? null }));
      }
      setErr(ae.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record a sale" sub={<>At <StoreLine store={store} />. Units are taken first-expiry-first-out; expired batches are never sold.</>} width={560}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label htmlFor="sell-med" className={labelCls}>Medicine</label>
          <MedicineCombobox id="sell-med" options={options} value={med} onChange={setMed} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
          <div>
            <label htmlFor="sell-qty" className={labelCls}>Quantity</label>
            <input id="sell-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, "").slice(0, 6))} className={inputCls} />
          </div>
          <div>
            <label htmlFor="sell-ref" className={labelCls}>Bill / Rx ref <span className="font-normal text-ink-3">optional</span></label>
            <input id="sell-ref" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="rounded-2xl border border-hairline bg-surface-2 p-4">
          <p className="mb-2 flex items-center justify-between text-[12px] font-medium text-ink-2">
            <span>FEFO allocation preview</span>
            {loadingPrev && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-3" aria-label="Updating preview" />}
          </p>
          {!med ? <p className="text-[12.5px] text-ink-3">Pick a medicine to see which batches the units come from.</p>
            : !prev ? <p className="text-[12.5px] text-ink-3">…</p>
            : (
              <>
                {prev.allocation.length > 0 ? (
                  <ul className="space-y-1.5 text-[12.5px]">
                    {prev.allocation.map((a) => (
                      <li key={a.batch_id} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate"><b className="font-medium">{a.batch_no}</b> <span className="text-ink-3">· exp {dateFmt(a.expiry)}{a.days_left != null ? ` (${daysText(a.days_left)})` : ""}</span></span>
                        <span className="shrink-0 font-semibold tnum">{a.qty} u</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[12.5px] text-ink-3">No sellable batches.</p>}
                <p className="mt-2 border-t border-hairline pt-2 text-[12px] text-ink-3 tnum">{fmt.int(prev.available)} sellable unit{prev.available === 1 ? "" : "s"} in this store</p>
              </>
            )}
        </div>

        {short && prev && (
          <div className="rounded-2xl border border-[rgba(208,59,59,0.3)] bg-[#fdf5f5] p-4" role="status">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-critical"><OctagonAlert className="h-4 w-4" aria-hidden /> Not enough stock: {prev.available} of {prev.requested} available</p>
            {prev.available > 0 && (
              <button type="button" onClick={() => setQty(String(prev.available))} className="focus-ring mt-2 rounded-lg border border-hairline bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2 hover:bg-sunken">
                Sell the {fmt.int(prev.available)} available instead
              </button>
            )}
            {(prev.substitutes.length > 0 || (extOnly && extOnly.length > 0)) ? (
              <>
                {prev.substitutes.length > 0 && <p className="mt-2 text-[12.5px] font-medium text-ink">Same generic name, in stock here</p>}
                <ul className="mt-1.5 space-y-1.5 text-[12.5px]">
                  {prev.substitutes.map((s) => (
                    <li key={s.medicine_id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0">
                        <b className="font-medium">{s.medicine_name}</b> <span className="text-ink-3">· {s.generic_name} · {s.form}{!s.same_form ? " (different form)" : ""}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-ink-3 tnum">{fmt.int(s.on_hand)} on hand</span>
                        <button type="button" onClick={() => { setMed(s.medicine_id); onPickMedicine?.(s.medicine_id); }} aria-label={`Sell ${s.medicine_name} instead`} className="focus-ring rounded-lg border border-hairline bg-surface px-2 py-0.5 text-[11.5px] font-medium hover:bg-sunken">Use</button>
                      </span>
                    </li>
                  ))}
                </ul>
                {extOnly && extOnly.length > 0 && <p className="mt-2.5 text-[12.5px] font-medium text-ink">Other suggested alternatives <span className="font-normal text-ink-3">(substitutes check)</span></p>}
                <ul className="mt-1.5 space-y-1.5 text-[12.5px]">
                  {extOnly?.map((x) => (
                    <li key={x.medicine_id ?? x.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0"><b className="font-medium">{x.medicine_name ?? x.name ?? x.medicine_id ?? x.id}</b>{(x.reason || x.note) && <span className="text-ink-3"> · {x.reason ?? x.note}</span>}</span>
                      <span className="flex items-center gap-2">
                        {x.on_hand != null && <span className="text-ink-3 tnum">{fmt.int(x.on_hand)} here</span>}
                        <Link href={`/medicines/${encodeURIComponent(String(x.medicine_id ?? x.id))}`} className="focus-ring rounded text-[11.5px] font-medium text-brand hover:underline">Details</Link>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-2">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />
                  {(prev.substitutes.length > 0 && prev.substitute_note) || SUB_CAUTION}
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-[12.5px] text-ink-2">No item with the same generic name is in stock here. Check other branches in the item panel{prev.available > 0 ? ", or sell what is available" : ""}.</p>
            )}
          </div>
        )}

        <ErrorLine msg={short ? null : err} />
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={!med || !qOk || busy || !!short} className={primaryBtn}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Record sale</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── Adjust ───────────────────────── */

export function AdjustDialog({ open, onClose, onDone, batches, medicineName, store, limit, initialBatch }: {
  open: boolean; onClose: () => void; onDone: (msg: string) => void; batches: Batch[]; medicineName: string; store: StoreRef | null;
  limit: number | null; initialBatch?: number | null;
}) {
  const [batch, setBatch] = useState<number | null>(null);
  const [dir, setDir] = useState<"-" | "+">("-");
  const [n, setN] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setBatch(initialBatch ?? batches[0]?.batch_id ?? null); setDir("-"); setN(""); setReason(""); setErr(null); } }, [open, initialBatch, batches]);
  const b = batches.find((x) => x.batch_id === batch);
  const amt = Number(n);
  const delta = dir === "-" ? -amt : amt;
  const overLimit = limit != null && amt > limit;
  const below = b ? b.qty + delta < 0 : false;
  const valid = b && Number.isInteger(amt) && amt > 0 && !overLimit && !below && reason.trim().length >= 3;
  const submit = async () => {
    if (!valid || !b || busy) return;
    setBusy(true); setErr(null);
    try {
      await apiPost("/api/stock/adjust", { ...storeBody(store), batch_id: b.batch_id, delta, reason: reason.trim() });
      onDone(`Adjusted ${b.batch_no} by ${delta > 0 ? "+" : ""}${delta}`);
      onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Adjust stock" sub={<>{medicineName} at <StoreLine store={store} />. For count corrections, damage or breakage. Every adjustment is logged with your name and reason.</>} width={500}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label htmlFor="adj-batch" className={labelCls}>Batch</label>
          <select id="adj-batch" value={batch ?? ""} onChange={(e) => setBatch(Number(e.target.value))} className={inputCls}>
            {batches.map((x) => <option key={x.batch_id} value={x.batch_id}>{x.batch_no} · {x.qty} u · exp {dateFmt(x.expiry_date)}{x.expired ? " (expired)" : ""}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
          <div>
            <span className={labelCls}>Direction</span>
            <div className="inline-flex h-10 rounded-xl border border-hairline bg-sunken p-1" role="radiogroup" aria-label="Direction">
              {(["-", "+"] as const).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={dir === d} onClick={() => setDir(d)}
                  className={`focus-ring rounded-lg px-3 text-[13px] ${dir === d ? "bg-surface font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3"}`}>
                  {d === "-" ? "Remove" : "Add"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="adj-n" className={labelCls}>Units</label>
            <input id="adj-n" inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, "").slice(0, 7))} className={inputCls} placeholder="0" />
          </div>
        </div>
        {b && amt > 0 && <p className="text-[12.5px] text-ink-2 tnum">{b.batch_no}: {b.qty} → <b className="font-semibold text-ink">{b.qty + delta}</b> units</p>}
        {limit != null && <p className={`flex items-center gap-1.5 text-[12px] ${overLimit ? "font-medium text-critical" : "text-ink-3"}`}><Info className="h-3.5 w-3.5" aria-hidden /> Your role can adjust up to ±{limit} units per batch at a time. Larger corrections need the owner.</p>}
        {below && <p className="text-[12px] font-medium text-critical">The batch only has {b?.qty} units.</p>}
        <div>
          <label htmlFor="adj-reason" className={labelCls}>Reason</label>
          <input id="adj-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="e.g. Cycle count, 2 strips damaged" />
        </div>
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={!valid || busy} className={primaryBtn}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Save adjustment</button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── Write off expired ───────────────────────── */

export function WriteOffDialog({ open, onClose, onDone, store, expired }: {
  open: boolean; onClose: () => void; onDone: (msg: string) => void; store: StoreRef | null; expired: { batches: number; units: number; value: number } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) setErr(null); }, [open]);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiPost<{ batches: number; units: number; value: number }>("/api/stock/writeoff-expired", storeBody(store));
      onDone(r.batches ? `Wrote off ${fmt.int(r.units)} expired units from ${r.batches} batch${r.batches === 1 ? "" : "es"} (${fmt.inrFull(r.value)} at cost)` : "Nothing to write off");
      onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const none = !expired || expired.batches === 0;
  return (
    <Modal open={open} onClose={onClose} title="Write off expired stock" sub={<>At <StoreLine store={store} />. Sets every batch at or past its expiry date to zero and logs an expiry write-off.</>}>
      {none ? <p className="flex items-center gap-2 text-[13px] text-ink-2"><CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> No expired stock is on the shelf in this store.</p> : (
        <div className="grid grid-cols-3 gap-3 rounded-2xl bg-surface-2 p-4 text-center">
          <div><p className="text-[11.5px] text-ink-3">Batches</p><p className="mt-1 text-[20px] font-semibold tnum">{expired.batches}</p></div>
          <div><p className="text-[11.5px] text-ink-3">Units</p><p className="mt-1 text-[20px] font-semibold tnum">{fmt.int(expired.units)}</p></div>
          <div><p className="text-[11.5px] text-ink-3">At cost</p><p className="mt-1 text-[20px] font-semibold tnum">{fmt.inrFull(expired.value)}</p></div>
        </div>
      )}
      {!none && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">Physically remove these packs and quarantine them for return or disposal as per your drug-disposal procedure before confirming.</p>}
      <div className="mt-4"><ErrorLine msg={err} /></div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>{none ? "Close" : "Cancel"}</button>
        {!none && <button type="button" onClick={submit} disabled={busy} className={`${primaryBtn} !bg-critical hover:!bg-[#b13131]`}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Write off {fmt.int(expired.units)} units</button>}
      </div>
    </Modal>
  );
}

/* ───────────────────────── CSV import ───────────────────────── */

type ImportRow = { row: number; medicine_id: string; medicine_name: string; batch_no: string; expiry_date: string; qty: number; unit_cost: number; cost_assumed: boolean; supplier_id: string | null; value: number };
type ImportResp = {
  committed: boolean; rows: number; valid_rows: number; error_rows: number; can_commit: boolean;
  errors: { row: number; field: string; message: string }[]; warnings: { row: number; message: string }[];
  totals: { units: number; value: number; medicines: number }; preview: ImportRow[];
};

async function postCsv(text: string, commit: boolean, store: StoreRef | null): Promise<ImportResp> {
  return apiFetch<ImportResp>(`/api/stock/import?commit=${commit}${storeQuery(store)}`, { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
}

export function ImportDialog({ open, onClose, onDone, store }: { open: boolean; onClose: () => void; onDone: (msg: string) => void; store: StoreRef | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [rep, setRep] = useState<ImportResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setFile(null); setRep(null); setErr(null); } }, [open]);

  const read = (f: File) => {
    setErr(null); setRep(null);
    if (f.size > 2_000_000) { setErr("File is larger than 2 MB"); return; }
    f.text().then(async (text) => {
      setFile({ name: f.name, text });
      setBusy(true);
      try { setRep(await postCsv(text, false, store)); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
    }).catch(() => setErr("Could not read this file"));
  };
  const commit = async () => {
    if (!file || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await postCsv(file.text, true, store);
      onDone(`Imported ${fmt.int(r.totals.units)} units in ${r.valid_rows} batch line${r.valid_rows === 1 ? "" : "s"}`);
      onClose();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  const errorsByRow = useMemo(() => {
    const m = new Map<number, string[]>();
    rep?.errors.forEach((e) => m.set(e.row, [...(m.get(e.row) ?? []), e.message]));
    return [...m.entries()];
  }, [rep]);

  return (
    <Modal open={open} onClose={onClose} title="Import stock from CSV" sub={<>Receive many batches into <StoreLine store={store} /> at once. Every row is checked first; nothing is saved unless all rows are valid.</>} width={720}>
      <div className="rounded-2xl border border-dashed border-[rgba(11,11,11,0.18)] bg-surface-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-[12.5px] text-ink-2">Columns: <code className="rounded bg-sunken px-1 font-mono text-[11.5px]">medicine_id,batch_no,expiry_date,qty,unit_cost[,supplier_id]</code>. Dates as YYYY-MM-DD; a blank unit_cost uses 80% of the median selling price.</p>
          <div className="flex flex-wrap gap-2">
            <a href="/api/stock/template.csv" download className={`${ghostBtn} !py-1.5 text-[12px]`}><FileDown className="h-3.5 w-3.5" aria-hidden /> Template</a>
            <button type="button" onClick={() => input.current?.click()} className={`${primaryBtn} !py-1.5 text-[12px]`}><FileUp className="h-3.5 w-3.5" aria-hidden /> Choose CSV</button>
            <input ref={input} type="file" tabIndex={-1} aria-hidden accept=".csv,text/csv,text/plain" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ""; }} />
          </div>
        </div>
        {file && <p className="mt-2 text-[12px] text-ink-3">{file.name}</p>}
      </div>
      {busy && !rep && <p className="mt-4 flex items-center gap-2 text-[13px] text-ink-3"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Validating…</p>}
      {rep && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2 text-[12.5px]">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#e8f5e8] px-2.5 py-1 font-medium text-good"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {rep.valid_rows} valid row{rep.valid_rows === 1 ? "" : "s"}</span>
            {rep.error_rows > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-[#fbeaea] px-2.5 py-1 font-medium text-critical"><OctagonAlert className="h-3.5 w-3.5" aria-hidden /> {rep.error_rows} row{rep.error_rows === 1 ? "" : "s"} with errors</span>}
            {rep.warnings.length > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-[#fef6e3] px-2.5 py-1 font-medium text-[#8a5a00]"><TriangleAlert className="h-3.5 w-3.5" aria-hidden /> {rep.warnings.length} warning{rep.warnings.length === 1 ? "" : "s"}</span>}
            <span className="rounded-full bg-sunken px-2.5 py-1 text-ink-2 tnum">{fmt.int(rep.totals.units)} units · {fmt.inrFull(rep.totals.value)} at cost · {rep.totals.medicines} medicines</span>
          </div>
          {errorsByRow.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-xl border border-[rgba(208,59,59,0.25)] bg-[#fdf5f5] p-3 text-[12.5px]">
              {errorsByRow.slice(0, 100).map(([row, msgs]) => <p key={row}><b className="font-semibold">Row {row}:</b> <span className="text-ink-2">{msgs.join("; ")}</span></p>)}
            </div>
          )}
          {rep.warnings.length > 0 && (
            <details className="rounded-xl bg-surface-2 p-3 text-[12.5px]">
              <summary className="cursor-pointer font-medium text-ink-2">Warnings</summary>
              <div className="mt-2 max-h-32 space-y-0.5 overflow-y-auto">{rep.warnings.slice(0, 100).map((w, i) => <p key={i}><b className="font-medium">Row {w.row}:</b> {w.message}</p>)}</div>
            </details>
          )}
          {rep.preview.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-xl border border-hairline">
              <table className="w-full min-w-[560px] text-[12px]">
                <thead className="sticky top-0 bg-surface-2"><tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-3">
                  <th className="px-3 py-2 font-medium">Row</th><th className="px-3 py-2 font-medium">Medicine</th><th className="px-3 py-2 font-medium">Batch</th>
                  <th className="px-3 py-2 font-medium">Expiry</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="px-3 py-2 text-right font-medium">Unit cost</th>
                </tr></thead>
                <tbody>{rep.preview.map((r) => (
                  <tr key={r.row} className="border-t border-hairline">
                    <td className="px-3 py-1.5 text-ink-3 tnum">{r.row}</td>
                    <td className="max-w-[200px] truncate px-3 py-1.5">{r.medicine_name}</td>
                    <td className="px-3 py-1.5">{r.batch_no}</td>
                    <td className="px-3 py-1.5 tnum">{r.expiry_date}</td>
                    <td className="px-3 py-1.5 text-right tnum">{r.qty}</td>
                    <td className="px-3 py-1.5 text-right tnum">{fmt.inrFull(r.unit_cost)}{r.cost_assumed && <span className="text-ink-3" title="Assumed: 80% of median selling price">*</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="mt-4"><ErrorLine msg={err} /></div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
        <button type="button" onClick={commit} disabled={!rep?.can_commit || busy} className={primaryBtn}>{busy && rep && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Import {rep?.valid_rows ?? 0} rows</button>
      </div>
    </Modal>
  );
}

/* ───────────────────────── Transfer hint (read-only) ───────────────────────── */
export function TransferHint({ spare, name }: { spare: number; name: string }) {
  if (spare <= 0) return null;
  return <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-3"><ArrowRightLeft className="h-3 w-3" aria-hidden /> ~{spare} spare at {name}</span>;
}
