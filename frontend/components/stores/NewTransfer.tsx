"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { apiGet, apiPost, ApiError } from "@/lib/api";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import type { StoreInfo } from "@/lib/auth";

type Med = { id: string; name: string; category: string };
const MAX_QTY = 100000;

/** Manual transfer (owner/buyer execute; pharmacists file a request touching their own store). */
export function NewTransfer({ open, onClose, stores, mode, homeStore, onDone }: {
  open: boolean; onClose: () => void; stores: StoreInfo[]; mode: "execute" | "request"; homeStore: string | null; onDone: (msg: string) => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [meds, setMeds] = useState<Med[]>([]);
  const [searching, setSearching] = useState(false);
  const [med, setMed] = useState<Med | null>(null);
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Defaults only when the dialog opens (not on every refetch of the store list while it is open).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current && stores.some((s) => s.id === from) && stores.some((s) => s.id === to)) return;
    wasOpen.current = true;
    setErr(null);
    const home = homeStore ?? stores[0]?.id ?? "";
    if (mode === "request") { setTo(home); setFrom(stores.find((s) => s.id !== home)?.id ?? ""); }
    else { setFrom(stores[0]?.id ?? ""); setTo(stores[1]?.id ?? ""); }
  }, [open, mode, homeStore, stores, from, to]);

  useEffect(() => {
    if (!open || med) return;
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      apiGet<{ items: Med[] }>(`/api/medicines?q=${encodeURIComponent(q.trim())}&sort=next4&limit=8`)
        .then((r) => { if (alive) setMeds(r.items ?? []); })
        .catch(() => { if (alive) setMeds([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, med]);

  const n = Number(qty);
  const qtyOk = qty.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= MAX_QTY;

  const validate = (): string | null => {
    if (!from || !to) return "Choose both branches";
    if (from === to) return "Source and destination must differ";
    if (mode === "request" && homeStore && from !== homeStore && to !== homeStore) return "A request must involve your own branch";
    if (!med) return "Choose a medicine";
    if (!qtyOk) return `Units must be a whole number from 1 to ${MAX_QTY.toLocaleString("en-IN")}`;
    return null;
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const problem = validate();
    if (problem) return setErr(problem);
    if (!med) return;
    setBusy(true);
    setErr(null);
    try {
      const body = { from_store: from, to_store: to, medicine_id: med.id, qty: n, reason: reason.trim() || undefined };
      if (mode === "execute") {
        const r = await apiPost<{ ref: string; moved: number }>("/api/stores/transfers", body);
        onDone(`${r.ref}: moved ${r.moved.toLocaleString("en-IN")} units of ${med.name}.`);
      } else {
        await apiPost("/api/stores/transfers/requests", body);
        onDone(`Requested ${n.toLocaleString("en-IN")} units of ${med.name}. An owner or buyer will approve it.`);
      }
      setMed(null); setQ(""); setQty("1"); setReason("");
      onClose();
    } catch (e) {
      // ApiError.message is already readable for string, {message, available} and validation-list details.
      setErr((e as ApiError).message || "Could not complete the transfer");
    } finally {
      setBusy(false);
    }
  };

  const name = (s: StoreInfo) => `${s.name}${s.simulated ? " (simulated)" : ""}`;
  return (
    <Modal open={open} onClose={onClose} title={mode === "execute" ? "New transfer" : "Request a transfer"} width={500}
      sub={mode === "execute" ? "Moves sellable stock first-expiry-first-out. Expired batches never move." : "Must involve your branch. An owner or buyer approves it."}>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
          <label className="block min-w-0"><span className={labelCls}>From</span>
            <select className={inputCls} value={from} onChange={(e) => { setFrom(e.target.value); setErr(null); }}>
              {stores.map((s) => <option key={s.id} value={s.id}>{name(s)}</option>)}
            </select>
          </label>
          <label className="block min-w-0"><span className={labelCls}>To</span>
            <select className={inputCls} value={to} onChange={(e) => { setTo(e.target.value); setErr(null); }}>
              {stores.map((s) => <option key={s.id} value={s.id}>{name(s)}</option>)}
            </select>
          </label>
        </div>
        <div>
          <span className={labelCls} id="nt-med-label">Medicine</span>
          {med ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-hairline px-3 py-2 text-[14px]">
              <span className="min-w-0 truncate"><b className="font-medium">{med.name}</b> <span className="text-ink-3">· {med.category}</span></span>
              <button type="button" onClick={() => setMed(null)} className="focus-ring shrink-0 rounded px-2 text-[12.5px] text-brand hover:underline">Change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden />
                <input className={`${inputCls} pl-9`} placeholder="Search by name or generic" value={q} maxLength={80}
                  onChange={(e) => setQ(e.target.value)} aria-labelledby="nt-med-label" aria-describedby="nt-med-hint"
                  onKeyDown={(e) => {
                    // Enter picks the top match instead of submitting a form with no medicine.
                    if (e.key === "Enter") { e.preventDefault(); if (meds[0]) { setMed(meds[0]); setErr(null); } }
                  }} />
              </div>
              <p id="nt-med-hint" className="sr-only">Press Enter to choose the first match.</p>
              <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-xl border border-hairline" aria-label="Matching medicines" aria-busy={searching}>
                {meds.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => { setMed(m); setErr(null); }} className="focus-ring flex w-full justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-sunken">
                      <span className="min-w-0 truncate font-medium">{m.name}</span><span className="shrink-0 text-ink-3">{m.category}</span>
                    </button>
                  </li>
                ))}
                {meds.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-3">{searching ? "Searching…" : "No matches"}</li>}
              </ul>
            </>
          )}
        </div>
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3">
          <label className="block"><span className={labelCls}>Units</span>
            <input type="number" inputMode="numeric" min={1} max={MAX_QTY} step={1} className={inputCls} value={qty}
              aria-invalid={!qtyOk} onChange={(e) => { setQty(e.target.value); setErr(null); }} />
          </label>
          <label className="block min-w-0"><span className={labelCls}>Reason (optional)</span>
            <input className={inputCls} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. covering a monsoon spike" />
          </label>
        </div>
        {mode === "request" && (
          <p className="text-[12px] text-ink-3">Stock levels at other branches are visible to owners and buyers only; they check availability when approving.</p>
        )}
        {err && <p role="alert" className="rounded-xl bg-[#fdf0f0] px-3 py-2 text-[13px] text-[#9c2b2b]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="submit" disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{mode === "execute" ? "Transfer now" : "Send request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
