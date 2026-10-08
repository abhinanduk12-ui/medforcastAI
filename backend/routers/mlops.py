"""Data upload, retraining and model registry (MLOps).

    /api/mlops/status                 registry + base-data + job summary, what the caller may do
    /api/mlops/uploads                POST raw file body (?filename=) or multipart (field "file"), <= 25 MB
    /api/mlops/uploads/{id}/report    validation report (errors / warnings with row samples)
    /api/mlops/uploads/{id}/accept    pending -> accepted   (owner)      /reject  (owner)
    /api/mlops/uploads/{id}           DELETE (owner)
    /api/mlops/datasets/preview       coverage of what a training run would use
    /api/mlops/train                  start a retraining job (owner; one at a time)
    /api/mlops/jobs[/{id}[/cancel]]   job progress, log tail, cancel
    /api/mlops/versions               registry: metrics side by side, champion, gate verdict
    /api/mlops/versions/{v}/promote   gate-checked promotion (owner; override needs a reason)
    /api/mlops/rollback               re-activate the previous champion (owner)
    /api/mlops/drift                  billing-ledger sales vs the active model's forecast

Permissions (no new permission exists for model management): every write is `settings.edit`
(owner only); reads need `view` (every role). Uploads hold sales lines only (no patient data).

A training job runs `python -m ml.train --data <dataset> --out ml/models_registry/<v>` and then
`python -m ml.explain` against the candidate as subprocesses; progress comes from the
"PROGRESS <pct> <message>" lines. Job state is JSON under <registry>/_jobs/ (not the DB, so a job
outliving a test's temp DB can never write into the real database).
"""
from __future__ import annotations

import email.parser
import email.policy
import json
import math
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Annotated

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Path as PathParam, Query, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from backend import db
from backend import inventory as inv
from backend.auth import current_user, has_perm, require_perm, store_scope
from backend.core import S, clean
from ml import config as C
from ml import ingest, registry

router = APIRouter(prefix="/api/mlops", tags=["mlops"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
TOLERANCE_KEY = "mlops.gate_tolerance"
UID = Annotated[str, PathParam(pattern=r"^u[0-9a-f]{12}$")]
VID = Annotated[str, PathParam(pattern=r"^v[0-9]{1,6}$")]
JID = Annotated[str, PathParam(pattern=r"^j[0-9a-f]{12}$")]
OWNER = require_perm("settings.edit")


def _err(e: Exception):
    status = getattr(e, "status", 400)
    return HTTPException(status, str(e))


def _tolerance() -> float:
    try:
        t = float(db.get_setting(TOLERANCE_KEY, registry.DEFAULT_TOLERANCE))
        return t if 0 <= t <= 0.5 else registry.DEFAULT_TOLERANCE
    except Exception:  # noqa: BLE001
        return registry.DEFAULT_TOLERANCE


def _uname(user: dict) -> str:
    return user.get("username") or "unknown"


def _safe(fn):
    try:
        fn()
    except Exception:  # noqa: BLE001
        pass


# Register ml/artifacts as v1 the first time the registry is used, and warm the base-data cache.
_safe(registry.bootstrap)
threading.Thread(target=lambda: _safe(ingest.ensure_base), daemon=True).start()


# --------------------------------------------------------------------------------------------------
# Status
# --------------------------------------------------------------------------------------------------

@router.get("/status")
def status(user: dict = Depends(current_user)):
    job = JOBS.current()
    return clean({
        "active_version": registry.active(),
        "serving_version": getattr(S, "version", None),
        "serving_dir": str(getattr(S, "artifact_dir", "")),
        "generated_at": S.meta.get("generated_at"),
        "versions": len(registry.versions()),
        "base_ready": ingest.base_ready(),
        "running_job": job,
        "can_manage": has_perm(user, "settings.edit"),
        "tolerance": _tolerance(),
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "rollback_target": registry.rollback_target(),
    })


# --------------------------------------------------------------------------------------------------
# Uploads
# --------------------------------------------------------------------------------------------------

def _parse_multipart(ctype: str, body: bytes) -> tuple[bytes, str]:
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + ctype.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if not msg.is_multipart():
        raise HTTPException(400, "Malformed multipart body")
    for part in msg.iter_parts():
        fn = part.get_filename()
        if fn:
            return part.get_payload(decode=True) or b"", fn
    raise HTTPException(400, "No file found in the form (use field 'file')")


@router.post("/uploads", status_code=201)
async def upload(request: Request, filename: str | None = Query(None, max_length=200),
                 user: dict = Depends(OWNER)):
    """Upload a sales file (.xlsx/.csv). Send the file as the raw body with ?filename=, or as
    multipart/form-data. It is validated and stored as a PENDING dataset (accept/reject next)."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_UPLOAD_BYTES + 64 * 1024:
            raise HTTPException(413, f"File too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    ctype = request.headers.get("content-type", "")
    content, name = bytes(buf), filename
    if ctype.lower().startswith("multipart/form-data"):
        content, name = _parse_multipart(ctype, content)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    if not content:
        raise HTTPException(400, "Empty file")
    if not name:
        raise HTTPException(400, "Missing filename (pass ?filename=sales.xlsx)")
    if not name.lower().endswith((".xlsx", ".xlsm", ".csv")):
        raise HTTPException(415, "Only .xlsx and .csv files are accepted")
    try:
        man = await run_in_threadpool(ingest.create_upload, content, name, _uname(user))
        rep = ingest.get_report(man["id"])
    except ingest.IngestError as e:
        raise _err(e)
    return clean({"upload": man, "report": rep})


@router.get("/uploads")
def uploads(_: dict = Depends(current_user)):
    return clean({"uploads": ingest.list_uploads(), "base_ready": ingest.base_ready()})


@router.get("/uploads/{uid}/report")
def upload_report(uid: UID, _: dict = Depends(current_user)):
    try:
        return clean({"upload": ingest.get_upload(uid), "report": ingest.get_report(uid)})
    except ingest.IngestError as e:
        raise _err(e)


class AcceptBody(BaseModel):
    add_new_medicines: bool = False


class RejectBody(BaseModel):
    reason: str | None = Field(None, max_length=300)


@router.post("/uploads/{uid}/accept")
def accept(uid: UID, body: AcceptBody | None = None, user: dict = Depends(OWNER)):
    try:
        body = body or AcceptBody()
        return clean({"upload": ingest.accept_upload(uid, add_new_medicines=body.add_new_medicines, user=_uname(user))})
    except ingest.IngestError as e:
        raise _err(e)


@router.post("/uploads/{uid}/reject")
def reject(uid: UID, body: RejectBody | None = None, user: dict = Depends(OWNER)):
    try:
        return clean({"upload": ingest.reject_upload(uid, user=_uname(user), reason=(body.reason if body else None))})
    except ingest.IngestError as e:
        raise _err(e)


@router.delete("/uploads/{uid}")
def delete_upload(uid: UID, _: dict = Depends(OWNER)):
    job = JOBS.current()
    if job and uid in (job.get("params", {}).get("uploads") or []):
        raise HTTPException(409, "This upload is being used by the running training job")
    try:
        ingest.delete_upload(uid)
    except ingest.IngestError as e:
        raise _err(e)
    return {"ok": True, "deleted": uid}


# --------------------------------------------------------------------------------------------------
# Dataset preview
# --------------------------------------------------------------------------------------------------

def _ledger_store() -> str | None:
    try:
        return inv.main_store_id()
    except inv.InventoryError:
        return None


def _upload_ids(raw: str | None) -> list[str]:
    ids = [x.strip() for x in (raw or "").split(",") if x.strip()]
    if len(ids) > 50:
        raise HTTPException(422, "At most 50 uploads")
    for x in ids:
        if not ingest.UPLOAD_ID_RE.match(x):
            raise HTTPException(422, f"Bad upload id {x!r}")
    return ids


def _gap_weeks(cov: dict) -> list[str]:
    weeks = [r["week"] for r in cov.get("timeline", [])]
    if not weeks:
        return []
    have = set(weeks)
    allw = pd.date_range(weeks[0], weeks[-1], freq="7D").strftime("%Y-%m-%d")
    return [w for w in allw if w not in have]


@router.get("/datasets/preview")
def preview(uploads: str | None = Query(None, max_length=2000, description="comma-separated accepted upload ids"),
            include_ledger: bool = Query(True), _: dict = Depends(current_user)):
    ids = _upload_ids(uploads)
    if not ingest.base_ready():
        threading.Thread(target=lambda: _safe(ingest.ensure_base), daemon=True).start()
        return {"ready": False, "message": "Preparing the base history (first use only, about 20 seconds). "
                                           "Try again shortly."}
    try:
        _, _, cov = ingest.assemble(ids, include_ledger, db_file=db.db_path(), ledger_store=_ledger_store())
    except ingest.IngestError as e:
        raise _err(e)
    gaps = _gap_weeks(cov)
    warnings = []
    if gaps:
        warnings.append(f"{len(gaps)} week(s) inside the date range have no sales from any source "
                        f"(first: {gaps[0]}). The model will read them as zero demand.")
    for s in cov["sources"]:
        if s.get("days_replaced_by_newer"):
            warnings.append(f"{s['label']}: {s['days_replaced_by_newer']} day(s) replaced by a newer source "
                            f"({s['dropped_overlap_rows']} rows dropped).")
        if s["kind"] == "ledger" and not s["rows_in"]:
            warnings.append("No sales have been billed through the app yet, so the ledger adds nothing.")
    return clean({"ready": True, **cov, "gap_weeks": gaps, "warnings": warnings,
                  "ledger_store": _ledger_store()})


# --------------------------------------------------------------------------------------------------
# Training jobs
# --------------------------------------------------------------------------------------------------

PROGRESS_RE = re.compile(r"^PROGRESS\s+(\d{1,3})\s+(.*)$")


class Jobs:
    """One training job at a time, run in a background thread that drives subprocesses."""

    def __init__(self):
        self._lock = threading.Lock()
        self._running: dict | None = None      # in-memory state of the live job
        self._proc: subprocess.Popen | None = None
        self._cancel = threading.Event()

    # -- persistence ------------------------------------------------------------------------------
    @staticmethod
    def _dir() -> Path:
        d = C.registry_dir() / "_jobs"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _save(self, job: dict) -> None:
        p = self._dir() / f"{job['id']}.json"
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(job, default=str), encoding="utf-8")
        os.replace(tmp, p)

    def get(self, jid: str) -> dict | None:
        with self._lock:
            if self._running and self._running["id"] == jid:
                return dict(self._running)
        try:
            job = json.loads((self._dir() / f"{jid}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if job.get("status") in ("queued", "preparing", "training", "explaining"):
            job["status"] = "interrupted"   # the server restarted while it ran
            job["message"] = "The API restarted while this job was running."
        return job

    def list(self, limit: int = 20) -> list[dict]:
        files = sorted(self._dir().glob("j*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
        out = []
        for f in files:
            j = self.get(f.stem)
            if j:
                j.pop("log_tail", None)
                out.append(j)
        return out

    def current(self) -> dict | None:
        with self._lock:
            if self._running:
                j = dict(self._running)
                j.pop("log_tail", None)
                return j
        return None

    # -- lifecycle --------------------------------------------------------------------------------
    def start(self, params: dict, user: str, db_file: Path, ledger_store: str | None) -> dict:
        with self._lock:
            if self._running:
                raise HTTPException(409, f"A training job is already running ({self._running['id']})")
            version = registry.create_candidate({"source": "training", "requested_by": user, "params": params})
            job = {"id": "j" + secrets.token_hex(6), "version": version, "status": "queued", "progress": 0,
                   "message": "Queued", "params": params, "user": user, "created_at": registry.now_iso(),
                   "started_at": None, "finished_at": None, "log_tail": [], "gate": None, "error": None}
            self._running = job
            self._cancel.clear()
            self._save(job)
        threading.Thread(target=self._run, args=(job, db_file, ledger_store), daemon=True,
                         name=f"mlops-{job['id']}").start()
        return dict(job)

    def cancel(self, jid: str) -> dict:
        with self._lock:
            if not self._running or self._running["id"] != jid:
                raise HTTPException(409, "That job is not running")
            self._cancel.set()
            proc = self._proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
        return {"ok": True, "id": jid, "status": "cancelling"}

    def _update(self, job: dict, **fields) -> None:
        with self._lock:
            job.update(fields)
            self._save(job)

    def _log(self, job: dict, tail: deque, line: str, logf) -> None:
        tail.append(line[:400])
        logf.write(line + "\n")
        logf.flush()

    def _run_proc(self, job, args, env, tail, logf, lo, hi, phase) -> int:
        self._update(job, status=phase)
        if self._cancel.is_set():
            return -1
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, cwd=str(C.ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=flags)
        with self._lock:
            self._proc = proc
        last_save = 0.0
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.rstrip()
            self._log(job, tail, line, logf)
            m = PROGRESS_RE.match(line)
            if m:
                pct = min(100, int(m.group(1)))
                self._update(job, progress=round(lo + (hi - lo) * pct / 100, 1), message=m.group(2)[:200],
                             log_tail=list(tail)[-40:])
                last_save = time.time()
            elif time.time() - last_save > 5:
                self._update(job, log_tail=list(tail)[-40:])
                last_save = time.time()
            if self._cancel.is_set() and proc.poll() is None:
                proc.terminate()
        rc = proc.wait()
        with self._lock:
            self._proc = None
        return rc

    def _run(self, job: dict, db_file: Path, ledger_store: str | None) -> None:
        v = job["version"]
        vdir = registry.version_dir(v)
        tail: deque = deque(maxlen=200)
        try:
            with open(vdir / "train.log", "a", encoding="utf-8") as logf:
                self._update(job, status="preparing", started_at=registry.now_iso(), progress=1,
                             message="Building the training dataset")
                ds_dir = ingest.uploads_dir() / "_training" / v
                xlsx, ds_man = ingest.build_training_dataset(
                    ds_dir, job["params"]["uploads"], job["params"]["include_ledger_sales"],
                    db_file=db_file, ledger_store=ledger_store)
                cov = ds_man.get("coverage") or {}
                registry.update_manifest(v, dataset={"path": str(ds_dir), "rows": ds_man["rows"],
                                                     "date_range": ds_man["date_range"],
                                                     "sales_sha256": ds_man["sales_sha256"]},
                                         data_sources=cov.get("sources", []))
                self._log(job, tail, f"Dataset: {ds_man['rows']:,} rows {ds_man['date_range']}", logf)
                self._update(job, progress=5, message="Dataset ready; starting training")
                env = {k: val for k, val in os.environ.items()
                       if k not in ("MEDFORECAST_ARTIFACTS", "MEDFORECAST_RAW")}
                env["PYTHONUNBUFFERED"] = "1"
                rc = self._run_proc(job, [sys.executable, "-m", "ml.train", "--data", str(ds_dir / "manifest.json"),
                                          "--out", str(vdir)], env, tail, logf, 5, 90, "training")
                if self._cancel.is_set():
                    raise _Cancelled()
                if rc != 0:
                    raise RuntimeError(f"ml.train exited with code {rc}")
                env2 = env | {"MEDFORECAST_ARTIFACTS": str(vdir), "MEDFORECAST_RAW": str(xlsx)}
                rc = self._run_proc(job, [sys.executable, "-m", "ml.explain"], env2, tail, logf, 90, 99, "explaining")
                if self._cancel.is_set():
                    raise _Cancelled()
                if rc != 0:
                    self._log(job, tail, f"WARNING: ml.explain exited with code {rc}; forecast explanations "
                                         "will be unavailable for this version.", logf)
                man = registry.finalize(v, "ready", job_id=job["id"], explain_ok=rc == 0)
                if man["status"] != "ready":
                    raise RuntimeError(man.get("error") or "training produced an incomplete artifact set")
                g = registry.gate(v, registry.active(), _TOL_SNAPSHOT.get(job["id"], registry.DEFAULT_TOLERANCE))
                self._update(job, status="succeeded", progress=100, message="Finished; ready to review",
                             finished_at=registry.now_iso(), gate=g, log_tail=list(tail)[-40:])
        except _Cancelled:
            _safe(lambda: registry.finalize(v, "cancelled", job_id=job["id"]))
            self._update(job, status="cancelled", message="Cancelled by the owner", finished_at=registry.now_iso(),
                         log_tail=list(tail)[-40:])
        except Exception as e:  # noqa: BLE001
            _safe(lambda: registry.finalize(v, "failed", job_id=job["id"], error=f"{type(e).__name__}: {e}"[:500]))
            self._update(job, status="failed", message="Training failed", error=f"{type(e).__name__}: {e}"[:500],
                         finished_at=registry.now_iso(), log_tail=list(tail)[-40:])
        finally:
            with self._lock:
                self._running = None
                self._proc = None
            _TOL_SNAPSHOT.pop(job["id"], None)


class _Cancelled(Exception):
    pass


_TOL_SNAPSHOT: dict[str, float] = {}
JOBS = Jobs()


class TrainBody(BaseModel):
    uploads: list[str] = Field(default_factory=list, max_length=50)
    include_ledger_sales: bool = True


@router.post("/train", status_code=202)
def train(body: TrainBody, user: dict = Depends(OWNER)):
    ids = _upload_ids(",".join(body.uploads))
    for uid in ids:
        try:
            m = ingest.get_upload(uid)
        except ingest.IngestError as e:
            raise _err(e)
        if m["status"] != "accepted":
            raise HTTPException(409, f"Upload {m['filename']} is {m['status']}; accept it first")
    if not ingest.base_ready():
        threading.Thread(target=lambda: _safe(ingest.ensure_base), daemon=True).start()
    job = JOBS.start({"uploads": ids, "include_ledger_sales": body.include_ledger_sales}, _uname(user),
                     db.db_path(), _ledger_store())
    _TOL_SNAPSHOT[job["id"]] = _tolerance()
    return clean({"job": job})


@router.get("/jobs")
def jobs(_: dict = Depends(current_user)):
    return clean({"jobs": JOBS.list(), "running": JOBS.current()})


@router.get("/jobs/{jid}")
def job(jid: JID, _: dict = Depends(current_user)):
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "Unknown job")
    return clean(j)


@router.post("/jobs/{jid}/cancel")
def cancel(jid: JID, _: dict = Depends(OWNER)):
    return JOBS.cancel(jid)


# --------------------------------------------------------------------------------------------------
# Versions, promotion, rollback
# --------------------------------------------------------------------------------------------------

def _version_row(r: dict) -> dict:
    man = r["manifest"]
    return {
        "version": r["version"], "active": r["active"], "status": man.get("status"),
        "created_at": man.get("created_at"), "finished_at": man.get("finished_at"), "source": man.get("source"),
        "requested_by": man.get("requested_by"), "promoted_at": man.get("promoted_at"),
        "promoted_by": man.get("promoted_by"), "code_hash": man.get("code_hash"), "note": man.get("note"),
        "holdout_window": man.get("holdout_window"), "error": man.get("error"), "explain_ok": man.get("explain_ok"),
        "params": man.get("params"), "dataset": man.get("dataset"),
        "data_sources": [{k: s.get(k) for k in ("key", "kind", "label", "rows_used", "units", "start", "end", "weeks",
                                               "sha256", "path")} for s in (man.get("data_sources") or [])],
        "summary": r["summary"], "gate": r["gate"],
    }


@router.get("/versions")
def versions(_: dict = Depends(current_user)):
    tol = _tolerance()
    rows = [_version_row(r) for r in registry.list_versions(tol)]
    return clean({"versions": rows, "active": registry.active(), "serving": getattr(S, "version", None),
                  "tolerance": tol, "rollback_target": registry.rollback_target(),
                  "history": list(reversed(registry.history()))[:30]})


class PromoteBody(BaseModel):
    override: bool = False
    reason: str = Field("", max_length=500)


def _clear_model_caches() -> int:
    """Best-effort: clear module-level lru_caches in feature routers that derive from the model."""
    n = 0
    for name, mod in list(sys.modules.items()):
        if not name.startswith("backend.routers.") or mod is None:
            continue
        for attr in list(vars(mod).values()):
            if callable(attr) and hasattr(attr, "cache_clear") and getattr(attr, "__module__", "") == name:
                try:
                    attr.cache_clear()
                    n += 1
                except Exception:  # noqa: BLE001
                    pass
    return n


_swap_lock = threading.RLock()


def _activate(target: str | None, fn) -> dict:
    """Load `target` off to the side FIRST; only if it loads cleanly run the registry pointer change
    (which records history) and swap the loaded state in. A broken artifact set therefore never moves
    the ACTIVE pointer or leaves a phantom promote/rollback entry in history.json."""
    with _swap_lock:
        if not target:
            try:
                fn()  # let the registry raise its own, specific error
            except registry.RegistryError as e:
                raise _err(e)
            raise HTTPException(400, "Nothing to activate")
        try:
            vdir = registry.version_dir(target)
        except registry.RegistryError as e:
            raise _err(e)
        if (vdir / "forecast.csv").exists():
            fresh = type(S).__new__(type(S))
            try:
                fresh._read(vdir)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(409, f"{target} cannot be loaded ({type(e).__name__}: {str(e)[:160]}); "
                                         "the active model was not changed")
        else:
            fresh = None  # unknown / incomplete version: the registry call below raises the right error
        try:
            entry = fn()
        except registry.RegistryError as e:
            raise _err(e)
        if fresh is None or entry["version"] != target:
            S.reload(registry.version_dir(entry["version"]))
        else:
            with type(S)._lock:
                S.__dict__ = fresh.__dict__
        entry["caches_cleared"] = _clear_model_caches()
        entry["serving"] = S.version
        return entry


@router.post("/versions/{v}/promote")
def promote(v: VID, body: PromoteBody | None = None, user: dict = Depends(OWNER)):
    if JOBS.current() and JOBS.current().get("version") == v:
        raise HTTPException(409, "This version is still training")
    body = body or PromoteBody()
    tol = _tolerance()
    return clean(_activate(v, lambda: registry.promote(v, override=body.override, reason=body.reason,
                                                       user=_uname(user), tolerance=tol)))


class RollbackBody(BaseModel):
    reason: str = Field("", max_length=500)


@router.post("/rollback")
def rollback(body: RollbackBody | None = None, user: dict = Depends(OWNER)):
    with _swap_lock:  # re-entrant: the target cannot change between resolving and activating it
        target = registry.rollback_target()
        return clean(_activate(target, lambda: registry.rollback(user=_uname(user),
                                                                 reason=(body.reason if body else ""))))


# --------------------------------------------------------------------------------------------------
# Drift: ledger sales vs the active model's forecast
# --------------------------------------------------------------------------------------------------

def _psi(p: pd.Series, q: pd.Series) -> float:
    idx = p.index.union(q.index)
    p = p.reindex(idx, fill_value=0) / max(float(p.sum()), 1e-9)
    q = q.reindex(idx, fill_value=0) / max(float(q.sum()), 1e-9)
    p, q = p.clip(lower=1e-4), q.clip(lower=1e-4)
    return float(((p - q) * np.log(p / q)).sum())


@router.get("/drift")
def drift(store_id: str = Depends(store_scope), _: dict = Depends(current_user)):
    scale = inv.store_scale(store_id)
    today = ingest.today_ist()
    rows = db.query("SELECT medicine_id, -qty AS qty, created_at FROM movements WHERE store_id = ? AND kind = 'sale' "
                    "AND qty < 0 AND (ref IS NULL OR ref NOT LIKE 'RET-%')", (store_id,))
    fweeks = list(S.fweeks)
    base = {"store_id": store_id, "version": getattr(S, "version", None), "demand_scale": scale,
            "forecast_weeks": [fweeks[0], fweeks[-1]] if fweeks else None, "ledger_sales": len(rows)}
    if not rows:
        return clean(base | {"overlap_weeks": [], "status": "no_data",
                             "message": "No sales have been billed through the app for this store yet, so there is "
                                        "nothing to compare with the forecast."})
    led = pd.DataFrame(rows)
    ts = pd.to_datetime(led["created_at"], utc=True, errors="coerce").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    led = led.assign(day=ts.dt.normalize()).dropna(subset=["day"])
    led["week"] = (led["day"] - pd.to_timedelta(led["day"].dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
    first = led["week"].min()
    complete = [w for w in fweeks if w >= first and pd.Timestamp(w) + pd.Timedelta(days=6) < today]
    base |= {"ledger_first_sale": str(led["day"].min().date()), "ledger_last_sale": str(led["day"].max().date())}
    if not complete:
        return clean(base | {"overlap_weeks": [], "status": "no_overlap",
                             "message": (f"Billed sales start {base['ledger_first_sale']}; the active model forecasts "
                                         f"{fweeks[0]} to {fweeks[-1]}. There is no complete week in both yet, so "
                                         "drift cannot be measured honestly.")})
    a = led[led["week"].isin(complete)].groupby(["medicine_id", "week"])["qty"].sum()
    f = S.fc[S.fc["week"].isin(complete)].set_index(["medicine_id", "week"])["ensemble"] * scale
    idx = a.index.union(f.index)
    a, f = a.reindex(idx, fill_value=0).astype(float), f.reindex(idx, fill_value=0).astype(float)
    ya, yf = float(a.sum()), float(f.sum())
    item_wape = float((a - f).abs().sum() / max(ya, 1e-9))
    wk = pd.DataFrame({"a": a, "f": f}).groupby(level="week").sum()
    store_wape = float((wk["a"] - wk["f"]).abs().sum() / max(ya, 1e-9))
    cat = S.meds["category"]
    ca = a.groupby(a.index.get_level_values("medicine_id").map(cat)).sum()
    cf = f.groupby(f.index.get_level_values("medicine_id").map(cat)).sum()
    psi = _psi(ca, cf)
    mix = pd.DataFrame({"actual": ca / max(ca.sum(), 1e-9), "forecast": cf / max(cf.sum(), 1e-9)}).fillna(0)
    mix["diff"] = mix["actual"] - mix["forecast"]
    mix = mix.reindex(mix["diff"].abs().sort_values(ascending=False).index).head(8)
    bias = (yf - ya) / max(ya, 1e-9)
    notes = []
    if ya < 0.3 * yf:
        notes.append("Billed sales are under a third of the forecast. If not every sale is billed through the app "
                     "yet, the gap reflects partial POS use rather than model error.")
    if len(complete) < 4:
        notes.append(f"Only {len(complete)} complete week(s) overlap; treat these numbers as an early signal.")
    level = "stable" if psi < 0.1 else ("moderate shift" if psi < 0.25 else "large shift")
    return clean(base | {
        "status": "ok", "overlap_weeks": complete, "actual_units": ya, "forecast_units": yf,
        "item_week_wape": item_wape, "store_week_wape": store_wape, "bias": bias, "psi_category_mix": psi,
        "psi_level": level,
        "weekly": [{"week": w, "actual": float(wk.at[w, "a"]), "forecast": float(wk.at[w, "f"])} for w in wk.index],
        "category_mix": [{"category": c, **r} for c, r in mix.to_dict("index").items()],
        "notes": notes,
        "method": "Weeks are Monday-Sunday in India time; only complete weeks that the active model forecasts are "
                  "compared. Forecast is scaled by the store's demand_scale. PSI compares the category share of "
                  "billed units with the forecast's (<0.1 stable, 0.1-0.25 moderate, >0.25 large).",
    })
