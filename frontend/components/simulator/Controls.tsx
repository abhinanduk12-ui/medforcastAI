"use client";

import { Bug, CircleDot, CloudRain, CloudSun, Eye, IndianRupee, Info, Plus, Sun, Thermometer, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Skeleton } from "@/components/ui";
import { epidemicCurve, matchesPreset, OUTBREAK_LABEL, OUTBREAK_TYPES, type Outbreak, type OutbreakType, type Params, type Preset } from "./model";

const PRESET_ICON: Record<string, typeof Sun> = {
  "circle-dot": CircleDot, "cloud-rain": CloudRain, "cloud-sun": CloudSun, bug: Bug, thermometer: Thermometer, sun: Sun, eye: Eye, "indian-rupee": IndianRupee,
};

/* ───────────── Preset cards ───────────── */
export function PresetRow({ presets, error, params, onPick }: { presets: Preset[] | null; error?: string | null; params: Params; onPick: (p: Preset) => void }) {
  if (!presets && error) return <p className="rounded-xl border border-hairline bg-surface px-4 py-3 text-[13px] text-ink-3">Presets could not be loaded ({error}). The controls below still work.</p>;
  if (!presets) return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[...Array(8)].map((_, i) => <Skeleton key={i} className="h-[72px] sm:h-[104px]" />)}</div>;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {presets.map((p, i) => {
        const Icon = PRESET_ICON[p.icon] ?? CircleDot;
        const active = matchesPreset(params, p);
        return (
          <button key={p.id} onClick={() => onPick(p)} aria-pressed={active} title={p.rationale} style={{ animationDelay: `${40 + i * 25}ms` }}
            className={`rise focus-ring group flex min-w-0 flex-col items-start gap-2 rounded-[18px] border p-3.5 text-left transition-all sm:p-4 ${
              active ? "border-ink bg-ink text-white shadow-[0_10px_28px_-14px_rgba(0,0,0,0.5)]" : "border-hairline bg-surface hover:-translate-y-0.5 hover:border-[rgba(11,11,11,0.18)] hover:shadow-[0_10px_28px_-18px_rgba(0,0,0,0.3)]"}`}>
            <span className={`grid h-8 w-8 place-items-center rounded-lg ${active ? "bg-white/15 text-white" : "bg-brand-wash text-brand"}`}>
              <Icon className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <span className="text-[13px] font-semibold tracking-tight sm:text-[14px]">{p.name}</span>
            {/* Rationale is hidden on phones to keep the eight presets compact; it stays available as the tooltip */}
            <span className={`hidden text-[12px] leading-snug sm:block ${active ? "text-white/75" : "text-ink-3"}`}>{p.rationale}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────── Small building blocks ───────────── */
function Section({ title, value, children }: { title: string; value?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-hairline px-5 py-5 first:border-t-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-semibold tracking-tight">{title}</p>
        {value != null && <span className="text-[13px] font-medium tnum text-ink">{value}</span>}
      </div>
      {children}
    </div>
  );
}

function Stepper({ label, value, set, min, max, suffix }: { label: string; value: number; set: (v: number) => void; min: number; max: number; suffix: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] text-ink-3">{label}</p>
      <div className="flex h-9 items-center rounded-lg border border-hairline bg-surface">
        <button aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(Math.max(min, value - 1))} className="focus-ring h-full w-8 rounded-l-lg text-[16px] text-ink-2 hover:bg-sunken disabled:opacity-30 disabled:hover:bg-transparent">−</button>
        <span className="flex-1 text-center text-[13px] font-medium tnum" aria-live="polite">{value}{suffix}</span>
        <button aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(Math.min(max, value + 1))} className="focus-ring h-full w-8 rounded-r-lg text-[16px] text-ink-2 hover:bg-sunken disabled:opacity-30 disabled:hover:bg-transparent">+</button>
      </div>
    </div>
  );
}

/** Range slider with labelled tick marks positioned at their value. */
function MarkedSlider({ value, min, max, step, onChange, marks, label, valueText }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; marks: { v: number; label: string }[]; label: string; valueText: string;
}) {
  const pos = (v: number) => `calc(${((v - min) / (max - min)) * 100}% + ${8 - ((v - min) / (max - min)) * 16}px)`;
  return (
    <div>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} aria-valuetext={valueText} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
      <div className="relative mt-1 h-8 text-[11px] text-ink-3">
        {marks.map((m) => (
          <button key={m.v} onClick={() => onChange(m.v)} style={{ left: pos(m.v) }} aria-label={`Set ${label.toLowerCase()} to ${m.label}`}
            className={`focus-ring absolute -translate-x-1/2 rounded px-1 text-center leading-tight transition hover:text-ink ${Math.abs(value - m.v) < 1e-9 ? "font-semibold text-ink" : ""}`}>
            <span className="mx-auto mb-0.5 block h-1.5 w-px bg-[#c3c2b7]" />
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Tiny epidemic-curve preview over the 12 forecast weeks. Height is a display scale of intensity (flat at 0×). */
export function CurvePreview({ o, weeks = 12, width = 132, height = 34 }: { o: Outbreak; weeks?: number; width?: number; height?: number }) {
  const amp = o.intensity <= 0 ? 0 : Math.min(1, o.intensity / 3 + 0.34);
  const c = epidemicCurve(weeks, o.start_week, o.duration_weeks).map((v) => v * amp);
  const x = (i: number) => 2 + (i * (width - 4)) / (weeks - 1);
  const y = (v: number) => height - 3 - v * (height - 7);
  const d = c.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} className="shrink-0" role="img" aria-label={`Epidemic curve: weeks ${o.start_week}–${Math.min(12, o.start_week + o.duration_weeks - 1)}`}>
      <rect x={x(o.start_week - 1) - 2} y={0} width={Math.max(4, x(Math.min(weeks, o.start_week + o.duration_weeks - 1) - 1) - x(o.start_week - 1) + 4)} height={height} rx={4} fill={C.s2} opacity={0.08} />
      <line x1={0} x2={width} y1={height - 3} y2={height - 3} stroke={C.axis} strokeWidth={1} />
      <path d={`${d}L${x(weeks - 1)},${height - 3}L${x(0)},${height - 3}Z`} fill={C.s2} opacity={0.14} />
      <path d={d} fill="none" stroke={C.s2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Week of the epidemic peak (1-based, may fall after week 12), from the same curve the backend uses. */
function peakWeek(o: Outbreak) {
  const c = epidemicCurve(o.start_week + o.duration_weeks - 1, o.start_week, o.duration_weeks);
  return c.indexOf(Math.max(...c)) + 1;
}

function OutbreakRow({ o, onChange, onRemove, summary, weeks, horizon, reach }: {
  o: Outbreak; onChange: (o: Outbreak) => void; onRemove: () => void; summary?: string; weeks: string[]; horizon: number; reach: number;
}) {
  const last = o.start_week + o.duration_weeks - 1;
  const end = Math.min(12, last);
  const peak = peakWeek(o);
  const date = (w: number) => (weeks[w - 1] ? fmt.week(weeks[w - 1]) : null);
  const span = date(o.start_week) && date(end) ? `${date(o.start_week)} – ${date(end)}` : null;
  // Outside the simulated window an outbreak changes nothing (or only the stock checks), so say so
  const note = o.start_week > reach ? `Starts after week ${reach}, so it has no effect in this ${horizon}-week view.`
    : o.start_week > horizon ? `Starts after the ${horizon}-week horizon, so it only affects the stock checks (risk and extra stock), not forecast demand.`
    : o.intensity === 0 ? "Intensity is 0×, so this outbreak has no effect." : null;
  return (
    <div className="rounded-2xl border border-hairline bg-surface-2 p-3.5">
      <div className="flex items-center gap-2">
        <select value={o.type} onChange={(e) => onChange({ ...o, type: e.target.value as OutbreakType })} aria-label="Outbreak type"
          className="focus-ring h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-2.5 text-[13px] font-medium">
          {OUTBREAK_TYPES.map((t) => <option key={t} value={t}>{OUTBREAK_LABEL[t]}</option>)}
        </select>
        <button onClick={onRemove} aria-label={`Remove ${OUTBREAK_LABEL[o.type]} outbreak`} className="focus-ring grid h-9 w-9 place-items-center rounded-lg text-ink-3 transition hover:bg-sunken hover:text-ink">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {summary && <p className="mt-2 text-[11px] leading-snug text-ink-3">{summary}</p>}
      <div className="mt-3 flex items-center gap-3">
        <CurvePreview o={o} />
        <p className="min-w-0 text-[11px] leading-snug text-ink-3">
          Weeks {o.start_week}–{end}{last > 12 ? "+" : ""}{span && <span className="block">{span}</span>}
          <span className="block">{peak <= 12 ? `peak in week ${peak}` : "peaks after week 12"}</span>
        </p>
      </div>
      {note && <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-ink-2"><Info className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" />{note}</p>}
      <div className="mt-3">
        <p className="mb-1 flex justify-between text-[11px] text-ink-3"><span>Intensity</span><span className="font-medium tnum text-ink">{o.intensity.toFixed(1)}×</span></p>
        <input type="range" min={0} max={3} step={0.1} value={o.intensity} aria-label="Outbreak intensity" aria-valuetext={`${o.intensity.toFixed(1)} times`} onChange={(e) => onChange({ ...o, intensity: Number(e.target.value) })} className="w-full" />
        <div className="flex justify-between text-[10px] text-muted"><span>none</span><span>typical (1×)</span><span>severe (3×)</span></div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stepper label="Starts in week" value={o.start_week} set={(v) => onChange({ ...o, start_week: v })} min={1} max={12} suffix="" />
        <Stepper label="Lasts" value={o.duration_weeks} set={(v) => onChange({ ...o, duration_weeks: v })} min={1} max={12} suffix=" wk" />
      </div>
    </div>
  );
}

/* ───────────── Control panel ───────────── */
export function ControlPanel({ params, set, summaries, weeks }: {
  params: Params; set: (p: Partial<Params>) => void; summaries: Partial<Record<OutbreakType, string>>; weeks: string[];
}) {
  const k = params.seasonal_intensity;
  const reach = Math.min(12, Math.max(params.horizon, params.lead_time + params.review)); // last week any result looks at
  const updateOutbreak = (i: number, o: Outbreak) => set({ outbreaks: params.outbreaks.map((x, j) => (j === i ? o : x)) });
  const add = () => {
    const used = new Set(params.outbreaks.map((o) => o.type));
    const type = OUTBREAK_TYPES.find((t) => !used.has(t)) ?? "dengue";
    set({ outbreaks: [...params.outbreaks, { type, intensity: 1, start_week: 2, duration_weeks: 6 }] });
  };
  return (
    <>
      <Section title="Seasonal intensity" value={`${k.toFixed(2)}×`}>
        <MarkedSlider value={k} min={0} max={2.5} step={0.05} onChange={(v) => set({ seasonal_intensity: v })} label="Seasonal intensity" valueText={`${k.toFixed(2)} times`}
          marks={[{ v: 0, label: "flat" }, { v: 0.6, label: "weak" }, { v: 1, label: "normal" }, { v: 1.5, label: "strong" }, { v: 2.5, label: "extreme" }]} />
        <p className="text-[12px] leading-relaxed text-ink-3">
          Scales every medicine&apos;s seasonal swing. 1× is the model&apos;s forecast, 0× removes the seasonal effect, and 1.5× makes it half again as large.
        </p>
      </Section>

      <Section title="Outbreaks" value={params.outbreaks.length ? `${params.outbreaks.length} active` : undefined}>
        <div className="space-y-3">
          {params.outbreaks.map((o, i) => (
            <OutbreakRow key={i} o={o} summary={summaries[o.type]} weeks={weeks} horizon={params.horizon} reach={reach} onChange={(x) => updateOutbreak(i, x)} onRemove={() => set({ outbreaks: params.outbreaks.filter((_, j) => j !== i) })} />
          ))}
          {params.outbreaks.length === 0 && <p className="text-[12px] leading-relaxed text-ink-3">No outbreak in this scenario. Add one to model a demand surge for specific medicines.</p>}
          {params.outbreaks.length < 6 && (
            <button onClick={add} className="focus-ring inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[rgba(11,11,11,0.2)] text-[13px] font-medium text-ink-2 transition hover:border-ink hover:text-ink">
              <Plus className="h-4 w-4" /> Add outbreak
            </button>
          )}
        </div>
      </Section>

      <Section title="Price change" value={fmt.signedPct(params.price_change_pct / 100)}>
        <MarkedSlider value={params.price_change_pct} min={-30} max={30} step={1} onChange={(v) => set({ price_change_pct: v })} label="Price change" valueText={fmt.signedPct(params.price_change_pct / 100)}
          marks={[{ v: -30, label: "−30%" }, { v: -10, label: "−10%" }, { v: 0, label: "none" }, { v: 10, label: "+10%" }, { v: 30, label: "+30%" }]} />
        <p className="text-[12px] leading-relaxed text-ink-3">Applied to every medicine. Volume responds through own-price elasticity: about −0.1 for chronic Rx and −0.5 for OTC.</p>
      </Section>

      <Section title="Stock plan to test">
        <div className="grid grid-cols-2 gap-2">
          <Stepper label="Lead time" value={params.lead_time} set={(v) => set({ lead_time: v })} min={0} max={8} suffix=" wk" />
          <Stepper label="Review period" value={params.review} set={(v) => set({ review: v })} min={1} max={8} suffix=" wk" />
          <Stepper label="Horizon" value={params.horizon} set={(v) => set({ horizon: v })} min={4} max={12} suffix=" wk" />
          <div className="min-w-0">
            <p className="mb-1.5 flex justify-between text-[11px] text-ink-3"><span>Service level</span><span className="font-medium tnum text-ink">{fmt.pct(params.service)}</span></p>
            <div className="flex h-9 items-center rounded-lg border border-hairline bg-surface px-2.5">
              <input type="range" min={0.8} max={0.99} step={0.01} value={params.service} aria-label="Service level" onChange={(e) => set({ service: Number(e.target.value) })} className="w-full" />
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
