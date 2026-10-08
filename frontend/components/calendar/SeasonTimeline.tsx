"use client";

import { PartyPopper, Sparkles } from "lucide-react";
import { fmt } from "@/lib/format";
import { SeasonIcon } from "@/components/ui";
import type { CalMonth } from "./types";

/* Season tints: neutral warm surfaces, so the band reads as context and never competes with data colours. */
const SEASON_BG: Record<string, string> = {
  Winter: "#eef2f6", Summer: "#fbf3e4", Monsoon: "#e9f1ef", "Post-Monsoon": "#f3f0ea",
};

/** One row of months, grouped into season bands, with festival markers and the ML-blend window. */
export function SeasonTimeline({ months }: { months: CalMonth[] }) {
  // Group consecutive months of the same season into one band.
  const bands: { season: string; from: number; span: number }[] = [];
  months.forEach((m, i) => {
    const last = bands[bands.length - 1];
    if (last && last.season === m.season) last.span++;
    else bands.push({ season: m.season, from: i, span: 1 });
  });
  const cols = { gridTemplateColumns: `repeat(${months.length}, minmax(56px, 1fr))` };

  return (
    <div className="overflow-x-auto pb-1">
      <div className="min-w-[900px]">
        {/* Season bands */}
        <div className="grid gap-1" style={cols}>
          {bands.map((b) => (
            <div key={`${b.season}-${b.from}`} className="flex h-10 items-center gap-2 overflow-hidden rounded-xl px-3 text-[12px] font-medium text-ink-2"
              style={{ gridColumn: `${b.from + 1} / span ${b.span}`, background: SEASON_BG[b.season] ?? "#f1f0eb" }} title={`${b.season}: ${b.span} month${b.span > 1 ? "s" : ""}`}>
              <SeasonIcon season={b.season} className="h-4 w-4 shrink-0" />
              <span className="truncate">{b.season}</span>
            </div>
          ))}
        </div>

        {/* Month ticks */}
        <div className="mt-2 grid gap-1" style={cols}>
          {months.map((m, i) => (
            <div key={m.month} className="text-center">
              <p className="text-[12px] font-semibold text-ink">{m.short}</p>
              <p className="text-[10px] text-ink-3 tnum">{i === 0 || m.month.endsWith("-01") ? m.month.slice(0, 4) : " "}</p>
            </div>
          ))}
        </div>

        {/* ML blend window */}
        <div className="mt-2 grid gap-1" style={cols}>
          {months.map((m) => (
            <div key={m.month} className="flex h-6 items-center justify-center" title={m.ml_days ? `${m.ml_days} of ${m.days} days covered by the ML forecast · weight ${Math.round(m.ml_weight * 100)}%` : "Seasonal projection only"}>
              {m.ml_days > 0 ? (
                <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-brand-wash px-2 py-0.5 text-[10px] font-medium text-brand-ink">
                  <Sparkles className="h-3 w-3" />ML {Math.round(m.ml_weight * 100)}%
                </span>
              ) : <span className="h-px w-full bg-hairline" />}
            </div>
          ))}
        </div>

        {/* Festival markers */}
        <div className="mt-1 grid gap-1" style={cols}>
          {months.map((m) => (
            <div key={m.month} className="flex min-h-[44px] flex-col items-center gap-1 pt-1">
              {m.festivals.map((f) => (
                <span key={f.name} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-hairline bg-surface px-1 py-0.5 text-[10px] font-medium text-ink-2"
                  title={`${f.name}: ${f.days_in_month} day${f.days_in_month > 1 ? "s" : ""} this month (${fmt.weekYear(f.start)} to ${fmt.weekYear(f.end)})${f.effects.length ? " · significant lift in festival weeks: " + f.effects.map((e) => `${e.category} ${fmt.signedPct(e.uplift)}`).join(", ") : " · no statistically clear lift"}`}>
                  <PartyPopper className="h-3 w-3 shrink-0 text-ink-3" />
                  <span className="truncate">{f.name.replace("Christmas/New Year", "Xmas/NY")}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
