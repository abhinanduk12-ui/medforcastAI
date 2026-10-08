"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * API helpers. Next rewrites /api/* to the FastAPI backend, so the httpOnly session cookie flows
 * automatically (same origin). Any 401 sends the browser to /login?next=<current page>.
 *
 *   const { data, error, loading, reload } = useApi<T>("/api/thing");      // GET, refetches on store switch
 *   const res = await apiPost<T>("/api/inventory/sell", { ... });            // throws ApiError
 *   await apiSend("PATCH", `/api/auth/users/${id}`, { role: "buyer" });
 */

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Fired on window after the selected store changes; useApi hooks refetch on it. */
export const STORE_CHANGED_EVENT = "mf:store-changed";

/** Human-readable message from a FastAPI error body ({detail: string | {message} | validation[]}). */
export function errorMessage(detail: unknown, fallback = "Request failed"): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      if (d && typeof d === "object" && "msg" in d) {
        const loc = Array.isArray((d as { loc?: unknown[] }).loc) ? (d as { loc: unknown[] }).loc.filter((x) => x !== "body").join(".") : "";
        return `${loc ? loc + ": " : ""}${String((d as { msg: string }).msg).replace(/^Value error, /, "")}`;
      }
      return String(d);
    });
    return parts.join("; ") || fallback;
  }
  if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
  return fallback;
}

let redirecting = false;
/** Send the browser to the login page (no-op on /login itself, so there are no loops). */
export function redirectToLogin() {
  if (typeof window === "undefined" || redirecting) return;
  const { pathname, search } = window.location;
  if (pathname === "/login" || pathname.startsWith("/login/")) return;
  redirecting = true;
  window.location.assign(`/login?next=${encodeURIComponent(pathname + search)}`);
}

export type FetchOpts = RequestInit & { /** default true: redirect to /login on 401 */ redirectOn401?: boolean };

/** fetch + JSON + errors. Throws ApiError(status, message, detail) on non-2xx. */
export async function apiFetch<T = unknown>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { redirectOn401 = true, ...init } = opts;
  let r: Response;
  try {
    r = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    throw new ApiError(0, `Network error: ${(e as Error)?.message ?? e}`);
  }
  const text = await r.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!r.ok) {
    if (r.status === 401 && redirectOn401) redirectToLogin();
    const detail = body && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : body;
    throw new ApiError(r.status, errorMessage(detail, `${r.status} ${r.statusText}`), detail);
  }
  return body as T;
}

export const apiGet = <T = unknown>(path: string, opts?: FetchOpts) => apiFetch<T>(path, opts);

/** JSON request with a body. method: POST | PUT | PATCH | DELETE. */
export function apiSend<T = unknown>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, opts: FetchOpts = {}): Promise<T> {
  return apiFetch<T>(path, {
    ...opts,
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export const apiPost = <T = unknown>(path: string, body?: unknown, opts?: FetchOpts) => apiSend<T>("POST", path, body, opts);

/**
 * GET `path` (null = idle). Backward compatible: `{ data, error, loading }`, plus `reload()`,
 * `setData` and `status` (HTTP status of the last error, 0 = network). Refetches automatically
 * when the selected store changes (set `refetchOnStoreChange: false` to opt out).
 */
export function useApi<T>(path: string | null, opts: { refetchOnStoreChange?: boolean } = {}) {
  const { refetchOnStoreChange = true } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    apiFetch<T>(path)
      .then((d) => { if (alive) { setData(d); setError(null); setStatus(null); } })
      .catch((e: ApiError) => { if (alive) { setError(String(e.message ?? e)); setStatus(e.status ?? 0); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path, tick]);

  useEffect(() => {
    if (!refetchOnStoreChange) return;
    const on = () => reload();
    window.addEventListener(STORE_CHANGED_EVENT, on);
    return () => window.removeEventListener(STORE_CHANGED_EVENT, on);
  }, [refetchOnStoreChange, reload]);

  return { data, error, loading, reload, setData, status };
}

export const SEASONS = ["Winter", "Summer", "Monsoon", "Post-Monsoon"] as const;
export type Season = (typeof SEASONS)[number];
