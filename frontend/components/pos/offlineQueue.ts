"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiPost } from "@/lib/api";
import type { Invoice, InvoicePayload } from "./types";

/**
 * Offline invoice queue (IndexedDB "medforecast-pos", store "queue").
 *
 * A bill that cannot reach the server (network error / server down) is stored WITH its client_uuid.
 * Sync re-posts it; the backend is idempotent on client_uuid, so a bill that did reach the server
 * before the connection dropped is returned (200), never sold twice. A queued bill the server rejects
 * (4xx: e.g. stock ran out meanwhile, or a register field is missing) is kept as "failed" with the
 * reason for the pharmacist to resolve - it is never silently dropped.
 */
export type QueuedBill = {
  client_uuid: string; payload: InvoicePayload; queued_at: string; store_id: string | null;
  status: "pending" | "failed"; error?: string; attempts: number; summary: { items: number; total: number };
};

const DB = "medforecast-pos";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available in this browser"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "client_uuid" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const queueList = () => run<QueuedBill[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedBill[]>);
export const queuePut = (b: QueuedBill) => run("readwrite", (s) => s.put(b));
export const queueDelete = (id: string) => run("readwrite", (s) => s.delete(id));

/** A network-level failure (no HTTP response) or a gateway error from the dev proxy while the API is down. */
export function isOffline(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
}

export function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let syncing = false;

/** React hook: queued bills + background sync (on mount, on "online", every 30 s while bills wait). */
export function useOfflineQueue(onSynced?: (inv: Invoice) => void) {
  const [items, setItems] = useState<QueuedBill[]>([]);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [supported, setSupported] = useState(true);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const cb = useRef(onSynced);
  useEffect(() => { cb.current = onSynced; }, [onSynced]);

  const refresh = useCallback(async () => {
    try { setItems((await queueList()).sort((a, b) => a.queued_at.localeCompare(b.queued_at))); }
    catch { setSupported(false); }
  }, []);

  const sync = useCallback(async () => {
    if (syncing) return;
    syncing = true;
    setBusy(true);
    try {
      const all = (await queueList()).filter((b) => b.status === "pending").sort((a, b) => a.queued_at.localeCompare(b.queued_at));
      for (const b of all) {
        try {
          const inv = await apiPost<Invoice>("/api/pos/invoices", b.payload);
          await queueDelete(b.client_uuid);
          cb.current?.(inv);
        } catch (e) {
          if (isOffline(e)) break; // still offline: keep everything, try later
          const msg = e instanceof ApiError ? e.message : String(e);
          if (e instanceof ApiError && e.status === 401) break; // signed out: retry after login
          await queuePut({ ...b, status: "failed", error: msg, attempts: b.attempts + 1 });
        }
      }
      setLastSync(new Date().toISOString());
    } catch {
      setSupported(false);
    } finally {
      syncing = false;
      setBusy(false);
      await refresh();
    }
  }, [refresh]);

  const enqueue = useCallback(async (b: QueuedBill) => { await queuePut(b); await refresh(); }, [refresh]);
  const remove = useCallback(async (id: string) => { await queueDelete(id); await refresh(); }, [refresh]);
  const retry = useCallback(async (b: QueuedBill) => { await queuePut({ ...b, status: "pending", error: undefined }); await sync(); }, [sync]);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    void refresh().then(() => sync());
    const on = () => { setOnline(true); void sync(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [refresh, sync]);

  const pending = items.filter((i) => i.status === "pending").length;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { void sync(); }, 30_000);
    return () => clearInterval(t);
  }, [pending, sync]);

  return { items, pending, failed: items.length - pending, busy, online, supported, lastSync, enqueue, remove, retry, sync, refresh };
}
