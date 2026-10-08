"""Outbound delivery for the daily brief: SMTP email and the Meta WhatsApp Cloud API.

Both channels are optional and configured only through environment variables (read at call time,
so a restart is not needed after changing them and tests can monkeypatch os.environ):

  Email (SMTP)
    MEDFORECAST_SMTP_HOST       required to enable email
    MEDFORECAST_SMTP_PORT       default 587
    MEDFORECAST_SMTP_USER       optional (login is skipped when empty)
    MEDFORECAST_SMTP_PASSWORD   optional
    MEDFORECAST_SMTP_FROM       sender address (default: SMTP_USER)
    MEDFORECAST_SMTP_TLS        starttls | ssl | none   (default: ssl on port 465, else starttls)

  WhatsApp (Meta WhatsApp Cloud API, https://developers.facebook.com/docs/whatsapp/cloud-api)
    MEDFORECAST_WA_TOKEN        permanent / system-user access token
    MEDFORECAST_WA_PHONE_ID     the business phone-number id messages are sent from
    MEDFORECAST_WA_API_VERSION  Graph API version (default v21.0)
    MEDFORECAST_WA_TEMPLATE     optional approved template name. Meta only delivers free-form text
                                inside a 24-hour customer-service window; a scheduled morning
                                message outside that window needs an approved template. When set,
                                the brief's one-line summary is sent as the template's {{1}} body
                                parameter (Meta forbids newlines in parameters).
    MEDFORECAST_WA_TEMPLATE_LANG  template language code (default en)

Nothing here ever pretends a message was sent: an unconfigured channel returns
status "not_configured", a refused or failed request returns "failed" with the reason.
The wa.me share link needs no API at all.
"""
from __future__ import annotations

import json
import os
import re
import smtplib
import ssl
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                      r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")
PHONE_RE = re.compile(r"^[1-9]\d{7,14}$")      # E.164 digits: never starts with 0
TIMEOUT_S = 15
WA_TEXT_LIMIT = 4096          # Cloud API text body limit
WA_PARAM_LIMIT = 1024         # template parameter limit

STATUS_SENT = "sent"
STATUS_FAILED = "failed"
STATUS_NOT_CONFIGURED = "not_configured"
STATUS_INVALID = "invalid"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


# ── recipients ───────────────────────────────────────────────────────────────

def normalize_email(addr: str) -> str | None:
    a = (addr or "").strip()
    if len(a) > 254 or not EMAIL_RE.match(a):
        return None
    return a


def normalize_phone(num: str) -> str | None:
    """E.164 digits without '+' (what the Cloud API and wa.me expect). Bare 10-digit Indian
    mobile numbers get the 91 country code."""
    d = re.sub(r"[\s()+.-]", "", (num or "").strip())
    if d.startswith("00"):
        d = d[2:]
    elif re.fullmatch(r"0[6-9]\d{9}", d):   # Indian trunk prefix: 0 98765 43210
        d = d[1:]
    if re.fullmatch(r"[6-9]\d{9}", d):
        d = "91" + d
    return d if PHONE_RE.match(d) else None


def mask(recipient: str | None) -> str:
    """Partially hide an address or number for people who may see the log but not the settings."""
    r = recipient or ""
    if "@" in r:
        user, _, dom = r.partition("@")
        return (user[:2] + "***@" + dom) if user else "***@" + dom
    if len(r) > 4:
        return "*" * (len(r) - 4) + r[-4:]
    return r


_EMAIL_IN_TEXT = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}")
_PHONE_IN_TEXT = re.compile(r"(?<!\d)\d{8,15}(?!\d)")


def mask_text(text: str | None) -> str | None:
    """Mask any email address or phone number inside free text (e.g. a provider error message)."""
    if not text:
        return text
    t = _EMAIL_IN_TEXT.sub(lambda m: mask(m.group(0)), text)
    return _PHONE_IN_TEXT.sub(lambda m: mask(m.group(0)), t)


def header_safe(value: str, limit: int = 200) -> str:
    """One-line header value (no CR/LF or other control characters)."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", value or "").strip()[:limit]


# ── configuration status ────────────────────────────────────────────────────

def email_config() -> dict:
    host = _env("MEDFORECAST_SMTP_HOST")
    try:
        port = int(_env("MEDFORECAST_SMTP_PORT", "587"))
    except ValueError:
        port = -1
    user = _env("MEDFORECAST_SMTP_USER")
    sender = _env("MEDFORECAST_SMTP_FROM") or user
    tls = _env("MEDFORECAST_SMTP_TLS").lower() or ("ssl" if port == 465 else "starttls")
    problems = []
    if not host:
        problems.append("MEDFORECAST_SMTP_HOST is not set")
    if not 0 < port < 65536:
        problems.append("MEDFORECAST_SMTP_PORT is not a valid port")
    if not sender or not normalize_email(sender):
        problems.append("MEDFORECAST_SMTP_FROM (or _USER) is not a valid sender address")
    if tls not in ("starttls", "ssl", "none"):
        problems.append("MEDFORECAST_SMTP_TLS must be starttls, ssl or none")
    return {"configured": not problems, "host": host or None, "port": port if port > 0 else None,
            "sender": sender or None, "tls": tls, "auth": bool(user), "problems": problems}


def whatsapp_config() -> dict:
    token = _env("MEDFORECAST_WA_TOKEN")
    phone_id = _env("MEDFORECAST_WA_PHONE_ID")
    problems = []
    if not token:
        problems.append("MEDFORECAST_WA_TOKEN is not set")
    if not phone_id:
        problems.append("MEDFORECAST_WA_PHONE_ID is not set")
    elif not re.fullmatch(r"\d{5,32}", phone_id):
        problems.append("MEDFORECAST_WA_PHONE_ID must be the numeric phone-number id")
    version = _env("MEDFORECAST_WA_API_VERSION", "v21.0")
    if not re.fullmatch(r"v\d{1,3}\.\d{1,2}", version):
        problems.append("MEDFORECAST_WA_API_VERSION must look like v21.0")
    template = _env("MEDFORECAST_WA_TEMPLATE")
    return {"configured": not problems, "phone_id_set": bool(phone_id), "api_version": version,
            "mode": "template" if template else "text", "template": template or None,
            "template_lang": _env("MEDFORECAST_WA_TEMPLATE_LANG", "en"), "problems": problems}


def channel_status() -> dict:
    """What the UI shows in the "Send now" dialog. Never includes secrets."""
    e, w = email_config(), whatsapp_config()
    return {
        "email": {"configured": e["configured"], "detail": (f"SMTP {e['host']}:{e['port']} ({e['tls']}) from {e['sender']}"
                                                              if e["configured"] else "; ".join(e["problems"]))},
        "whatsapp": {"configured": w["configured"],
                     "detail": ((f"WhatsApp Cloud API {w['api_version']}, "
                                 + (f"template '{w['template']}'" if w["template"] else "free-form text (24-hour window only)"))
                                if w["configured"] else "; ".join(w["problems"]))},
        "share_link": {"configured": True, "detail": "wa.me link: opens WhatsApp with the brief pre-filled; you pick the chat"},
    }


def wa_share_link(text: str, phone: str | None = None) -> str:
    """https://wa.me/?text=... (no API, no account). With a number, opens that chat directly."""
    base = f"https://wa.me/{phone}" if phone else "https://wa.me/"
    return base + "?text=" + urllib.parse.quote(text, safe="")


def _short_error(e: BaseException) -> str:
    msg = f"{type(e).__name__}: {e}"
    for secret in (_env("MEDFORECAST_SMTP_PASSWORD"), _env("MEDFORECAST_WA_TOKEN")):
        if secret:
            msg = msg.replace(secret, "***")
    return msg[:300]


# ── email ────────────────────────────────────────────────────────────────────

def send_email(recipients: list[str], subject: str, text: str, html: str | None = None) -> list[dict]:
    """Send one message per recipient (so one bad address does not block the rest).
    Returns [{channel, recipient, status, error}]."""
    cfg = email_config()
    rcpts = list(dict.fromkeys(recipients))
    if not cfg["configured"]:
        why = "Email not configured: " + "; ".join(cfg["problems"])
        return [{"channel": "email", "recipient": r, "status": STATUS_NOT_CONFIGURED, "error": why} for r in rcpts]
    out, valid = [], []
    for r in rcpts:
        n = normalize_email(r)
        if n:
            valid.append(n)
        else:
            out.append({"channel": "email", "recipient": r, "status": STATUS_INVALID, "error": "Not a valid email address"})
    if not valid:
        return out
    server = None
    try:
        if cfg["tls"] == "ssl":
            server = smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=TIMEOUT_S, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=TIMEOUT_S)
            if cfg["tls"] == "starttls":
                server.starttls(context=ssl.create_default_context())
        if cfg["auth"]:
            server.login(_env("MEDFORECAST_SMTP_USER"), _env("MEDFORECAST_SMTP_PASSWORD"))
    except Exception as e:  # connection / TLS / auth failure applies to every recipient
        err = _short_error(e)
        try:
            if server is not None:
                server.quit()
        except Exception:
            pass
        return out + [{"channel": "email", "recipient": r, "status": STATUS_FAILED, "error": err} for r in valid]
    try:
        for r in valid:
            try:
                msg = EmailMessage()
                msg["Subject"] = header_safe(subject)
                msg["From"] = formataddr(("MedForecast AI", cfg["sender"]))
                msg["To"] = r
                msg["Message-ID"] = make_msgid(domain=cfg["sender"].split("@")[-1])
                msg.set_content(text)
                if html:
                    msg.add_alternative(html, subtype="html")
                refused = server.send_message(msg)
                if refused:
                    out.append({"channel": "email", "recipient": r, "status": STATUS_FAILED,
                                "error": f"Refused by server: {str(refused)[:200]}"})
                else:
                    out.append({"channel": "email", "recipient": r, "status": STATUS_SENT, "error": None})
            except Exception as e:
                out.append({"channel": "email", "recipient": r, "status": STATUS_FAILED, "error": _short_error(e)})
    finally:
        try:
            server.quit()
        except Exception:
            pass
    return out


# ── WhatsApp Cloud API ───────────────────────────────────────────────────────

def _http_post_json(url: str, payload: dict, headers: dict, timeout: float = TIMEOUT_S) -> tuple[int, dict]:
    """POST JSON, return (status, parsed body). Tests monkeypatch this function."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        try:
            return e.code, json.loads(body) if body else {}
        except ValueError:
            return e.code, {"error": {"message": body[:200]}}


def whatsapp_payload(to: str, text: str, summary: str) -> dict:
    cfg = whatsapp_config()
    if cfg["template"]:
        param = re.sub(r"\s+", " ", summary).strip()[:WA_PARAM_LIMIT]
        return {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "template",
                "template": {"name": cfg["template"], "language": {"code": cfg["template_lang"]},
                             "components": [{"type": "body", "parameters": [{"type": "text", "text": param}]}]}}
    return {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to, "type": "text",
            "text": {"preview_url": False, "body": text[:WA_TEXT_LIMIT]}}


def send_whatsapp(recipients: list[str], text: str, summary: str = "") -> list[dict]:
    cfg = whatsapp_config()
    rcpts = list(dict.fromkeys(recipients))
    if not cfg["configured"]:
        why = "WhatsApp not configured: " + "; ".join(cfg["problems"])
        return [{"channel": "whatsapp", "recipient": r, "status": STATUS_NOT_CONFIGURED, "error": why} for r in rcpts]
    url = f"https://graph.facebook.com/{cfg['api_version']}/{_env('MEDFORECAST_WA_PHONE_ID')}/messages"
    headers = {"Authorization": f"Bearer {_env('MEDFORECAST_WA_TOKEN')}"}
    out = []
    for r in rcpts:
        to = normalize_phone(r)
        if not to:
            out.append({"channel": "whatsapp", "recipient": r, "status": STATUS_INVALID,
                        "error": "Not a valid phone number (use country code, e.g. 91XXXXXXXXXX)"})
            continue
        try:
            status, body = _http_post_json(url, whatsapp_payload(to, text, summary or text), headers)
        except Exception as e:
            out.append({"channel": "whatsapp", "recipient": to, "status": STATUS_FAILED, "error": _short_error(e)})
            continue
        msgs = body.get("messages") if isinstance(body, dict) else None
        if 200 <= status < 300 and msgs:
            out.append({"channel": "whatsapp", "recipient": to, "status": STATUS_SENT, "error": None,
                        "provider_id": str(msgs[0].get("id", ""))[:120]})
        else:
            err = body.get("error", {}) if isinstance(body, dict) else {}
            msg = err.get("message") if isinstance(err, dict) else None
            code = err.get("code") if isinstance(err, dict) else None
            out.append({"channel": "whatsapp", "recipient": to, "status": STATUS_FAILED,
                        "error": f"HTTP {status}" + (f" (code {code})" if code else "") + (f": {str(msg)[:200]}" if msg else "")})
    return out
