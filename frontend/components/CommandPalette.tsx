"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Pill, Search, Sparkles } from "lucide-react";
import { NAV } from "@/components/nav";

type Med = { id: string; name: string; generic: string; category: string };
type Item = { key: string; label: string; sub?: string; href: string; kind: "page" | "medicine" | "ask"; icon?: React.ComponentType<{ className?: string; strokeWidth?: number }> };

let medCache: Med[] | null = null;

/** Normalised fuzzy score: every query token must prefix-match a word (or appear) in the haystack. */
function score(q: string, hay: string) {
  const h = hay.toLowerCase();
  let s = 0;
  for (const t of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = h.indexOf(t);
    if (i < 0) return -1;
    s += i === 0 ? 3 : h[i - 1] === " " ? 2 : 1;
  }
  return s;
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [meds, setMeds] = useState<Med[]>(medCache ?? []);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 10);
    if (!medCache) {
      fetch("/api/medicines?limit=500&sort=total_units")
        .then((r) => r.json())
        .then((d) => {
          medCache = d.items.map((m: Med) => ({ id: m.id, name: m.name, generic: m.generic, category: m.category }));
          setMeds(medCache!);
        })
        .catch(() => {});
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = NAV.flatMap((g) => g.items).map((n) => ({ key: n.href, label: n.label, sub: "Page", href: n.href, kind: "page", icon: n.icon }));
    if (!q.trim()) return [...pages, ...meds.slice(0, 6).map((m) => ({ key: m.id, label: m.name, sub: m.category, href: `/medicines/${m.id}`, kind: "medicine" as const }))];
    const p = pages.map((i) => ({ i, s: score(q, i.label) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.i);
    const m = meds
      .map((x) => ({ x, s: Math.max(score(q, x.name), score(q, x.generic) - 0.5, score(q, `${x.id} ${x.category}`) - 1) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(({ x }) => ({ key: x.id, label: x.name, sub: `${x.generic} · ${x.category}`, href: `/medicines/${x.id}`, kind: "medicine" as const }));
    const ask: Item = { key: "ask", label: `Ask Copilot: “${q.trim()}”`, sub: "AI answer grounded in your data", href: `/copilot?q=${encodeURIComponent(q.trim())}`, kind: "ask" };
    return [...p, ...m, ask];
  }, [q, meds]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = useCallback((it?: Item) => {
    if (!it) return;
    setOpen(false);
    router.push(it.href);
  }, [router]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-[rgba(11,11,11,0.28)] backdrop-blur-[2px]" onClick={() => setOpen(false)} />
      <div className="rise relative w-full max-w-[620px] overflow-hidden rounded-2xl border border-hairline bg-surface shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3 border-b border-hairline px-4">
          <Search className="h-[18px] w-[18px] text-ink-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); go(items[active]); }
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search medicines, pages, or ask a question…"
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
            aria-label="Search"
          />
          <kbd className="rounded-md border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-ink-3">Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[420px] overflow-y-auto p-2">
          {items.map((it, i) => {
            const Icon = it.kind === "ask" ? Sparkles : it.kind === "medicine" ? Pill : it.icon ?? Search;
            return (
              <button
                key={`${it.kind}-${it.key}`}
                data-idx={i}
                onMouseMove={() => setActive(i)}
                onClick={() => go(it)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${i === active ? "bg-sunken" : ""}`}
              >
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${it.kind === "ask" ? "bg-brand text-white" : "border border-hairline bg-surface text-ink-2"}`}>
                  <Icon className="h-4 w-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{it.label}</span>
                  {it.sub && <span className="block truncate text-[12px] text-ink-3">{it.sub}</span>}
                </span>
                {i === active && <CornerDownLeft className="h-4 w-4 text-ink-3" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-hairline bg-surface-2 px-4 py-2.5 text-[11px] text-ink-3">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span className="ml-auto"><kbd className="font-mono">Ctrl K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
