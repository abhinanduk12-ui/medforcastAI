"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Boxes, CalendarRange, Eye, EyeOff, FlaskConical, Loader2, ShieldCheck, Store } from "lucide-react";
import { ApiError } from "@/lib/api";
import { fetchAuthStatus, login, logout, useMe, type AuthStatus } from "@/lib/auth";
import { Avatar } from "@/components/auth/UserMenu";

/** Seeded demo accounts (backend/seed.py). Shown because this build is a demo. */
const DEMO = [
  { username: "owner", password: "Owner@2026", name: "Joseph Mathew", role: "Owner", scope: "All stores · user admin" },
  { username: "buyer", password: "Buyer@2026", name: "Fathima Rasheed", role: "Buyer", scope: "All stores · purchasing & transfers" },
  { username: "pharmacist.kochi", password: "Pharma@2026", name: "Anjali Menon", role: "Pharmacist", scope: "Kochi – Main only" },
  { username: "pharmacist.tsr", password: "Pharma@2026", name: "Rahul Varma", role: "Pharmacist", scope: "Thrissur branch only" },
];

/**
 * Where to go after signing in: only a same-origin path. Browsers read "/\evil.com" and
 * "/\t/evil.com" as "//evil.com", so the value is resolved with the URL parser and its origin compared.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("next");
  // eslint-disable-next-line no-control-regex
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return "/";
    if (u.pathname === "/login" || u.pathname.startsWith("/login/")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

function BrandPanel() {
  const points = [
    { icon: CalendarRange, title: "Season-aware forecasts", text: "Monsoon, summer and festival effects, measured per medicine with honest uncertainty." },
    { icon: Boxes, title: "Batch-level stock", text: "First-expiry-first-out dispensing, expiry watch and a full movement ledger." },
    { icon: ShieldCheck, title: "Role-based access", text: "Owners, buyers and pharmacists each see and do what their job needs." },
  ];
  return (
    <aside className="relative hidden overflow-hidden bg-brand-ink text-white lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12 xl:p-14"
      style={{ backgroundImage: "radial-gradient(120% 80% at 0% 0%, rgba(255,255,255,0.10) 0%, transparent 55%), radial-gradient(90% 70% at 100% 100%, rgba(27,175,122,0.22) 0%, transparent 60%)" }}>
      <svg aria-hidden className="pointer-events-none absolute -right-24 top-1/2 h-[560px] w-[560px] -translate-y-1/2 opacity-[0.09]" viewBox="0 0 200 200" fill="none" stroke="currentColor">
        {[30, 50, 70, 90].map((r) => <circle key={r} cx="100" cy="100" r={r} strokeWidth="0.6" />)}
      </svg>
      <div className="relative flex items-center gap-2.5">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/12 ring-1 ring-white/20">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 17l5-5 4 3 7-8" /><path d="M15 7h4v4" /></svg>
        </span>
        <span className="leading-tight">
          <span className="block text-[16px] font-semibold tracking-tight">MedForecast</span>
          <span className="block text-[11.5px] text-white/60">Seasonal demand AI</span>
        </span>
      </div>
      <div className="relative max-w-md">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/55">Kerala retail pharmacy</p>
        <h2 className="mt-3 text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] xl:text-[40px]">Stock the right medicines before the season turns.</h2>
        <ul className="mt-10 space-y-6">
          {points.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/10 ring-1 ring-white/15"><Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden /></span>
              <span>
                <span className="block text-[14px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-white/65">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative max-w-md text-[11.5px] leading-relaxed text-white/50">
        Sales history is synthetic, as stated in the dataset&apos;s Read Me. The Thrissur and Kozhikode branches are simulated
        by scaling the Kochi shop&apos;s forecast.
      </p>
    </aside>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetchAuthStatus().then(setStatus).catch(() => setStatus(null));
    document.title = "Sign in · MedForecast";
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError("Enter your username and password."); return; }
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      router.replace(safeNext());
    } catch (err) {
      const ae = err as ApiError;
      setError(ae.status === 0 ? "Can't reach the MedForecast API. Is the backend running on port 8000?" : ae.message);
      setBusy(false);
      pwRef.current?.select();
    }
  };

  const fill = (d: (typeof DEMO)[number]) => {
    setUsername(d.username);
    setPassword(d.password);
    setError(null);
    submitRef.current?.focus();
  };

  const signedIn = !meLoading && me && !me.dev;

  return (
    <div className="flex min-h-screen bg-page">
      <BrandPanel />
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="rise w-full max-w-[420px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 17l5-5 4 3 7-8" /><path d="M15 7h4v4" /></svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight">MedForecast</span>
          </div>

          <p className="eyebrow">Welcome back</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">Sign in</h1>
          <p className="mt-2 text-[14px] text-ink-3">Use your pharmacy account. Sessions last 12 hours of activity.</p>

          {status && !status.enabled && (
            <div className="mt-6 flex gap-3 rounded-2xl border border-dashed border-[var(--hairline-strong)] bg-surface p-4 text-[13px]">
              <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
              <div>
                <p className="font-medium">Auth disabled (dev)</p>
                <p className="mt-0.5 text-ink-3">The API is not enforcing sign-in, so you can browse without an account. Signing in still applies your role.</p>
                <Link href="/" className="focus-ring mt-2 inline-flex items-center gap-1 rounded font-medium text-brand-ink hover:underline">
                  Continue without signing in <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>
            </div>
          )}

          {signedIn && (
            <div className="mt-6 flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-4">
              <Avatar name={me.user.full_name || me.user.username} size={36} tone="brand" />
              <div className="min-w-0 flex-1 text-[13px]">
                <p className="truncate font-medium">Signed in as {me.user.full_name || me.user.username}</p>
                <p className="text-ink-3">{me.role_label}</p>
              </div>
              <button onClick={() => router.replace(safeNext())} className="focus-ring rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#262624]">Continue</button>
              <button onClick={() => void logout(false)} className="focus-ring rounded-lg px-2 py-1.5 text-[12px] text-ink-2 hover:bg-sunken">Sign out</button>
            </div>
          )}

          <form onSubmit={submit} className="card mt-6 space-y-4 p-6" noValidate>
            <div>
              <label htmlFor="username" className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Username</label>
              <input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus
                value={username} onChange={(e) => setUsername(e.target.value)} maxLength={64}
                className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface px-3.5 text-[14px] placeholder:text-muted"
                placeholder="e.g. pharmacist.kochi" aria-invalid={!!error} />
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-[12.5px] font-medium text-ink-2">Password</label>
              <div className="relative">
                <input id="password" name="password" ref={pwRef} type={show ? "text" : "password"} autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} maxLength={256}
                  onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
                  className="focus-ring h-11 w-full rounded-xl border border-hairline bg-surface pl-3.5 pr-11 text-[14px]" aria-invalid={!!error}
                  aria-describedby={caps ? "caps-hint" : undefined} />
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
                  className="focus-ring absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-ink-3 hover:bg-sunken hover:text-ink">
                  {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
              {caps && <p id="caps-hint" className="mt-1.5 text-[12px] text-ink-3">Caps Lock is on.</p>}
            </div>
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-[#fdecea] px-3 py-2.5 text-[13px] text-[#8f2626]">
                <AlertCircle className="mt-px h-4 w-4 shrink-0" aria-hidden />{error}
              </p>
            )}
            <button ref={submitRef} type="submit" disabled={busy}
              className="focus-ring flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[14px] font-medium text-white transition hover:bg-[#262624] disabled:opacity-70">
              {busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Signing in…</> : <>Sign in <ArrowRight className="h-4 w-4" aria-hidden /></>}
            </button>
          </form>

          <section aria-labelledby="demo-h" className="mt-8">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="demo-h" className="text-[13px] font-semibold">Demo accounts</h2>
              <span className="text-[11.5px] text-ink-3">Click to fill · demo build only</span>
            </div>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {DEMO.map((d) => {
                const active = username === d.username;
                return (
                  <li key={d.username}>
                    <button type="button" onClick={() => fill(d)} aria-pressed={active}
                      className={`focus-ring flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                        active ? "border-ink bg-surface shadow-sm" : "border-hairline bg-surface-2 hover:border-[var(--hairline-strong)] hover:bg-surface"}`}>
                      <Avatar name={d.name} size={30} tone={active ? "brand" : "soft"} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{d.role}</span>
                        <span className="block truncate text-[11.5px] text-ink-3">{d.scope}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-3">
              <Store className="h-3.5 w-3.5" aria-hidden />Branch stores are simulated from the single real shop.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
