"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { useApi } from "@/lib/api";
import { Skeleton } from "@/components/ui";
import { Comparison } from "./Comparison";
import type { SubstitutesResp } from "./model";

const QTYS = [1, 10, 30, 100];

/** Right-hand drawer comparing every candidate for one medicine. */
export function SubstituteDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [qty, setQty] = useState(10);
  const { data, error, loading } = useApi<SubstitutesResp>(id ? `/api/substitutes/${encodeURIComponent(id)}?qty=${qty}` : null);
  const panel = useRef<HTMLDivElement>(null);

  // Keep the latest onClose in a ref so an unstable callback does not re-run the focus effect.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!id) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      // Focus trap: aria-modal promises the page behind is inert.
      const f = Array.from(panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.current.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !panel.current.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      clearTimeout(t); document.removeEventListener("keydown", onKey);
      body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [id]);

  if (!id || typeof document === "undefined") return null;
  const shown = data && data.medicine.id === id ? data : null;

  // Portal to <body>: ancestors with .rise keep a transform, which would trap a fixed panel.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[rgba(11,11,11,0.24)] backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="sub-drawer-title"
        className="rise relative flex h-full w-full max-w-[620px] flex-col border-l border-hairline bg-surface shadow-[0_30px_60px_-20px_rgba(11,11,11,0.35)]">
        <header className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="eyebrow mb-1">Substitute comparison</p>
            <h2 id="sub-drawer-title" className="truncate text-[17px] font-semibold tracking-tight">{shown?.medicine.name ?? "Loading…"}</h2>
            {shown?.store && (
              <p className="mt-0.5 text-[12px] text-ink-3">Stock at {shown.store.name}{shown.store.simulated ? " (simulated branch)" : ""}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Link href={`/medicines/${encodeURIComponent(id)}`} onClick={onClose} aria-label="Open medicine page" className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink">
              <ExternalLink className="h-4 w-4" aria-hidden />
            </Link>
            <button data-autofocus onClick={onClose} aria-label="Close comparison" className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </header>

        {shown && shown.exact.length === 0 ? (
          <p className="border-b border-hairline px-5 py-3 text-[12.5px] text-ink-3 sm:px-6">
            Savings are only estimated for exact substitutes; none exist for this product.
          </p>
        ) : (
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-5 py-3 text-[12.5px] sm:px-6">
          <span className="text-ink-3">Savings for</span>
          <div className="inline-flex rounded-xl border border-hairline bg-sunken p-1" role="group" aria-label="Quantity for savings">
            {QTYS.map((q) => (
              <button key={q} onClick={() => setQty(q)} aria-pressed={q === qty}
                className={`focus-ring rounded-lg px-2.5 py-1 tnum transition ${q === qty ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3 hover:text-ink"}`}>
                {q}
              </button>
            ))}
          </div>
          <span className="text-ink-3">units</span>
          {loading && shown && <span className="ml-auto text-ink-3" aria-live="polite">updating…</span>}
        </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {error && !loading ? (
            <div className="rounded-2xl border border-hairline p-6 text-center">
              <p className="text-[14px] font-semibold">Could not load substitutes</p>
              <p className="mt-1 text-[12.5px] text-ink-3">{error}</p>
            </div>
          ) : !shown ? (
            <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
          ) : <Comparison data={shown} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}
