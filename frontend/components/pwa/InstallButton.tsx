"use client";

import { useState } from "react";
import { Download, PlusSquare, Share } from "lucide-react";
import { Modal, ghostBtn } from "@/components/auth/Modal";
import { usePwa } from "./PwaProvider";

/**
 * "Install app" button. Uses the browser install prompt where available; on iOS Safari
 * (no prompt API) it opens short "Add to Home Screen" instructions. Renders nothing once installed
 * or when the browser offers no install path.
 */
export default function InstallButton({ className = ghostBtn, label = "Install app" }: { className?: string; label?: string }) {
  const { canInstall, installed, isIos, promptInstall } = usePwa();
  const [help, setHelp] = useState(false);
  if (installed || (!canInstall && !isIos)) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => { if (canInstall) void promptInstall(); else setHelp(true); }}
        title="Install MedForecast as an app"
      >
        <Download className="h-4 w-4" aria-hidden />
        {label}
      </button>
      <Modal open={help} onClose={() => setHelp(false)} title="Install on iPhone or iPad" sub="Safari adds MedForecast to your Home Screen.">
        <ol className="flex flex-col gap-3 text-[14px] text-ink-2">
          <li className="flex items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-wash text-brand"><Share className="h-4 w-4" aria-hidden /></span>
            Tap <strong className="font-semibold text-ink">Share</strong> in Safari&apos;s toolbar.
          </li>
          <li className="flex items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-wash text-brand"><PlusSquare className="h-4 w-4" aria-hidden /></span>
            Choose <strong className="font-semibold text-ink">Add to Home Screen</strong>, then <strong className="font-semibold text-ink">Add</strong>.
          </li>
        </ol>
        <div className="mt-6 flex justify-end">
          <button type="button" className={ghostBtn} onClick={() => setHelp(false)}>Done</button>
        </div>
      </Modal>
    </>
  );
}
