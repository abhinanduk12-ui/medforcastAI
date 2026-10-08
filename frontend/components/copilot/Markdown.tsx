"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/* Lightweight markdown for copilot answers: paragraphs, headings, **bold**, _italic_, `code`, [links](/path),
   bullet / numbered lists, blockquotes, fenced code, rules and GitHub-style tables. No HTML is ever injected. */

const INLINE = /(\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])_[^_]+_(?!\w)|(?<![\w*])\*[^*\s][^*]*\*(?!\w))/g;

function MdLink({ label, href }: { label: string; href: string }) {
  const cls = "font-medium text-brand underline decoration-brand-soft underline-offset-2 hover:decoration-brand focus-ring rounded-sm";
  if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href} className={cls}>{label}</Link>;
  if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{label}</a>;
  return <span>{label}</span>; // anything else (javascript:, data:, …) is shown as plain text
}

function inline(text: string, key = "0"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t) ?? [];
      out.push(<MdLink key={k} label={label ?? t} href={href ?? ""} />);
    } else if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-ink">{inline(t.slice(2, -2), k)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k} className="break-words rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[12.5px] text-ink">{t.slice(1, -1)}</code>);
    else out.push(<em key={k} className="text-ink-3">{inline(t.slice(1, -1), k)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTableSep = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,4}\s+/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*```/;

function Table({ lines }: { lines: string[] }) {
  const head = cells(lines[0]);
  const align = cells(lines[1]).map((c) => (c.endsWith(":") ? "right" : "left") as "left" | "right");
  const body = lines.slice(2).map(cells);
  return (
    <div className="my-3 overflow-x-auto rounded-xl border border-hairline">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="bg-surface-2 text-[11px] uppercase tracking-wider text-ink-3">
            {head.map((h, i) => (
              <th key={i} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${align[i] === "right" ? "text-right" : "text-left"}`}>{inline(h, `h${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="border-t border-hairline">
              {head.map((_, ci) => (
                <td key={ci} className={`px-3 py-2 ${align[ci] === "right" ? "whitespace-nowrap text-right tnum" : "min-w-[8rem] text-left"} ${ci === 0 ? "text-ink" : "text-ink-2"}`}>
                  {inline(r[ci] ?? "", `${ri}-${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of text)
      blocks.push(
        <pre key={blocks.length} className="my-3 overflow-x-auto rounded-xl bg-sunken px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink">{code.join("\n")}</pre>,
      );
      continue;
    }
    // table: header row followed by a separator row
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      blocks.push(<Table key={blocks.length} lines={rows} />);
      continue;
    }
    if (RULE.test(line)) {
      blocks.push(<hr key={blocks.length} className="my-4 border-hairline" />);
      i++;
      continue;
    }
    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) items.push(lines[i++].replace(BULLET, ""));
      blocks.push(
        <ul key={blocks.length} className="my-2 space-y-1.5">
          {items.map((it, k) => (
            <li key={k} className="relative pl-4 before:absolute before:left-0.5 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-[#c3c2b7]">{inline(it, `b${k}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (NUMBERED.test(line)) {
      const items: string[] = [];
      while (i < lines.length && NUMBERED.test(lines[i])) items.push(lines[i++].replace(NUMBERED, ""));
      blocks.push(
        <ol key={blocks.length} className="my-2 list-decimal space-y-1.5 pl-5 marker:text-ink-3">
          {items.map((it, k) => <li key={k}>{inline(it, `n${k}`)}</li>)}
        </ol>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={blocks.length} className="my-2 rounded-xl border border-hairline bg-sunken px-3.5 py-2.5 text-[13px] text-ink-2">
          {inline(q.join(" "))}
        </blockquote>,
      );
      continue;
    }
    if (HEADING.test(line)) {
      blocks.push(<p key={blocks.length} className="mt-4 mb-1 font-semibold text-ink">{inline(line.replace(HEADING, ""))}</p>);
      i++;
      continue;
    }
    // paragraph: consecutive plain lines
    const para: string[] = [];
    const breaks = (l: string) => BULLET.test(l) || NUMBERED.test(l) || HEADING.test(l) || FENCE.test(l) || RULE.test(l) || l.startsWith(">") || /^\s*\|/.test(l);
    while (i < lines.length && lines[i].trim() && !breaks(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={blocks.length} className="my-2 break-words">{inline(para.join(" "))}</p>);
  }
  return <div className="text-[14px] leading-relaxed text-ink-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{blocks}</div>;
}
