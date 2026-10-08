"use client";

import { useState } from "react";
import { ChevronsUpDown, Info, Store as StoreIcon } from "lucide-react";
import { switchStore, useMe } from "@/lib/auth";

/**
 * Selected-store picker. `variant="panel"` for the sidebar card (shows the simulated-branch note),
 * `variant="compact"` for the header. Single-store users see a static label.
 */
export function StoreSwitcher({ variant = "compact" }: { variant?: "compact" | "panel" }) {
  const { me } = useMe();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!me) {
    return variant === "panel" ? <div className="skeleton h-[92px]" aria-hidden /> : <span className="skeleton hidden h-9 w-40 sm:block" aria-hidden />;
  }
  const sel = me.selected_store_info ?? me.stores.find((s) => s.id === me.selected_store) ?? null;
  const multi = me.stores.length > 1;

  const onChange = async (id: string) => {
    if (id === me.selected_store) return;
    setBusy(true);
    setErr(null);
    try { await switchStore(id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const select = (cls: string) => (
    <div className="relative min-w-0">
      <select value={me.selected_store ?? ""} onChange={(e) => onChange(e.target.value)} disabled={busy || !multi}
        aria-label="Selected store" className={`focus-ring w-full appearance-none truncate rounded-xl border border-hairline bg-surface pr-8 text-ink disabled:cursor-default disabled:opacity-100 ${cls}`}>
        {me.stores.map((s) => (
          <option key={s.id} value={s.id}>{s.name}{s.simulated ? " (simulated)" : ""}</option>
        ))}
      </select>
      {multi && <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden />}
    </div>
  );

  if (variant === "panel") {
    return (
      <div className="rounded-2xl border border-hairline bg-surface p-4">
        <p className="eyebrow flex items-center gap-1.5"><StoreIcon className="h-3 w-3" aria-hidden />Store</p>
        <div className={`mt-2 ${busy ? "opacity-60" : ""}`}>{select("h-9 pl-3 text-[13px] font-medium")}</div>
        {sel && (
          <p className="mt-2 text-[11.5px] leading-snug text-ink-3">
            {sel.simulated
              ? <><Info className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />Simulated branch: demand = main shop forecast × {sel.demand_scale.toFixed(2)}.</>
              : <>{sel.city} · the shop the sales data comes from.</>}
          </p>
        )}
        {err && <p role="alert" className="mt-1.5 text-[11.5px] text-critical">{err}</p>}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2" title={sel?.simulated ? `Simulated branch: main forecast × ${sel.demand_scale.toFixed(2)}` : undefined}>
      <div className={`w-[176px] ${busy ? "opacity-60" : ""}`}>{select("h-9 pl-3 text-[13px]")}</div>
      {sel?.simulated && (
        <span className="hidden rounded-md bg-sunken px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3 xl:inline">Simulated</span>
      )}
      {err && <span role="alert" className="sr-only">{err}</span>}
    </div>
  );
}
