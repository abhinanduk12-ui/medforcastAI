"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCheck, Hourglass, Inbox, Loader2, Scale, Send } from "lucide-react";
import { apiPost, ApiError } from "@/lib/api";
import { fmt } from "@/lib/format";
import { AbcBadge } from "@/components/ui";
import { Modal, ghostBtn, primaryBtn } from "@/components/auth/Modal";
import type { ApplyResp, Kind, Side, Suggestion, SuggestResp } from "./types";
import { KIND_LABEL, cover, day } from "./types";

const KIND_ICON = { stockout: AlertTriangle, expiry: Hourglass, rebalance: Scale } as const;
const KIND_TONE: Record<Kind, string> = {
  stockout: "border-[#f5c9c9] bg-[#fdf0f0] text-[#9c2b2b]",
  expiry: "border-[#f3d9a6] bg-[#fff7e6] text-[#7a5200]",
  rebalance: "border-hairline bg-sunken text-ink-2",
};
const KINDS: Kind[] = ["stockout", "expiry", "rebalance"];

function CoverBar({ side, name, dir }: { side: Side; name: string; dir: "out" | "in" }) {
  if (side.qty_before == null) {
    return (
      <div className="min-w-0 rounded-xl bg-sunken px-3 py-2">
        <p className="truncate text-[12px] font-medium text-ink-2">{name}</p>
        <p className="mt-0.5 text-[11.5px] text-ink-3">Stock at other branches is not visible to your role.</p>
      </div>
    );
  }
  const target = side.target ?? 0;
  const max = Math.max(side.qty_before ?? 0, side.qty_after ?? 0, target, 1);
  const pct = (v: number | null) => `${((v ?? 0) / max) * 100}%`;
  return (
    <div className="min-w-0 rounded-xl bg-sunken px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-[12px] font-medium text-ink">{name}</p>
        <p className="shrink-0 text-[11.5px] tnum text-ink-2">{cover(side.cover_before)} → <b className="font-semibold text-ink">{cover(side.cover_after)}</b></p>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-surface" aria-hidden>
        <div className="absolute inset-y-0 left-0 rounded-full bg-[#c9d9ee]" style={{ width: pct(side.qty_before) }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-[#2a78d6]" style={{ width: pct(side.qty_after) }} />
        <div className="absolute -top-1 h-4 w-[2px] rounded bg-ink" style={{ left: pct(target) }} title={`Target ${target}`} />
      </div>
      <p className="mt-1.5 text-[11px] tnum text-ink-3">
        {fmt.int(side.qty_before)} → {fmt.int(side.qty_after)} units · target {fmt.int(target)} · {fmt.one(side.weekly_rate)}/wk
        {dir === "out" && side.projected_writeoff_units != null && side.projected_writeoff_units >= 0.5 && ` · ~${fmt.int(side.projected_writeoff_units)} would expire here`}
      </p>
    </div>
  );
}

function SuggestionCard({ s, canApply, canRequest, busy, locked, onApprove, onRequest, done }: {
  s: Suggestion; canApply: boolean; canRequest: boolean; busy: boolean; locked: boolean; done?: string;
  onApprove: () => void; onRequest: () => void;
}) {
  const Icon = KIND_ICON[s.kind];
  return (
    <article className={`card p-5 transition ${done ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${KIND_TONE[s.kind]}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden />{KIND_LABEL[s.kind]}
            </span>
            <AbcBadge abc={s.abc} />
            <Link href={`/medicines/${s.medicine_id}`} className="focus-ring truncate rounded text-[15px] font-semibold hover:underline">{s.medicine_name}</Link>
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-2">
            <span className="font-medium text-ink">{s.from_name}</span>
            <ArrowRight className="h-3.5 w-3.5 text-ink-3" aria-label="to" />
            <span className="font-medium text-ink">{s.to_name}</span>
            <span className="text-ink-3">· {s.category}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {done ? (
            <span className="inline-flex items-center gap-1 rounded-xl bg-brand-wash px-3 py-2 text-[13px] font-medium text-brand-ink"><Check className="h-4 w-4" aria-hidden />{done}</span>
          ) : canApply ? (
            <button onClick={onApprove} disabled={locked} aria-busy={busy} className={primaryBtn} aria-label={`Approve: move ${s.qty} units of ${s.medicine_name} from ${s.from_name} to ${s.to_name}`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Approve
            </button>
          ) : canRequest ? (
            <button onClick={onRequest} disabled={locked} aria-busy={busy} className={ghostBtn} aria-label={`Request: move ${s.qty} units of ${s.medicine_name} from ${s.from_name} to ${s.to_name}`}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Request
            </button>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div><dt className="text-[11.5px] text-ink-3">Move</dt><dd className="text-[16px] font-semibold tnum">{fmt.int(s.qty)} units</dd><dd className="text-[11px] text-ink-3 tnum">{fmt.inrFull(s.value)} at cost</dd></div>
        <div><dt className="text-[11.5px] text-ink-3">Write-off avoided</dt><dd className="text-[16px] font-semibold tnum">{s.writeoff_saved_value >= 1 ? `~${fmt.inrFull(s.writeoff_saved_value)}` : "—"}</dd><dd className="text-[11px] text-ink-3 tnum">{s.writeoff_saved_units >= 0.5 ? `~${fmt.int(s.writeoff_saved_units)} units` : "no expiry risk"}</dd></div>
        <div><dt className="text-[11.5px] text-ink-3">Sales protected</dt><dd className="text-[16px] font-semibold tnum">{s.revenue_protected >= 1 ? `~${fmt.inrFull(s.revenue_protected)}` : "—"}</dd><dd className="text-[11px] text-ink-3 tnum">{s.shortfall_units_avoided >= 0.5 ? `~${fmt.int(s.shortfall_units_avoided)} units short avoided` : "over lead + review"}</dd></div>
        <div><dt className="text-[11.5px] text-ink-3">Soonest expiry</dt><dd className="text-[16px] font-semibold tnum">{s.days_to_expiry} days</dd><dd className="text-[11px] text-ink-3 tnum">{day(s.soonest_expiry)}</dd></div>
      </dl>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <CoverBar side={s.from} name={`From ${s.from_name}`} dir="out" />
        <CoverBar side={s.to} name={`To ${s.to_name}`} dir="in" />
      </div>

      {s.rationale && <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{s.rationale}</p>}
      <p className="mt-2 text-[11.5px] text-ink-3">
        Batches (first-expiry-first-out): {s.batches.map((b) => `${b.batch_no} × ${fmt.int(b.qty)} (exp ${day(b.expiry_date)})`).join(", ")}
      </p>
    </article>
  );
}

export function Suggestions({ data, minValue, onChanged }: { data: SuggestResp; minValue: number; onChanged: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [limit, setLimit] = useState(12);

  const list = useMemo(() => data.suggestions.filter((s) => !kind || s.kind === kind), [data, kind]);
  // "Approve all" acts on what the user is looking at: the active kind filter, not yet done.
  const open = list.filter((s) => !done[s.id]);
  const closeConfirm = useCallback(() => setConfirm(false), []);

  // Same scope as the list on screen: the medicine filter (medicine pages) and the minimum value.
  const medicineId = data.params.medicine_id ?? undefined;
  const approve = async (ids: string[], all = false) => {
    setBusy(all ? "all" : ids[0]);
    setMsg(null);
    try {
      // "Approve all" sends the exact ids that were confirmed, so the server never executes moves the
      // user did not see; ids that went stale meanwhile come back in stale_ids.
      const r = await apiPost<ApplyResp>("/api/stores/transfers/apply-suggestions",
        { ids, min_value: minValue, medicine_id: medicineId });
      const next = { ...done };
      r.applied.forEach((a) => { next[a.id] = a.ref; });
      setDone(next);
      const parts = [`${r.applied.length} transfer${r.applied.length === 1 ? "" : "s"} done, ${fmt.int(r.moved_units)} units moved`];
      if (r.failed.length) parts.push(`${r.failed.length} not done (${r.failed[0].error})`);
      if (r.stale_ids.length) parts.push(`${r.stale_ids.length} out of date: stock changed, so the list was refreshed`);
      setMsg({ ok: r.failed.length === 0 && r.stale_ids.length === 0, text: parts.join(" · ") });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };

  const request = async (s: Suggestion) => {
    setBusy(s.id);
    setMsg(null);
    try {
      await apiPost("/api/stores/transfers/requests", {
        from_store: s.from_store, to_store: s.to_store, medicine_id: s.medicine_id, qty: s.qty,
        reason: `${KIND_LABEL[s.kind]} (suggested)`,
      });
      setDone((d) => ({ ...d, [s.id]: "Requested" }));
      setMsg({ ok: true, text: "Request sent. An owner or buyer will approve it." });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setKind(null)} aria-pressed={!kind}
          className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] ${!kind ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:text-ink"}`}>
          All <span className={`tnum text-[12px] ${!kind ? "text-white/70" : "text-ink-3"}`}>{data.summary.count}</span>
        </button>
        {KINDS.map((k) => {
          const Icon = KIND_ICON[k];
          const active = kind === k;
          return (
            <button key={k} onClick={() => setKind(active ? null : k)} aria-pressed={active}
              className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] ${active ? "border-ink bg-ink text-white" : "border-hairline bg-surface text-ink-2 hover:text-ink"}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden />{KIND_LABEL[k]}
              <span className={`tnum text-[12px] ${active ? "text-white/70" : "text-ink-3"}`}>{data.summary.by_kind[k]}</span>
            </button>
          );
        })}
        {data.can_apply && open.length > 0 && (
          <button onClick={() => setConfirm(true)} disabled={!!busy} className={`${primaryBtn} ml-auto`}>
            {busy === "all" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCheck className="h-4 w-4" aria-hidden />}
            {kind ? `Approve all ${open.length} shown` : `Approve all (${open.length})`}
          </button>
        )}
      </div>

      {msg && (
        <p role="status" className={`mt-4 rounded-xl px-3.5 py-2.5 text-[13px] ${msg.ok ? "bg-brand-wash text-brand-ink" : "bg-[#fdf0f0] text-[#9c2b2b]"}`}>{msg.text}</p>
      )}
      {!data.can_apply && (
        <p className="mt-4 rounded-xl bg-sunken px-3.5 py-2.5 text-[12.5px] text-ink-2">
          {data.can_request
            ? "Your role can request transfers that touch your branch; an owner or buyer approves and executes them."
            : "Your role can view suggestions but not act on them."}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {list.length === 0 ? (
          <div className="card flex flex-col items-center px-6 py-12 text-center">
            <Inbox className="h-9 w-9 text-ink-3" strokeWidth={1.6} aria-hidden />
            <p className="mt-3 text-[15px] font-semibold">No transfers worth making</p>
            <p className="mt-1 max-w-md text-[13px] text-ink-3">
              Every branch is at or near target, or the remaining moves are below the minimum value. Lower the threshold to see smaller moves.
            </p>
          </div>
        ) : list.slice(0, limit).map((s) => (
          <SuggestionCard key={s.id} s={s} canApply={data.can_apply} canRequest={data.can_request} busy={busy === s.id || busy === "all"} locked={busy !== null}
            done={done[s.id]} onApprove={() => approve([s.id])} onRequest={() => request(s)} />
        ))}
      </div>
      {list.length > limit && (
        <div className="mt-4 text-center">
          <button onClick={() => setLimit(limit + 24)} className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-brand hover:bg-brand-wash">
            Show more ({list.length - limit} left)
          </button>
        </div>
      )}

      <Modal open={confirm} onClose={closeConfirm} title={`Approve ${open.length} ${kind ? `“${KIND_LABEL[kind]}” ` : ""}transfer${open.length === 1 ? "" : "s"}?`}
        sub="Stock moves first-expiry-first-out between branches. This updates on-hand stock immediately and is recorded in the ledger.">
        <ul className="space-y-1.5 text-[13px] text-ink-2">
          <li className="flex justify-between"><span>Units moved</span><b className="tnum text-ink">{fmt.int(open.reduce((t, s) => t + s.qty, 0))}</b></li>
          <li className="flex justify-between"><span>Stock value moved (cost)</span><b className="tnum text-ink">{fmt.inrFull(open.reduce((t, s) => t + s.value, 0))}</b></li>
          <li className="flex justify-between"><span>Projected write-off avoided</span><b className="tnum text-ink">~{fmt.inrFull(open.reduce((t, s) => t + s.writeoff_saved_value, 0))}</b></li>
        </ul>
        <p className="mt-3 text-[12px] text-ink-3">Estimates rely on simulated branch demand. Arrange physical transport and check cold-chain items before dispatch.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={closeConfirm} className={ghostBtn}>Cancel</button>
          <button onClick={() => approve(open.map((s) => s.id), true)} disabled={busy !== null || open.length === 0} className={primaryBtn}>
            {busy === "all" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Approve all
          </button>
        </div>
      </Modal>
    </div>
  );
}
