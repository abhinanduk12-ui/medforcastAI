"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowRight, Replace } from "lucide-react";
import { useApi } from "@/lib/api";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { CandidateRow, WarningList } from "./Comparison";
import { SubstituteDrawer } from "./SubstituteDrawer";
import type { SubstitutesResp } from "./model";

/**
 * Compact substitutes card for the medicine detail page: `<SubstitutesCard id="MED00283" />`.
 * Shows exact substitutes first, then same-molecule products (dose review), with safety notes.
 * Renders nothing if the substitutes API is unavailable (404), so it is safe to mount anywhere.
 */
export function SubstitutesCard({ id, delay = 0 }: { id: string; delay?: number }) {
  const { data: raw, error, status } = useApi<SubstitutesResp>(`/api/substitutes/${encodeURIComponent(id)}?qty=10`);
  // useApi keeps the previous payload while a new id loads: never show another medicine's substitutes.
  const data = raw && raw.medicine.id === id ? raw : null;
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);

  if (error && status === 404) return null;

  const total = data ? data.exact.length + data.same_molecule.length : 0;
  const list = data ? [...data.exact, ...data.same_molecule].slice(0, 3) : [];
  const warnings = data ? data.warnings.filter((w) => w.code !== "none" && w.code !== "same_molecule") : [];

  return (
    <Card className="pb-5" delay={delay}>
      <CardHeader
        title="Generic substitutes"
        sub={data ? (total === 0 ? "No other product with the same molecule set" :
          `${data.exact.length} exact · ${data.same_molecule.length} same molecule, different strength or form`) : "Same-molecule products in the catalogue"}
        right={total > 0 ? (
          <button onClick={() => setOpen(id)} aria-haspopup="dialog" className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-sunken hover:text-ink">
            Compare all <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : undefined}
      />
      <div className="mt-4 space-y-3 px-6">
        {error && !data ? (
          <p className="text-[13px] text-ink-3">Substitutes are unavailable right now ({error}).</p>
        ) : !data ? (
          <><Skeleton className="h-24" /><Skeleton className="h-24" /></>
        ) : total === 0 ? (
          <div className="flex items-start gap-3 rounded-xl bg-sunken px-4 py-3 text-[12.5px] text-ink-2">
            <Replace className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <span>No other product in this catalogue has the same molecule{data.medicine.molecule.is_combination ? " combination" : ""}.
              Therapeutic alternatives (different molecules) are a prescriber&apos;s decision and are not suggested.</span>
          </div>
        ) : (
          <>
            <WarningList warnings={warnings} />
            {list.map((c) => <CandidateRow key={c.id} c={c} origName={data.medicine.name} compact />)}
            {total > list.length && (
              <button onClick={() => setOpen(id)} aria-haspopup="dialog" className="focus-ring text-[12.5px] font-medium text-ink-2 underline-offset-2 hover:underline">
                {total - list.length} more in the comparison
              </button>
            )}
          </>
        )}
        <p className="text-[11.5px] text-ink-3">
          Savings shown for 10 units at median selling prices. <Link href="/substitutes" className="focus-ring rounded underline-offset-2 hover:underline">All substitutes</Link>
        </p>
      </div>
      <SubstituteDrawer id={open} onClose={close} />
    </Card>
  );
}

export default SubstitutesCard;
