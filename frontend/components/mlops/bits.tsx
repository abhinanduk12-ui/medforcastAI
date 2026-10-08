"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Crown, Loader2, Octagon, XCircle } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "good" | "warn" | "bad" | "neutral" | "info" | "brand";
const TONE: Record<Tone, string> = {
  good: "bg-[#e8f6e8] text-[#1d6b1d]",
  warn: "bg-[#fff4dc] text-[#7a5200]",
  bad: "bg-[#fdecea] text-[#8f2626]",
  neutral: "bg-sunken text-ink-2",
  info: "bg-[#e6f0fc] text-[#1c5cab]",
  brand: "bg-brand-wash text-brand-ink",
};
const ICON: Record<Tone, typeof CheckCircle2> = {
  good: CheckCircle2, warn: AlertTriangle, bad: XCircle, neutral: CircleDashed, info: Loader2, brand: Crown,
};

/** Status pill: always icon + label, never colour alone. */
export function Pill({ tone, children, spin }: { tone: Tone; children: ReactNode; spin?: boolean }) {
  const Icon = ICON[tone];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium ${TONE[tone]}`}>
      <Icon className={`h-3 w-3 ${spin ? "animate-spin" : ""}`} strokeWidth={2.2} aria-hidden />
      {children}
    </span>
  );
}

export function ValidationPill({ status }: { status: string }) {
  if (status === "ok") return <Pill tone="good">Clean</Pill>;
  if (status === "warnings") return <Pill tone="warn">Warnings</Pill>;
  if (status === "errors") return <Pill tone="warn">Rows dropped</Pill>;
  return <Pill tone="bad">Failed</Pill>;
}

export function UploadStatusPill({ status }: { status: string }) {
  if (status === "accepted") return <Pill tone="good">Accepted</Pill>;
  if (status === "rejected") return <Pill tone="bad">Rejected</Pill>;
  return <Pill tone="neutral">Pending review</Pill>;
}

export function GatePill({ verdict }: { verdict?: string | null }) {
  switch (verdict) {
    case "pass": return <Pill tone="good">Gate passed</Pill>;
    case "fail": return <Pill tone="bad">Worse than champion</Pill>;
    case "needs_override": return <Pill tone="warn">Not comparable</Pill>;
    case "champion": return <Pill tone="brand">Champion</Pill>;
    default: return <Pill tone="neutral">Not ready</Pill>;
  }
}

export function JobStatusPill({ status }: { status: string }) {
  if (status === "succeeded") return <Pill tone="good">Succeeded</Pill>;
  if (status === "failed") return <Pill tone="bad">Failed</Pill>;
  if (status === "cancelled" || status === "interrupted") return <Pill tone="neutral">{status === "cancelled" ? "Cancelled" : "Interrupted"}</Pill>;
  return <Pill tone="info" spin>{status === "queued" ? "Queued" : status === "preparing" ? "Preparing data" : status === "explaining" ? "Explaining" : "Training"}</Pill>;
}

export function Notice({ tone = "warn", children }: { tone?: "warn" | "bad" | "info"; children: ReactNode }) {
  const Icon = tone === "bad" ? Octagon : AlertTriangle;
  const cls = tone === "bad" ? "bg-[#fdecea] text-[#8f2626]" : tone === "info" ? "bg-sunken text-ink-2" : "bg-[#fff8e8] text-[#6b4a00]";
  return (
    <div role={tone === "bad" ? "alert" : undefined} className={`flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ${cls}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export const pct1 = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
export const delta1 = (n?: number | null) =>
  n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n * 100).toFixed(1)} pts`;
