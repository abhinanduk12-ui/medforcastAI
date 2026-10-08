"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** Accessible dialog: Escape / backdrop closes, Tab stays inside, focus moves in and returns on close. */
export function Modal({ open, onClose, title, sub, children, width = 460 }: {
  open: boolean; onClose: () => void; title: string; sub?: ReactNode; children: ReactNode; width?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => box.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])")?.focus(), 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab" || !box.current) return;
      const f = Array.from(box.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-[rgba(11,11,11,0.28)] backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="modal-title"
        className="rise relative max-h-[92vh] w-full overflow-y-auto rounded-t-[20px] border border-hairline bg-surface shadow-[0_30px_60px_-20px_rgba(11,11,11,0.35)] sm:rounded-[20px]"
        style={{ maxWidth: width }}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 id="modal-title" className="text-[16px] font-semibold tracking-tight">{title}</h2>
            {sub && <p className="mt-1 text-[13px] text-ink-3">{sub}</p>}
          </div>
          <button data-close onClick={onClose} aria-label="Close dialog" className="focus-ring -mr-2 rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 pb-6 pt-4">{children}</div>
      </div>
    </div>
  );
}

export const inputCls = "focus-ring h-10 w-full rounded-xl border border-hairline bg-surface px-3 text-[14px] placeholder:text-muted";
export const labelCls = "mb-1.5 block text-[12.5px] font-medium text-ink-2";
export const primaryBtn = "focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white transition hover:bg-[#262624] disabled:opacity-60";
export const ghostBtn = "focus-ring inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 transition hover:bg-sunken hover:text-ink disabled:opacity-50";

/** A strong random password (client-side crypto), e.g. for resets. */
export function generatePassword(len = 14): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const sym = "@#%&*!?";
  const all = alpha + digits + sym;
  const r = new Uint32Array(len);
  crypto.getRandomValues(r);
  const chars = Array.from(r, (v) => all[v % all.length]);
  chars[r[0] % len] = digits[r[1] % digits.length];
  chars[(r[0] + 3) % len] = sym[r[2] % sym.length];
  return chars.join("");
}
