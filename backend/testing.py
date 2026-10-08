"""Test helpers shared by every feature agent. Run tests from the project root.

    from backend.testing import temp_db, client_as, anon_client, fresh_db

    with temp_db():                       # throwaway COPY of data/medforecast.db for the whole block
        c = client_as("owner")            # logged-in TestClient, auth enforced (MEDFORECAST_AUTH=1)
        r = c.post("/api/inventory/receive", json={...})
        p = client_as("pharmacist")       # pharmacist.kochi (store KOCHI)
        p2 = client_as("pharmacist.tsr")  # any demo username works too
        a = anon_client()                 # not logged in -> 401 on protected routes

    with fresh_db():                      # brand-new empty DB, seeded deterministically (slower, ~5 s)
        ...

Rules: anything that WRITES (stock, users, sessions...) must run inside temp_db()/fresh_db() so the
real data/medforecast.db is never touched. Logging in writes a session row, so client_as() refuses
to run outside temp_db() unless you pass allow_real_db=True (read-only checks against the live DB).

Schema caveat: db.register_schema() is process-wide and is applied to EVERY database the process
connects to afterwards, including data/medforecast.db. A component registered only for a test
(throwaway table) must be removed with ``db._registry.pop(name, None)`` before the test leaves
temp_db() and touches the real DB again. Real feature components need nothing: the live server
applies them on import anyway.

Role shortcuts for client_as(): "owner" -> owner, "pharmacist" -> pharmacist.kochi (KOCHI),
"buyer" -> buyer. DEMO_PASSWORDS maps each demo username to its password.
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from backend import db
from backend.seed import DEMO_USERS

ROLE_USER = {"owner": "owner", "pharmacist": "pharmacist.kochi", "buyer": "buyer"}
DEMO_PASSWORDS = {u: pw for u, pw, *_ in DEMO_USERS}


def _app():
    from backend.app import app  # imported lazily: loads the model artifacts (a few seconds)
    return app


@contextmanager
def _pointing_at(path: Path) -> Iterator[Path]:
    prev = os.environ.get("MEDFORECAST_DB")
    os.environ["MEDFORECAST_DB"] = str(path)
    try:
        yield path
    finally:
        if prev is None:
            os.environ.pop("MEDFORECAST_DB", None)
        else:
            os.environ["MEDFORECAST_DB"] = prev
        db.close_all(path)
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(str(path) + suffix)
            except OSError:
                pass
        try:
            os.rmdir(path.parent)
        except OSError:
            pass


@contextmanager
def temp_db(source: str | Path | None = None) -> Iterator[Path]:
    """Copy the current database (default data/medforecast.db) to a temp file with SQLite's online
    backup API (consistent even while the live server writes) and point MEDFORECAST_DB at it for
    the duration of the block. The copy is deleted afterwards. Yields the temp path."""
    src = Path(source) if source else db.db_path()
    if not src.exists():
        raise FileNotFoundError(f"{src} does not exist - run `python -m backend.seed` first")
    tmp = Path(tempfile.mkdtemp(prefix="mf_test_")) / "medforecast_test.db"
    s = sqlite3.connect(str(src))
    d = sqlite3.connect(str(tmp))
    try:
        s.backup(d)
    finally:
        d.close()
        s.close()
    with _pointing_at(tmp) as p:
        db.init_db()
        yield p


@contextmanager
def fresh_db() -> Iterator[Path]:
    """Brand-new temp database seeded with backend.seed (deterministic demo data)."""
    tmp = Path(tempfile.mkdtemp(prefix="mf_test_")) / "medforecast_fresh.db"
    with _pointing_at(tmp) as p:
        from backend.seed import seed
        seed(reset=False, verbose=False)
        yield p


def _in_temp_db() -> bool:
    return Path(db.db_path()).resolve() != db.DEFAULT_DB.resolve()


def anon_client(auth: bool = True):
    """A TestClient with no session. auth=True sets MEDFORECAST_AUTH=1 (enforced) for this process."""
    from fastapi.testclient import TestClient
    os.environ["MEDFORECAST_AUTH"] = "1" if auth else "0"
    return TestClient(_app())


def login(client, username: str, password: str | None = None):
    """POST /api/auth/login on an existing client; returns the response."""
    return client.post("/api/auth/login", json={"username": username, "password": password or DEMO_PASSWORDS[username]})


def client_as(who: str = "owner", password: str | None = None, *, store_id: str | None = None,
              allow_real_db: bool = False):
    """Logged-in TestClient (auth enforced). `who` is a role ("owner"/"pharmacist"/"buyer") or a
    username. If store_id is given, switches the session's selected store. Raises AssertionError if
    the login fails."""
    if not allow_real_db and not _in_temp_db():
        raise RuntimeError("client_as() writes a session row: use it inside temp_db()/fresh_db() "
                           "(or pass allow_real_db=True)")
    username = ROLE_USER.get(who, who)
    c = anon_client(auth=True)
    r = login(c, username, password)
    assert r.status_code == 200, f"login as {username} failed: {r.status_code} {r.text}"
    if store_id:
        r = c.post("/api/auth/store", json={"store_id": store_id})
        assert r.status_code == 200, f"store switch to {store_id} failed: {r.status_code} {r.text}"
    return c
