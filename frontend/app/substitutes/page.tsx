"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, CheckCircle2, ChevronRight, CircleSlash, Layers, PackageCheck, Search, ShieldCheck, Stethoscope } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, Segmented, Skeleton, StatTile } from "@/components/ui";
import { SubstituteDrawer } from "@/components/substitutes/SubstituteDrawer";
import { SafetyBadge, StockPill, TierBadge, inrPrecise, type CatalogueResp, type MoleculeGroup, type OosItem, type OosResp } from "@/components/substitutes/model";

const MODES = ["With alternatives", "All molecules"] as const;
type Mode = (typeof MODES)[number];
const PAGE = 24;

const inr2 = inrPrecise;

function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

function OosRow({ item, onOpen, review = false, basis }: { item: OosItem; onOpen: (id: string) => void; review?: boolean; basis?: string }) {
  const b = item.best;
  const other = b.on_hand_other_stores[0];
  const where = b.on_hand_here > 0 ? `${fmt.int(b.on_hand_here)} in stock here`
    : other ? `${other.qty == null ? "In stock" : `${fmt.int(other.qty)} in stock`} at ${other.store_name ?? other.store_id}${other.simulated ? " (simulated branch)" : ""}` : "Not in stock";
  const flags = b.flags.filter((f) => f.level !== "info");
  return (
    <li>
      <button onClick={() => onOpen(item.medicine.id)} aria-haspopup="dialog"
        className="focus-ring group grid w-full grid-cols-1 gap-3 px-5 py-4 text-left transition hover:bg-[var(--surface-2)] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.1fr)_auto] sm:items-center sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">{item.medicine.name}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {item.medicine.strength} · {item.medicine.form} · <span className="inline-flex items-center gap-1 font-medium text-critical"><CircleSlash className="h-3 w-3" aria-hidden />Out of stock here</span>
            {item.weekly_demand != null && <> · <span title={basis}>~{fmt.one(item.weekly_demand)}/wk forecast</span></>}
          </p>
        </div>
        <ArrowRightLeft className="hidden h-4 w-4 text-ink-3 sm:block" aria-hidden />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{b.name}</span>
            <TierBadge tier={b.tier} />
          </div>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {b.strength} · {b.form} · {where}
            {!review && b.price_diff_pct != null && <> · {fmt.signedPct(b.price_diff_pct)} price</>}
          </p>
          {flags.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{flags.map((f) => <SafetyBadge key={f.kind} flag={f} compact />)}</div>}
        </div>
        <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2 group-hover:text-ink">
          {b.on_hand_here > 0 ? "Compare" : "Compare · transfer"} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </button>
    </li>
  );
}

function MoleculeCard({ g, onOpen, delay }: { g: MoleculeGroup; onOpen: (id: string) => void; delay: number }) {
  return (
    <Card className="flex min-w-0 flex-col p-5" delay={delay}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold tracking-tight" title={g.label}>{g.label}</h3>
          <p className="mt-0.5 truncate text-[12px] text-ink-3">{g.categories.join(" · ")}</p>
        </div>
        <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[11.5px] font-medium tnum text-ink-2">{g.n_products} {g.n_products === 1 ? "product" : "products"}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {g.exact_pairs > 0 && <span className="inline-flex items-center gap-1 rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-white"><CheckCircle2 className="h-3 w-3" aria-hidden />{g.exact_pairs} exact {g.exact_pairs === 1 ? "pair" : "pairs"}</span>}
        {g.is_combination && <span className="inline-flex items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-[11px] font-medium text-ink-2"><Layers className="h-3 w-3" aria-hidden />Combination</span>}
        {g.nti && <SafetyBadge compact flag={{ kind: "nti", level: "critical", label: "Narrow therapeutic index", text: "Avoid brand switching without prescriber review." }} />}
        {g.rx && <SafetyBadge compact flag={{ kind: "rx", level: "warning", label: "Prescription", text: "Substitution of a prescribed brand requires the prescriber's/pharmacist's confirmation as per applicable rules." }} />}
      </div>
      <ul className="mt-3 divide-y divide-[var(--hairline)] border-y border-hairline">
        {g.products.map((p) => (
          <li key={p.id}>
            <button onClick={() => onOpen(p.id)} aria-haspopup="dialog" title={`Compare substitutes for ${p.name}`}
              className="focus-ring flex w-full items-center gap-3 rounded-lg py-2.5 text-left hover:bg-[var(--surface-2)]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium"><span className="sr-only">Compare substitutes for </span>{p.name}</p>
                <p className="truncate text-[11.5px] text-ink-3">
                  {p.strength} · {p.form}{p.form_conflict ? " · check pack" : ""}
                </p>
              </div>
              <span className="tnum shrink-0 text-[12.5px] text-ink-2">{inr2(p.price)}</span>
              <StockPill qty={p.on_hand_here} />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] text-ink-3">
        {g.price_min != null && g.price_max != null && g.n_products > 1 ? <>Unit price {inr2(g.price_min)} – {inr2(g.price_max)} · </> : null}
        {g.in_stock_here} of {g.n_products} in stock here · {g.in_stock_anywhere} of {g.n_products} in any store
      </p>
    </Card>
  );
}

export default function SubstitutesPage() {
  const [mode, setMode] = useState<Mode>("With alternatives");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);

  const catPath = `/api/substitutes?multi_only=${mode === "With alternatives"}${dq ? `&q=${encodeURIComponent(dq.slice(0, 80))}` : ""}`;
  const cat = useApi<CatalogueResp>(catPath);
  const oos = useApi<OosResp>("/api/substitutes/out-of-stock");
  useEffect(() => setLimit(PAGE), [catPath]);

  const groups = useMemo(() => cat.data?.groups ?? [], [cat.data]);
  // The data on screen may belong to the previous query while a new one loads.
  const [shownQ, setShownQ] = useState("");
  useEffect(() => { if (cat.data && !cat.loading) setShownQ(dq); }, [cat.data, cat.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (cat.error && !cat.data) return <ErrorState error={cat.error} />;
  if (!cat.data && !oos.data) return <PageSkeleton />;

  const s = cat.data?.summary;
  const store = oos.data?.store ?? cat.data?.store;

  return (
    <>
      <PageHeader eyebrow="Substitutes" title="Generic substitutes"
        actions={store ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1.5 text-[12.5px] text-ink-2">
            <PackageCheck className="h-3.5 w-3.5" aria-hidden />Stock at {store.name}{store.simulated ? " (simulated)" : ""}
          </span>
        ) : undefined}>
        Same-molecule alternatives when a product is out of stock or a cheaper equivalent exists. Only identical molecule,
        strength and form count as exact; anything else needs a pharmacist&apos;s dose review. Different molecules are never suggested.
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="Molecules with alternatives" value={s ? fmt.int(s.multi_product_molecules) : "—"} hint={s ? `of ${fmt.int(s.molecules)} molecules in the catalogue` : undefined} />
        <StatTile label="Exact substitute pairs" value={s?.exact_pairs != null ? fmt.int(s.exact_pairs) : "—"} hint="same molecule, strength and form" />
        <StatTile label="Out of stock, exact alternative" value={oos.data ? fmt.int(oos.data.counts.exact) : "—"} hint={oos.data ? `${oos.data.counts.exact_here} available in this store` : undefined} />
        <StatTile label="Out of stock, dose review only" value={oos.data ? fmt.int(oos.data.counts.review) : "—"} hint="other strength or form in stock, any store" />
      </div>

      <Card className="mt-6 overflow-hidden" delay={80}>
        <CardHeader title="Out of stock — alternatives available"
          sub="Items with no sellable stock here that have a same-molecule product in this store or another one." />
        {oos.error ? (
          <p className="px-6 py-6 text-[13px] text-ink-3">Could not load out-of-stock items: {oos.error}</p>
        ) : !oos.data ? (
          <div className="space-y-2 px-6 py-5"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        ) : oos.data.items.length + oos.data.review_items.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-good" strokeWidth={1.6} aria-hidden />
            <p className="mt-3 text-[15px] font-semibold">Nothing to substitute right now</p>
            <p className="mt-1 max-w-md text-[13px] text-ink-3">Every product that has a same-molecule alternative is in stock at this store.</p>
          </div>
        ) : (
          <div className={`mt-4 transition-opacity ${oos.loading ? "opacity-60" : ""}`} aria-busy={oos.loading}>
            <p className="flex items-center gap-1.5 border-t border-hairline bg-[var(--surface-2)] px-6 py-2 text-[12px] font-medium text-ink-2">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />Exact substitute available · {oos.data.items.length}
            </p>
            {oos.data.items.length === 0 ? (
              <p className="border-t border-hairline px-6 py-4 text-[12.5px] text-ink-3">No out-of-stock item has an exact (same strength and form) substitute in stock anywhere.</p>
            ) : (
              <ul className="divide-y divide-[var(--hairline)] border-t border-hairline">
                {oos.data.items.map((it) => <OosRow key={it.medicine.id} item={it} onOpen={setOpen} basis={oos.data?.weekly_demand_basis} />)}
              </ul>
            )}
            {oos.data.review_items.length > 0 && (
              <>
                <p className="flex items-center gap-1.5 border-t border-hairline bg-[var(--surface-2)] px-6 py-2 text-[12px] font-medium text-ink-2">
                  <Stethoscope className="h-3.5 w-3.5" aria-hidden />Only a different strength or form · pharmacist dose review · {oos.data.review_items.length}
                </p>
                <ul className="divide-y divide-[var(--hairline)] border-t border-hairline">
                  {oos.data.review_items.map((it) => <OosRow key={it.medicine.id} item={it} onOpen={setOpen} review basis={oos.data?.weekly_demand_basis} />)}
                </ul>
              </>
            )}
          </div>
        )}
      </Card>

      <section className="mt-10" aria-label="Molecule explorer">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow mb-1">Molecule explorer</p>
            <h2 className="text-[20px] font-semibold tracking-tight">Products by molecule</h2>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block">
              <span className="sr-only">Search molecule or product</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search molecule or brand…" maxLength={80}
                className="focus-ring h-10 w-full rounded-xl border border-hairline bg-surface pl-9 pr-3 text-[14px] placeholder:text-muted sm:w-64" />
            </label>
            <Segmented options={MODES} value={mode} onChange={setMode} />
          </div>
        </div>

        {cat.error ? (
          <ErrorState error={cat.error} />
        ) : !cat.data ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64" />)}</div>
        ) : groups.length === 0 ? (
          <div className="card rise flex flex-col items-center px-6 py-12 text-center">
            <Search className="h-8 w-8 text-ink-3" strokeWidth={1.6} aria-hidden />
            <p className="mt-3 text-[15px] font-semibold">{cat.loading ? "Searching…" : shownQ ? `No molecules match “${shownQ}”` : "No molecules to show"}</p>
            <p className="mt-1 text-[13px] text-ink-3">
              {mode === "With alternatives" ? "Only molecules with more than one product are shown. Try “All molecules”." : "Try a generic name such as paracetamol or a brand such as Dolo."}
            </p>
          </div>
        ) : (
          <>
            <div className={`grid gap-4 md:grid-cols-2 xl:grid-cols-3 transition-opacity ${cat.loading ? "opacity-60" : ""}`} aria-busy={cat.loading}>
              {groups.slice(0, limit).map((g, i) => <MoleculeCard key={g.key} g={g} onOpen={setOpen} delay={Math.min(i, 8) * 30} />)}
            </div>
            {groups.length > limit && (
              <div className="mt-5 flex justify-center">
                <button onClick={() => setLimit(limit + PAGE)}
                  className="focus-ring rounded-xl border border-hairline bg-surface px-4 py-2 text-[13px] font-medium text-ink-2 hover:bg-sunken hover:text-ink">
                  Show more <span className="tnum text-ink-3">({groups.length - limit} left)</span>
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <Card className="mt-10 p-6" delay={60}>
        <p className="eyebrow mb-3">How substitutes are decided</p>
        <ul className="grid gap-x-8 gap-y-3 text-[13px] leading-relaxed text-ink-2 md:grid-cols-2">
          <li><b className="font-semibold text-ink">Exact substitute.</b> Same molecule set, same strength (with an explicit unit) and same dosage form: an interchangeable brand or generic. Prescription rules still apply.</li>
          <li><b className="font-semibold text-ink">Same molecule, different strength or form.</b> A pharmacist must recalculate the dose; never swapped automatically. Liquids vs tablets and route changes are flagged as critical.</li>
          <li><b className="font-semibold text-ink">Combinations.</b> Compared as exact component sets: a combination is never a substitute for a single molecule.</li>
          <li><b className="font-semibold text-ink">Narrow therapeutic index.</b> Phenytoin, carbamazepine, valproate, digoxin, warfarin, levothyroxine, lithium, tacrolimus, cyclosporine, theophylline and similar: avoid brand switching without prescriber review.</li>
          <li><b className="font-semibold text-ink">Out of scope.</b> {cat.data?.therapeutic_alternatives.note ?? "Therapeutic alternatives (different molecules) are never suggested."}</li>
          <li><b className="font-semibold text-ink">Names.</b> Generic names are normalised conservatively (paracetamol = acetaminophen, aspirin = acetylsalicylic acid). Different salts are not merged.</li>
        </ul>
        {cat.data && (
          <ul className="mt-4 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-ink-3">
            {cat.data.assumptions.map((a) => <li key={a}>{a}</li>)}
          </ul>
        )}
      </Card>

      <SubstituteDrawer id={open} onClose={close} />
    </>
  );
}
