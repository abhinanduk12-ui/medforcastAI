"use client";

import { useRef, useState } from "react";
import { AlertCircle, FileDown, FileUp, Info, X } from "lucide-react";
import { fmt } from "@/lib/format";
import { downloadCsv } from "./types";

const grouped = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Rupee amount with Indian digit grouping, plus a slider over 0..max. */
export function BudgetInput({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number }) {
  const [focus, setFocus] = useState(false);
  const [draft, setDraft] = useState("");
  const step = max > 2_000_000 ? 10_000 : max > 200_000 ? 5_000 : 1_000;
  return (
    <div>
      <label htmlFor="budget" className="mb-1.5 flex items-baseline justify-between text-[12px] text-ink-3">
        <span>Cash budget for this order</span>
        <span className="tnum">{fmt.inr(value)}</span>
      </label>
      <div className="flex h-14 items-center rounded-2xl border border-hairline bg-surface px-4 transition focus-within:border-brand">
        <span className="mr-2 text-[22px] font-medium text-ink-3">₹</span>
        <input
          id="budget" inputMode="numeric" autoComplete="off"
          value={focus ? draft : grouped.format(value)}
          onFocus={() => { setFocus(true); setDraft(String(value)); }}
          onBlur={() => setFocus(false)}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 10);
            const n = Math.min(Number(digits || 0), 1e9);   // API ceiling; show the capped figure, not what was typed
            setDraft(Number(digits || 0) > 1e9 ? String(n) : digits);
            onChange(n);
          }}
          className="w-full bg-transparent text-[24px] font-semibold tracking-[-0.01em] tnum outline-none"
        />
      </div>
      <input type="range" min={0} max={max} step={step} value={Math.min(value, max)} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-3 w-full" aria-label="Budget slider" />
      <div className="mt-1 flex justify-between text-[11px] text-muted tnum"><span>₹0</span><span>{fmt.inr(max)}</span></div>
    </div>
  );
}

export function Stepper({ label, value, set, min, max, step = 1, suffix, digits = 0 }: {
  label: string; value: number; set: (v: number) => void; min: number; max: number; step?: number; suffix: string; digits?: number;
}) {
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 1000) / 1000;
  return (
    <div>
      <p className="mb-1.5 text-[12px] text-ink-3">{label}</p>
      <div className="flex h-11 items-center rounded-xl border border-hairline bg-surface">
        <button aria-label={`Decrease ${label}`} onClick={() => set(clamp(value - step))} className="focus-ring h-full w-10 rounded-l-xl text-[18px] text-ink-2 hover:bg-sunken">−</button>
        <span className="flex-1 text-center text-[14px] font-medium tnum">{value.toFixed(digits)}{suffix}</span>
        <button aria-label={`Increase ${label}`} onClick={() => set(clamp(value + step))} className="focus-ring h-full w-10 rounded-r-xl text-[18px] text-ink-2 hover:bg-sunken">+</button>
      </div>
    </div>
  );
}

type Parsed = { stock: Record<string, number>; rows: number; skipped: number; file: string };

/** Parse "medicine_id,on_hand" text. Header optional; bad rows are counted, not fatal. */
export function parseStockCsv(text: string, file: string): Parsed {
  const stock: Record<string, number> = {};
  let rows = 0, skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [id, qty] = line.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, ""));
    if (/^medicine_id$/i.test(id ?? "")) continue;
    const n = Number(qty);
    if (!id || qty === undefined || qty === "" || !Number.isFinite(n) || n < 0 || n > 1e6) { skipped++; continue; }
    stock[id.toUpperCase()] = Math.floor(n);   // a repeated ID keeps its last row
  }
  rows = Object.keys(stock).length;
  return { stock, rows, skipped, file };
}

export function StockUpload({ value, onChange, unknown }: { value: Parsed | null; onChange: (p: Parsed | null) => void; unknown: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const template = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/medicines?sort=medicine_name&limit=1000");
      if (!r.ok) throw new Error(r.statusText);
      const d: { items: { id: string; name: string }[] } = await r.json();
      downloadCsv("on-hand-stock-template.csv", [["medicine_id", "on_hand", "medicine_name"], ...d.items.map((m) => [m.id, 0, m.name])]);
    } catch {
      downloadCsv("on-hand-stock-template.csv", [["medicine_id", "on_hand"], ["MED00001", 0]]);
    } finally {
      setBusy(false);
    }
  };

  const read = (f: File) => {
    setErr(null);
    if (f.size > 2_000_000) { setErr("File is larger than 2 MB"); return; }
    f.text().then((t) => {
      const p = parseStockCsv(t, f.name);
      if (!p.rows) setErr("No valid medicine_id,on_hand rows found");
      else if (p.rows > 5000) setErr("More than 5,000 medicines; split the file");
      else onChange(p);
    }).catch(() => setErr("Could not read this file"));
  };

  return (
    <div className="rounded-2xl border border-dashed border-[rgba(11,11,11,0.18)] bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">Stock already on the shelf <span className="font-normal text-ink-3">(optional)</span></p>
          <p className="mt-0.5 text-[12px] text-ink-3">CSV with columns <code className="rounded bg-sunken px-1 font-mono text-[11px]">medicine_id,on_hand</code>. Parsed in your browser and netted off the order.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={template} disabled={busy} title="Download a CSV listing every medicine ID" className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-[12px] font-medium text-ink-2 hover:bg-sunken disabled:opacity-50">
            <FileDown className="h-3.5 w-3.5" /> Template
          </button>
          <button onClick={() => input.current?.click()} className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2 text-[12px] font-medium text-white hover:bg-[#262624]">
            <FileUp className="h-3.5 w-3.5" /> Upload CSV
          </button>
          <input ref={input} type="file" tabIndex={-1} aria-hidden accept=".csv,text/csv,text/plain" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) read(f); e.target.value = ""; }} />
        </div>
      </div>
      {err && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[12px] font-medium text-critical"><AlertCircle className="h-3.5 w-3.5 shrink-0" /> {err}</p>}
      {value && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[12px]">
          <span className="font-medium">{value.file}</span>
          <span className="text-ink-3">· {fmt.int(value.rows)} medicines · {fmt.int(Object.values(value.stock).reduce((a, b) => a + b, 0))} units</span>
          {value.skipped > 0 && <span className="text-ink-3">· {value.skipped} rows skipped</span>}
          {unknown > 0 && <span className="inline-flex items-center gap-1 text-ink-2"><Info className="h-3.5 w-3.5" /> {unknown} IDs not in the catalogue, ignored</span>}
          <button onClick={() => onChange(null)} aria-label="Remove stock file" className="focus-ring ml-auto rounded p-1 text-ink-3 hover:bg-sunken hover:text-ink"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
    </div>
  );
}

export type { Parsed as StockFile };
