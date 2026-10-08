"use client";

import { CloudRain, Gauge, Package, Snowflake, Thermometer, TrendingUp } from "lucide-react";
import { fmt } from "@/lib/format";
import { SeasonIcon } from "@/components/ui";
import { CopilotAvatar } from "./Message";

export const SUGGESTIONS = [
  { icon: TrendingUp, title: "Forecast a medicine", prompt: "How much Dolo 650 will I sell next month?" },
  { icon: CloudRain, title: "Monsoon movers", prompt: "Which antibiotics rise in monsoon?" },
  { icon: Snowflake, title: "Prepare for winter", prompt: "What should I stock up for winter?" },
  { icon: Thermometer, title: "Seasonal profile", prompt: "Compare seasons for Cetzine" },
  { icon: Package, title: "Plan a reorder", prompt: "Plan stock for Augmentin with 2 week lead time at 98% service" },
  { icon: Gauge, title: "Check the model", prompt: "How accurate is the model?" },
] as const;

export function EngineBadge({ engine, model, offline = false }: { engine?: string; model?: string | null; offline?: boolean }) {
  const claude = engine === "claude";
  const label = offline ? "API offline" : !engine ? "Connecting…" : claude ? `Claude${model ? ` · ${model}` : ""}` : "Local engine";
  return (
    <span
      title={offline ? "The forecasting API could not be reached" : claude ? "Claude chooses which data tools to call" : engine ? "Rule-based engine over the same data tools (no AI key configured)" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${
        claude && !offline ? "border-brand-soft bg-brand-wash text-brand-ink" : "border-hairline bg-surface text-ink-2"}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${offline || !engine ? "bg-[#c3c2b7]" : claude ? "bg-brand" : "bg-ink-3"}`} />
      <span className="sr-only">Answer engine: </span>{label}
    </span>
  );
}

/* The forecast starts the week after the last sales data; say plainly when that window is already behind us. */
function windowNote(start: string, today?: string) {
  if (!today) return "";
  const end = new Date(start + "T00:00:00");
  end.setDate(end.getDate() + 27); // last day of the 4th forecast week
  const endIso = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  return endIso < today ? ", which is already in the past" : start < today ? ", which is partly in the past" : "";
}

export function Welcome({ onPick, engine, model, season, today, dataThrough, forecastStart, offline = false }: {
  onPick: (p: string) => void; engine?: string; model?: string | null; season?: string; today?: string;
  dataThrough?: string | null; forecastStart?: string | null; offline?: boolean;
}) {
  return (
    <div className="mx-auto max-w-3xl py-6 sm:py-10">
      <div className="rise flex flex-col items-center text-center">
        <CopilotAvatar size={52} />
        <h2 className="mt-5 text-[26px] font-semibold tracking-[-0.02em] sm:text-[30px]">Ask about your shop&apos;s demand</h2>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-2">
          Every answer is built from this pharmacy&apos;s sales history, the ensemble forecast and the seasonal analysis – the
          copilot looks the numbers up with tools and says so when the data can&apos;t answer.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <EngineBadge engine={engine} model={model} offline={offline} />
          {season && today && <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 text-[12px] text-ink-2"><SeasonIcon season={season} className="h-3.5 w-3.5" />Today {fmt.weekYear(today)} · {season}</span>}
        </div>
        {dataThrough && forecastStart && (
          <p className="mt-3 max-w-xl text-[12px] leading-relaxed text-ink-3">
            Sales data runs to the week of {fmt.weekYear(dataThrough)}, so &ldquo;next 4 weeks&rdquo; means the 4 weeks from{" "}
            {fmt.weekYear(forecastStart)}{windowNote(forecastStart, today)}. Answers show the exact dates.
          </p>
        )}
      </div>
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SUGGESTIONS.map((s, i) => (
          <button
            type="button"
            key={s.title}
            onClick={() => onPick(s.prompt)}
            className="focus-ring card rise group flex flex-col items-start gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-22px_rgba(11,11,11,0.35)]"
            style={{ animationDelay: `${80 + i * 40}ms` }}
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-sunken text-ink-2 transition group-hover:bg-brand-wash group-hover:text-brand-ink">
              <s.icon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
            </span>
            <span>
              <span className="block text-[13px] font-semibold text-ink">{s.title}</span>
              <span className="mt-1 block text-[13px] leading-snug text-ink-3">“{s.prompt}”</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
