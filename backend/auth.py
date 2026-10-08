"""Authentication, sessions and the role/store permission model.

Passwords   PBKDF2-HMAC-SHA256, 16-byte per-user salt, 260 000 iterations, constant-time compare.
            Stored as  "pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>".
Sessions    secrets.token_urlsafe(32) given to the browser in an httpOnly, SameSite=Lax cookie
            "mf_session" (Secure flag when env MEDFORECAST_COOKIE_SECURE=1). Only sha256(token) is stored.
            12-hour sliding expiry: any authenticated request more than SLIDE_AFTER after the last
            extension pushes expires_at (and the cookie) to now + 12 h.
Rate limit  5 failed logins per (username, client IP) within 5 minutes -> HTTP 429 with Retry-After.
Enforcement env MEDFORECAST_AUTH (read per request): anything but "0" means every /api/* request except
            PUBLIC_PATHS needs a valid session (401 JSON otherwise; AuthMiddleware in app.py).
            With MEDFORECAST_AUTH=0 the API is open: a request without a session acts as a synthetic
            "dev" owner (id None) so the app still works, while a real login still identifies the user.

Permission matrix (GET /api/auth/permissions serves this)
----------------------------------------------------------
permission            owner  buyer  pharmacist   meaning
view                    x      x       x         read forecasts, plans, alerts, stock
stores.all              x      x       -         see/act on every store ("all stores" scope)
stock.receive           x      x       x         receive goods into a batch
stock.adjust            x      -       x         stock-count corrections (pharmacist: |delta| <= 10 per batch)
stock.adjust.large      x      -       -         corrections above the pharmacist limit
stock.writeoff          x      x       x         write off expired batches
sales.record            x      -       x         record sales (FEFO dispensing)
transfers.request       x      x       x         ask for stock to be moved between stores
transfers.create        x      x       -         execute / approve inter-store transfers
purchase.plan           x      x       -         purchase planning, optimizer, supplier orders
settings.edit           x      -       -         change app-wide settings
users.admin             x      -       -         create users, change roles/stores, reset passwords

Store scope: a user with users.store_id NULL may access every store; otherwise ONLY that store
(pharmacists always have a store). Owners always have store_id NULL.

FastAPI usage (feature routers)
-------------------------------
    from backend.auth import current_user, require_role, require_perm, store_scope, store_scope_all, resolve_store, has_perm

    @router.get("/stock")
    def stock(store: str = Depends(store_scope)):                      # ?store_id=..., default = selected store
        ...
    @router.get("/stock/all")
    def stock_all(store: str | None = Depends(store_scope_all)):       # ?store_id=all -> None (all stores)
        ...
    @router.post("/sell")
    def sell(body: SellBody, user: dict = Depends(require_perm("sales.record"))):
        store = resolve_store(user, body.store_id)                     # 403 if not accessible
        ...
User dicts look like: {"id", "username", "full_name", "role", "store_id", "active", "created_at",
"last_login", "selected_store", "dev"}; "dev" is True only for the synthetic auth-disabled user.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from typing import Any, Callable

from fastapi import Depends, HTTPException, Query, Request, Response

from backend import db

# ---------------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------------
COOKIE_NAME = "mf_session"
STORE_COOKIE = "mf_store"            # selected store when there is no session (auth disabled)
SESSION_HOURS = 12
SLIDE_AFTER = timedelta(minutes=5)   # extend expiry at most this often (avoids a write per request)
PBKDF2_ITERATIONS = 260_000
RATE_MAX_FAILURES = 5
RATE_WINDOW_S = 300
PHARMACIST_ADJUST_LIMIT = 10         # max |delta| per adjustment without stock.adjust.large
PUBLIC_PATHS = frozenset({"/api/auth/login", "/api/auth/status", "/api/auth/logout", "/api/health"})

ROLES = ("owner", "pharmacist", "buyer")
ROLE_LABEL = {"owner": "Owner", "pharmacist": "Pharmacist", "buyer": "Buyer"}
ROLE_BLURB = {
    "owner": "Everything, in every store, including user administration.",
    "buyer": "Reads every store; receives stock, moves stock between stores and plans purchases. No sales, no user admin.",
    "pharmacist": "Own store only: records sales, receives stock, small stock corrections and expiry write-offs.",
}
PERMISSION_INFO: dict[str, str] = {
    "view": "Read forecasts, plans, alerts and stock",
    "stores.all": "Access every store (all-stores views)",
    "stock.receive": "Receive goods into stock",
    "stock.adjust": f"Correct stock counts (pharmacists up to ±{PHARMACIST_ADJUST_LIMIT} units per batch)",
    "stock.adjust.large": f"Stock corrections above ±{PHARMACIST_ADJUST_LIMIT} units",
    "stock.writeoff": "Write off expired batches",
    "sales.record": "Record sales (first-expiry-first-out dispensing)",
    "transfers.request": "Request stock from another store",
    "transfers.create": "Execute / approve inter-store transfers",
    "purchase.plan": "Purchase planning and supplier orders",
    "settings.edit": "Change app-wide settings",
    "users.admin": "Manage users, roles, stores and passwords",
}
PERMISSIONS: dict[str, frozenset[str]] = {
    "owner": frozenset(PERMISSION_INFO),
    "buyer": frozenset({"view", "stores.all", "stock.receive", "stock.writeoff", "transfers.request",
                        "transfers.create", "purchase.plan"}),
    "pharmacist": frozenset({"view", "stock.receive", "stock.adjust", "stock.writeoff", "sales.record",
                             "transfers.request"}),
}

DEV_USER: dict[str, Any] = {"id": None, "username": "dev", "full_name": "Developer (auth disabled)",
                            "role": "owner", "store_id": None, "active": 1, "created_at": None,
                            "last_login": None, "dev": True}


def auth_enabled() -> bool:
    """Auth enforcement switch, read on every call: env MEDFORECAST_AUTH != "0"."""
    return os.environ.get("MEDFORECAST_AUTH", "1").strip() != "0"


def cookie_secure() -> bool:
    return os.environ.get("MEDFORECAST_COOKIE_SECURE", "0").strip() == "1"


# ---------------------------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------------------------
def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of `password` against a hash_password() string. Never raises."""
    try:
        algo, it, salt, digest = (stored or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), base64.b64decode(salt), int(it))
        return hmac.compare_digest(dk, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


_DUMMY_HASH = hash_password("timing-equaliser", iterations=PBKDF2_ITERATIONS)


def password_problem(password: str) -> str | None:
    """Return a human message if the password is too weak, else None."""
    if len(password) < 8:
        return "Password must be at least 8 characters"
    if len(password) > 128:
        return "Password must be at most 128 characters"
    if password.isalpha() or password.isdigit():
        return "Password must mix letters with digits or symbols"
    return None


# ---------------------------------------------------------------------------------------------
# Login rate limiting (in-memory, per process)
# ---------------------------------------------------------------------------------------------
_fail: dict[tuple[str, str], deque] = defaultdict(deque)
_fail_lock = threading.Lock()
_SWEEP_AT = 1000                     # sweep stale keys once the table grows past this many entries


def _prune(q: deque, now: float) -> None:
    while q and now - q[0] > RATE_WINDOW_S:
        q.popleft()


def _sweep(now: float) -> None:
    """Drop keys whose failures have all aged out (bounds memory under username spraying)."""
    if len(_fail) <= _SWEEP_AT:
        return
    for k in [k for k, q in _fail.items() if not q or now - q[-1] > RATE_WINDOW_S]:
        _fail.pop(k, None)


def _wait_s(q: deque, now: float) -> int:
    return max(1, int(RATE_WINDOW_S - (now - q[0])) + 1)


def rate_limited(username: str, ip: str) -> int:
    """Seconds until the (username, ip) pair may try again; 0 when allowed."""
    now = time.monotonic()
    with _fail_lock:
        q = _fail.get((username.lower(), ip))
        if not q:
            return 0
        _prune(q, now)
        if len(q) < RATE_MAX_FAILURES:
            return 0
        return _wait_s(q, now)


def reserve_attempt(username: str, ip: str) -> int:
    """Atomically check the limit AND count this attempt as a failure up front.

    Returns 0 when the attempt may proceed, else the seconds to wait. Counting before the (slow)
    password check closes the race where many parallel requests all pass a separate check before
    any failure is recorded. Call clear_failures() after a successful login."""
    now = time.monotonic()
    key = (username.lower(), ip)
    with _fail_lock:
        q = _fail[key]
        _prune(q, now)
        if len(q) >= RATE_MAX_FAILURES:
            return _wait_s(q, now)
        q.append(now)
        _sweep(now)
        return 0


def record_failure(username: str, ip: str) -> None:
    with _fail_lock:
        now = time.monotonic()
        q = _fail[(username.lower(), ip)]
        _prune(q, now)
        q.append(now)
        _sweep(now)


def clear_failures(username: str, ip: str) -> None:
    with _fail_lock:
        _fail.pop((username.lower(), ip), None)


def clear_user_failures(username: str) -> None:
    """Forget failures for a username from every IP (an owner reset its password / re-activated it)."""
    u = username.lower()
    with _fail_lock:
        for k in [k for k in _fail if k[0] == u]:
            _fail.pop(k, None)


def reset_rate_limits() -> None:
    """Forget every recorded failure (tests)."""
    with _fail_lock:
        _fail.clear()


# ---------------------------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------------------------
USER_COLS = "id, username, full_name, role, store_id, active, created_at, last_login"


def public_user(row: dict | None) -> dict | None:
    """Strip secrets from a users row (never expose password_hash)."""
    if row is None:
        return None
    return {k: row.get(k) for k in ("id", "username", "full_name", "role", "store_id", "active",
                                     "created_at", "last_login")}


def get_user(user_id: int) -> dict | None:
    return db.query_one(f"SELECT {USER_COLS} FROM users WHERE id = ?", (user_id,))


def list_users() -> list[dict]:
    return db.query(f"SELECT {USER_COLS} FROM users ORDER BY active DESC, role, username")


def create_user(username: str, password: str, role: str, full_name: str = "", store_id: str | None = None) -> dict:
    """Insert a user (validates role/store rules). Raises ValueError with a readable message."""
    username = username.strip().lower()
    _check_role_store(role, store_id)
    msg = password_problem(password)
    if msg:
        raise ValueError(msg)
    if db.query_one("SELECT 1 FROM users WHERE username = ?", (username,)):
        raise ValueError(f"Username '{username}' is already taken")
    pw_hash = hash_password(password)
    try:
        cur = db.execute(
            "INSERT INTO users(username, full_name, role, store_id, password_hash, active, created_at) VALUES (?,?,?,?,?,1,?)",
            (username, full_name.strip(), role, store_id, pw_hash, db.now_iso()))
    except sqlite3.IntegrityError as e:  # lost a race with a concurrent create of the same name
        if "username" in str(e).lower():
            raise ValueError(f"Username '{username}' is already taken") from e
        raise ValueError(f"Rejected by data integrity rules: {e}") from e
    return get_user(cur.lastrowid)


def _check_role_store(role: str, store_id: str | None) -> None:
    if role not in ROLES:
        raise ValueError(f"Unknown role '{role}'")
    if role == "pharmacist" and not store_id:
        raise ValueError("A pharmacist must be assigned to a store")
    if role == "owner" and store_id:
        raise ValueError("Owners always have access to every store (store must be empty)")
    if store_id and not db.query_one("SELECT 1 FROM stores WHERE id = ?", (store_id,)):
        raise ValueError(f"Unknown store '{store_id}'")


def has_perm(user: dict | None, perm: str) -> bool:
    return bool(user) and perm in PERMISSIONS.get(user.get("role", ""), frozenset())


def permissions_for(user: dict) -> list[str]:
    return sorted(PERMISSIONS.get(user.get("role", ""), frozenset()))


def max_adjust(user: dict) -> int | None:
    """Largest |delta| this user may apply in one stock adjustment (None = unlimited, 0 = not allowed)."""
    if has_perm(user, "stock.adjust.large"):
        return None
    return PHARMACIST_ADJUST_LIMIT if has_perm(user, "stock.adjust") else 0


# ---------------------------------------------------------------------------------------------
# Stores (light helpers; inventory.store_list() is the richer version)
# ---------------------------------------------------------------------------------------------
def _stores() -> list[dict]:
    return db.query("SELECT id, name, city, demand_scale, is_main FROM stores ORDER BY is_main DESC, demand_scale DESC, id")


def main_store_id() -> str | None:
    return db.scalar("SELECT id FROM stores ORDER BY is_main DESC, demand_scale DESC, id LIMIT 1")


def accessible_stores(user: dict) -> list[dict]:
    """Stores the user may access, main store first. Each: id, name, city, demand_scale, is_main, simulated."""
    rows = _stores()
    if user.get("store_id"):
        rows = [r for r in rows if r["id"] == user["store_id"]]
    return [{**r, "is_main": bool(r["is_main"]), "simulated": not r["is_main"]} for r in rows]


def can_access_store(user: dict, store_id: str) -> bool:
    return not user.get("store_id") or user["store_id"] == store_id


def default_store(user: dict) -> str | None:
    return user.get("store_id") or main_store_id()


def resolve_store(user: dict, requested_store_id: str | None = None, *, allow_all: bool = False) -> str | None:
    """Store a request should act on.

    * requested None/""  -> the session's selected store (falls back to the user's home / main store)
    * requested "all"/"*" with allow_all=True -> None meaning "every store"; 403 unless the user may
      access all stores
    * anything else      -> that store; 404 if it does not exist, 403 if the user may not access it
      (pharmacists: only their own store)
    """
    req = (requested_store_id or "").strip()
    if not req:
        sel = user.get("selected_store")
        if sel and can_access_store(user, sel):
            return sel
        return default_store(user)
    if req.lower() in ("all", "*"):
        if not allow_all:
            raise HTTPException(400, "This endpoint needs a single store, not 'all'")
        if user.get("store_id"):
            raise HTTPException(403, "You can only access your own store")
        return None
    if not db.query_one("SELECT 1 FROM stores WHERE id = ?", (req,)):
        raise HTTPException(404, f"Unknown store '{req}'")
    if not can_access_store(user, req):
        raise HTTPException(403, "You can only access your own store")
    return req


# ---------------------------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------------------------
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utc(dt_iso: str) -> datetime:
    dt = datetime.fromisoformat(dt_iso)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)  # naive values are stored UTC


def create_session(user_id: int, store_id: str | None) -> str:
    """Create a session and return the raw token (only its hash is stored)."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    db.execute("INSERT INTO sessions(token_hash, user_id, store_id, created_at, expires_at) VALUES (?,?,?,?,?)",
               (_token_hash(token), user_id, store_id, now.isoformat(timespec="seconds"),
                (now + timedelta(hours=SESSION_HOURS)).isoformat(timespec="seconds")))
    return token


def delete_session(token: str | None) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))


def delete_user_sessions(user_id: int, except_token: str | None = None) -> None:
    if except_token:
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", (user_id, _token_hash(except_token)))
    else:
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def purge_expired_sessions() -> int:
    return db.execute("DELETE FROM sessions WHERE expires_at <= ?", (db.now_iso(),)).rowcount


def load_session(token: str | None) -> dict | None:
    """Validate a raw token -> {"user": user-dict, "token": raw, "expires_at", "refreshed": bool} or None.

    Expired sessions and inactive users are rejected (and expired rows deleted). Applies the
    sliding expiry: if the session was last extended more than SLIDE_AFTER ago, expires_at moves
    to now + 12 h and "refreshed" is True (the caller should re-send the cookie).
    """
    if not token or len(token) > 200:
        return None
    th = _token_hash(token)
    row = db.query_one(
        f"SELECT s.store_id AS selected_store, s.expires_at, u.id, u.username, u.full_name, u.role, "
        f"u.store_id, u.active, u.created_at, u.last_login "
        f"FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (th,))
    if row is None:
        return None
    now = datetime.now(timezone.utc)
    if _utc(row["expires_at"]) <= now:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (th,))
        return None
    if not row["active"]:
        return None
    refreshed = False
    new_exp = now + timedelta(hours=SESSION_HOURS)
    if new_exp - _utc(row["expires_at"]) >= SLIDE_AFTER:
        db.execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", (new_exp.isoformat(timespec="seconds"), th))
        row["expires_at"] = new_exp.isoformat(timespec="seconds")
        refreshed = True
    user = {k: row[k] for k in ("id", "username", "full_name", "role", "store_id", "active", "created_at", "last_login")}
    sel = row["selected_store"]
    if not sel or not can_access_store(user, sel):
        sel = default_store(user)
    user["selected_store"] = sel
    user["dev"] = False
    return {"user": user, "token": token, "expires_at": row["expires_at"], "refreshed": refreshed}


def set_session_store(token: str, store_id: str) -> None:
    db.execute("UPDATE sessions SET store_id = ? WHERE token_hash = ?", (store_id, _token_hash(token)))


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="lax",
                        secure=cookie_secure(), path="/")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=cookie_secure())


def session_cookie_header(token: str) -> bytes:
    """Raw Set-Cookie header value (used by the ASGI middleware for sliding refresh)."""
    c = SimpleCookie()
    c[COOKIE_NAME] = token
    m = c[COOKIE_NAME]
    m["path"] = "/"
    m["max-age"] = SESSION_HOURS * 3600
    m["httponly"] = True
    m["samesite"] = "Lax"
    if cookie_secure():
        m["secure"] = True
    return m.OutputString().encode("latin-1")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------------------------
def session_from_request(request: Request) -> dict | None:
    """The validated session for this request (cached on request.state by AuthMiddleware)."""
    st = request.scope.setdefault("state", {})
    if "mf_session" in st:
        return st["mf_session"]
    sess = load_session(request.cookies.get(COOKIE_NAME))
    st["mf_session"] = sess
    return sess


def optional_user(request: Request) -> dict | None:
    """Logged-in user, the synthetic dev owner when auth is disabled, or None."""
    sess = session_from_request(request)
    if sess:
        return sess["user"]
    if not auth_enabled():
        u = dict(DEV_USER)
        pick = request.cookies.get(STORE_COOKIE)
        u["selected_store"] = pick if pick and db.query_one("SELECT 1 FROM stores WHERE id = ?", (pick,)) else main_store_id()
        return u
    return None


def current_user(request: Request) -> dict:
    """Dependency: the authenticated user (401 if none). With auth disabled, a dev owner is returned."""
    u = optional_user(request)
    if u is None:
        raise HTTPException(401, "Not authenticated")
    return u


def require_role(*roles: str) -> Callable[..., dict]:
    """Dependency factory: 403 unless the user's role is one of `roles`."""
    bad = set(roles) - set(ROLES)
    if bad:
        raise ValueError(f"unknown roles {bad}")

    def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(403, f"Requires role: {' or '.join(roles)}")
        return user
    return dep


def require_perm(perm: str) -> Callable[..., dict]:
    """Dependency factory: 403 unless the user's role grants `perm` (see PERMISSION_INFO)."""
    if perm not in PERMISSION_INFO:
        raise ValueError(f"unknown permission {perm!r}")

    def dep(user: dict = Depends(current_user)) -> dict:
        if not has_perm(user, perm):
            raise HTTPException(403, f"Your role ({user['role']}) cannot do this: {PERMISSION_INFO[perm].lower()}")
        return user
    return dep


def store_scope(store_id: str | None = Query(None, max_length=32, description="Store id; default = selected store"),
                user: dict = Depends(current_user)) -> str:
    """Dependency: a single accessible store id from ?store_id= (default: the session's selected store)."""
    sid = resolve_store(user, store_id)
    if sid is None:
        raise HTTPException(409, "No stores exist yet - run `python -m backend.seed`")
    return sid


def store_scope_all(store_id: str | None = Query(None, max_length=32, description="Store id, or 'all'"),
                    user: dict = Depends(current_user)) -> str | None:
    """Dependency: like store_scope but ?store_id=all returns None (= every store; 403 for single-store users)."""
    return resolve_store(user, store_id, allow_all=True)


def permission_matrix() -> dict:
    return {
        "roles": {r: {"label": ROLE_LABEL[r], "description": ROLE_BLURB[r], "permissions": sorted(PERMISSIONS[r]),
                      "all_stores": r != "pharmacist"} for r in ROLES},
        "permissions": PERMISSION_INFO,
        "matrix": [{"permission": p, "description": d, **{r: p in PERMISSIONS[r] for r in ROLES}}
                   for p, d in PERMISSION_INFO.items()],
        "limits": {"pharmacist_adjust_max": PHARMACIST_ADJUST_LIMIT, "session_hours": SESSION_HOURS,
                   "login_max_failures": RATE_MAX_FAILURES, "login_window_seconds": RATE_WINDOW_S},
    }


# ---------------------------------------------------------------------------------------------
# ASGI middleware (mounted in app.py)
# ---------------------------------------------------------------------------------------------
def _cookie_from_scope(scope) -> str | None:
    """Session cookie exactly as route code sees it (request.cookies), for http AND websocket scopes."""
    from starlette.requests import HTTPConnection
    return HTTPConnection(scope).cookies.get(COOKIE_NAME)


def _is_preflight(scope) -> bool:
    """A real CORS preflight (OPTIONS + Origin + Access-Control-Request-Method), not any OPTIONS."""
    if scope.get("method") != "OPTIONS":
        return False
    names = {k.lower() for k, _ in scope.get("headers") or []}
    return b"origin" in names and b"access-control-request-method" in names


class AuthMiddleware:
    """Pure-ASGI gate: when auth_enabled(), /api/* (except PUBLIC_PATHS and CORS preflight) needs a
    valid session cookie, else a 401 JSON {"detail": "Not authenticated"}. Validated sessions are
    cached in scope["state"]["mf_session"] for the dependencies; sliding refreshes re-send the cookie."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        from anyio import to_thread

        token = _cookie_from_scope(scope)
        sess = None
        if token:
            try:
                sess = await to_thread.run_sync(load_session, token)
            except Exception:  # DB problem: treat as anonymous rather than 500
                sess = None
        scope.setdefault("state", {})["mf_session"] = sess
        if scope["type"] == "websocket":
            if auth_enabled() and sess is None:
                # closing before accept makes the server reject the handshake (HTTP 403)
                return await send({"type": "websocket.close", "code": 1008})
            return await self.app(scope, receive, send)
        if (auth_enabled() and sess is None and scope["path"] not in PUBLIC_PATHS
                and not _is_preflight(scope)):
            from fastapi.responses import JSONResponse
            resp = JSONResponse({"detail": "Not authenticated"}, status_code=401)
            if token:  # stale cookie: tell the browser to drop it
                clear_session_cookie(resp)
            return await resp(scope, receive, send)

        if not (sess and sess.get("refreshed")):
            return await self.app(scope, receive, send)
        cookie = session_cookie_header(sess["token"])

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                # don't fight a login/logout response that sets the cookie itself
                if not any(k.lower() == b"set-cookie" and v.startswith(COOKIE_NAME.encode() + b"=") for k, v in headers):
                    headers.append((b"set-cookie", cookie))
                message = {**message, "headers": headers}
            await send(message)
        return await self.app(scope, receive, send_wrapper)
