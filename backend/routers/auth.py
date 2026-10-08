"""Auth endpoints: login/logout, current user, store switching, permission matrix, owner user admin.

    POST  /api/auth/login        {username, password}  -> me payload + httpOnly cookie mf_session
    POST  /api/auth/logout       (always 200; clears the cookie and the session)
    GET   /api/auth/status       {enabled, ...} public
    GET   /api/auth/me           me payload (user, role, permissions, stores, selected_store)
    POST  /api/auth/store        {store_id} switch the selected store (permission-checked)
    GET   /api/auth/permissions  role x permission matrix
    GET   /api/auth/users        owner only
    POST  /api/auth/users        owner only {username, full_name, role, store_id, password}
    PATCH /api/auth/users/{id}   owner only {full_name?, role?, store_id?, active?, password?}
Password hashes are never returned.
"""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from backend import auth as A
from backend import db
from backend.core import clean

router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")


def _me(user: dict) -> dict:
    stores = A.accessible_stores(user)
    sel = user.get("selected_store")
    sel_info = next((s for s in stores if s["id"] == sel), None)
    return clean({
        "user": A.public_user(user), "role": user["role"], "role_label": A.ROLE_LABEL[user["role"]],
        "permissions": A.permissions_for(user), "stores": stores, "all_stores": not user.get("store_id"),
        "selected_store": sel, "selected_store_info": sel_info,
        "auth_enabled": A.auth_enabled(), "dev": bool(user.get("dev")),
        "limits": {"adjust_max": A.max_adjust(user)},
    })


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    uname = body.username.strip().lower()
    ip = A.client_ip(request)
    # check-and-count atomically (the attempt counts as a failure until it succeeds), so parallel
    # requests cannot all slip past the limit while the slow password hash runs
    wait = A.reserve_attempt(uname, ip)
    if wait:
        raise HTTPException(429, f"Too many failed sign-in attempts. Try again in {max(1, round(wait / 60))} min.",
                            headers={"Retry-After": str(wait)})
    row = db.query_one("SELECT * FROM users WHERE username = ?", (uname,))
    ok = A.verify_password(body.password, row["password_hash"] if row else A._DUMMY_HASH) and row is not None
    if not ok or not row["active"]:
        if ok and not row["active"]:
            raise HTTPException(403, "This account is deactivated. Ask the owner to re-activate it.")
        raise HTTPException(401, "Invalid username or password")
    A.clear_failures(uname, ip)
    A.purge_expired_sessions()
    old = request.cookies.get(A.COOKIE_NAME)
    if old:
        A.delete_session(old)
    token = A.create_session(row["id"], A.default_store(row))
    db.execute("UPDATE users SET last_login = ? WHERE id = ?", (db.now_iso(), row["id"]))
    A.set_session_cookie(response, token)
    sess = A.load_session(token)
    return _me(sess["user"])


@router.post("/logout")
def logout(request: Request, response: Response):
    A.delete_session(request.cookies.get(A.COOKIE_NAME))
    A.clear_session_cookie(response)
    return {"ok": True}


@router.get("/status")
def status():
    return {"enabled": A.auth_enabled(), "cookie": A.COOKIE_NAME, "session_hours": A.SESSION_HOURS,
            "has_users": bool(db.scalar("SELECT COUNT(*) FROM users WHERE active = 1", default=0))}


@router.get("/me")
def me(user: dict = Depends(A.current_user)):
    return _me(user)


@router.get("/permissions")
def permissions():
    return A.permission_matrix()


class StoreBody(BaseModel):
    store_id: str = Field(min_length=1, max_length=32)


@router.post("/store")
def switch_store(body: StoreBody, request: Request, response: Response, user: dict = Depends(A.current_user)):
    sid = A.resolve_store(user, body.store_id)  # 404 unknown, 403 not accessible
    sess = A.session_from_request(request)
    if sess:
        A.set_session_store(sess["token"], sid)
    else:  # auth disabled, no session: remember the choice in a plain cookie
        response.set_cookie(A.STORE_COOKIE, sid, max_age=30 * 86400, samesite="lax", path="/")
    return _me({**user, "selected_store": sid})


# ---------------------------------------------------------------------------------------------
# Owner-only user administration
# ---------------------------------------------------------------------------------------------
Role = Literal["owner", "pharmacist", "buyer"]


class NewUser(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    full_name: str = Field("", max_length=80)
    role: Role
    store_id: str | None = Field(None, max_length=32)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def _uname(cls, v: str) -> str:
        v = v.strip().lower()
        if not USERNAME_RE.match(v):
            raise ValueError("3-32 characters: lowercase letters, digits, '.', '_' or '-' (must start with a letter or digit)")
        return v


class UserPatch(BaseModel):
    full_name: str | None = Field(None, max_length=80)
    role: Role | None = None
    store_id: str | None = Field(None, max_length=32)   # send null explicitly to mean "all stores"
    active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=128)


def _user_out(u: dict) -> dict:
    out = A.public_user(u)
    out["active"] = bool(out["active"])
    out["sessions"] = int(db.scalar("SELECT COUNT(*) FROM sessions WHERE user_id = ? AND expires_at > ?",
                                    (u["id"], db.now_iso()), default=0))
    return out


@router.get("/users")
def users(_: dict = Depends(A.require_perm("users.admin"))):
    return {"users": [_user_out(u) for u in A.list_users()], "stores": A.accessible_stores({"store_id": None}),
            "roles": [{"id": r, "label": A.ROLE_LABEL[r], "description": A.ROLE_BLURB[r]} for r in A.ROLES]}


@router.post("/users", status_code=201)
def create_user(body: NewUser, _: dict = Depends(A.require_perm("users.admin"))):
    store = body.store_id or None
    if body.role == "owner":
        store = None
    try:
        u = A.create_user(body.username, body.password, body.role, body.full_name, store)
    except ValueError as e:
        raise HTTPException(409 if "taken" in str(e) else 400, str(e))
    return _user_out(u)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request, me_: dict = Depends(A.require_perm("users.admin"))):
    u = A.get_user(user_id)
    if u is None:
        raise HTTPException(404, "Unknown user")
    fields = body.model_fields_set
    role = body.role if "role" in fields and body.role else u["role"]
    store = (body.store_id or None) if "store_id" in fields else u["store_id"]
    if role == "owner":
        store = None
    active = u["active"] if "active" not in fields or body.active is None else int(body.active)
    try:
        A._check_role_store(role, store)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if "password" in fields and body.password:
        msg = A.password_problem(body.password)
        if msg:
            raise HTTPException(400, msg)
    is_self = me_.get("id") == user_id
    with db.tx():
        cur = A.get_user(user_id) or u   # re-read under the write lock (concurrent admin edits)
        # never leave the system without an active owner (also stops owners locking themselves out)
        if cur["role"] == "owner" and cur["active"] and (role != "owner" or not active):
            others = db.scalar("SELECT COUNT(*) FROM users WHERE role='owner' AND active=1 AND id<>?", (user_id,), default=0)
            if others == 0:
                raise HTTPException(409, "At least one active owner must remain")
            if is_self:
                raise HTTPException(409, "You cannot demote or deactivate your own account")
        db.execute("UPDATE users SET full_name = ?, role = ?, store_id = ?, active = ? WHERE id = ?",
                   ((body.full_name.strip() if "full_name" in fields and body.full_name is not None else u["full_name"]),
                    role, store, active, user_id))
        if "password" in fields and body.password:
            db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (A.hash_password(body.password), user_id))
            A.delete_user_sessions(user_id, except_token=request.cookies.get(A.COOKIE_NAME) if is_self else None)
        if not active:
            A.delete_user_sessions(user_id)
    if active and ("password" in fields and body.password or not u["active"]):
        A.clear_user_failures(u["username"])  # a reset / re-activation also lifts a sign-in lockout
    return _user_out(A.get_user(user_id))
