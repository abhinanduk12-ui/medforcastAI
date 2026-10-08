import {
  Bell, BellRing, Boxes, BrainCircuit, CalendarDays, CalendarRange, DatabaseZap, FlaskConical, LayoutGrid, Network, Pill, Radar,
  Replace, ScanBarcode, ShieldCheck, ShoppingCart, Sparkles, Sunrise, Truck, Undo2, UsersRound, Wallet,
} from "lucide-react";
import type { Permission, Role } from "@/lib/auth";

/**
 * Sidebar / command-palette navigation.
 * Access control per item (optional; omitted = every signed-in role):
 *   roles: only these roles see the item and may open the route
 *   perm:  only users holding this permission (see GET /api/auth/permissions)
 * The Shell hides items via navFor() and blocks the page itself via routeAccess().
 */
export type NavItem = {
  href: string; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; badge?: string;
  roles?: Role[]; perm?: Permission;
};

export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Insights",
    items: [
      { href: "/", label: "Overview", icon: LayoutGrid },
      { href: "/brief", label: "Morning brief", icon: Sunrise },
      { href: "/alerts", label: "Alerts", icon: Bell },
      { href: "/seasons", label: "Seasonal impact", icon: CalendarRange },
      { href: "/medicines", label: "Medicines", icon: Pill },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/pos", label: "Point of sale", icon: ScanBarcode },
      { href: "/stock", label: "Stock & expiry", icon: Boxes },
      { href: "/substitutes", label: "Substitutes", icon: Replace },
      { href: "/stores", label: "Branches", icon: Network },
      { href: "/suppliers", label: "Suppliers", icon: Truck },
      { href: "/deadstock", label: "Slow stock & returns", icon: Undo2 },
      { href: "/patients", label: "Refill reminders", icon: BellRing },
      { href: "/compliance", label: "Compliance", icon: ShieldCheck },
    ],
  },
  {
    group: "Plan",
    items: [
      { href: "/planner", label: "Stock planner", icon: ShoppingCart },
      { href: "/purchase", label: "Purchase optimizer", icon: Wallet },
      { href: "/calendar", label: "Year planner", icon: CalendarDays },
      { href: "/simulator", label: "Scenario lab", icon: FlaskConical },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { href: "/copilot", label: "Copilot", icon: Sparkles, badge: "AI" },
      { href: "/signals", label: "Early warning", icon: Radar },
      { href: "/models", label: "Model lab", icon: BrainCircuit },
      { href: "/data", label: "Data & models", icon: DatabaseZap },
    ],
  },
  {
    group: "Admin",
    items: [
      { href: "/admin/users", label: "Users", icon: UsersRound, roles: ["owner"], perm: "users.admin" },
    ],
  },
];

type Who = { role: Role; permissions: Permission[] } | null | undefined;

/** Whether `who` may see/open a nav item. Unknown user (still loading) only sees unrestricted items. */
export function allowed(item: Pick<NavItem, "roles" | "perm">, who: Who): boolean {
  if (!item.roles && !item.perm) return true;
  if (!who) return false;
  if (item.roles && !item.roles.includes(who.role)) return false;
  if (item.perm && !who.permissions.includes(item.perm)) return false;
  return true;
}

/** NAV filtered for a user; groups left empty are dropped. */
export function navFor(who: Who) {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, who)) })).filter((g) => g.items.length > 0);
}

/** The most specific restricted nav item covering `path`, if any (used to gate pages). */
export function routeAccess(path: string): NavItem | undefined {
  return NAV.flatMap((g) => g.items)
    .filter((i) => (i.roles || i.perm) && i.href !== "/" && (path === i.href || path.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
