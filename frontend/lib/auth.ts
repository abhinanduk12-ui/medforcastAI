"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ApiError, apiFetch, apiPost, STORE_CHANGED_EVENT } from "./api";

/**
 * Client-side auth state. One shared /api/auth/me request feeds every component.
 *
 *   const { me, loading, can, store } = useMe();
 *   if (can("sales.record")) ...
 *   await switchStore("TSR");     // updates the session, then every useApi hook refetches
 *   await logout();
 *
 * With auth disabled on the server (MEDFORECAST_AUTH=0) `me.dev` is true (a synthetic owner) unless
 * someone signed in, and `me.auth_enabled` is false. Nothing redirects in that mode.
 */

export type Role = "owner" | "pharmacist" | "buyer";
export type Permission =
  | "view" | "stores.all" | "stock.receive" | "stock.adjust" | "stock.adjust.large" | "stock.writeoff"
  | "sales.record" | "transfers.request" | "transfers.create" | "purchase.plan" | "settings.edit" | "users.admin";

export type StoreInfo = { id: string; name: string; city: string; demand_scale: number; is_main: boolean; simulated: boolean };
export type User = {
  id: number | null; username: string; full_name: string; role: Role; store_id: string | null;
  active: number | boolean; created_at: string | null; last_login: string | null;
};
export type Me = {
  user: User; role: Role; role_label: string; permissions: Permission[]; stores: StoreInfo[]; all_stores: boolean;
  selected_store: string | null; selected_store_info: StoreInfo | null; auth_enabled: boolean; dev: boolean;
  limits: { adjust_max: number | null };
};

type State = { me: Me | null; loading: boolean; error: string | null; status: number | null; loaded: boolean };
let state: State = { me: null, loading: false, error: null, status: null, loaded: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
const SERVER_STATE: State = { me: null, loading: true, error: null, status: null, loaded: false };

function set(p: Partial<State>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

/** (Re)load /api/auth/me into the shared cache. Never redirects; callers decide. */
export function refreshMe(): Promise<void> {
  if (inflight) return inflight;
  set({ loading: true });
  inflight = apiFetch<Me>("/api/auth/me", { redirectOn401: false })
    .then((me) => set({ me, error: null, status: null }))
    .catch((e: ApiError) => set({ me: null, error: e.message, status: e.status ?? 0 }))
    .finally(() => { inflight = null; set({ loading: false, loaded: true }); });
  return inflight;
}

/** Replace the cached user (e.g. with the login response). */
export function setMe(me: Me | null) {
  set({ me, error: null, status: me ? null : 401, loaded: true, loading: false });
}

export function can(me: Me | null | undefined, perm: Permission): boolean {
  return !!me && me.permissions.includes(perm);
}

export function useMe() {
  const s = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => state,
    () => SERVER_STATE,
  );
  useEffect(() => { if (!state.loaded && !inflight) void refreshMe(); }, []);
  const check = useCallback((perm: Permission) => can(s.me, perm), [s.me]);
  return {
    me: s.me, loading: !s.loaded || s.loading, error: s.error,
    /** HTTP status of the last failure (401 = signed out, 0 = network) */
    status: s.status,
    can: check,
    /** the selected store (null until loaded) */
    store: s.me?.selected_store_info ?? null,
    storeId: s.me?.selected_store ?? null,
    reload: refreshMe,
  };
}

export async function login(username: string, password: string): Promise<Me> {
  const me = await apiPost<Me>("/api/auth/login", { username, password }, { redirectOn401: false });
  setMe(me);
  return me;
}

export async function logout(redirect = true) {
  try { await apiPost("/api/auth/logout", undefined, { redirectOn401: false }); } catch { /* already signed out */ }
  if (redirect && typeof window !== "undefined") { window.location.assign("/login"); return; }
  // Re-ask the server: 401 when auth is enforced, the dev user when it is disabled (no false 401s).
  set({ loaded: false });
  await refreshMe();
}

export async function switchStore(storeId: string): Promise<Me> {
  const me = await apiPost<Me>("/api/auth/store", { store_id: storeId });
  setMe(me);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORE_CHANGED_EVENT));
  return me;
}

export type AuthStatus = { enabled: boolean; cookie: string; session_hours: number; has_users: boolean };
export const fetchAuthStatus = () => apiFetch<AuthStatus>("/api/auth/status", { redirectOn401: false });

export function initials(name: string | null | undefined, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return fallback;
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", pharmacist: "Pharmacist", buyer: "Buyer" };
