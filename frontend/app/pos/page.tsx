"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote, Camera, CheckCircle2, CloudOff, CreditCard, History, Loader2, Printer, ReceiptText, RefreshCw, ScanBarcode,
  Search, ShoppingBasket, Smartphone, Trash2, Wallet, Wifi, WifiOff, X,
} from "lucide-react";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { useMe } from "@/lib/auth";
import { Card, PageHeader, Skeleton } from "@/components/ui";
import { inputCls, labelCls, primaryBtn, ghostBtn } from "@/components/auth/Modal";
import { CartRow, RegisterPanel, TotalsBlock } from "@/components/pos/Cart";
import { DaySummaryDialog } from "@/components/pos/DaySummary";
import { HistoryDrawer } from "@/components/pos/History";
import { Kbd, ScheduleBadge } from "@/components/pos/bits";
import { estimate, expiryLabel, inr2 } from "@/components/pos/money";
import { isOffline, newUuid, useOfflineQueue } from "@/components/pos/offlineQueue";
import { PrintableReceipt } from "@/components/pos/Receipt";
import { CameraScanner } from "@/components/pos/Scanner";
import {
  PAYMENT_LABEL, PAYMENT_MODES, type CartLine, type CatalogItem, type CatalogResp, type ComplianceLine, type Invoice,
  type InvoicePayload, type OosDetail, type PaymentMode, type QuoteResp, type RegisterDetails,
} from "@/components/pos/types";

const PAY_ICON: Record<PaymentMode, typeof Banknote> = { cash: Banknote, upi: Smartphone, card: CreditCard, credit: Wallet };
const EMPTY_REG: RegisterDetails = { patient_name: "", patient_address: "", prescriber_name: "", prescriber_reg_no: "", rx_ref: "" };
const AUTOPRINT_KEY = "mf:pos:autoprint";
const MAX_LINES = 60; // backend pos.MAX_LINES
const DRAFT_TTL_MS = 8 * 3600 * 1000;

/**
 * Unfinished bill, kept so a reload / crash mid-bill does not lose it (and re-uses the same client_uuid,
 * so a bill whose response was lost replays instead of selling twice). It can hold patient / prescriber
 * details, so it lives in sessionStorage (cleared with the tab), is keyed per user, and expires.
 */
type Draft = { cart: CartLine[]; uuid: string; mode: PaymentMode; customer: { name: string; phone: string }; reg: RegisterDetails; store: string | null; saved_at?: number };
const draftKey = (userKey: string) => `mf:pos:draft:${userKey}`;

function loadDraft(userKey: string): Draft | null {
  try {
    try { localStorage.removeItem("mf:pos:draft"); } catch { /* legacy shared key: never keep PII there */ }
    const raw = sessionStorage.getItem(draftKey(userKey));
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    if (!d || !Array.isArray(d.cart) || (d.saved_at && Date.now() - d.saved_at > DRAFT_TTL_MS)) return null;
    return d;
  } catch { return null; }
}
function saveDraft(userKey: string, d: Draft | null) {
  try { if (d) sessionStorage.setItem(draftKey(userKey), JSON.stringify({ ...d, saved_at: Date.now() })); else sessionStorage.removeItem(draftKey(userKey)); } catch { /* storage blocked */ }
}

export default function PosPage() {
  const { me, can, storeId, store, loading: meLoading } = useMe();
  const canBill = can("sales.record");

  // ---- cart state -------------------------------------------------------------------------
  const [cart, setCart] = useState<CartLine[]>([]);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const [uuid, setUuid] = useState<string>("");
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [reg, setReg] = useState<RegisterDetails>(EMPTY_REG);
  const [hydrated, setHydrated] = useState(false);
  const userKey = me ? `${me.user.id ?? "dev"}:${me.user.username}` : null;

  useEffect(() => {
    if (!userKey || hydrated) return;
    const d = loadDraft(userKey);
    if (d && d.cart.length && canBill && (!d.store || !storeId || d.store === storeId)) {
      setCart(d.cart); setUuid(d.uuid || newUuid()); setMode(d.mode || "cash"); setCustomer(d.customer ?? { name: "", phone: "" }); setReg({ ...EMPTY_REG, ...(d.reg ?? {}) });
    } else setUuid(newUuid());
    setHydrated(true);
  }, [userKey, hydrated, canBill, storeId]);
  useEffect(() => {
    if (!hydrated || !userKey) return;
    saveDraft(userKey, cart.length ? { cart, uuid, mode, customer, reg, store: storeId } : null);
  }, [hydrated, userKey, cart, uuid, mode, customer, reg, storeId]);

  // ---- search -----------------------------------------------------------------------------
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CatalogItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const cache = useRef(new Map<string, CatalogItem>()); // seen items (offline barcode fallback)
  const searchRef = useRef<HTMLInputElement>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);
  const remember = (items: CatalogItem[]) => items.forEach((i) => { cache.current.set(i.medicine_id, i); if (i.barcode) cache.current.set(`bc:${i.barcode}`, i); });

  useEffect(() => {
    if (!showResults) return;
    let alive = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await apiGet<CatalogResp>(`/api/pos/catalog?limit=12&q=${encodeURIComponent(q.trim())}`);
        if (!alive) return;
        remember(r.items); setResults(r.items); setActive(0); setSearchErr(null);
      } catch (e) {
        if (!alive) return;
        const local = [...cache.current.entries()].filter(([k]) => !k.startsWith("bc:")).map(([, v]) => v)
          .filter((i) => !q.trim() || `${i.medicine_name} ${i.generic_name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12);
        setResults(local); setSearchErr(isOffline(e) ? "Offline: showing items seen earlier in this session" : (e as Error).message);
      } finally { if (alive) setSearching(false); }
    }, q.trim() ? 140 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q, showResults, storeId]);

  // ---- notices ------------------------------------------------------------------------------
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  useEffect(() => { if (!notice || notice.kind === "err") return; const t = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(t); }, [notice]);

  const addItem = useCallback((item: CatalogItem, qty = 1) => {
    if (item.mrp == null) { setNotice({ kind: "err", text: `${item.medicine_name} has no price on record and cannot be billed.` }); return; }
    const cur = cartRef.current;
    if (cur.length >= MAX_LINES && !cur.some((l) => l.item.medicine_id === item.medicine_id)) {
      setNotice({ kind: "err", text: `A bill can hold at most ${MAX_LINES} different items. Charge this bill and start another.` }); return;
    }
    setCart((c) => {
      const i = c.findIndex((l) => l.item.medicine_id === item.medicine_id);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], item, qty: Math.min(10000, n[i].qty + qty) }; return n; }
      if (c.length >= MAX_LINES) return c;
      return [...c, { item, qty, discount_pct: 0 }];
    });
    if (item.on_hand <= 0) setNotice({ kind: "warn", text: `${item.medicine_name}: no sellable stock here. See substitutes on the line.` });
  }, []);

  const pick = (item: CatalogItem) => { addItem(item); setQ(""); setShowResults(false); searchRef.current?.focus(); };

  const addByBarcode = useCallback(async (code: string) => {
    const c = code.trim();
    if (!c) return;
    try {
      const it = await apiGet<CatalogItem>(`/api/pos/barcode/${encodeURIComponent(c)}`);
      remember([it]); addItem(it); setNotice({ kind: "ok", text: `Added ${it.medicine_name}` });
    } catch (e) {
      const hit = cache.current.get(`bc:${c}`);
      if (hit && isOffline(e)) { addItem(hit); setNotice({ kind: "warn", text: `Offline: added ${hit.medicine_name} from this session's cache` }); }
      else setNotice({ kind: "err", text: e instanceof ApiError && e.status === 404 ? `Barcode ${c} is not mapped to a medicine` : `Barcode lookup failed: ${(e as Error).message}` });
    }
  }, [addItem]);

  // ---- server quote (FEFO preview + exact GST) -----------------------------------------------
  const [quote, setQuote] = useState<{ key: string; data: QuoteResp } | null>(null);
  const [quoteOffline, setQuoteOffline] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const cartKey = useMemo(() => JSON.stringify([storeId, cart.map((l) => [l.item.medicine_id, l.qty, l.discount_pct])]), [cart, storeId]);
  useEffect(() => {
    if (!cart.length) { setQuote(null); setQuoteErr(null); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const data = await apiPost<QuoteResp>("/api/pos/quote", { store_id: storeId, lines: cart.map((l) => ({ medicine_id: l.item.medicine_id, qty: l.qty, discount_pct: l.discount_pct })) });
        if (alive) { setQuote({ key: cartKey, data }); setQuoteOffline(false); setQuoteErr(null); }
      } catch (e) {
        if (!alive) return;
        if (isOffline(e)) { setQuoteOffline(true); setQuoteErr(null); }
        else { setQuoteOffline(false); setQuoteErr(e instanceof ApiError ? e.message : String(e)); }
      }
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [cartKey, cart, storeId]);
  const fresh = quote && quote.key === cartKey ? quote.data : null;
  const est = useMemo(() => estimate(cart), [cart]);
  const shown = fresh ? { totals: fresh.totals, gst_breakup: fresh.gst_breakup } : { totals: est.totals, gst_breakup: est.gst };

  // ---- compliance -----------------------------------------------------------------------------
  const needRegister = cart.some((l) => ["H1", "X", "NDPS"].includes(l.item.schedule));
  const needRx = cart.some((l) => l.item.schedule !== "OTC");
  const [compErr, setCompErr] = useState<ComplianceLine[] | null>(null);
  const missingLocal = useMemo(() => {
    const m = new Set<string>();
    if (needRx && !reg.prescriber_name.trim()) m.add("prescriber_name");
    if (needRegister) (["patient_name", "patient_address", "prescriber_reg_no"] as const).forEach((k) => { if (!reg[k].trim()) m.add(k); });
    return m;
  }, [needRx, needRegister, reg]);
  const [showMissing, setShowMissing] = useState(false);

  // ---- charge -----------------------------------------------------------------------------------
  const [charging, setCharging] = useState(false);
  const chargingRef = useRef(false); // F9 auto-repeat / double press must not start a second request
  const [oosState, setOosState] = useState<{ key: string; d: OosDetail } | null>(null);
  // a 409 refers to the line indexes of the cart it was raised for; once the cart changes it no longer applies
  const oos = oosState && oosState.key === cartKey ? oosState.d : null;
  const setOos = (d: OosDetail | null) => setOosState(d ? { key: cartKey, d } : null);
  const [done, setDone] = useState<{ invoice?: Invoice; queued?: { total: number; uuid: string } } | null>(null);
  const [printInv, setPrintInv] = useState<Invoice | null>(null);
  const [autoPrint, setAutoPrint] = useState(false);
  useEffect(() => { try { setAutoPrint(localStorage.getItem(AUTOPRINT_KEY) === "1"); } catch { /* ignore */ } }, []);
  useEffect(() => {
    if (!printInv) return;
    const t = setTimeout(() => { window.print(); setPrintInv(null); }, 80);
    return () => clearTimeout(t);
  }, [printInv]);

  const queue = useOfflineQueue(useCallback((inv: Invoice) => setNotice({ kind: "ok", text: `Synced offline bill → ${inv.invoice_no}` }), []));

  const resetCart = () => { setCart([]); setUuid(newUuid()); setCustomer({ name: "", phone: "" }); setReg(EMPTY_REG); setMode("cash"); setOos(null); setCompErr(null); setShowMissing(false); };

  const charge = useCallback(async () => {
    if (!canBill || !cart.length || charging || chargingRef.current) return;
    if (missingLocal.size) { setShowMissing(true); setNotice({ kind: "err", text: "Fill the required prescription / register details first." }); return; }
    chargingRef.current = true;
    const payload: InvoicePayload = {
      client_uuid: uuid, store_id: storeId, payment_mode: mode,
      lines: cart.map((l) => ({ medicine_id: l.item.medicine_id, qty: l.qty, discount_pct: l.discount_pct })),
      customer: customer.name.trim() || customer.phone.trim() ? { name: customer.name.trim() || null, phone: customer.phone.trim() || null } : null,
      prescriber: reg.prescriber_name.trim() ? { name: reg.prescriber_name.trim(), reg_no: reg.prescriber_reg_no.trim() || null, rx_ref: reg.rx_ref.trim() || null } : null,
      register_details: needRegister ? { ...reg } : null,
    };
    setCharging(true); setOos(null); setCompErr(null);
    try {
      const inv = await apiPost<Invoice>("/api/pos/invoices", payload);
      setDone({ invoice: inv });
      resetCart();
      if (inv.warnings?.length) setNotice({ kind: "warn", text: inv.warnings.join(" ") });
      if (autoPrint) setPrintInv(inv);
    } catch (e) {
      if (isOffline(e)) {
        try {
          await queue.enqueue({ client_uuid: uuid, payload: { ...payload, offline_created_at: new Date().toISOString() }, queued_at: new Date().toISOString(), store_id: storeId,
            status: "pending", attempts: 0, summary: { items: cart.length, total: shown.totals.total } });
          setDone({ queued: { total: shown.totals.total, uuid } });
          resetCart();
        } catch (qe) {
          setNotice({ kind: "err", text: `Offline and the local queue is unavailable (${(qe as Error).message}). The bill was NOT saved.` });
        }
      } else if (e instanceof ApiError && e.status === 409 && (e.detail as OosDetail)?.code === "insufficient_stock") {
        setOos(e.detail as OosDetail);
        setNotice({ kind: "err", text: e.message });
      } else if (e instanceof ApiError && e.status === 422 && (e.detail as { code?: string })?.code === "compliance") {
        setCompErr((e.detail as { lines: ComplianceLine[] }).lines); setShowMissing(true);
        setNotice({ kind: "err", text: e.message });
      } else {
        setNotice({ kind: "err", text: e instanceof ApiError ? e.message : String(e) });
      }
    } finally { chargingRef.current = false; setCharging(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBill, cart, cartKey, charging, missingLocal, uuid, storeId, mode, customer, reg, needRegister, autoPrint, queue.enqueue, shown.totals.total]);

  // ---- swap a short line for a substitute ----------------------------------------------------------
  const swap = async (idx: number, medicineId: string) => {
    try {
      const r = await apiGet<CatalogResp>(`/api/pos/catalog?limit=1&q=${encodeURIComponent(medicineId)}`);
      const it = r.items.find((i) => i.medicine_id === medicineId);
      if (!it) return;
      remember([it]);
      setCart((c) => {
        const n = c.filter((_, i) => i !== idx);
        const j = n.findIndex((l) => l.item.medicine_id === it.medicine_id);
        if (j >= 0) { n[j] = { ...n[j], qty: n[j].qty + c[idx].qty }; return n; }
        n.splice(idx, 0, { item: it, qty: c[idx].qty, discount_pct: c[idx].discount_pct });
        return n;
      });
      setOos(null);
      setNotice({ kind: "warn", text: `Swapped to ${it.medicine_name}. Confirm equivalence (and the prescriber's agreement for Rx items).` });
    } catch (e) { setNotice({ kind: "err", text: (e as Error).message }); }
  };

  // ---- dialogs & keyboard ----------------------------------------------------------------------------
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const scanBuf = useRef<{ s: string; t: number }>({ s: "", t: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const dialogOpen = !!document.querySelector('[aria-modal="true"]');
      if (e.key === "F9") { e.preventDefault(); if (!dialogOpen) void charge(); return; }
      if (e.key === "F2") { e.preventDefault(); barcodeRef.current?.focus(); return; }
      if (e.key === "F4") { e.preventDefault(); setHistoryId(null); setHistoryOpen(true); return; }
      if (dialogOpen) return;
      if (!typing && e.key === "/") { e.preventDefault(); searchRef.current?.focus(); setShowResults(true); return; }
      if (!typing && e.altKey && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); setMode(PAYMENT_MODES[Number(e.key) - 1]); return; }
      // USB scanners outside any input: a fast burst of digits followed by Enter
      if (!typing && canBill) {
        const now = performance.now();
        if (/^\d$/.test(e.key)) {
          scanBuf.current = { s: (now - scanBuf.current.t < 60 ? scanBuf.current.s : "") + e.key, t: now };
        } else if (e.key === "Enter" && scanBuf.current.s.length >= 8 && now - scanBuf.current.t < 100) {
          e.preventDefault(); void addByBarcode(scanBuf.current.s); scanBuf.current = { s: "", t: 0 };
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [charge, addByBarcode, canBill]);

  // Stable handlers: the shared Modal re-runs its focus effect whenever onClose changes identity,
  // which would yank focus out of a field each time this (busy) page re-renders.
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const closeSummary = useCallback(() => setSummaryOpen(false), []);
  const closeCam = useCallback(() => setCamOpen(false), []);
  const onCamCode = useCallback((c: string) => { setCamOpen(false); void addByBarcode(c); }, [addByBarcode]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const list = results ?? [];
    if (e.key === "ArrowDown") { e.preventDefault(); setShowResults(true); setActive((a) => Math.min(list.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const v = q.trim();
      if (/^\d{8,14}$/.test(v)) { void addByBarcode(v); setQ(""); setShowResults(false); return; }
      if (list[active]) pick(list[active]);
    } else if (e.key === "Escape") { if (q) setQ(""); else setShowResults(false); }
  };

  // ---- render ----------------------------------------------------------------------------------------
  if (meLoading && !me) return <div className="space-y-4"><Skeleton className="h-16 w-80" /><Skeleton className="h-[420px]" /></div>;

  const shortageFor = (i: number) => {
    if (oos && oos.line_index === i) return { ...oos };
    const s = fresh?.shortages.find((x) => x.index === i);
    return s ?? null;
  };
  const anyShort = !!fresh?.shortages.length;
  const units = cart.reduce((s, l) => s + l.qty, 0);

  return (
    <div>
      {printInv && <PrintableReceipt invoice={printInv} />}
      <PageHeader eyebrow="Operations · Billing" title="Point of sale"
        actions={<>
          <SyncPill q={queue} />
          <button className={ghostBtn} onClick={() => setSummaryOpen(true)}><ReceiptText className="h-4 w-4" aria-hidden />Day summary</button>
          <button className={ghostBtn} onClick={() => { setHistoryId(null); setHistoryOpen(true); }}><History className="h-4 w-4" aria-hidden />Invoices <Kbd>F4</Kbd></button>
        </>}>
        Billing for <b className="font-medium text-ink">{store?.name ?? "—"}</b>{store?.simulated ? " (simulated branch stock)" : ""}. Sales are written to the stock ledger FEFO; prices are MRP inclusive of GST.
      </PageHeader>

      {!canBill && (
        <div className="card rise mb-5 flex items-start gap-3 px-5 py-4 text-[13px] text-ink-2">
          <ShoppingBasket className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
          <p>Your role can view invoices and the day summary, but billing needs the <b className="font-medium">sales.record</b> permission (owner or pharmacist).</p>
        </div>
      )}

      {notice && (
        <div role={notice.kind === "err" ? "alert" : "status"}
          className={`rise mb-4 flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-[13px] ${notice.kind === "ok" ? "border-brand-soft bg-brand-wash text-brand-ink" : notice.kind === "warn" ? "border-[#f3d9a4] bg-[#fdf5e3] text-[#7a5200]" : "border-[#f1b9b9] bg-[#fdf3f3] text-critical"}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message" className="focus-ring rounded p-0.5 opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------------- left: search + cart ---------------- */}
        <div className="min-w-0 space-y-5">
          <Card className="relative z-10 p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
              <div className="relative">
                <label htmlFor="pos-search" className="sr-only">Search medicines</label>
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                <input id="pos-search" ref={searchRef} value={q} autoComplete="off" disabled={!canBill}
                  onChange={(e) => { setQ(e.target.value); setShowResults(true); }} onFocus={() => setShowResults(true)}
                  onBlur={() => setTimeout(() => setShowResults(false), 150)} onKeyDown={onSearchKey}
                  role="combobox" aria-expanded={showResults} aria-controls="pos-results" aria-autocomplete="list"
                  aria-activedescendant={showResults && results?.[active] ? `pos-opt-${results[active].medicine_id}` : undefined}
                  placeholder="Search name, generic or scan barcode…" className={`${inputCls} h-12 rounded-2xl pl-10 pr-16 text-[15px]`} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>
                {showResults && canBill && (
                  <div id="pos-results" role="listbox" aria-label="Matching medicines"
                    className="absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-[380px] overflow-y-auto rounded-2xl border border-hairline bg-surface p-1.5 shadow-[0_24px_48px_-20px_rgba(11,11,11,0.3)]">
                    {searching && !results ? <div className="space-y-1.5 p-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11" />)}</div>
                      : !results?.length ? <p className="px-3 py-4 text-[13px] text-ink-3">{searchErr ?? "No medicines match."}</p>
                      : <>
                        {searchErr && <p className="px-3 py-1.5 text-[11.5px] text-ink-3">{searchErr}</p>}
                        {results.map((it, i) => (
                          <div key={it.medicine_id} id={`pos-opt-${it.medicine_id}`} role="option" aria-selected={i === active}
                            onMouseDown={(e) => { e.preventDefault(); pick(it); }} onMouseEnter={() => setActive(i)}
                            className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2 ${i === active ? "bg-sunken" : ""}`}>
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 truncate text-[13.5px] font-medium">{it.medicine_name}<ScheduleBadge schedule={it.schedule} compact /></span>
                              <span className="block truncate text-[12px] text-ink-3">{it.generic_name} · {it.form}{it.earliest_expiry ? ` · next exp ${expiryLabel(it.earliest_expiry)}` : ""}</span>
                            </span>
                            <span className="text-right">
                              <span className="tnum block text-[13px] font-semibold">{inr2(it.mrp)}</span>
                              <span className={`block text-[11.5px] ${it.on_hand > 0 ? "text-ink-3" : "font-medium text-critical"}`}>{it.on_hand > 0 ? `${it.on_hand} in stock` : "Out of stock"}</span>
                            </span>
                          </div>
                        ))}
                      </>}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Barcode (USB scanner or type, then Enter)</span>
                  <ScanBarcode className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
                  <input ref={barcodeRef} inputMode="numeric" autoComplete="off" placeholder="Barcode  F2" disabled={!canBill}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ""; void addByBarcode(v); } }}
                    className={`${inputCls} h-12 rounded-2xl pl-9 font-mono text-[13px]`} />
                </label>
                <button className={`${ghostBtn} h-12 w-12 shrink-0 rounded-2xl px-0`} onClick={() => setCamOpen(true)} disabled={!canBill} aria-label="Scan barcode with camera" title="Scan with camera">
                  <Camera className="h-4 w-4" />
                </button>
              </div>
            </div>
            <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>Enter</Kbd> add</span><span><Kbd>F9</Kbd> charge</span><span><Kbd>Alt</Kbd>+<Kbd>1–4</Kbd> payment</span><span>USB scanners work anywhere on the page</span>
            </p>
          </Card>

          <Card className="overflow-hidden" delay={40}>
            <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3.5 sm:px-5">
              <h2 className="text-[15px] font-semibold tracking-tight">Bill {cart.length ? <span className="font-normal text-ink-3">· {cart.length} item{cart.length === 1 ? "" : "s"}, {units} unit{units === 1 ? "" : "s"}</span> : null}</h2>
              {cart.length > 0 && <button className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-3 hover:bg-sunken hover:text-ink" onClick={resetCart}><Trash2 className="h-3.5 w-3.5" aria-hidden />Clear</button>}
            </div>
            {!cart.length ? (
              <div className="flex flex-col items-center px-6 py-14 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-sunken text-ink-2"><ScanBarcode className="h-5 w-5" strokeWidth={1.8} aria-hidden /></span>
                <p className="mt-4 text-[15px] font-semibold">Scan or search to start a bill</p>
                <p className="mt-1 max-w-sm text-[13px] text-ink-3">Each item is dispensed first-expiry-first-out from sellable (non-expired) batches. The batch and expiry show on each line.</p>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--hairline)]">
                {cart.map((l, i) => (
                  <CartRow key={l.item.medicine_id} line={l} index={i} quote={fresh?.lines[i] ?? null} shortage={shortageFor(i)}
                    onQty={(qv) => setCart((c) => c.map((x, j) => (j === i ? { ...x, qty: qv } : x)))}
                    onDisc={(d) => setCart((c) => c.map((x, j) => (j === i ? { ...x, discount_pct: d } : x)))}
                    onRemove={() => setCart((c) => c.filter((_, j) => j !== i))}
                    onSwap={(mid) => void swap(i, mid)} />
                ))}
              </ul>
            )}
            {cart.length > 0 && quoteErr && !fresh && (
              <p className="flex items-start gap-1.5 border-t border-hairline px-5 py-2.5 text-[12px] text-critical" role="alert">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Could not price this bill: {quoteErr}. Totals below are a local estimate.
              </p>
            )}
            {cart.length > 0 && quoteOffline && !fresh && <p className="border-t border-hairline px-5 py-2.5 text-[12px] text-ink-3">Offline: totals are a local estimate; batch preview unavailable. The server re-prices and allocates batches when the bill syncs.</p>}
          </Card>

          {canBill && (needRx || needRegister) && (
            <div className="rise">
              <RegisterPanel needRx={needRx} needRegister={needRegister} reg={reg} setReg={setReg} missing={showMissing ? missingLocal : new Set()} />
              {compErr && <ul className="mt-2 space-y-0.5 text-[12px] text-critical" role="alert">{compErr.map((c) => <li key={c.index}>{c.medicine_name} ({c.schedule}): missing {c.missing.join(", ").replace(/_/g, " ")}</li>)}</ul>}
            </div>
          )}
        </div>

        {/* ---------------- right: customer, payment, totals ---------------- */}
        <div className="min-w-0">
          <div className="space-y-5 lg:sticky lg:top-24">
            {done && <DonePanel done={done} onPrint={(inv) => setPrintInv(inv)} onOpen={(id) => { setHistoryId(id); setHistoryOpen(true); }} onClose={() => setDone(null)} />}
            <Card className="p-5" delay={80}>
              <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2 sm:col-span-1 lg:col-span-2"><span className={labelCls}>Customer (optional)</span>
                  <input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} maxLength={120} className={inputCls} placeholder="Name" disabled={!canBill} /></label>
                <label className="col-span-2 sm:col-span-1 lg:col-span-2"><span className={labelCls}>Phone (stored masked)</span>
                  <input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value.replace(/[^\d+ ]/g, "") })} maxLength={20} inputMode="tel" className={inputCls} placeholder="Last 4 digits kept" disabled={!canBill} /></label>
              </div>
              <fieldset className="mt-4">
                <legend className={labelCls}>Payment</legend>
                <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Payment mode">
                  {PAYMENT_MODES.map((m, i) => {
                    const Icon = PAY_ICON[m];
                    return (
                      <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} disabled={!canBill} title={`Alt+${i + 1}`}
                        className={`focus-ring flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[12px] font-medium transition ${mode === m ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:bg-sunken"}`}>
                        <Icon className="h-4 w-4" aria-hidden />{PAYMENT_LABEL[m]}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </Card>

            <Card className="p-5" delay={120}>
              <TotalsBlock q={shown} />
              <div className="mt-3 flex items-end justify-between border-t border-hairline pt-3">
                <span className="text-[13px] text-ink-2">Total{!fresh && cart.length ? " (estimate)" : ""}</span>
                <span className="tnum text-[34px] font-semibold leading-none tracking-[-0.02em]">{inr2(shown.totals.total)}</span>
              </div>
              <button onClick={() => void charge()} disabled={!canBill || !cart.length || charging}
                className={`${primaryBtn} mt-4 h-12 w-full rounded-2xl text-[15px]`} aria-keyshortcuts="F9">
                {charging ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                {charging ? "Charging…" : `Charge ${PAYMENT_LABEL[mode]}`} <span className="ml-1 rounded-md bg-white/15 px-1.5 py-0.5 font-mono text-[11px]">F9</span>
              </button>
              {anyShort && <p className="mt-2 text-[12px] text-critical">Some lines exceed sellable stock: reduce the quantity or swap to a substitute.</p>}
              <label className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
                <input type="checkbox" checked={autoPrint} className="accent-[var(--brand)]"
                  onChange={(e) => { setAutoPrint(e.target.checked); try { localStorage.setItem(AUTOPRINT_KEY, e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
                Print receipt automatically (80 mm)
              </label>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                {fresh?.notes.gst ?? "GST rates are defaults by category - verify with your CA. CGST = SGST (intra-state)."} {fresh?.notes.mrp ?? ""}
              </p>
            </Card>

            {queue.items.length > 0 && <QueuePanel q={queue} />}
          </div>
        </div>
      </div>

      <HistoryDrawer open={historyOpen} initialId={historyId} onClose={closeHistory} />
      <DaySummaryDialog open={summaryOpen} onClose={closeSummary} />
      <CameraScanner open={camOpen} onClose={closeCam} onCode={onCamCode} />
    </div>
  );
}

type Q = ReturnType<typeof useOfflineQueue>;

function SyncPill({ q }: { q: Q }) {
  if (!q.supported) return <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-[12px] text-ink-3"><CloudOff className="h-3.5 w-3.5" aria-hidden />Offline queue unavailable</span>;
  const Icon = !q.online ? WifiOff : q.busy ? RefreshCw : Wifi;
  const label = !q.online ? "Offline" : q.busy ? "Syncing…" : q.pending ? `${q.pending} to sync` : q.failed ? `${q.failed} need attention` : "Online";
  const tone = !q.online || q.failed ? "border-[#f3d9a4] bg-[#fdf5e3] text-[#7a5200]" : "border-hairline bg-surface text-ink-2";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${tone}`} role="status" aria-live="polite">
      <Icon className={`h-3.5 w-3.5 ${q.busy ? "animate-spin" : ""}`} aria-hidden />{label}
    </span>
  );
}

function QueuePanel({ q }: { q: Q }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">Offline bills</h2>
        <button className={ghostBtn} onClick={() => void q.sync()} disabled={q.busy}><RefreshCw className={`h-3.5 w-3.5 ${q.busy ? "animate-spin" : ""}`} aria-hidden />Sync now</button>
      </div>
      <p className="mt-1 text-[12px] text-ink-3">Each bill keeps its unique id, so re-sending can never sell twice. Stock is allocated when it reaches the server.</p>
      <ul className="mt-3 space-y-2">
        {q.items.map((b) => (
          <li key={b.client_uuid} className="rounded-xl border border-hairline px-3 py-2.5 text-[12.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-medium">
                {b.status === "pending" ? <CloudOff className="h-3.5 w-3.5 text-ink-3" aria-hidden /> : <X className="h-3.5 w-3.5 text-critical" aria-hidden />}
                {b.status === "pending" ? "Queued (offline)" : "Rejected by server"}
              </span>
              <span className="tnum font-semibold">~{inr2(b.summary.total)}</span>
            </div>
            <p className="mt-0.5 text-ink-3">{b.summary.items} item{b.summary.items === 1 ? "" : "s"} · {new Date(b.queued_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {b.store_id ?? "—"}</p>
            {b.error && <p className="mt-1 text-critical">{b.error}</p>}
            {b.status === "failed" && (
              <div className="mt-2 flex gap-2">
                <button className={ghostBtn} onClick={() => void q.retry(b)}>Retry</button>
                <button className={ghostBtn} onClick={() => { if (window.confirm("Discard this unsynced bill? Its items were never deducted from stock.")) void q.remove(b.client_uuid); }}>Discard</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DonePanel({ done, onPrint, onOpen, onClose }: { done: { invoice?: Invoice; queued?: { total: number; uuid: string } }; onPrint: (i: Invoice) => void; onOpen: (id: number) => void; onClose: () => void }) {
  if (done.queued) {
    return (
      <div className="card rise border-[#f3d9a4] bg-[#fffbf2] p-5" role="status">
        <div className="flex items-start justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-[#7a5200]"><CloudOff className="h-4 w-4" aria-hidden />Queued (offline)</p>
          <button onClick={onClose} aria-label="Dismiss" className="focus-ring rounded p-0.5 text-ink-3"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-1 text-[13px] text-ink-2">~{inr2(done.queued.total)} saved on this device. It gets an invoice number when it syncs; print the receipt from Invoices after that.</p>
      </div>
    );
  }
  const inv = done.invoice!;
  return (
    <div className="card rise border-brand-soft bg-brand-wash/60 p-5" role="status">
      <div className="flex items-start justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand-ink"><CheckCircle2 className="h-4 w-4" aria-hidden />{inv.replayed ? "Already billed" : "Paid"}</p>
        <button onClick={onClose} aria-label="Dismiss" className="focus-ring rounded p-0.5 text-ink-3"><X className="h-4 w-4" /></button>
      </div>
      <p className="mt-1 font-mono text-[13px]">{inv.invoice_no}</p>
      <p className="tnum mt-0.5 text-[22px] font-semibold">{inr2(inv.total)} <span className="text-[13px] font-normal text-ink-3">· {PAYMENT_LABEL[inv.payment_mode]}</span></p>
      <div className="mt-3 flex gap-2">
        <button className={primaryBtn} onClick={() => onPrint(inv)}><Printer className="h-4 w-4" aria-hidden />Print receipt</button>
        <button className={ghostBtn} onClick={() => onOpen(inv.id)}>Details</button>
      </div>
    </div>
  );
}
