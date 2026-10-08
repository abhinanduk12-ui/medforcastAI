"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";
import { apiPost, apiSend, type ApiError } from "@/lib/api";
import type { Role, StoreInfo } from "@/lib/auth";
import { Segmented } from "@/components/ui";
import { Modal, generatePassword, ghostBtn, inputCls, labelCls, primaryBtn } from "./Modal";

export type AdminUser = {
  id: number; username: string; full_name: string; role: Role; store_id: string | null; active: boolean;
  created_at: string; last_login: string | null; sessions: number;
};

const ROLES = ["pharmacist", "buyer", "owner"] as const;
const ROLE_NAME: Record<Role, string> = { owner: "Owner", pharmacist: "Pharmacist", buyer: "Buyer" };
const ROLE_HINT: Record<Role, string> = {
  pharmacist: "One store only. Sales, receiving, small stock corrections, expiry write-offs.",
  buyer: "Purchasing, receiving and inter-store transfers. No sales, no user admin.",
  owner: "Everything in every store, including this page.",
};

function PasswordField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input id={id} type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password"
          minLength={8} maxLength={128} className={`${inputCls} pr-10 font-mono`} />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}
          className="focus-ring absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-ink-3 hover:bg-sunken">
          {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      <button type="button" onClick={() => { onChange(generatePassword()); setShow(true); }} className={ghostBtn} title="Generate a strong password">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />Generate
      </button>
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-3 py-2">
      <span className="min-w-0 text-[12px] text-ink-3">{label}<span className="block truncate font-mono text-[13px] text-ink">{value}</span></span>
      <button type="button" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}
        className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface">
        {done ? <Check className="h-4 w-4 text-good" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}

export function CreateUserDialog({ open, onClose, stores, onCreated }: {
  open: boolean; onClose: () => void; stores: StoreInfo[]; onCreated: (u: AdminUser) => void;
}) {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("pharmacist");
  const [store, setStore] = useState<string>("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  const reset = () => { setUsername(""); setFullName(""); setRole("pharmacist"); setStore(""); setPassword(""); setError(null); setCreated(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (role === "pharmacist" && !store) { setError("Pick the pharmacist's store."); return; }
    setBusy(true);
    try {
      const u = await apiPost<AdminUser>("/api/auth/users", {
        username: username.trim().toLowerCase(), full_name: fullName.trim(), role,
        store_id: role === "owner" ? null : store || null, password,
      });
      onCreated(u);
      setCreated({ username: u.username, password });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={created ? "User created" : "New user"}
      sub={created ? "Share these sign-in details privately. The password is not shown again." : "They can sign in straight away."}>
      {created ? (
        <div className="space-y-2.5">
          <CopyLine label="Username" value={created.username} />
          <CopyLine label="Password" value={created.password} />
          <div className="flex justify-end gap-2 pt-3">
            <button onClick={() => { reset(); }} className={ghostBtn}>Add another</button>
            <button onClick={close} className={primaryBtn}>Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="nu-username" className={labelCls}>Username</label>
              <input id="nu-username" value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls}
                autoCapitalize="none" spellCheck={false} maxLength={32} placeholder="e.g. pharmacist.kzd" required />
            </div>
            <div>
              <label htmlFor="nu-name" className={labelCls}>Full name</label>
              <input id="nu-name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} maxLength={80} placeholder="Optional" />
            </div>
          </div>
          <div>
            <p className={labelCls}>Role</p>
            <Segmented options={ROLES} value={role} onChange={setRole} render={(r) => ROLE_NAME[r]} />
            <p className="mt-1.5 text-[12px] text-ink-3">{ROLE_HINT[role]}</p>
          </div>
          {role !== "owner" && (
            <div>
              <label htmlFor="nu-store" className={labelCls}>Store access</label>
              <select id="nu-store" value={store} onChange={(e) => setStore(e.target.value)} className={inputCls}>
                {role === "pharmacist" ? <option value="" disabled>Choose a store…</option> : <option value="">All stores</option>}
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.simulated ? " (simulated)" : ""}{role === "buyer" ? " only" : ""}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="nu-pw" className={labelCls}>Initial password</label>
            <PasswordField id="nu-pw" value={password} onChange={setPassword} />
            <p className="mt-1.5 text-[12px] text-ink-3">At least 8 characters, mixing letters with digits or symbols.</p>
          </div>
          {error && <p role="alert" className="rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={close} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={busy || !username.trim() || password.length < 8} className={primaryBtn}>{busy ? "Creating…" : "Create user"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function ResetPasswordDialog({ user, onClose, onDone }: { user: AdminUser | null; onClose: () => void; onDone: (u: AdminUser) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const close = () => { setPassword(""); setError(null); setDone(false); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const u = await apiSend<AdminUser>("PATCH", `/api/auth/users/${user.id}`, { password });
      onDone(u);
      setDone(true);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!user} onClose={close} title={done ? "Password reset" : `Reset password for ${user?.full_name || user?.username}`}
      sub={done ? "They have been signed out everywhere. Share the new password privately." : "Their other sessions end immediately."}>
      {done ? (
        <div className="space-y-2.5">
          <CopyLine label="Username" value={user?.username ?? ""} />
          <CopyLine label="New password" value={password} />
          <div className="flex justify-end pt-3"><button onClick={close} className={primaryBtn}>Done</button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="rp-pw" className={labelCls}>New password</label>
            <PasswordField id="rp-pw" value={password} onChange={setPassword} />
          </div>
          {error && <p role="alert" className="rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={busy || password.length < 8} className={primaryBtn}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden />{busy ? "Saving…" : "Reset password"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function ConfirmDialog({ open, title, body, confirm, danger, onConfirm, onClose }: {
  open: boolean; title: string; body: React.ReactNode; confirm: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={() => { setError(null); onClose(); }} title={title} width={420}>
      <div className="text-[13.5px] leading-relaxed text-ink-2">{body}</div>
      {error && <p role="alert" className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-[13px] text-[#8f2626]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={ghostBtn}>Cancel</button>
        <button disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }} className={danger ? `${primaryBtn} !bg-[#b42f2f] hover:!bg-[#982626]` : primaryBtn}>{busy ? "Working…" : confirm}</button>
      </div>
    </Modal>
  );
}
