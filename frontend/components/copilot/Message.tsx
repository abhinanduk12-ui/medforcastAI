"use client";

import Link from "next/link";
import { forwardRef } from "react";
import {
  ArrowUpRight, CalendarRange, CircleAlert, CloudSun, Gauge, LayoutGrid, Package, Search, Sparkles, TrendingUp, Trophy, Wrench,
} from "lucide-react";
import { Sparkline } from "@/components/charts";
import { fmt } from "@/lib/format";
import { Markdown } from "./Markdown";

export type ToolCall = { name: string; input: Record<string, unknown>; summary: string };
export type MedCardData = { type: "medicine"; id: string; name: string; category: string; next4: number | null; spark: number[] };
export type ChatMsg = {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
  cards?: MedCardData[];
  engine?: "claude" | "local";
  model?: string | null;
  error?: boolean;
};

/* History comes back from sessionStorage, which may hold an older or hand-edited shape:
   keep only fields that match the current types so rendering can never throw. */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toolCallOf(v: unknown): ToolCall | null {
  if (!isObj(v) || typeof v.name !== "string" || typeof v.summary !== "string") return null;
  return { name: v.name, summary: v.summary, input: isObj(v.input) ? v.input : {} };
}

function cardOf(v: unknown): MedCardData | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.name !== "string") return null;
  return {
    type: "medicine", id: v.id, name: v.name, category: typeof v.category === "string" ? v.category : "",
    next4: typeof v.next4 === "number" && Number.isFinite(v.next4) ? v.next4 : null,
    spark: Array.isArray(v.spark) ? v.spark.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [],
  };
}

export function sanitizeMsg(v: unknown): ChatMsg | null {
  if (!isObj(v) || (v.role !== "user" && v.role !== "assistant") || typeof v.content !== "string" || !v.content) return null;
  const m: ChatMsg = { role: v.role, content: v.content };
  if (Array.isArray(v.tool_calls)) m.tool_calls = v.tool_calls.map(toolCallOf).filter((x): x is ToolCall => x !== null);
  if (Array.isArray(v.cards)) m.cards = v.cards.map(cardOf).filter((x): x is MedCardData => x !== null);
  if (v.engine === "claude" || v.engine === "local") m.engine = v.engine;
  if (typeof v.model === "string") m.model = v.model;
  if (v.error === true) m.error = true;
  return m;
}

const TOOL_ICON: Record<string, typeof Search> = {
  search_medicines: Search, get_medicine_forecast: TrendingUp, get_season_impact: CloudSun, get_stock_plan: Package,
  get_model_performance: Gauge, list_categories: LayoutGrid, compare_seasons: CalendarRange, get_top_medicines: Trophy,
};

export function CopilotAvatar({ size = 32 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-xl bg-brand text-white shadow-[0_6px_16px_-8px_rgba(14,92,79,0.7)]" style={{ width: size, height: size }} aria-hidden>
      <Sparkles className="h-[55%] w-[55%]" strokeWidth={1.9} />
    </span>
  );
}

function ToolChip({ call }: { call: ToolCall }) {
  const failed = call.summary.endsWith("· error");
  // A failed lookup uses the critical status colour, so it always carries the alert icon and the word "error".
  const Icon = failed ? CircleAlert : TOOL_ICON[call.name] ?? Wrench;
  return (
    <span
      title={`${call.name}(${JSON.stringify(call.input)})`}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${
        failed ? "border-[#f4aaa6] bg-[#fdecea] text-[#7a1f1e]" : "border-hairline bg-surface-2 text-ink-2"}`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-critical" : "text-ink-3"}`} strokeWidth={2} aria-hidden />
      <span className="truncate">{call.summary}</span>
    </span>
  );
}

function MedCard({ c, delay }: { c: MedCardData; delay: number }) {
  return (
    <Link
      href={`/medicines/${encodeURIComponent(c.id)}`}
      className="focus-ring rise group flex min-w-0 items-center gap-3 rounded-2xl border border-hairline bg-surface p-3.5 transition hover:border-[rgba(11,11,11,0.16)] hover:shadow-[0_8px_24px_-16px_rgba(11,11,11,0.3)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[13px] font-semibold text-ink">
          <span className="truncate">{c.name}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-ink" aria-hidden />
        </p>
        {c.category && <p className="truncate text-[12px] text-ink-3">{c.category}</p>}
        <p className="mt-1.5 text-[12px] text-ink-2"><span className="font-semibold tnum text-ink">{fmt.int(c.next4)}</span> units forecast · next 4 wk</p>
      </div>
      {c.spark.length > 1 && (
        <div className="flex flex-col items-end gap-0.5">
          <Sparkline data={c.spark} width={84} height={30} />
          <span className="text-[10px] text-muted">sold, last {c.spark.length} wk</span>
        </div>
      )}
    </Link>
  );
}

function EngineMeta({ msg }: { msg: ChatMsg }) {
  if (!msg.engine) return null;
  const label = msg.engine === "claude" ? `Claude${msg.model ? ` · ${msg.model}` : ""}` : "Local engine";
  return <p className="mt-2 pl-1 text-[11px] text-muted">Answered by {label} · from this shop&apos;s data</p>;
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="rise flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-ink px-4 py-2.5 text-[14px] leading-relaxed text-white sm:max-w-[70%]">
        <span className="sr-only">You: </span>{text}
      </div>
    </div>
  );
}

export const AssistantMessage = forwardRef<HTMLDivElement, { msg: ChatMsg }>(function AssistantMessage({ msg }, ref) {
  return (
    <div ref={ref} className="rise flex scroll-mt-24 gap-3">
      <CopilotAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        <span className="sr-only">Copilot: </span>
        {msg.tool_calls && msg.tool_calls.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5" aria-label="Data the copilot looked up">
            {msg.tool_calls.map((t, i) => <ToolChip key={i} call={t} />)}
          </div>
        )}
        {msg.error ? (
          <div role="alert" className="flex items-start gap-2.5 rounded-2xl border border-[#f4aaa6] bg-[#fdecea] px-4 py-3 text-[13px] text-[#7a1f1e]">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-critical" aria-hidden />
            <div className="min-w-0 break-words"><p className="font-semibold">Couldn&apos;t get an answer</p><p className="mt-0.5">{msg.content}</p></div>
          </div>
        ) : (
          <div className="card px-4 py-4 sm:px-5"><Markdown text={msg.content} /></div>
        )}
        {msg.cards && msg.cards.length > 0 && (
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            {msg.cards.map((c, i) => <MedCard key={`${c.id}-${i}`} c={c} delay={80 + i * 50} />)}
          </div>
        )}
        {!msg.error && <EngineMeta msg={msg} />}
      </div>
    </div>
  );
});

export function TypingIndicator() {
  return (
    <div className="rise flex gap-3" role="status">
      <CopilotAvatar />
      <div className="card flex items-center gap-2.5 px-4 py-3.5">
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-3 motion-reduce:animate-none" style={{ animationDelay: `${i * 140}ms` }} />
          ))}
        </span>
        <span className="text-[12px] text-ink-3">Checking the data…</span>
      </div>
    </div>
  );
}
