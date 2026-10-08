"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Search, X } from "lucide-react";
import { SeasonChip } from "./ui";
import { navFor, routeAccess } from "./nav";
import CommandPalette from "./CommandPalette";
import { AlertBell } from "./alerts/AlertBell";
import { InstallButton, OfflineBadge } from "./pwa";
import { DevAuthBadge, UserMenu } from "./auth/UserMenu";
import { StoreSwitcher } from "./auth/StoreSwitcher";
import { NoAccess } from "./auth/NoAccess";
import { useMe } from "@/lib/auth";
import { redirectToLogin } from "@/lib/api";

const MONTH_SEASON = ["Winter", "Winter", "Summer", "Summer", "Summer", "Monsoon", "Monsoon", "Monsoon", "Monsoon", "Post-Monsoon", "Post-Monsoon", "Winter"];

/** Routes rendered full-screen, without the app chrome or the sign-in gate. */
const BARE_ROUTES = ["/login"];

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 focus-ring rounded-lg">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white shadow-[0_6px_16px_-6px_rgba(14,92,79,0.6)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 17l5-5 4 3 7-8" />
          <path d="M15 7h4v4" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight">MedForecast</span>
        <span className="block text-[11px] text-ink-3">Seasonal demand AI</span>
      </span>
    </Link>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const bare = BARE_ROUTES.some((r) => path === r || path.startsWith(r + "/"));
  if (bare) return <>{children}</>;
  return <AppShell path={path}>{children}</AppShell>;
}

function AppShell({ path, children }: { path: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { me, loading, status } = useMe();
  // "Now" is read in the browser after mount. Pages are pre-rendered at build time, so computing it
  // during render would make the server HTML disagree with the client (React hydration error #418).
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const season = now ? MONTH_SEASON[now.getMonth()] : null;
  const today = now ? now.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" }) : "";

  // Signed out (only possible while the server enforces auth): go to the login page.
  useEffect(() => { if (!loading && status === 401) redirectToLogin(); }, [loading, status]);

  const restricted = routeAccess(path);
  // Fail closed: if /me failed for any reason other than 401 (which redirects), a restricted page is blocked too.
  const blocked = !!restricted && (me
    ? (!!restricted.roles && !restricted.roles.includes(me.role)) || (!!restricted.perm && !me.permissions.includes(restricted.perm))
    : !loading && status !== 401);
  const waitingForGate = !!restricted && !me && !blocked; // don't flash restricted content before we know the role

  const nav = (
    <nav className="mt-6 flex flex-col gap-5">
      {navFor(me).map(({ group, items }) => (
        <div key={group}>
          <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">{group}</p>
          <div className="flex flex-col gap-0.5">
            {items.map(({ href, label, icon: Icon, badge }) => {
              const active = href === "/" ? path === "/" : path.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={`focus-ring group flex items-center gap-3 rounded-xl px-3 py-2 text-[14px] transition-colors ${
                    active ? "bg-ink text-white shadow-sm" : "text-ink-2 hover:bg-sunken"
                  }`}
                >
                  <Icon className={`h-[18px] w-[18px] ${active ? "text-white" : "text-ink-3 group-hover:text-ink"}`} strokeWidth={1.8} />
                  {label}
                  {badge && (
                    <span className={`ml-auto rounded-md px-1.5 py-px text-[10px] font-semibold tracking-wide ${active ? "bg-white/15 text-white" : "bg-brand-wash text-brand-ink"}`}>{badge}</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );

  const searchButton = (
    <button
      onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
      className="focus-ring mt-6 flex w-full items-center gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2 text-[13px] text-ink-3 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:text-ink"
    >
      <Search className="h-4 w-4" />
      Search or ask…
      <kbd className="ml-auto rounded-md border border-hairline px-1.5 font-mono text-[10.5px]">Ctrl K</kbd>
    </button>
  );

  return (
    <div className="min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-hairline bg-surface-2/80 px-5 py-6 backdrop-blur lg:flex">
        <Logo />
        {searchButton}
        <div className="-mr-2 flex-1 overflow-y-auto pr-2">{nav}</div>
        <div className="mt-4">
          <StoreSwitcher variant="panel" />
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[272px] flex-col bg-surface px-5 py-6 shadow-xl">
            <div className="flex items-center justify-between">
              <Logo />
              <button aria-label="Close menu" onClick={() => setOpen(false)} className="focus-ring rounded-lg p-1.5">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="-mr-2 flex-1 overflow-y-auto pr-2">{nav}</div>
            <div className="mt-4"><StoreSwitcher variant="panel" /></div>
          </aside>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-hairline bg-page/80 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-3 px-4 sm:px-8">
            <button aria-label="Open menu" onClick={() => setOpen(true)} className="focus-ring -ml-1 rounded-lg p-1.5 lg:hidden">
              <Menu className="h-5 w-5" />
            </button>
            <p className="hidden text-[13px] text-ink-3 xl:block">{today}</p>
            <div className="hidden sm:block lg:hidden xl:block"><DevAuthBadge me={me} /></div>
            <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
              <div className="hidden sm:block"><StoreSwitcher variant="compact" /></div>
              <button aria-label="Search" onClick={() => window.dispatchEvent(new Event("open-command-palette"))} className="focus-ring rounded-lg p-1.5 text-ink-2 hover:bg-sunken lg:hidden">
                <Search className="h-5 w-5" />
              </button>
              <OfflineBadge />
              <div className="hidden md:block"><InstallButton /></div>
              <AlertBell />
              <span className="hidden text-[12px] text-ink-3 2xl:inline">Current season</span>
              {season && <span className="hidden md:inline-flex"><SeasonChip season={season} /></span>}
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1320px] px-4 pb-20 pt-8 sm:px-8">
          {blocked ? <NoAccess need={me && restricted?.roles ? `the ${restricted.roles.join(" or ")} role` : undefined} />
            : waitingForGate ? <div className="space-y-4"><div className="skeleton h-10 w-72" /><div className="skeleton h-[320px]" /></div>
            : children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
