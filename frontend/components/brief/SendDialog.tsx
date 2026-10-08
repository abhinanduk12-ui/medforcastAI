"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, Mail, MessageCircle, Send, XCircle } from "lucide-react";
import { apiPost, ApiError, useApi } from "@/lib/api";
import { Modal, ghostBtn, inputCls, labelCls, primaryBtn } from "@/components/auth/Modal";
import type { ChannelStatus, SendResp, SendResult } from "./types";

type Ch = "email" | "whatsapp";

const STATUS: Record<SendResult["status"], { label: string; icon: typeof CheckCircle2; color: string }> = {
  sent: { label: "Sent", icon: CheckCircle2, color: "var(--good)" },
  failed: { label: "Failed", icon: XCircle, color: "var(--critical)" },
  not_configured: { label: "Not configured", icon: CircleDashed, color: "var(--ink-3)" },
  invalid: { label: "Invalid", icon: CircleAlert, color: "var(--serious)" },
  skipped: { label: "Skipped", icon: CircleDashed, color: "var(--ink-3)" },
};

export function ChannelBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-good"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Configured</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-3"><CircleDashed className="h-3.5 w-3.5" aria-hidden />Not configured</span>
  );
}

export function splitList(s: string): string[] {
  return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}

/* Light client-side checks that mirror (never replace) the server's validation. */
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export const badEmails = (xs: string[]) => xs.filter((x) => !EMAIL_RE.test(x));
export const badPhones = (xs: string[]) => xs.filter((x) => {
  if (/[^\d\s()+.-]/.test(x)) return true;
  const n = x.replace(/\D/g, "").length;
  return n < 8 || n > 15;
});

const SUMMARY_LABEL: [keyof typeof STATUS, string][] = [
  ["failed", "failed"], ["not_configured", "not configured"], ["invalid", "invalid"], ["skipped", "skipped"],
];

export function SendDialog({ open, onClose, storeId, storeName, shareUrl, onSent, canSeeSchedule = false }: {
  open: boolean; onClose: () => void; storeId: string; storeName: string; shareUrl: string | null; onSent?: () => void;
  canSeeSchedule?: boolean;
}) {
  const { data: ch, error: chError } = useApi<ChannelStatus>(open ? "/api/brief/channels" : null, { refetchOnStoreChange: false });
  const [channels, setChannels] = useState<Ch[]>(["email"]);
  const [emails, setEmails] = useState("");
  const [phones, setPhones] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<SendResp | null>(null);

  useEffect(() => { if (open) { setRes(null); setErr(null); } }, [open]);

  const toggle = (c: Ch) => { setRes(null); setErr(null); setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c])); };
  const emailList = channels.includes("email") ? splitList(emails) : [];
  const phoneList = channels.includes("whatsapp") ? splitList(phones) : [];
  const recipients = [...emailList, ...phoneList];
  const badE = badEmails(emailList), badP = badPhones(phoneList);
  const localProblem = channels.length === 0
    ? "Choose at least one channel."
    : badE.length || badP.length
      ? `Check ${[...badE, ...badP].slice(0, 3).join(", ")}: ${badE.length ? "emails look like name@example.in" : ""}${badE.length && badP.length ? "; " : ""}${badP.length ? "phone numbers need 10 digits (or a country code)" : ""}.`
      : null;

  async function send() {
    if (busy || localProblem) return;
    setBusy(true); setErr(null); setRes(null);
    try {
      const r = await apiPost<SendResp>("/api/brief/send", { store_id: storeId, channels, recipients });
      setRes(r);
      onSent?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const CHS: { id: Ch; label: string; icon: typeof Mail }[] = [
    { id: "email", label: "Email", icon: Mail },
    { id: "whatsapp", label: "WhatsApp (Cloud API)", icon: MessageCircle },
  ];
  const summary = res?.summary ?? {};
  const sent = summary.sent ?? 0;

  return (
    <Modal open={open} onClose={onClose} title="Send the brief now" sub={`${storeName} · today's brief`} width={520}>
      <form onSubmit={(e) => { e.preventDefault(); void send(); }} aria-busy={busy} noValidate>
        <fieldset disabled={busy}>
          <legend className={labelCls}>Channels</legend>
          <div className="space-y-2">
            {CHS.map(({ id, label, icon: Icon }) => (
              <label key={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-hairline p-3 hover:bg-surface-2">
                <input type="checkbox" className="focus-ring mt-1 accent-[var(--brand)]" checked={channels.includes(id)} onChange={() => toggle(id)} />
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] font-medium">{label}{ch?.[id] && <ChannelBadge ok={ch[id].configured} />}</span>
                  {ch?.[id] && <span className="mt-0.5 block break-words text-[12px] text-ink-3">{ch[id].detail}</span>}
                </span>
              </label>
            ))}
          </div>
          {chError && <p className="mt-2 text-[12px] text-ink-3">Channel status could not be loaded ({chError}); the send result will still say what happened.</p>}
        </fieldset>

        {channels.includes("email") && (
          <div className="mt-4">
            <label className={labelCls} htmlFor="brief-emails">Email addresses</label>
            <input id="brief-emails" type="text" inputMode="email" autoComplete="off" className={inputCls} disabled={busy}
              placeholder="owner@pharmacy.in, buyer@pharmacy.in" value={emails} aria-invalid={badE.length > 0}
              aria-describedby="brief-recipients-hint" onChange={(e) => { setEmails(e.target.value); setRes(null); }} />
          </div>
        )}
        {channels.includes("whatsapp") && (
          <div className="mt-4">
            <label className={labelCls} htmlFor="brief-phones">WhatsApp numbers</label>
            <input id="brief-phones" type="text" inputMode="tel" autoComplete="off" className={inputCls} disabled={busy}
              placeholder="98765 43210, +91 98470 12345" value={phones} aria-invalid={badP.length > 0}
              aria-describedby="brief-phones-hint brief-recipients-hint" onChange={(e) => { setPhones(e.target.value); setRes(null); }} />
            <p id="brief-phones-hint" className="mt-1 text-[12px] text-ink-3">10-digit Indian mobiles get +91 added. Meta only delivers free-form text within 24 hours of the recipient's last message unless an approved template is set.</p>
          </div>
        )}
        <p id="brief-recipients-hint" className="mt-3 text-[12px] text-ink-3">
          Separate several with commas. Leave the fields empty to use this store's scheduled recipients
          {canSeeSchedule ? " (set in Daily schedule below)" : " (set by the owner; they are partly hidden in the result)"}.
        </p>

        {localProblem && (
          <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-ink-2" role="status">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--serious)" }} aria-hidden />{localProblem}
          </p>
        )}

        {err && (
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-[#fbeaea] px-3 py-2 text-[13px] text-[#a8302f]" role="alert">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span className="min-w-0 break-words">{err}</span>
          </p>
        )}

        {res && (
          <div className="mt-4 rounded-xl border border-hairline" role="status" aria-live="polite">
            <p className="border-b border-hairline px-3 py-2 text-[12.5px] font-medium">
              {sent ? `${sent} sent` : "Nothing was sent"}
              {SUMMARY_LABEL.map(([k, l]) => (summary[k] ? ` · ${summary[k]} ${l}` : "")).join("")}
              {res.recipients_masked ? " · scheduled recipients partly hidden" : ""}
            </p>
            {res.results.length === 0 ? (
              <p className="px-3 py-2 text-[12.5px] text-ink-3">No recipients were processed.</p>
            ) : (
              <ul className="max-h-48 divide-y divide-[var(--hairline)] overflow-y-auto">
                {res.results.map((r, i) => {
                  const s = STATUS[r.status] ?? STATUS.skipped;
                  const Icon = s.icon;
                  return (
                    <li key={i} className="flex items-start gap-2 px-3 py-2 text-[12.5px]">
                      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: s.color }} aria-hidden />
                      <span className="min-w-0 flex-1 break-words">
                        <span className="font-medium">{s.label}</span> · {r.channel === "whatsapp" ? "WhatsApp" : "Email"}{r.recipient ? ` · ${r.recipient}` : ""}
                        {r.error && <span className="block break-words text-ink-3">{r.error}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          {shareUrl ? (
            <a href={shareUrl} target="_blank" rel="noopener noreferrer" className={ghostBtn}>
              <MessageCircle className="h-4 w-4" aria-hidden /> Share via wa.me instead
            </a>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
            <button type="submit" className={primaryBtn} disabled={busy || !!localProblem}>
              <Send className="h-4 w-4" aria-hidden />{busy ? "Sending…" : res ? "Send again" : "Send"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
