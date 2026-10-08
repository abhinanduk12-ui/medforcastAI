"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, FlaskConical, LogIn, LogOut, ShieldCheck, Store as StoreIcon, UsersRound } from "lucide-react";
import { can, initials, logout, useMe, type Me } from "@/lib/auth";
import { clearOfflineCache } from "@/components/pwa";

export function Avatar({ name, size = 32, tone = "ink" }: { name: string; size?: number; tone?: "ink" | "brand" | "soft" }) {
  const cls = tone === "brand" ? "bg-brand text-white" : tone === "soft" ? "bg-sunken text-ink-2" : "bg-ink text-white";
  return (
    <span aria-hidden className={`inline-grid shrink-0 place-items-center rounded-full font-semibold tracking-wide ${cls}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {initials(name)}
    </span>
  );
}

/** Subtle pill shown whenever the server does not enforce sign-in (MEDFORECAST_AUTH=0). */
export function DevAuthBadge({ me }: { me: Me | null }) {
  if (!me || me.auth_enabled) return null;
  return (
    <span title="The API runs with MEDFORECAST_AUTH=0: every request is allowed without signing in. Do not use in production."
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--hairline-strong)] bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-3">
      <FlaskConical className="h-3 w-3" strokeWidth={2} aria-hidden />
      Auth disabled (dev)
    </span>
  );
}

export function UserMenu() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!me) return <span className="skeleton h-8 w-8 rounded-full" aria-hidden />;
  const name = me.user.full_name || me.user.username;
  const storeLabel = me.all_stores ? "All stores" : me.stores[0]?.name ?? me.user.store_id ?? "";

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu for ${name}`}
        className="focus-ring flex items-center gap-2 rounded-full p-0.5 pr-1.5 transition hover:bg-sunken">
        <Avatar name={me.dev ? "Dev" : name} tone={me.dev ? "soft" : "ink"} />
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[140px] truncate text-[13px] font-medium">{me.dev ? "Developer" : name}</span>
          <span className="block text-[11px] text-ink-3">{me.role_label}</span>
        </span>
        <ChevronDown className="hidden h-3.5 w-3.5 text-ink-3 md:block" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="rise absolute right-0 top-[calc(100%+8px)] z-50 w-[260px] overflow-hidden rounded-2xl border border-hairline bg-surface shadow-[0_18px_40px_-16px_rgba(11,11,11,0.25)]">
          <div className="flex items-center gap-3 border-b border-hairline p-4">
            <Avatar name={me.dev ? "Dev" : name} size={40} tone={me.dev ? "soft" : "brand"} />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold">{me.dev ? "Developer (no sign-in)" : name}</p>
              <p className={`text-[12px] text-ink-3 ${me.dev ? "leading-snug" : "truncate"}`}>{me.dev ? "Synthetic owner while auth is off" : `@${me.user.username}`}</p>
            </div>
          </div>
          <div className="space-y-1.5 px-4 py-3 text-[12px] text-ink-2">
            <p className="flex items-center gap-2"><ShieldCheck className="h-3.5 w-3.5 text-ink-3" aria-hidden />Role: <b className="font-medium text-ink">{me.role_label}</b></p>
            <p className="flex items-center gap-2"><StoreIcon className="h-3.5 w-3.5 text-ink-3" aria-hidden />Access: <b className="font-medium text-ink">{storeLabel}</b></p>
            {!me.auth_enabled && <div className="pt-1"><DevAuthBadge me={me} /></div>}
          </div>
          <div className="border-t border-hairline p-1.5">
            {can(me, "users.admin") && (
              <Link href="/admin/users" role="menuitem" onClick={() => setOpen(false)}
                className="focus-ring flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] text-ink-2 hover:bg-sunken hover:text-ink">
                <UsersRound className="h-4 w-4" aria-hidden />Users & access
              </Link>
            )}
            {me.dev ? (
              <Link href="/login" role="menuitem" onClick={() => setOpen(false)}
                className="focus-ring flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] text-ink-2 hover:bg-sunken hover:text-ink">
                <LogIn className="h-4 w-4" aria-hidden />Sign in as a demo user
              </Link>
            ) : (
              <button role="menuitem" onClick={async () => { setOpen(false); await clearOfflineCache().catch(() => {}); void logout(); }}
                className="focus-ring flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-sunken hover:text-ink">
                <LogOut className="h-4 w-4" aria-hidden />Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
