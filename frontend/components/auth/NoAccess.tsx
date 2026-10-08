"use client";

import Link from "next/link";
import { Lock } from "lucide-react";

/** Shown in place of a page the current role may not open. */
export function NoAccess({ what = "this page", need }: { what?: string; need?: string }) {
  return (
    <div className="card rise mx-auto mt-10 flex max-w-lg flex-col items-center px-6 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-sunken text-ink-2"><Lock className="h-5 w-5" strokeWidth={1.8} aria-hidden /></span>
      <p className="mt-4 text-[16px] font-semibold">You don&apos;t have access to {what}</p>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-3">
        {need ? `It needs ${need}. ` : ""}Ask the owner if you think your role should include it.
      </p>
      <Link href="/" className="focus-ring mt-5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-[#262624]">Back to overview</Link>
    </div>
  );
}
