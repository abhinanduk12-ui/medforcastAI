"use client";

import { ArrowDownRight, ArrowUpRight, CloudRain, CloudSun, Minus, Snowflake, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { Sparkline } from "./charts";
import { signedPctText } from "@/lib/format";

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rise mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[34px]">{title}</h1>
        {children && <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{children}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <section className={`card rise ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </section>
  );
}

export function CardHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-1 text-[13px] text-ink-3">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function StatTile({ label, value, delta, deltaLabel, upIsGood = true, spark, hint }: {
  label: string; value: string; delta?: number | null; deltaLabel?: string; upIsGood?: boolean; spark?: number[]; hint?: string;
}) {
  const dir = delta == null ? 0 : delta > 0.005 ? 1 : delta < -0.005 ? -1 : 0;
  const good = dir === 0 ? null : (dir > 0) === upIsGood;
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
  return (
    <div className="card rise flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-ink-3">{label}</p>
        {spark && <Sparkline data={spark} width={84} height={28} />}
      </div>
      <p className="mt-3 text-[28px] font-semibold leading-none tracking-[-0.02em]">{value}</p>
      <div className="mt-auto flex items-center gap-1.5 pt-3 text-[12px]">
        {delta != null && (
          <span className={`inline-flex items-center gap-0.5 font-medium ${good == null ? "text-ink-3" : good ? "text-good" : "text-critical"}`}>
            <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
            {signedPctText(delta, 1)}
          </span>
        )}
        {(deltaLabel || hint) && <span className="text-ink-3">{deltaLabel ?? hint}</span>}
      </div>
    </div>
  );
}

const SEASON_ICON = { Winter: Snowflake, Summer: Sun, Monsoon: CloudRain, "Post-Monsoon": CloudSun } as const;

export function SeasonIcon({ season, className = "h-4 w-4" }: { season: string; className?: string }) {
  const Icon = SEASON_ICON[season as keyof typeof SEASON_ICON] ?? Sun;
  return <Icon className={className} strokeWidth={1.8} />;
}

export function SeasonChip({ season, active = true }: { season: string; active?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
      active ? "border-brand-soft bg-brand-wash text-brand-ink" : "border-hairline bg-surface text-ink-2"}`}>
      <SeasonIcon season={season} className="h-3.5 w-3.5" />
      {season}
    </span>
  );
}

export function Segmented<T extends string>({ options, value, onChange, render }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; render?: (v: T) => ReactNode;
}) {
  return (
    <div className="inline-flex rounded-xl border border-hairline bg-sunken p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={o === value}
          onClick={() => onChange(o)}
          className={`focus-ring flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-all ${
            o === value ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-ink-3 hover:text-ink"
          }`}
        >
          {render ? render(o) : o}
        </button>
      ))}
    </div>
  );
}

export function UpliftBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-ink-3">—</span>;
  const up = value > 0.02, down = value < -0.02;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium tnum ${
      up ? "bg-[#fdecea] text-[#a8302f]" : down ? "bg-[#e6f0fc] text-[#1c5cab]" : "bg-sunken text-ink-3"}`}>
      <Icon className="h-3 w-3" strokeWidth={2.4} />
      {signedPctText(value)}
    </span>
  );
}

export function AbcBadge({ abc }: { abc: string }) {
  const style = abc === "A" ? "bg-ink text-white" : abc === "B" ? "bg-sunken text-ink" : "border border-hairline text-ink-3";
  return <span className={`inline-grid h-5 w-5 place-items-center rounded-md text-[11px] font-semibold ${style}`} title={`ABC class ${abc}`}>{abc}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function ErrorState({ error }: { error: string }) {
  return (
    <div className="card p-8 text-center">
      <p className="text-[15px] font-semibold">Could not reach the forecasting API</p>
      <p className="mt-2 text-[13px] text-ink-3">{error}</p>
      <p className="mt-4 text-[13px] text-ink-2">
        Start it with <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px]">uvicorn backend.app:app --port 8000</code> from the project root.
      </p>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-80" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
      </div>
      <Skeleton className="h-[380px]" />
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "line" | "dash" | "band" | "dot" }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.kind === "band" ? (
            <span className="h-2.5 w-4 rounded-[3px]" style={{ background: it.color, opacity: 0.18 }} />
          ) : it.kind === "dot" ? (
            <span className="h-2 w-2 rounded-full" style={{ background: it.color }} />
          ) : (
            <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={it.color} strokeWidth="2" strokeDasharray={it.kind === "dash" ? "3 3" : undefined} strokeLinecap="round" /></svg>
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}
