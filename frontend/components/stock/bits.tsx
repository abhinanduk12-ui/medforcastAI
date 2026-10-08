"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, FlaskConical, Hourglass, OctagonAlert, Search } from "lucide-react";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { EXPIRING, STATUS, daysText, dateFmt, type Batch, type StockStatus, type StoreRef } from "./types";

export function StatusChip({ status, compact = false }: { status: StockStatus; compact?: boolean }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium"
      style={{ background: s.wash, color: s.color, border: status === "none" ? "1px solid var(--hairline)" : undefined }}>
      <Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden />
      {compact && status === "none" ? "—" : s.label}
    </span>
  );
}

export function ExpiringChip({ expired = false }: { expired?: boolean }) {
  if (expired)
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#fbeaea] px-2 py-0.5 text-[11.5px] font-medium text-critical">
        <OctagonAlert className="h-3 w-3" strokeWidth={2.2} aria-hidden /> Expired on shelf
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium" style={{ background: EXPIRING.wash, color: EXPIRING.color }}>
      <Hourglass className="h-3 w-3" strokeWidth={2.2} aria-hidden /> {EXPIRING.label}
    </span>
  );
}

/** Banner shown whenever the selected store is a simulated branch. */
export function SimulatedNote({ store, className = "" }: { store: StoreRef | null | undefined; className?: string }) {
  if (!store?.simulated) return null;
  return (
    <p className={`flex items-start gap-2 rounded-xl border border-hairline bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-2 ${className}`}>
      <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
      <span><b className="font-semibold text-ink">{store.name} is a simulated branch.</b> The sales data comes from one real shop; this branch&apos;s demand is the main-shop
        forecast × {store.demand_scale.toFixed(2)} and its opening stock was generated for the demo.</span>
    </p>
  );
}

/**
 * Batches on a shared time axis (today → latest expiry). Each bar spans today → expiry; the solid part is the
 * units projected to sell first-expiry-first-out before expiry, the hatched part what would be left.
 */
export function BatchTimeline({ batches, compact = false }: { batches: Batch[]; compact?: boolean }) {
  const maxDays = Math.max(90, ...batches.map((b) => b.days_left));
  const maxQty = Math.max(1, ...batches.map((b) => b.qty));
  const ticks = [0, 30, 90, 180, 365, 730].filter((t) => t <= maxDays);
  if (!batches.length) return <p className="text-[13px] text-ink-3">No batches with stock in this store.</p>;
  return (
    <div>
      <div className="space-y-2.5">
        {batches.map((b) => {
          const w = b.expired ? 0 : (b.days_left / maxDays) * 100;
          const soldShare = b.qty ? Math.min(1, b.proj_sold / b.qty) : 0;
          const h = compact ? 8 : 6 + Math.round((b.qty / maxQty) * 8);
          return (
            <div key={b.batch_id} className="grid grid-cols-[minmax(0,108px)_minmax(0,1fr)_auto] items-center gap-3 text-[12px]"
              title={`${b.batch_no}: ${b.qty} units, expires ${dateFmt(b.expiry_date)}. Projected to sell ${fmt.one(b.proj_sold)}, leave ${fmt.one(b.proj_unsold)}.`}>
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{b.batch_no}</span>
                <span className="block text-[11px] text-ink-3 tnum">{b.qty} u · {dateFmt(b.expiry_date)}</span>
              </span>
              <div className="relative h-4">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--grid)]" />
                {b.expired ? (
                  <span className="absolute left-0 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 text-[11px] font-medium text-critical">
                    <OctagonAlert className="h-3 w-3" aria-hidden /> expired
                  </span>
                ) : (
                  <div className="absolute left-0 top-1/2 flex -translate-y-1/2 gap-[2px] overflow-hidden rounded-[4px]" style={{ width: `${Math.max(w, 1.5)}%`, height: h }}>
                    <span style={{ flex: soldShare, background: C.s1 }} />
                    {soldShare < 0.999 && (
                      <span style={{ flex: 1 - soldShare, backgroundColor: "#f3e1c7", backgroundImage: "repeating-linear-gradient(45deg, rgba(138,90,0,0.55) 0 1.5px, transparent 1.5px 5px)" }} />
                    )}
                  </div>
                )}
              </div>
              <span className={`text-right tnum ${b.expired || b.days_left <= 30 ? "font-semibold text-ink" : "text-ink-2"}`}>{daysText(b.days_left)}</span>
            </div>
          );
        })}
      </div>
      {!compact && (
        <div className="mt-2 grid grid-cols-[minmax(0,108px)_minmax(0,1fr)_auto] gap-3 text-[10.5px] text-muted">
          <span />
          <div className="relative h-4">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2 tnum" style={{ left: `${(t / maxDays) * 100}%` }}>{t === 0 ? "today" : t < 365 ? `${t}d` : `${t / 365}y`}</span>
            ))}
          </div>
          <span className="invisible">00 mo</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ background: C.s1 }} /> Projected to sell before expiry (FEFO)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[3px]" style={{ backgroundColor: "#f3e1c7", backgroundImage: "repeating-linear-gradient(45deg, rgba(138,90,0,0.55) 0 1.5px, transparent 1.5px 5px)" }} /> Projected left at expiry</span>
      </div>
    </div>
  );
}

/** Reload when `version` bumps after a mutation, but not on mount (the fetch already runs then). */
export function useReloadOnVersion(version: number, reload: () => void) {
  const seen = useRef(version);
  useEffect(() => {
    if (version === seen.current) return;
    seen.current = version;
    reload();
  }, [version, reload]);
}

export type MedOption = { medicine_id: string; medicine_name: string; generic_name?: string; form?: string; on_hand?: number };

/** Accessible searchable medicine picker (ARIA combobox + listbox). */
export function MedicineCombobox({ options, value, onChange, id = "med-combo", disabled = false }: {
  options: MedOption[]; value: string | null; onChange: (id: string) => void; id?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = options.find((o) => o.medicine_id === value) ?? null;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const f = s ? options.filter((o) => o.medicine_name.toLowerCase().includes(s) || o.medicine_id.toLowerCase().includes(s)
      || (o.generic_name ?? "").toLowerCase().includes(s)) : options;
    return f.slice(0, 60);
  }, [options, q]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => setActive(0), [q]);
  const pick = (o: MedOption) => { onChange(o.medicine_id); setOpen(false); setQ(""); };
  return (
    <div ref={wrap} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <input
          id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" disabled={disabled}
          aria-activedescendant={open && list[active] ? `${id}-opt-${list[active].medicine_id}` : undefined}
          value={open ? q : sel ? `${sel.medicine_name} · ${sel.medicine_id}` : ""}
          placeholder="Search medicine name, generic or ID…"
          onFocus={() => { if (!value) setOpen(true); }}
          onClick={() => setOpen(true)}
          onBlur={() => { setOpen(false); setQ(""); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, list.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && open && list[active]) { e.preventDefault(); pick(list[active]); }
            else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
          }}
          className="focus-ring h-10 w-full rounded-xl border border-hairline bg-surface pl-9 pr-9 text-[14px] placeholder:text-muted disabled:opacity-60"
        />
        <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
      </div>
      {open && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-hairline bg-surface py-1 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.3)]">
          {list.length === 0 && <li className="px-3 py-2.5 text-[13px] text-ink-3">No medicine matches “{q}”.</li>}
          {list.map((o, i) => (
            <li key={o.medicine_id} id={`${id}-opt-${o.medicine_id}`} role="option" aria-selected={o.medicine_id === value}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] ${i === active ? "bg-sunken" : ""}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.medicine_name}</span>
                <span className="block truncate text-[11.5px] text-ink-3">{o.medicine_id}{o.generic_name ? ` · ${o.generic_name}` : ""}{o.form ? ` · ${o.form}` : ""}</span>
              </span>
              {o.on_hand != null && <span className="shrink-0 text-[11.5px] text-ink-3 tnum">{fmt.int(o.on_hand)} on hand</span>}
              {o.medicine_id === value && <Check className="h-4 w-4 shrink-0 text-brand" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
