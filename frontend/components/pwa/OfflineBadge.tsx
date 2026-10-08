"use client";

import Link from "next/link";
import { WifiOff } from "lucide-react";
import { usePwa } from "./PwaProvider";

/** Header pill shown only while offline. Icon + label (never colour alone). */
export default function OfflineBadge({ className = "" }: { className?: string }) {
  const { online, swActive } = usePwa();
  // A persistent live region (always mounted) so screen readers announce the change; the link
  // inside keeps its link role.
  return (
    <span role="status" aria-live="polite" className="contents">
      {!online && (
        <Link
          href="/offline"
          title={swActive ? "Offline: showing data cached on this device" : "Offline: nothing is cached on this device yet"}
          className={`focus-ring inline-flex items-center gap-1.5 rounded-full border border-[#e8d3a8] bg-[#fbf3e2] px-2.5 py-1 text-[12px] font-medium text-[#7a4b00] ${className}`}
        >
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          Offline
        </Link>
      )}
    </span>
  );
}
