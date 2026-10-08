"use client";

import { useEffect, useId, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FilePen, Loader2, PackageOpen, Search, Send, Sparkles, XCircle } from "lucide-react";
import { apiGet } from "@/lib/api";
import { inputCls } from "@/components/auth/Modal";
import type { Lead, POStatus } from "./types";
import { STATUS_LABEL } from "./types";

const STATUS_STYLE: Record<POStatus, { cls: string; Icon: typeof Send }> = {
  draft: { cls: "border-hairline bg-sunken text-ink-2", Icon: FilePen },
  sent: { cls: "border-[#cde2fb] bg-[#eef5fd] text-[#1c5cab]", Icon: Send },
  partially_received: { cls: "border-[#f6dfa6] bg-[#fff8e6] text-[#7a5200]", Icon: PackageOpen },
  received: { cls: "border-[#cfe8cf] bg-[#effaef] text-good", Icon: CheckCircle2 },
  cancelled: { cls: "border-hairline bg-surface text-ink-3", Icon: XCircle },
};

export function StatusBadge({ status, overdue }: { status: POStatus; overdue?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${s.cls}`}>
        <s.Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden /> {STATUS_LABEL[status]}
      </span>
      {overdue && (
        <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(208,59,59,0.3)] bg-[#fdf5f5] px-2 py-0.5 text-[11.5px] font-medium text-critical">
          <AlertTriangle className="h-3 w-3" strokeWidth={2.2} aria-hidden /> Overdue
        </span>
      )}
    </span>
  );
}

export function LeadBadge({ lead }: { lead: Lead }) {
  const map = {
    default: { Icon: Clock, label: "Default", cls: "bg-sunken text-ink-2", tip: "No deliveries recorded yet: using the supplier's default lead time" },
    learning: { Icon: Sparkles, label: `Learning · ${lead.n}`, cls: "bg-brand-wash text-brand-ink", tip: `${lead.n} deliveries so far; still pulled toward the default` },
    learned: { Icon: CheckCircle2, label: `Learned · ${lead.n}`, cls: "bg-[#effaef] text-good", tip: `${lead.n} deliveries recorded` },
  }[lead.status];
  return (
    <span title={map.tip} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ${map.cls}`}>
      <map.Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden /> {map.label}
    </span>
  );
}

export const inr2 = (n?: number | null) => (n == null ? "—" : "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 }));
export const days = (n?: number | null) => (n == null ? "—" : `${n.toFixed(n < 10 ? 1 : 0)} d`);
export const shortDate = (iso?: string | null) =>
  iso ? new Date(iso.length > 10 ? iso : iso + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

/** Local (not UTC) calendar date as YYYY-MM-DD; the backend's dates are IST calendar days. */
export const localDay = (ms: number = Date.now()) => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

/** Whole-number / decimal parse that treats a blank field as invalid (Number("") is 0). */
export const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export type MedOption = { id: string; name: string; category: string; price: number | null; form?: string };

/** Search-as-you-type medicine combobox (keyboard: arrows + Enter, Escape clears). */
export function MedicinePicker({ onPick, exclude = [], label = "Add medicine" }: { onPick: (m: MedOption) => void; exclude?: string[]; label?: string }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MedOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listId = useId();
  const exKey = exclude.join(",");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      apiGet<{ items: MedOption[] }>(`/api/medicines?q=${encodeURIComponent(q.trim())}&sort=next4&limit=10`)
        .then((r) => { if (alive) { setItems((r.items ?? []).filter((m) => !exKey.split(",").includes(m.id))); setHi(0); } })
        .catch(() => { if (alive) setItems([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, exKey]);
  const pick = (m: MedOption) => { onPick(m); setQ(""); setOpen(false); };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-3" aria-hidden />
      <input className={`${inputCls} pl-9`} placeholder="Search medicine by name, generic or id" value={q} maxLength={80}
        role="combobox" aria-expanded={open && items.length > 0} aria-controls={listId} aria-label={label} aria-autocomplete="list"
        aria-activedescendant={open && items[hi] ? `${listId}-${hi}` : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && items[hi]) { e.preventDefault(); pick(items[hi]); }
          else if (e.key === "Escape" && (q || open)) {
            // Clear the search only; don't let the dialog's Escape handler discard the whole form.
            e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setQ(""); setOpen(false);
          }
        }} />
      {busy && open && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-ink-3" aria-hidden />}
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-hairline bg-surface py-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]">
          {items.map((m, i) => (
            <li key={m.id} id={`${listId}-${i}`} role="option" aria-selected={i === hi}
              onMouseDown={(e) => { e.preventDefault(); pick(m); }} onMouseEnter={() => setHi(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-[13px] ${i === hi ? "bg-sunken" : ""}`}>
              <span className="min-w-0 truncate"><b className="font-medium">{m.name}</b> <span className="text-ink-3">· {m.category}</span></span>
              <span className="shrink-0 text-[12px] text-ink-3 tnum">{m.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "error" }) {
  const cls = tone === "error" ? "border-[rgba(208,59,59,0.3)] bg-[#fdf5f5]" : tone === "warn" ? "border-[#f6dfa6] bg-[#fff8e6]" : "border-hairline bg-surface-2";
  const Icon = tone === "info" ? Clock : AlertTriangle;
  return (
    <p role={tone === "info" ? undefined : "alert"} className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-2 ${cls}`}>
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone === "error" ? "text-critical" : tone === "warn" ? "text-[#a86b00]" : "text-ink-3"}`} aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
