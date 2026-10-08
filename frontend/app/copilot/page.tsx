"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import { useApi } from "@/lib/api";
import { PageHeader } from "@/components/ui";
import { AssistantMessage, TypingIndicator, UserBubble, sanitizeMsg, type ChatMsg } from "@/components/copilot/Message";
import { EngineBadge, Welcome } from "@/components/copilot/Welcome";

type Status = {
  engine: "claude" | "local"; model: string | null; today: string; season: string;
  data_through?: string | null; forecast_start?: string | null; tools: { name: string; description: string }[];
};
type ChatResponse = Pick<ChatMsg, "tool_calls" | "cards" | "engine" | "model"> & { answer: string; note?: string | null };

const STORE_KEY = "medforecast.copilot.v1";
const MAX_SENT = 30;       // most recent turns sent to the API (it accepts up to 40)
const MAX_CHARS = 4000;    // the API's per-message limit – applies to earlier assistant answers too
const MAX_STORED = 80;     // keep sessionStorage small

function loadHistory(): ChatMsg[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(sanitizeMsg).filter((m): m is ChatMsg => m !== null).slice(-MAX_STORED) : [];
  } catch {
    return [];
  }
}

/* Turn a failed response into a plain-language reason. FastAPI 422s carry `detail` as a string or a list. */
async function failureReason(r: Response): Promise<string> {
  const body: unknown = await r.json().catch(() => null);
  const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : null;
  const text = typeof detail === "string" ? detail
    : Array.isArray(detail) ? detail.map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : "")).filter(Boolean).join("; ")
    : "";
  if (r.status === 422) return `The question could not be processed${text ? ` (${text})` : ""}. Try rephrasing, or clear the chat if the conversation is very long.`;
  return `The forecasting API returned ${r.status}${r.statusText ? ` ${r.statusText}` : ""}${text ? ` – ${text}` : ""}.`;
}

export default function CopilotPage() {
  const { data: status, error: statusError } = useApi<Status>("/api/copilot/status");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);               // guards against a double send before the re-render lands
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastAnswerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const scrolledOnce = useRef(false);

  useEffect(() => { setMessages(loadHistory()); setHydrated(true); }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-MAX_STORED))); } catch { /* storage blocked or full: keep in memory only */ }
  }, [messages, hydrated]);
  // Abandon an in-flight request when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Scroll: restored history jumps to the end; a new long answer is shown from its first line; otherwise follow the end.
  useEffect(() => {
    if (!hydrated || messages.length === 0) return;
    const first = !scrolledOnce.current;
    scrolledOnce.current = true;
    const last = messages[messages.length - 1];
    const answer = lastAnswerRef.current;
    if (!first && !busy && last.role === "assistant" && answer && answer.offsetHeight > window.innerHeight - 280) {
      answer.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      endRef.current?.scrollIntoView({ behavior: first ? "auto" : "smooth", block: "end" });
    }
  }, [messages, busy, hydrated]);

  // Auto-grow the composer up to ~6 lines.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  const send = useCallback(async (text: string, base?: ChatMsg[]) => {
    const q = text.trim().slice(0, MAX_CHARS);
    if (!q || busyRef.current) return;
    busyRef.current = true;
    const history = (base ?? messages).filter((m) => !m.error);
    const next: ChatMsg[] = [...history, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const payload = next.slice(-MAX_SENT).map(({ role, content }) => ({ role, content: content.slice(0, MAX_CHARS) }));
      let r: Response;
      try {
        r = await fetch("/api/copilot/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        throw new Error(`The forecasting API did not respond (${e instanceof Error ? e.message : String(e)}). Check that the backend is running on port 8000, then retry.`);
      }
      if (!r.ok) throw new Error(await failureReason(r));
      const d: ChatResponse = await r.json();
      if (typeof d?.answer !== "string" || !d.answer) throw new Error("The forecasting API sent an empty answer.");
      const reply = sanitizeMsg({ role: "assistant", content: d.answer, tool_calls: d.tool_calls, cards: d.cards, engine: d.engine, model: d.model });
      if (!ctrl.signal.aborted && reply) setMessages([...next, reply]);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setMessages([...next, { role: "assistant", content: e instanceof Error ? e.message : String(e), error: true }]);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
      if (!ctrl.signal.aborted) boxRef.current?.focus();
    }
  }, [messages]);

  const retry = () => {
    let idx = messages.length - 1;
    while (idx >= 0 && messages[idx].role !== "user") idx--;
    if (idx < 0) return;
    send(messages[idx].content, messages.slice(0, idx));
  };

  const clear = () => { setMessages([]); setInput(""); scrolledOnce.current = false; boxRef.current?.focus(); };
  const lastIsError = messages.length > 0 && messages[messages.length - 1].error;
  const lastAnswerIdx = messages.length - 1;
  const offline = !!statusError && !status;

  // A question handed over from the command palette (/copilot?q=...) is asked once, then removed from the URL.
  const askedFromUrl = useRef(false);
  useEffect(() => {
    if (!hydrated || askedFromUrl.current) return;
    askedFromUrl.current = true;
    const q = new URLSearchParams(window.location.search).get("q")?.trim();
    if (!q) return;
    window.history.replaceState(null, "", "/copilot");
    send(q.slice(0, MAX_CHARS));
  }, [hydrated, send]);

  return (
    <div className="flex min-h-[calc(100dvh-9rem)] flex-col">
      <PageHeader
        eyebrow="AI assistant"
        title="Copilot"
        actions={
          <>
            <EngineBadge engine={status?.engine} model={status?.model} offline={offline} />
            {messages.length > 0 && (
              <button type="button" onClick={clear} disabled={busy} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] text-ink-2 transition hover:bg-sunken hover:text-ink disabled:opacity-40">
                <Trash2 className="h-4 w-4" aria-hidden /> Clear chat
              </button>
            )}
          </>
        }
      >
        Ask in plain words about forecasts, seasons, stock levels or model accuracy. Answers are grounded in this
        shop&apos;s data only{status?.engine === "claude" ? ", with Claude choosing which data tools to call" : status?.engine === "local" ? ", using the built-in local engine (no AI key configured)" : ""}.
      </PageHeader>

      <div className="flex-1">
        {!hydrated ? null : messages.length === 0 ? (
          <Welcome
            onPick={(p) => send(p)} engine={status?.engine} model={status?.model} season={status?.season} today={status?.today}
            dataThrough={status?.data_through} forecastStart={status?.forecast_start} offline={offline}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 pb-6" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation">
            {messages.map((m, i) => (m.role === "user"
              ? <UserBubble key={i} text={m.content} />
              : <AssistantMessage key={i} msg={m} ref={i === lastAnswerIdx ? lastAnswerRef : undefined} />))}
            {busy && <TypingIndicator />}
            {lastIsError && !busy && (
              <div className="flex justify-center">
                <button type="button" onClick={retry} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-sunken">
                  <RotateCcw className="h-4 w-4" aria-hidden /> Retry
                </button>
              </div>
            )}
          </div>
        )}
        {/* scroll-margin keeps the last line clear of the sticky composer */}
        <div ref={endRef} className="scroll-mb-36" />
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 bg-gradient-to-t from-page via-page to-transparent px-4 pb-4 pt-6 sm:-mx-8 sm:px-8">
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-[20px] border border-hairline bg-surface p-2 shadow-[0_18px_40px_-24px_rgba(11,11,11,0.35)] transition focus-within:border-[rgba(14,92,79,0.45)] focus-within:ring-4 focus-within:ring-brand-wash"
        >
          <label htmlFor="copilot-input" className="sr-only">Ask the copilot</label>
          <textarea
            id="copilot-input"
            ref={boxRef}
            rows={1}
            value={input}
            maxLength={MAX_CHARS}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); }
            }}
            placeholder="Ask about a medicine, a season or a stock plan…"
            aria-describedby="copilot-hint"
            className="max-h-[168px] min-h-[44px] min-w-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label={busy ? "Waiting for the answer" : "Send"}
            className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-ink text-white transition hover:bg-[#262624] disabled:bg-sunken disabled:text-muted"
          >
            <ArrowUp className="h-5 w-5" strokeWidth={2.2} aria-hidden />
          </button>
        </form>
        <p id="copilot-hint" className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted">
          <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line · </span>Demand data only – not clinical advice. Synthetic dataset.
          {input.length > MAX_CHARS - 400 && <span className="tnum"> · {input.length.toLocaleString("en-IN")}/{MAX_CHARS.toLocaleString("en-IN")}</span>}
        </p>
      </div>
    </div>
  );
}
