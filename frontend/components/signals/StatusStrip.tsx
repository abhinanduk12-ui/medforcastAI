"use client";

import { useState } from "react";
import { CircleCheck, CircleOff, Clock3, CloudRain, CloudSun, ExternalLink, FileText, Globe2, Scale, TriangleAlert, Thermometer } from "lucide-react";
import { apiSend, ApiError } from "@/lib/api";
import { ago, type LicenseMode, type Source, type StatusResp } from "./model";

const ICON: Record<string, typeof CloudRain> = { nasa_obs: CloudRain, om_forecast: CloudSun, om_seasonal: Thermometer, climatology: Globe2, dhs_idsp: FileText };

function Fresh({ s }: { s: Source }) {
  if (!s.enabled) return <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3"><CircleOff className="h-3.5 w-3.5" aria-hidden />Off</span>;
  if (s.status === "never" && !s.last_success) return <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3"><Clock3 className="h-3.5 w-3.5" aria-hidden />Not fetched</span>;
  if (s.stale || s.status === "error")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fef6e3] px-2 py-0.5 text-[11.5px] font-medium text-ink">
        <TriangleAlert className="h-3.5 w-3.5" style={{ color: "var(--warn)" }} aria-hidden />{s.stale ? "Stale" : "Last try failed"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#eaf6ea] px-2 py-0.5 text-[11.5px] font-medium text-ink">
      <CircleCheck className="h-3.5 w-3.5 text-good" aria-hidden />Fresh
    </span>
  );
}

export function StatusStrip({ status }: { status: StatusResp }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {status.sources.map((s, i) => {
        const Icon = ICON[s.id] ?? Globe2;
        return (
          <div key={s.id} className="card rise flex min-w-0 flex-col gap-2 p-4" style={{ animationDelay: `${i * 30}ms` }}>
            <span className="inline-flex min-w-0 items-start gap-2 text-[13px] font-semibold leading-snug">
              <Icon className="mt-px h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.9} aria-hidden />
              <span className="min-w-0">{s.name}</span>
            </span>
            <a href={s.url} target="_blank" rel="noreferrer" className="focus-ring inline-flex w-fit items-center gap-1 text-[12px] text-ink-2 underline decoration-hairline underline-offset-2 hover:text-ink">
              {s.provider}<ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            <p className="text-[12px] leading-snug text-ink-3">{s.detail}</p>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1">
              <p className="min-w-0 text-[11px] text-muted" title={s.message ?? undefined}>
                {s.enabled ? <>{s.last_success ? `Updated ${ago(s.last_success)}` : "Never fetched"}{s.status === "error" && s.message ? ` · ${s.message.slice(0, 60)}${s.message.length > 60 ? "…" : ""}` : ""}</> : s.licence}
              </p>
              <Fresh s={s} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MODE_LABEL: Record<LicenseMode, string> = { noncommercial: "Free (non-commercial)", "commercial-plan": "Commercial plan", off: "Off" };

export function LicenceNotice({ status, onChanged }: { status: StatusResp; onChanged: () => void }) {
  const lic = status.license;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const warn = lic.mode === "noncommercial" || (lic.mode === "commercial-plan" && !lic.api_key_set);
  const set = async (mode: LicenseMode) => {
    setBusy(true); setErr(null);
    try { await apiSend("PUT", "/api/signals/settings", { license_mode: mode }); onChanged(); }
    catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(false); }
  };
  return (
    <div className={`rise mt-4 flex flex-col gap-3 rounded-2xl border px-4 py-3.5 text-[13px] leading-relaxed sm:flex-row sm:items-start sm:justify-between ${warn ? "border-[#f3dca4] bg-[#fffaf0]" : "border-hairline bg-surface"}`}>
      <div className="flex min-w-0 gap-2.5">
        <Scale className="mt-0.5 h-4 w-4 shrink-0" style={{ color: warn ? "var(--warn)" : "var(--ink-3)" }} strokeWidth={2} aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-ink">Weather licence: {MODE_LABEL[lic.mode]}{lic.locked ? " (set by the server)" : ""}</p>
          <p className="mt-0.5 text-ink-2">{lic.notice}</p>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {lic.mode !== "off" && <><a className="focus-ring underline underline-offset-2 hover:text-ink" href={lic.attribution.open_meteo.url} target="_blank" rel="noreferrer">{lic.attribution.open_meteo.text}</a>{" "}
              (<a className="focus-ring underline underline-offset-2 hover:text-ink" href={lic.attribution.open_meteo.terms} target="_blank" rel="noreferrer">terms</a>) · </>}
            Observed rain: <a className="focus-ring underline underline-offset-2 hover:text-ink" href={lic.attribution.nasa_power.url} target="_blank" rel="noreferrer">NASA POWER</a> ·
            Disease counts: <a className="focus-ring underline underline-offset-2 hover:text-ink" href={lic.attribution.dhs_kerala.url} target="_blank" rel="noreferrer">DHS Kerala IDSP</a>
          </p>
          {err && <p className="mt-1 text-[12px] text-critical" role="alert">{err}</p>}
        </div>
      </div>
      {status.can_edit_settings && !lic.locked && (
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
          Mode
          <select aria-label="Weather licence mode" value={lic.mode} disabled={busy} onChange={(e) => set(e.target.value as LicenseMode)}
            className="focus-ring h-9 rounded-xl border border-hairline bg-surface px-2.5 text-[13px] text-ink">
            {lic.modes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
