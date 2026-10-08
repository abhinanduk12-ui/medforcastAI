"use client";

import { Ban, CheckCircle2, FileWarning, NotebookPen, RotateCcw, ShieldAlert, Undo2 } from "lucide-react";
import type { InvoiceStatus, Schedule } from "./types";

const SCHED: Record<Exclude<Schedule, "OTC">, { label: string; title: string; cls: string; Icon: typeof FileWarning }> = {
  H: { label: "Sch H", title: "Schedule H: sell only against a prescription", cls: "border-[#f3d9a4] bg-[#fdf5e3] text-[#7a5200]", Icon: FileWarning },
  H1: { label: "Sch H1", title: "Schedule H1: prescription + register entry required", cls: "border-[#f5c6b4] bg-[#fdeee8] text-[#9a3b17]", Icon: NotebookPen },
  X: { label: "Sch X", title: "Schedule X: prescription (retained copy) + register entry required", cls: "border-[#f1b9b9] bg-[#fdeaea] text-[#a8302f]", Icon: ShieldAlert },
  NDPS: { label: "NDPS", title: "Narcotic / psychotropic (NDPS): prescription + register entry required", cls: "border-[#f1b9b9] bg-[#fdeaea] text-[#a8302f]", Icon: ShieldAlert },
};

/** Drug schedule badge (icon + label; OTC renders a quiet text tag). */
export function ScheduleBadge({ schedule, compact = false }: { schedule: Schedule; compact?: boolean }) {
  if (schedule === "OTC") return compact ? null : <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[11px] font-medium text-ink-3">OTC</span>;
  const s = SCHED[schedule];
  return (
    <span title={s.title} className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${s.cls}`}>
      <s.Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden />
      {s.label}
    </span>
  );
}

const STATUS: Record<InvoiceStatus, { label: string; cls: string; Icon: typeof Ban }> = {
  paid: { label: "Paid", cls: "bg-[#e8f5e8] text-good", Icon: CheckCircle2 },
  void: { label: "Void", cls: "bg-sunken text-ink-3 line-through decoration-1", Icon: Ban },
  partially_returned: { label: "Part returned", cls: "bg-[#fdf5e3] text-[#7a5200]", Icon: Undo2 },
  returned: { label: "Returned", cls: "bg-[#fdeee8] text-[#9a3b17]", Icon: RotateCcw },
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium ${s.cls}`}>
      <s.Icon className="h-3 w-3 no-underline" strokeWidth={2.2} aria-hidden />
      {s.label}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-md border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink-3 shadow-[0_1px_0_rgba(11,11,11,0.06)]">{children}</kbd>;
}
