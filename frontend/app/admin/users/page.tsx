"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Circle, KeyRound, Minus, Check, Plus, Power, ShieldCheck, UserX } from "lucide-react";
import { apiSend, useApi, type ApiError } from "@/lib/api";
import { useMe, type Role, type StoreInfo } from "@/lib/auth";
import { Card, CardHeader, ErrorState, PageHeader, PageSkeleton, StatTile } from "@/components/ui";
import { Avatar } from "@/components/auth/UserMenu";
import { NoAccess } from "@/components/auth/NoAccess";
import { primaryBtn } from "@/components/auth/Modal";
import { ConfirmDialog, CreateUserDialog, ResetPasswordDialog, type AdminUser } from "@/components/auth/UserDialogs";

type UsersResp = { users: AdminUser[]; stores: StoreInfo[]; roles: { id: Role; label: string; description: string }[] };
type Matrix = {
  roles: Record<Role, { label: string; description: string; permissions: string[]; all_stores: boolean }>;
  matrix: ({ permission: string; description: string } & Record<Role, boolean>)[];
  limits: { pharmacist_adjust_max: number; session_hours: number; login_max_failures: number; login_window_seconds: number };
};

const ROLE_ORDER: Role[] = ["owner", "buyer", "pharmacist"];
const selCls = "focus-ring h-9 w-full min-w-[128px] rounded-lg border border-hairline bg-surface px-2.5 text-[13px] disabled:bg-sunken disabled:text-ink-3";

function ago(iso: string | null): string {
  if (!iso) return "Never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function UsersAdminPage() {
  const { me, can, loading: meLoading } = useMe();
  const allowed = can("users.admin");
  const { data, error, setData } = useApi<UsersResp>(allowed ? "/api/auth/users" : null, { refetchOnStoreChange: false });
  const { data: matrix } = useApi<Matrix>(allowed ? "/api/auth/permissions" : null, { refetchOnStoreChange: false });
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [toggling, setToggling] = useState<AdminUser | null>(null);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState<{ id: number; msg: string } | null>(null);

  const stats = useMemo(() => {
    const u = data?.users ?? [];
    const act = u.filter((x) => x.active);
    return {
      active: act.length, inactive: u.length - act.length,
      byRole: Object.fromEntries(ROLE_ORDER.map((r) => [r, act.filter((x) => x.role === r).length])) as Record<Role, number>,
      online: act.filter((x) => x.sessions > 0).length,
    };
  }, [data]);

  if (meLoading) return <PageSkeleton />;
  if (!allowed) return <NoAccess what="user administration" need="the owner role" />;
  if (error) return <ErrorState error={error} />;
  if (!data) return <PageSkeleton />;

  const storeName = (id: string | null) => (id ? data.stores.find((s) => s.id === id)?.name ?? id : "All stores");
  const replace = (u: AdminUser) => setData({ ...data, users: data.users.map((x) => (x.id === u.id ? u : x)) });

  const patch = async (u: AdminUser, body: Partial<Pick<AdminUser, "role" | "store_id" | "active">>) => {
    setRowBusy(u.id);
    setRowErr(null);
    try {
      replace(await apiSend<AdminUser>("PATCH", `/api/auth/users/${u.id}`, body));
    } catch (e) {
      setRowErr({ id: u.id, msg: (e as ApiError).message });
      throw e;
    } finally {
      setRowBusy(null);
    }
  };

  const changeRole = (u: AdminUser, role: Role) => {
    const store_id = role === "owner" ? null : role === "pharmacist" ? u.store_id ?? data.stores[0]?.id ?? null : u.store_id;
    void patch(u, { role, store_id }).catch(() => {});
  };

  const myId = me?.user.id ?? null;

  return (
    <>
      <PageHeader eyebrow="Admin" title="Users & access"
        actions={<button onClick={() => setCreating(true)} className={primaryBtn}><Plus className="h-4 w-4" aria-hidden />New user</button>}>
        Create accounts, set each person&apos;s role and store, and reset passwords. Changes apply on the user&apos;s next click;
        resetting a password or deactivating an account signs them out everywhere.
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="Active users" value={String(stats.active)} hint={stats.inactive ? `${stats.inactive} deactivated` : "None deactivated"} />
        <StatTile label="Pharmacists" value={String(stats.byRole.pharmacist)} hint="Single-store access" />
        <StatTile label="Buyers & owners" value={String(stats.byRole.buyer + stats.byRole.owner)} hint={`${stats.byRole.owner} owner${stats.byRole.owner === 1 ? "" : "s"}`} />
        <StatTile label="Signed in now" value={String(stats.online)} hint="Users with a live session" />
      </div>

      <Card className="mt-6 overflow-hidden" delay={80}>
        <CardHeader title="Team" sub={`${data.users.length} account${data.users.length === 1 ? "" : "s"} · passwords are stored as salted hashes and can't be viewed, only reset`} />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead>
              <tr className="border-y border-hairline bg-surface-2 text-left text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
                <th className="px-6 py-2.5 font-medium">User</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Store access</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Last sign-in</th>
                <th className="px-6 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => {
                const self = u.id === myId;
                const busy = rowBusy === u.id;
                return (
                  <tr key={u.id} className={`border-b border-hairline last:border-0 ${u.active ? "" : "bg-surface-2 text-ink-3"} ${busy ? "opacity-60" : ""}`}>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.full_name || u.username} size={34} tone={u.active ? (u.role === "owner" ? "brand" : "ink") : "soft"} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                            {u.full_name || u.username}
                            {self && <span className="rounded-md bg-brand-wash px-1.5 py-px text-[10.5px] font-semibold text-brand-ink">You</span>}
                          </p>
                          <p className="truncate text-[12px] text-ink-3">@{u.username}</p>
                        </div>
                      </div>
                      {rowErr?.id === u.id && <p role="alert" className="mt-1.5 text-[12px] text-critical">{rowErr.msg}</p>}
                    </td>
                    <td className="px-3 py-3">
                      <select aria-label={`Role for ${u.username}`} value={u.role} disabled={busy || self} className={selCls}
                        onChange={(e) => changeRole(u, e.target.value as Role)} title={self ? "You can't change your own role" : undefined}>
                        {ROLE_ORDER.map((r) => <option key={r} value={r}>{data.roles.find((x) => x.id === r)?.label ?? r}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      <select aria-label={`Store access for ${u.username}`} value={u.store_id ?? ""} disabled={busy || u.role === "owner"} className={selCls}
                        onChange={(e) => void patch(u, { store_id: e.target.value || null }).catch(() => {})}>
                        {u.role !== "pharmacist" && <option value="">All stores</option>}
                        {data.stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.simulated ? " (sim.)" : ""}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      {u.active ? (
                        <span className="inline-flex items-center gap-1.5 text-ink-2">
                          {u.sessions > 0 ? <CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> : <Circle className="h-4 w-4 text-ink-3" aria-hidden />}
                          {u.sessions > 0 ? "Active · signed in" : "Active"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5"><UserX className="h-4 w-4" aria-hidden />Deactivated</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-ink-2 tnum" title={u.last_login ?? undefined}>{ago(u.last_login)}</td>
                    <td className="px-6 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button onClick={() => setResetting(u)} disabled={busy} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-sunken hover:text-ink disabled:opacity-50">
                          <KeyRound className="h-3.5 w-3.5" aria-hidden />Reset password
                        </button>
                        <button onClick={() => setToggling(u)} disabled={busy || self} title={self ? "You can't deactivate yourself" : undefined}
                          className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-sunken hover:text-ink disabled:opacity-40">
                          <Power className="h-3.5 w-3.5" aria-hidden />{u.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {matrix && (
        <Card className="mt-6 overflow-hidden" delay={140}>
          <CardHeader title="What each role can do" sub={`Pharmacist stock corrections are capped at ±${matrix.limits.pharmacist_adjust_max} units per batch. Sessions last ${matrix.limits.session_hours} h of activity; ${matrix.limits.login_max_failures} failed sign-ins lock that username for ${Math.round(matrix.limits.login_window_seconds / 60)} min.`} />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-y border-hairline bg-surface-2 text-left text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
                  <th className="px-6 py-2.5 font-medium">Permission</th>
                  {ROLE_ORDER.map((r) => <th key={r} className="w-[120px] px-3 py-2.5 text-center font-medium">{matrix.roles[r].label}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.matrix.map((row) => (
                  <tr key={row.permission} className="border-b border-hairline last:border-0">
                    <td className="px-6 py-2.5">
                      <p className="text-ink">{row.description}</p>
                      <p className="font-mono text-[11px] text-ink-3">{row.permission}</p>
                    </td>
                    {ROLE_ORDER.map((r) => (
                      <td key={r} className="relative px-3 py-2.5 text-center">
                        {row[r]
                          ? <span className="inline-grid h-6 w-6 place-items-center rounded-full bg-brand-wash text-brand-ink"><Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden /><span className="sr-only">Allowed</span></span>
                          : <span className="inline-grid h-6 w-6 place-items-center text-muted"><Minus className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">Not allowed</span></span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex items-start gap-2 border-t border-hairline px-6 py-4 text-[12px] leading-relaxed text-ink-3">
            <ShieldCheck className="mt-px h-4 w-4 shrink-0" aria-hidden />
            Pharmacists only ever see and act on their own store. Branch stores other than Kochi are simulated from the Kochi shop&apos;s data.
          </p>
        </Card>
      )}

      <CreateUserDialog open={creating} onClose={() => setCreating(false)} stores={data.stores}
        onCreated={(u) => setData({ ...data, users: [...data.users, u] })} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onDone={replace} />
      <ConfirmDialog open={!!toggling} onClose={() => setToggling(null)}
        title={toggling?.active ? `Deactivate ${toggling?.full_name || toggling?.username}?` : `Reactivate ${toggling?.full_name || toggling?.username}?`}
        body={toggling?.active
          ? <>They are signed out at once and can&apos;t sign in until reactivated. Their past stock movements stay on record. Store access stays {storeName(toggling.store_id)}.</>
          : <>They can sign in again with their existing password.</>}
        confirm={toggling?.active ? "Deactivate" : "Reactivate"} danger={!!toggling?.active}
        onConfirm={async () => { if (toggling) await patch(toggling, { active: !toggling.active }); }} />
    </>
  );
}
