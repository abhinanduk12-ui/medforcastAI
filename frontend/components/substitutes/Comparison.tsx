"use client";

import Link from "next/link";
import { ArrowRightLeft, Info } from "lucide-react";
import { fmt } from "@/lib/format";
import { LEVEL, SafetyBadge, StockPill, TierBadge, fmtDate, inrPrecise as inr2, type Candidate, type SubstitutesResp, type Warning } from "./model";

const pct = (n: number | null | undefined) => (n == null ? "—" : fmt.signedPct(n, 0));

export function WarningList({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="space-y-2" aria-label="Safety notes">
      {warnings.map((w) => {
        const m = LEVEL[w.level];
        const Icon = m.icon;
        return (
          <li key={w.code} className="flex gap-2.5 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed" style={{ background: m.wash }}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.2} style={{ color: m.color }} aria-hidden />
            <span className="min-w-0 text-ink-2"><b className="font-semibold text-ink">{m.label}: {w.title}.</b> {w.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PriceDelta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-ink-3">—</span>;
  const cheaper = v < -0.005;
  const dearer = v > 0.005;
  return (
    <span className={`tnum font-medium ${cheaper ? "text-good" : dearer ? "text-critical" : "text-ink-2"}`}>
      {pct(v)} <span className="text-[11px] font-normal text-ink-3">{cheaper ? "cheaper" : dearer ? "dearer" : "same"}</span>
    </span>
  );
}

export function CandidateRow({ c, origName, compact = false }: { c: Candidate; origName: string; compact?: boolean }) {
  return (
    <article className="rounded-2xl border border-hairline bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/medicines/${c.id}`} className="focus-ring min-w-0 max-w-full truncate rounded text-[14px] font-semibold hover:underline">{c.name}</Link>
            <TierBadge tier={c.tier} />
          </div>
          <p className="mt-0.5 text-[12px] text-ink-3">{c.strength} · {c.form} · {c.generic}</p>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <StockPill qty={c.on_hand_here} />
          {c.on_hand_here > 0 && c.earliest_expiry_here && (
            <span className="text-[11px] text-ink-3">Earliest expiry {fmtDate(c.earliest_expiry_here)}</span>
          )}
        </div>
      </div>

      <dl className={`mt-3 grid gap-x-4 gap-y-2 text-[12px] ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
        <div className="min-w-0"><dt className="text-ink-3">Unit price</dt><dd className="tnum text-[13px] font-medium text-ink">{inr2(c.price)}</dd></div>
        <div className="min-w-0"><dt className="text-ink-3">vs {compact ? "this" : origName.split(" ")[0]}</dt><dd><PriceDelta v={c.price_diff_pct} /></dd></div>
        {c.tier === "exact" ? (
          <div className="min-w-0"><dt className="text-ink-3">{c.savings_for_qty != null && c.savings_for_qty < 0 ? "Extra cost" : "Savings"} for {c.qty}</dt>
            <dd className={`tnum text-[13px] font-medium ${c.savings_for_qty != null && c.savings_for_qty > 0 ? "text-good" : "text-ink"}`}>
              {c.savings_for_qty == null ? "—" : inr2(Math.abs(c.savings_for_qty))}
            </dd></div>
        ) : (
          <div className="min-w-0"><dt className="text-ink-3">Same-dose cost</dt>
            <dd className="tnum text-[13px] font-medium text-ink" title="Price per mg × the original strength, same route only; assumes the dose could be made up exactly. Information only: a dose change needs a pharmacist.">{inr2(c.equivalent_dose_cost)}</dd></div>
        )}
        <div className="min-w-0"><dt className="text-ink-3">Price per mg</dt>
          <dd className="tnum text-[13px] text-ink">{c.price_per_mg == null ? "—" : inr2(c.price_per_mg)}
            {c.price_per_mg_diff_pct != null && <span className="ml-1 text-[11px] text-ink-3">({pct(c.price_per_mg_diff_pct)})</span>}</dd></div>
      </dl>

      {c.flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">{c.flags.map((f) => <SafetyBadge key={f.kind} flag={f} compact />)}</div>
      )}
      {/* Critical flags are spelled out (a tooltip is not reachable on touch or by keyboard). */}
      {c.flags.some((f) => f.level === "critical") && (
        <ul className="mt-2 space-y-1">
          {c.flags.filter((f) => f.level === "critical").map((f) => (
            <li key={f.kind} className="rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-2" style={{ background: LEVEL.critical.wash }}>
              <b className="font-semibold text-ink">{f.label}:</b> {f.text}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-2">{c.match_note}</p>

      {(c.on_hand_other_stores.length > 0 || c.transfer_hint) && (
        <div className="mt-3 rounded-xl bg-sunken px-3 py-2 text-[12px] text-ink-2">
          {c.on_hand_other_stores.length > 0 && (
            <p>Other stores:{" "}
              {c.on_hand_other_stores.map((s, i) => (
                <span key={s.store_id} className="tnum">{i > 0 && ", "}{s.store_name ?? s.store_id} {s.qty == null ? "in stock" : s.qty}{s.simulated ? " (simulated)" : ""}</span>
              ))}
            </p>
          )}
          {c.transfer_hint && (
            <p className="mt-1 inline-flex items-start gap-1.5 font-medium text-ink"><ArrowRightLeft className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{c.transfer_hint}</p>
          )}
        </div>
      )}
    </article>
  );
}

/** Full comparison body (drawer). */
export function Comparison({ data }: { data: SubstitutesResp }) {
  const m = data.medicine;
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-hairline bg-[var(--surface-2)] p-4">
        <p className="eyebrow mb-1">Requested</p>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">{m.name}</p>
            <p className="text-[12px] text-ink-3">{m.strength} · {m.form} · {m.generic}</p>
          </div>
          <StockPill qty={m.on_hand_here} />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3 text-[12px]">
          <div><dt className="text-ink-3">Unit price</dt><dd className="tnum text-[13px] font-medium">{inr2(m.price)}</dd></div>
          <div><dt className="text-ink-3">Price per mg</dt><dd className="tnum text-[13px]">{inr2(m.price_per_mg)}</dd></div>
          <div><dt className="text-ink-3">Prescription share</dt><dd className="tnum text-[13px]">{fmt.pct(m.rx_share)}</dd></div>
        </dl>
      </div>

      <WarningList warnings={data.warnings} />

      <section aria-label="Exact substitutes">
        <h3 className="mb-2 text-[13px] font-semibold">Exact substitutes <span className="font-normal text-ink-3">· {data.exact.length}</span></h3>
        {data.exact.length === 0 ? (
          <p className="rounded-xl border border-dashed border-hairline px-3 py-3 text-[12.5px] text-ink-3">
            No product in the catalogue has the same molecule, strength and form.
          </p>
        ) : <div className="space-y-3">{data.exact.map((c) => <CandidateRow key={c.id} c={c} origName={m.name} />)}</div>}
      </section>

      <section aria-label="Same molecule, different strength or form">
        <h3 className="mb-2 text-[13px] font-semibold">Same molecule, different strength or form <span className="font-normal text-ink-3">· {data.same_molecule.length}</span></h3>
        {data.same_molecule.length === 0 ? (
          <p className="rounded-xl border border-dashed border-hairline px-3 py-3 text-[12.5px] text-ink-3">None in the catalogue.</p>
        ) : <div className="space-y-3">{data.same_molecule.map((c) => <CandidateRow key={c.id} c={c} origName={m.name} />)}</div>}
      </section>

      <div className="flex gap-2 rounded-xl bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-ink-3">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <div>
          <p>{data.therapeutic_alternatives.note}</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">{data.assumptions.slice(0, 4).map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}
