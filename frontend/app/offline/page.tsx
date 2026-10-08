"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CloudOff, Pill, RefreshCw, ShoppingCart, Wifi, WifiOff, XCircle } from "lucide-react";
import { usePwa } from "@/components/pwa/PwaProvider";
import InstallButton from "@/components/pwa/InstallButton";

const WORKS = [
  { icon: Pill, title: "Medicine lookup", body: "Names, generics and prices you opened recently stay available from this device's cache (up to 24 hours old)." },
  { icon: ShoppingCart, title: "POS offline queue", body: "Where the POS screen supports it, bills are queued on this device and sent when you reconnect. Check the queue before closing the app." },
  { icon: CheckCircle2, title: "Pages you visited", body: "Recently opened screens reopen. Overview, medicine and stock figures show the last copy saved on this device; other panels need the connection." },
];
const PAUSED = [
  "Receiving stock, adjustments, transfers and write-offs (these always need the server)",
  "Fresh forecasts, alerts, Copilot answers and the morning brief",
  "Signing in or switching stores",
];

export default function OfflinePage() {
  const pwa = usePwa();
  // navigator.onLine is only known after mount: until then assume offline (this page is usually
  // reached because the network failed) instead of flashing "You're connected again".
  const [mounted, setMounted] = useState(false);
  const [atOffline, setAtOffline] = useState(true);
  useEffect(() => {
    setMounted(true);
    // The service worker serves this screen in place of pages it could not load, so the address
    // bar may still show that page: offer to reload it rather than only "Go to overview".
    setAtOffline(window.location.pathname === "/offline");
  }, []);
  const online = mounted && pwa.online;
  const swActive = !mounted || pwa.swActive;
  return (
    <div className="mx-auto max-w-3xl py-6">
      <section className="card rise overflow-hidden">
        <div className="flex flex-col items-start gap-5 px-6 pb-6 pt-7 sm:flex-row sm:items-center sm:px-8">
          <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-[18px] ${online ? "bg-brand-wash text-brand" : "bg-[#fbf3e2] text-[#7a4b00]"}`}>
            {online ? <Wifi className="h-6 w-6" aria-hidden /> : <CloudOff className="h-6 w-6" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1" role="status" aria-live="polite">
            <p className="eyebrow mb-1.5">{online ? "Back online" : "No connection"}</p>
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[30px]">
              {online ? "You're connected again" : "You're offline"}
            </h1>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
              {online
                ? (atOffline ? "Everything is available again. Head back to where you were." : "Everything is available again. Reload to open the page you asked for.")
                : "MedForecast can't reach the server right now. Some things still work from data saved on this device."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {online ? (
              atOffline ? (
                <Link href="/" className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-[#262624]">
                  Go to overview
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-[#262624]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden /> Reload this page
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="focus-ring inline-flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-[13px] font-medium text-white hover:bg-[#262624]"
              >
                <RefreshCw className="h-4 w-4" aria-hidden /> Try again
              </button>
            )}
          </div>
        </div>

        <div className="border-t border-hairline px-6 py-6 sm:px-8">
          <h2 className="text-[15px] font-semibold tracking-tight">What still works offline</h2>
          {!swActive && (
            <p className="mt-1 text-[13px] text-ink-3">
              Offline caching isn&apos;t active in this browser session yet, so only what&apos;s already on screen is available.
            </p>
          )}
          <ul className="mt-4 grid gap-3 sm:grid-cols-3">
            {WORKS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="rise rounded-2xl border border-hairline bg-surface-2 p-4" style={{ animationDelay: `${60 + i * 50}ms` }}>
                <Icon className="h-5 w-5 text-brand" aria-hidden />
                <p className="mt-3 text-[14px] font-semibold">{title}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-hairline px-6 py-6 sm:px-8">
          <h2 className="text-[15px] font-semibold tracking-tight">Paused until you reconnect</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {PAUSED.map((t) => (
              <li key={t} className="flex items-start gap-2.5 text-[13.5px] text-ink-2">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <span><span className="sr-only">Unavailable: </span>{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-3 border-t border-hairline bg-surface-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <WifiOff className="h-3.5 w-3.5" aria-hidden />
            Cached data is cleared when you sign out and is never shared between users.
          </p>
          <InstallButton />
        </div>
      </section>
    </div>
  );
}
