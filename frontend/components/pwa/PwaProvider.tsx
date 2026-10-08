"use client";

/**
 * PwaProvider — registers /sw.js (production only), tracks online status, the install prompt
 * and waiting updates, and keeps the service worker's per-user API cache key in sync.
 *
 *   <PwaProvider>{children}</PwaProvider>      // mounted once in app/layout.tsx
 *   const { online, canInstall, updateAvailable, applyUpdate, promptInstall } = usePwa();
 *   await clearOfflineCache();                 // call from logout (see useLogoutCleanup)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";
import { useMe } from "@/lib/auth";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export type PwaState = {
  /** navigator.onLine, kept live */
  online: boolean;
  /** a service worker is controlling this page (offline caching active) */
  swActive: boolean;
  /** the browser offered an install prompt (Chromium/Android/desktop) */
  canInstall: boolean;
  /** running as an installed app */
  installed: boolean;
  /** iOS Safari — no prompt API; show "Share → Add to Home Screen" instructions */
  isIos: boolean;
  updateAvailable: boolean;
  promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
  applyUpdate: () => void;
  dismissUpdate: () => void;
};

const noop = () => {};
const PwaContext = createContext<PwaState>({
  online: true, swActive: false, canInstall: false, installed: false, isIos: false, updateAvailable: false,
  promptInstall: async () => "unavailable", applyUpdate: noop, dismissUpdate: noop,
});

export const usePwa = () => useContext(PwaContext);

const SW_ENABLED = process.env.NODE_ENV === "production";

function postToSw(message: unknown) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.controller?.postMessage(message);
  // also reach a worker that is installed but not yet controlling this tab
  navigator.serviceWorker.getRegistration().then((r) => r?.active?.postMessage(message)).catch(() => {});
}

/**
 * Delete every cached API response on this device (call on logout, before redirecting).
 * Safe to call when no service worker exists. Resolves within ~1.5 s even if the SW is busy.
 */
export async function clearOfflineCache(): Promise<void> {
  if (typeof window === "undefined") return;
  postToSw({ type: "LOGOUT" });
  // Belt and braces: the page can delete Cache Storage entries itself too.
  try {
    if ("caches" in window) {
      const names = await Promise.race([caches.keys(), new Promise<string[]>((r) => setTimeout(() => r([]), 1500))]);
      await Promise.all(names.filter((n) => n.startsWith("mf-api-")).map((n) => caches.delete(n)));
    }
  } catch { /* storage blocked: nothing cached either */ }
}

/** Hook form for the user menu: `const onLogoutCleanup = useLogoutCleanup(); await onLogoutCleanup(); await logout();` */
export function useLogoutCleanup() {
  return useCallback(() => clearOfflineCache(), []);
}

export default function PwaProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  const [swActive, setSwActive] = useState(false);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const reloading = useRef(false);
  const { me } = useMe();

  // online / install environment
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(!!standalone);
    const ua = navigator.userAgent;
    setIsIos(/iphone|ipad|ipod/i.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1));
    const bip = (e: Event) => { e.preventDefault(); setInstallEvt(e as BeforeInstallPromptEvent); };
    const done = () => { setInstalled(true); setInstallEvt(null); };
    window.addEventListener("beforeinstallprompt", bip);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("beforeinstallprompt", bip);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  // service worker registration + update detection
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!SW_ENABLED) {
      // dev: make sure an old production worker doesn't serve stale bundles
      navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
      return;
    }
    // Known immediately when a worker already controls the page (also offline, where register()
    // may be slow to settle), so the UI does not claim "nothing is cached" for a moment.
    setSwActive(!!navigator.serviceWorker.controller);
    let reg: ServiceWorkerRegistration | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const track = (r: ServiceWorkerRegistration) => {
      if (r.waiting && navigator.serviceWorker.controller) setWaiting(r.waiting);
      r.addEventListener("updatefound", () => {
        const nw = r.installing;
        nw?.addEventListener("statechange", () => {
          // only an *update* when a previous worker already controls the page
          if (nw.state === "installed" && navigator.serviceWorker.controller) { setWaiting(nw); setDismissed(false); }
        });
      });
    };
    const onControllerChange = () => {
      setSwActive(true);
      if (reloading.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((r) => {
      reg = r;
      setSwActive(!!navigator.serviceWorker.controller);
      track(r);
      timer = setInterval(() => { r.update().catch(() => {}); }, 30 * 60 * 1000);
    }).catch(() => { /* unsupported / blocked: the app works without it */ });
    const onVisible = () => { if (document.visibilityState === "visible") reg?.update().catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearInterval(timer);
    };
  }, []);

  // per-user + per-store API cache isolation
  // Post only once the user is KNOWN. `me` is null while /api/auth/me is still loading on every page
  // load, and posting an empty key then would wipe the offline cache before it could be used.
  // Sign-out is handled by the SW itself (401s, the logout/login POSTs) and by clearOfflineCache().
  // Keyed on the `me` object (new after every login / store switch / refresh) rather than the key
  // string, because the SW drops its key on those POSTs and must be re-armed even if it is unchanged.
  useEffect(() => {
    if (!SW_ENABLED || !me) return;
    postToSw({ type: "SET_USER", key: `${me.user.id}:${me.selected_store ?? "none"}` });
  }, [me, swActive]);

  const promptInstall = useCallback(async () => {
    if (!installEvt) return "unavailable" as const;
    // A deferred prompt can be used once; a second call (double click) throws InvalidStateError.
    const evt = installEvt;
    setInstallEvt(null);
    try {
      await evt.prompt();
      const choice = await evt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      return choice.outcome;
    } catch {
      return "unavailable" as const;
    }
  }, [installEvt]);

  const applyUpdate = useCallback(() => {
    if (!waiting) { window.location.reload(); return; }
    reloading.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    // fallback if controllerchange never fires
    setTimeout(() => { if (reloading.current) window.location.reload(); }, 4000);
  }, [waiting]);

  const value = useMemo<PwaState>(() => ({
    online, swActive, canInstall: !!installEvt && !installed, installed, isIos,
    updateAvailable: !!waiting, promptInstall, applyUpdate, dismissUpdate: () => setDismissed(true),
  }), [online, swActive, installEvt, installed, isIos, waiting, promptInstall, applyUpdate]);

  return (
    <PwaContext.Provider value={value}>
      {children}
      {waiting && !dismissed && <UpdateToast onReload={applyUpdate} onDismiss={() => setDismissed(true)} />}
    </PwaContext.Provider>
  );
}

function UpdateToast({ onReload, onDismiss }: { onReload: () => void; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rise fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-[20px] border border-hairline bg-surface px-4 py-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.25)] sm:left-auto sm:right-6 sm:mx-0"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-wash text-brand">
        <RefreshCw className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">Update available</p>
        <p className="text-[12.5px] text-ink-3">A new version of MedForecast is ready.</p>
      </div>
      <button type="button" onClick={onReload} className="focus-ring rounded-xl bg-ink px-3.5 py-2 text-[13px] font-medium text-white hover:bg-[#262624]">
        Reload
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss update notice" className="focus-ring rounded-lg p-1.5 text-ink-3 hover:bg-sunken hover:text-ink">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
