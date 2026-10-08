"""SQLite persistence for MedForecast (stores, users, sessions, stock batches, movements, transfers).

Database file: data/medforecast.db, overridable with env MEDFORECAST_DB (read at *connect* time, so a
test can point the whole app at a throwaway copy - see backend/testing.py:temp_db()).

Concurrency model
-----------------
* One sqlite3 connection per (thread, database path). FastAPI runs sync endpoints in a thread pool,
  so every worker thread gets its own connection; no connection is ever used by two threads at once.
* WAL journal (readers never block the writer), foreign keys ON, busy_timeout 10 s.
* Connections run in autocommit mode. Use ``with tx() as con:`` for anything that writes more than
  one row: it issues ``BEGIN IMMEDIATE`` (takes the write lock up front, so read-modify-write logic
  such as FEFO allocation cannot interleave with another writer) and COMMITs, or ROLLBACKs on any
  exception. ``tx()`` nests: an inner ``tx()`` becomes a SAVEPOINT.

Public API (import as ``from backend import db``)
-------------------------------------------------
    db.db_path() -> Path                         current database file (env-aware)
    db.connect() -> sqlite3.Connection           this thread's connection (schema ensured on first use)
    db.tx() -> ContextManager[Connection]        transaction / savepoint
    db.query(sql, params=()) -> list[dict]       SELECT -> list of plain dicts
    db.query_one(sql, params=()) -> dict | None
    db.scalar(sql, params=(), default=None)      first column of first row
    db.execute(sql, params=()) -> sqlite3.Cursor single statement (cursor.lastrowid / .rowcount)
    db.executemany(sql, seq) -> int              rowcount
    db.get_setting(key, default=None) / db.set_setting(key, value)   JSON values in `settings`
    db.register_schema(component, steps)         feature modules add their OWN tables (see below)
    db.init_db()                                 idempotent: core schema + registered migrations
    db.close_all(path=None)                      close cached connections (tests / file deletion)
    db.now_iso() -> str                          UTC timestamp 'YYYY-MM-DDTHH:MM:SS+00:00'

Feature modules that need their own tables must NOT edit this file; instead, at import time::

    from backend import db
    db.register_schema("myfeature", [
        "CREATE TABLE IF NOT EXISTS myfeature_things (id INTEGER PRIMARY KEY, ...)",   # step 1
        "ALTER TABLE myfeature_things ADD COLUMN extra TEXT",                          # step 2 (later)
    ])

Steps are applied once each, in order, per database file (tracked in `schema_migrations`), and are
re-applied automatically to any new database the process connects to (e.g. a test temp_db copy).
Never edit or reorder a published step - append a new one.

Time conventions: timestamps are UTC ISO-8601 strings (``now_iso()``); calendar dates (expiry) are
'YYYY-MM-DD' strings so they sort and compare correctly as text.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "medforecast.db"

SCHEMA_VERSION = 1  # core schema version (PRAGMA user_version)

_CORE_STEPS: list[str] = [
    # ---- v1 -----------------------------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS stores (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        city          TEXT NOT NULL DEFAULT '',
        demand_scale  REAL NOT NULL DEFAULT 1.0 CHECK (demand_scale > 0),
        is_main       INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
        created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
        id             INTEGER PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        full_name      TEXT NOT NULL DEFAULT '',
        role           TEXT NOT NULL CHECK (role IN ('owner', 'pharmacist', 'buyer')),
        store_id       TEXT NULL REFERENCES stores(id),
        password_hash  TEXT NOT NULL,
        active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at     TEXT NOT NULL,
        last_login     TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        store_id    TEXT NULL REFERENCES stores(id),
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS batches (
        id            INTEGER PRIMARY KEY,
        store_id      TEXT NOT NULL REFERENCES stores(id),
        medicine_id   TEXT NOT NULL,
        batch_no      TEXT NOT NULL,
        expiry_date   TEXT NOT NULL,
        qty_received  INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
        qty_on_hand   INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
        unit_cost     REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        supplier_id   TEXT NULL,
        received_at   TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'receipt' CHECK (source IN ('opening', 'receipt', 'transfer')),
        UNIQUE (store_id, medicine_id, batch_no)
    );
    CREATE INDEX IF NOT EXISTS ix_batches_store_med ON batches(store_id, medicine_id);
    CREATE INDEX IF NOT EXISTS ix_batches_expiry ON batches(expiry_date);
    CREATE INDEX IF NOT EXISTS ix_batches_med ON batches(medicine_id);
    CREATE TABLE IF NOT EXISTS movements (
        id           INTEGER PRIMARY KEY,
        store_id     TEXT NOT NULL REFERENCES stores(id),
        medicine_id  TEXT NOT NULL,
        batch_id     INTEGER NULL REFERENCES batches(id),
        kind         TEXT NOT NULL CHECK (kind IN ('receive', 'sale', 'adjust', 'transfer_out',
                                                   'transfer_in', 'expire_writeoff')),
        qty          INTEGER NOT NULL,
        unit_cost    REAL NULL,
        ref          TEXT NULL,
        note         TEXT NULL,
        user_id      INTEGER NULL REFERENCES users(id),
        created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_mov_store_med ON movements(store_id, medicine_id);
    CREATE INDEX IF NOT EXISTS ix_mov_created ON movements(created_at);
    CREATE INDEX IF NOT EXISTS ix_mov_kind ON movements(kind);
    CREATE INDEX IF NOT EXISTS ix_mov_batch ON movements(batch_id);
    CREATE TABLE IF NOT EXISTS transfers (
        id           INTEGER PRIMARY KEY,
        from_store   TEXT NOT NULL REFERENCES stores(id),
        to_store     TEXT NOT NULL REFERENCES stores(id),
        medicine_id  TEXT NOT NULL,
        qty          INTEGER NOT NULL CHECK (qty > 0),
        status       TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('requested', 'completed', 'cancelled')),
        reason       TEXT NULL,
        created_by   INTEGER NULL REFERENCES users(id),
        created_at   TEXT NOT NULL,
        CHECK (from_store <> to_store)
    );
    CREATE INDEX IF NOT EXISTS ix_transfers_from ON transfers(from_store, medicine_id);
    CREATE INDEX IF NOT EXISTS ix_transfers_to ON transfers(to_store, medicine_id);
    CREATE TABLE IF NOT EXISTS settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    """,
]

_MIGRATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    component   TEXT NOT NULL,
    step        INTEGER NOT NULL,
    applied_at  TEXT NOT NULL,
    PRIMARY KEY (component, step)
)"""

_registry: dict[str, list[str]] = {"core": _CORE_STEPS}
_registry_lock = threading.RLock()
_ready: set[str] = set()                       # db paths whose schema is fully applied this process
_local = threading.local()                     # per-thread {path: connection} and tx depth
_all_conns: list[tuple[str, sqlite3.Connection]] = []
_generation: dict[str, int] = {}               # bumped by close_all(); stale per-thread conns reopen
_conns_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db_path() -> Path:
    """Database file in effect *now* (env MEDFORECAST_DB, else data/medforecast.db)."""
    p = os.environ.get("MEDFORECAST_DB")
    return Path(p).resolve() if p else DEFAULT_DB


def _open(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=10.0, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 10000")
    try:
        con.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:  # pragma: no cover - e.g. read-only media
        pass
    con.execute("PRAGMA synchronous = NORMAL")
    return con


def connect() -> sqlite3.Connection:
    """This thread's connection to the current database, creating/migrating the schema on first use."""
    key = str(db_path())
    conns: dict = getattr(_local, "conns", None)
    if conns is None:
        conns = _local.conns = {}
    gen = _generation.get(key, 0)
    cached = conns.get(key)
    if cached is None or cached[0] != gen:          # none yet, or closed by close_all()
        con = _open(Path(key))
        conns[key] = (gen, con)
        with _conns_lock:
            _all_conns.append((key, con))
    else:
        con = cached[1]
    if key not in _ready:
        _apply_migrations(con, key)
    return con


def _apply_migrations(con: sqlite3.Connection, key: str) -> None:
    # Inside a caller's transaction (e.g. register_schema() called within tx(), or another thread
    # registered a component while this thread is mid-transaction) we must neither BEGIN again
    # ("cannot start a transaction within a transaction") nor block on _registry_lock while holding
    # the SQLite write lock (the registering thread may be waiting for that lock -> deadlock until
    # busy_timeout). So: never wait for the registry lock there, and apply pending steps inside a
    # SAVEPOINT of the caller's transaction (they commit or roll back with it).
    in_tx = con.in_transaction
    if not _registry_lock.acquire(blocking=not in_tx):
        return  # another thread is migrating right now; it marks the DB ready when done
    try:
        con.execute(_MIGRATIONS_TABLE)
        done = {(r[0], r[1]) for r in con.execute("SELECT component, step FROM schema_migrations")}
        applied = False
        for component, steps in _registry.items():
            for i, sql in enumerate(steps, start=1):
                if (component, i) in done:
                    continue
                con.execute("SAVEPOINT mf_migrate" if in_tx else "BEGIN IMMEDIATE")
                applied = True
                try:
                    # re-check inside the write lock (another process may have just applied it)
                    if con.execute("SELECT 1 FROM schema_migrations WHERE component=? AND step=?",
                                   (component, i)).fetchone() is None:
                        for stmt in _split_sql(sql):
                            con.execute(stmt)
                        con.execute("INSERT INTO schema_migrations(component, step, applied_at) VALUES (?,?,?)",
                                    (component, i, now_iso()))
                        if component == "core":
                            con.execute(f"PRAGMA user_version = {i}")
                    con.execute("RELEASE mf_migrate" if in_tx else "COMMIT")
                except Exception:
                    if in_tx:
                        con.execute("ROLLBACK TO mf_migrate")
                        con.execute("RELEASE mf_migrate")
                    elif con.in_transaction:
                        con.execute("ROLLBACK")
                    raise
        if not (in_tx and applied):  # steps applied inside a caller's tx may still roll back: re-check later
            _ready.add(key)
    finally:
        _registry_lock.release()


def _split_sql(script: str) -> list[str]:
    """Split an SQL script into complete statements (handles ';' inside literals/triggers)."""
    out, buf = [], ""
    for piece in script.split(";"):
        buf += piece + ";"
        if sqlite3.complete_statement(buf):
            if buf.strip().strip(";").strip():
                out.append(buf.strip())
            buf = ""
    if buf.strip().strip(";").strip():
        out.append(buf.strip().rstrip(";"))
    return out


def register_schema(component: str, steps: Sequence[str]) -> None:
    """Register ordered, append-only migration steps for a feature component and apply them now.

    Each step is a SQL script (may contain several ';'-separated statements) applied once per DB file.
    Use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS for safety. Table names should be
    prefixed with the component name to avoid collisions.
    """
    if component == "core":
        raise ValueError("'core' is reserved")
    with _registry_lock:
        prev = _registry.get(component, [])
        if list(steps[:len(prev)]) != prev:
            raise ValueError(f"migration steps for {component!r} were edited; only append new steps")
        _registry[component] = list(steps)
        _ready.clear()  # every known DB must pick up the new steps on its next connect()
    connect()


def init_db() -> Path:
    """Create / migrate the schema of the current database (idempotent). Returns its path."""
    _ready.discard(str(db_path()))
    connect()
    return db_path()


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Transaction context. Outermost: BEGIN IMMEDIATE..COMMIT/ROLLBACK; nested: SAVEPOINT.

    All db.query/db.execute calls made inside the block on the same thread join the transaction.
    """
    con = connect()
    depth = getattr(_local, "depth", {})
    _local.depth = depth
    key = str(db_path())
    d = depth.get(key, 0)
    if d == 0:
        con.execute("BEGIN IMMEDIATE")
    else:
        con.execute(f"SAVEPOINT sp{d}")
    depth[key] = d + 1
    try:
        yield con
    except BaseException:
        depth[key] = d
        try:
            if d == 0:
                if con.in_transaction:  # SQLite may already have rolled back (e.g. SQLITE_FULL)
                    con.execute("ROLLBACK")
            else:
                con.execute(f"ROLLBACK TO sp{d}")
                con.execute(f"RELEASE sp{d}")
        except sqlite3.Error:
            pass  # never mask the original exception with a rollback failure
        raise
    else:
        depth[key] = d
        if d == 0:
            try:
                con.execute("COMMIT")
            except BaseException:
                # a failed COMMIT leaves the transaction open; roll it back so this (pooled) thread's
                # connection is not stuck "inside a transaction" for every later request
                if con.in_transaction:
                    try:
                        con.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                raise
        else:
            con.execute(f"RELEASE sp{d}")


def in_tx() -> bool:
    return getattr(_local, "depth", {}).get(str(db_path()), 0) > 0


def query(sql: str, params: Sequence[Any] | dict = ()) -> list[dict]:
    """Run a SELECT and return rows as plain dicts."""
    return [dict(r) for r in connect().execute(sql, params).fetchall()]


def query_one(sql: str, params: Sequence[Any] | dict = ()) -> dict | None:
    r = connect().execute(sql, params).fetchone()
    return dict(r) if r is not None else None


def scalar(sql: str, params: Sequence[Any] | dict = (), default: Any = None) -> Any:
    r = connect().execute(sql, params).fetchone()
    return default if r is None or r[0] is None else r[0]


def execute(sql: str, params: Sequence[Any] | dict = ()) -> sqlite3.Cursor:
    """Run one statement (autocommits unless inside tx()). Use .lastrowid / .rowcount on the result."""
    return connect().execute(sql, params)


def executemany(sql: str, seq: Iterable[Sequence[Any] | dict]) -> int:
    cur = connect().executemany(sql, seq)
    return cur.rowcount


def get_setting(key: str, default: Any = None) -> Any:
    r = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    if r is None:
        return default
    try:
        return json.loads(r["value"])
    except (TypeError, ValueError):
        return default


def set_setting(key: str, value: Any) -> None:
    execute("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)))


def close_all(path: str | Path | None = None) -> None:
    """Close cached connections (all threads) for `path`, or every connection when path is None.

    Threads that cached a closed connection transparently reopen on their next connect().
    """
    target = str(Path(path).resolve()) if path is not None else None
    with _conns_lock:
        keep = []
        for key, con in _all_conns:
            if target is None or key == target:
                _generation[key] = _generation.get(key, 0) + 1
                try:
                    con.close()
                except Exception:
                    pass
                _ready.discard(key)
            else:
                keep.append((key, con))
        _all_conns[:] = keep
