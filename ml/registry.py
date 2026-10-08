"""Model registry: versioned artifact sets, an active (champion) pointer, and a champion/challenger gate.

Layout (root = env MEDFORECAST_REGISTRY or ml/models_registry/):

    ACTIVE                 name of the version the app serves ("v1"), swapped atomically (os.replace)
    history.json           promotion / rollback log (who, when, reason, override, gate verdict)
    v1/                    artifacts (forecast.csv, metrics.json, ...) + manifest.json
    v2/ ...                one directory per training run; manifest.status = training|ready|failed|cancelled

    python -m ml.registry bootstrap          # register ml/artifacts as v1 (copy, never move) if empty
    python -m ml.registry list
    python -m ml.registry register <dir>     # register an artifact dir trained outside the app
    python -m ml.registry promote <v> [--override --reason "..."]
    python -m ml.registry rollback

Gate (``gate()``): a candidate is promotable when its holdout WAPE is not worse than the champion's
by more than ``tolerance`` (absolute WAPE points, default 0.02) on BOTH item-week and category-week
level, measured on a comparable window:
  * same holdout window  -> the stored holdout metrics are compared directly;
  * different windows    -> both models' stored backtests are re-scored on the weeks they share inside
                            the candidate's holdout window (actuals taken from the candidate's data),
                            if at least MIN_OVERLAP_WEEKS weeks overlap. Caveat: on those weeks the two
                            models forecast from different origins/horizons;
  * otherwise            -> verdict "needs_override": promotion requires an explicit owner override
                            with a reason (recorded in history.json).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

REQUIRED = ["store.json", "metrics.json", "medicines.csv", "weekly_history.csv", "forecast.csv", "backtest.csv",
            "med_season_index.csv", "cat_season_index.csv", "festival_impact.csv", "feature_importance.csv"]
DEFAULT_TOLERANCE = 0.02
MIN_OVERLAP_WEEKS = 4
_lock = threading.RLock()


class RegistryError(ValueError):
    status = 400


class GateBlocked(RegistryError):
    status = 409


class UnknownVersion(RegistryError):
    status = 404


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def root() -> Path:
    return C.registry_dir()


def _valid(version: str) -> str:
    if not isinstance(version, str) or not C._VERSION_RE.match(version):
        raise UnknownVersion(f"Unknown model version {version!r}")
    return version


def version_dir(version: str) -> Path:
    return root() / _valid(version)


def _write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def file_sha256(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def code_hash() -> str:
    """Git-free fingerprint of the modelling code: sha256 over ml/**/*.py (sorted, path + content)."""
    h = hashlib.sha256()
    base = C.ROOT / "ml"
    for p in sorted(base.rglob("*.py")):
        rel = p.relative_to(base).as_posix()
        if rel.startswith(("models_registry/", "artifacts/")) or "__pycache__" in rel:
            continue
        h.update(rel.encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def holdout_window(metrics: dict | None) -> list[str] | None:
    try:
        w = metrics["protocol"]["fold_b"]["test"]
        return [str(w[0]), str(w[1])]
    except (KeyError, TypeError, IndexError):
        return None


def metrics_summary(metrics: dict | None) -> dict | None:
    """Headline holdout numbers (MedForecast ensemble) from a metrics.json."""
    if not metrics or "holdout" not in metrics:
        return None
    h = metrics["holdout"]
    ov = h.get("overall", {})
    ens = ov.get("ensemble", {})
    agg = h.get("aggregate", {})
    return {
        "item_week_wape": ens.get("wape"),
        "category_week_wape": agg.get("category_week", {}).get("ensemble"),
        "store_week_wape": agg.get("store_week", {}).get("ensemble"),
        "bias": ens.get("bias"),
        "skill_vs_ma8": ens.get("skill_vs_ma8"),
        "coverage_90": h.get("coverage_90"),
        "direction_accuracy": h.get("direction_accuracy"),
        "noise_floor_wape": h.get("noise_floor_wape"),
        "baselines": {k: v.get("wape") for k, v in ov.items() if k != "ensemble"},
        "holdout_window": holdout_window(metrics),
        "train_until": metrics.get("protocol", {}).get("final", {}).get("train_until"),
        "rows": metrics.get("protocol", {}).get("rows_per_fold"),
        "training_seconds": metrics.get("training_seconds"),
    }


# --------------------------------------------------------------------------------------------------
# Versions
# --------------------------------------------------------------------------------------------------

def versions() -> list[str]:
    r = root()
    if not r.exists():
        return []
    out = [p.name for p in r.iterdir() if p.is_dir() and C._VERSION_RE.match(p.name)]
    return sorted(out, key=lambda v: int(v[1:]))


def active() -> str | None:
    return C.active_version(root())


def read_manifest(version: str) -> dict:
    d = version_dir(version)
    m = _read_json(d / "manifest.json")
    if m is None:
        if not d.exists():
            raise UnknownVersion(f"Unknown model version {version!r}")
        m = {"version": version, "status": "ready" if is_complete(version) else "unknown"}
    return m


def write_manifest(version: str, manifest: dict) -> None:
    _write_json(version_dir(version) / "manifest.json", manifest)


def update_manifest(version: str, **fields) -> dict:
    with _lock:
        m = read_manifest(version)
        m.update(fields)
        write_manifest(version, m)
        return m


def is_complete(version: str) -> bool:
    d = version_dir(version)
    return all((d / f).exists() for f in REQUIRED)


def read_metrics(version: str) -> dict | None:
    return _read_json(version_dir(version) / "metrics.json")


def next_version() -> str:
    vs = versions()
    return f"v{(int(vs[-1][1:]) + 1) if vs else 1}"


def create_candidate(meta: dict | None = None) -> str:
    """Reserve the next version directory with a 'training' manifest. Returns the version name."""
    with _lock:
        root().mkdir(parents=True, exist_ok=True)
        while True:
            v = next_version()
            try:
                (root() / v).mkdir()
                break
            except FileExistsError:
                continue
        write_manifest(v, {"version": v, "status": "training", "created_at": now_iso(),
                           "code_hash": code_hash(), **(meta or {})})
        return v


def finalize(version: str, status: str, **fields) -> dict:
    """Mark a training run finished. A 'ready' version must contain every REQUIRED artifact."""
    if status == "ready" and not is_complete(version):
        missing = [f for f in REQUIRED if not (version_dir(version) / f).exists()]
        status, fields = "failed", {**fields, "error": f"missing artifacts: {', '.join(missing)}"}
    extra = {}
    if status == "ready":
        metrics = read_metrics(version)
        extra = {"holdout_window": holdout_window(metrics),
                 "artifact_hashes": {f: file_sha256(version_dir(version) / f) for f in REQUIRED}}
    return update_manifest(version, status=status, finished_at=now_iso(), **extra, **fields)


def register_dir(src: Path, *, source: str, data_sources: list | None = None, note: str | None = None) -> str:
    """Copy (never move) a complete artifact directory into the registry as a new ready version."""
    src = Path(src)
    missing = [f for f in REQUIRED if not (src / f).exists()]
    if missing:
        raise RegistryError(f"{src} is not a complete artifact set (missing {', '.join(missing)})")
    with _lock:
        v = create_candidate({"source": source, "registered_from": str(src), "note": note,
                              "data_sources": data_sources or []})
        for p in src.iterdir():
            if p.is_file():
                shutil.copy2(p, version_dir(v) / p.name)
        finalize(v, "ready")
        return v


def bootstrap(source: Path | None = None) -> str | None:
    """If the registry has no ready version, register ml/artifacts as v1 (a copy) and activate it.
    Returns the newly created version, or None if nothing was needed / possible."""
    with _lock:
        if any(read_manifest(v).get("status") == "ready" for v in versions()) and active():
            return None
        src = Path(source or C.DEFAULT_ARTIFACTS)
        if not (src / "forecast.csv").exists():
            return None
        raw = C.DEFAULT_RAW_XLSX
        data_sources = [{"kind": "base", "label": "Base history (data/raw/pharma_dataset.xlsx)",
                         "path": str(raw.relative_to(C.ROOT)) if raw.exists() else None,
                         "sha256": file_sha256(raw) if raw.exists() else None}]
        ready = [v for v in versions() if read_manifest(v).get("status") == "ready"]
        v = ready[0] if ready else register_dir(src, source="bootstrap", data_sources=data_sources,
                                                note="Initial model copied from ml/artifacts")
        _set_active(v)
        _append_history({"action": "bootstrap", "version": v, "previous": None, "at": now_iso(),
                         "user": "system", "reason": "Registered existing ml/artifacts", "override": False})
        return v


def _set_active(version: str) -> None:
    p = root() / "ACTIVE"
    tmp = p.with_name(f"ACTIVE.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(version, encoding="utf-8")
    os.replace(tmp, p)  # atomic on NTFS and POSIX: readers see the old or the new name, never half


def history() -> list[dict]:
    return _read_json(root() / "history.json", []) or []


def _append_history(entry: dict) -> None:
    h = history()
    h.append(entry)
    _write_json(root() / "history.json", h[-500:])


# --------------------------------------------------------------------------------------------------
# Champion / challenger gate
# --------------------------------------------------------------------------------------------------

def _load_bt(version: str) -> pd.DataFrame:
    return pd.read_csv(version_dir(version) / "backtest.csv", usecols=["medicine_id", "week", "ensemble", "actual"])


def _wapes(y: pd.Series, p: pd.Series, cat: pd.Series, week: pd.Series) -> tuple[float, float]:
    item = float(np.abs(y - p).sum() / max(float(y.sum()), 1e-9))
    df = pd.DataFrame({"y": y.to_numpy(), "p": p.to_numpy(), "c": cat.to_numpy(), "w": week.to_numpy()})
    agg = df.groupby(["c", "w"])[["y", "p"]].sum()
    catw = float(np.abs(agg["y"] - agg["p"]).sum() / max(float(agg["y"].sum()), 1e-9))
    return item, catw


def rescore_overlap(candidate: str, champion: str) -> dict | None:
    """Re-score both stored backtests on the weeks they share inside the candidate's holdout window."""
    try:
        cb, hb = _load_bt(candidate), _load_bt(champion)
    except (OSError, ValueError):
        return None
    weeks = sorted(set(cb["week"]) & set(hb["week"]))
    if len(weeks) < MIN_OVERLAP_WEEKS:
        return {"weeks": weeks, "n_weeks": len(weeks)}
    j = cb[cb["week"].isin(weeks)].merge(hb[hb["week"].isin(weeks)][["medicine_id", "week", "ensemble", "actual"]],
                                        on=["medicine_id", "week"], suffixes=("_cand", "_champ"))
    j = j.rename(columns={"actual_cand": "actual"})
    try:
        cats = pd.read_csv(version_dir(candidate) / "medicines.csv", usecols=["medicine_id", "category"])
        cat = j["medicine_id"].map(cats.set_index("medicine_id")["category"]).fillna("?")
    except (OSError, ValueError):
        cat = pd.Series("?", index=j.index)
    ci, cc = _wapes(j["actual"], j["ensemble_cand"], cat, j["week"])
    hi, hc = _wapes(j["actual"], j["ensemble_champ"], cat, j["week"])
    actuals_differ = bool((j["actual"] - j["actual_champ"]).abs().sum() > 1e-6)
    return {"weeks": weeks, "n_weeks": len(weeks), "rows": int(len(j)), "actuals_differ": actuals_differ,
            "candidate": {"item_week_wape": ci, "category_week_wape": cc},
            "champion": {"item_week_wape": hi, "category_week_wape": hc}}


def gate(candidate: str, champion: str | None = None, tolerance: float = DEFAULT_TOLERANCE) -> dict:
    """Champion/challenger verdict for `candidate`: pass | fail | needs_override | champion | not_ready."""
    champion = champion or active()
    man = read_manifest(candidate)
    out = {"candidate": candidate, "champion": champion, "tolerance": tolerance, "metrics": ["item_week_wape",
                                                                                            "category_week_wape"]}
    if man.get("status") != "ready" or not is_complete(candidate):
        return out | {"verdict": "not_ready", "comparable": False,
                      "explanation": f"{candidate} is not a finished model (status: {man.get('status')})."}
    if champion is None:
        return out | {"verdict": "pass", "comparable": False, "method": "no_champion",
                      "explanation": "There is no active model yet, so any finished model can be promoted."}
    if candidate == champion:
        return out | {"verdict": "champion", "comparable": True, "method": "same_version",
                      "explanation": f"{candidate} is the active model."}
    cm, hm = metrics_summary(read_metrics(candidate)), metrics_summary(read_metrics(champion))
    if not cm or not hm:
        return out | {"verdict": "needs_override", "comparable": False, "method": "missing_metrics",
                      "explanation": "Holdout metrics are missing for one of the models, so they cannot be compared. "
                                     "Promotion needs an owner override."}
    cw, hw = cm["holdout_window"], hm["holdout_window"]
    keys = ["item_week_wape", "category_week_wape"]
    same = bool(cw and cw == hw)
    r = rescore_overlap(candidate, champion) if same else None
    if same and not (r and "candidate" in r and r.get("actuals_differ")):
        method = "same_window"
        cand = {k: cm[k] for k in keys}
        champ = {k: hm[k] for k in keys}
        window = cw
        note = f"Both models were scored on the same holdout window ({cw[0]} to {cw[1]})."
    elif same:
        # Same weeks, but the candidate's data changed some holdout actuals (an upload or ledger sales
        # replaced those days): stored metrics would grade the two models against different truths, so
        # both stored backtests are re-scored against the candidate's (newer) actuals.
        method = "same_window_rescored"
        cand, champ = r["candidate"], r["champion"]
        window = [r["weeks"][0], r["weeks"][-1]]
        note = (f"Both models share the holdout window ({cw[0]} to {cw[1]}), but the candidate's data changed some of "
                "its actual sales, so both stored backtests were re-scored against the candidate's actuals.")
    else:
        r = rescore_overlap(candidate, champion)
        if not r or "candidate" not in r:
            n = (r or {}).get("n_weeks", 0)
            return out | {"verdict": "needs_override", "comparable": False, "method": "not_comparable",
                          "window": {"candidate": cw, "champion": hw}, "overlap_weeks": n,
                          "candidate_scores": {k: cm[k] for k in keys}, "champion_scores": {k: hm[k] for k in keys},
                          "explanation": (f"The holdout windows differ (candidate {cw}, champion {hw}) and the stored "
                                          f"backtests share only {n} week(s) (need {MIN_OVERLAP_WEEKS}). The two "
                                          "scores are not comparable; promotion needs an owner override with a reason.")}
        method = "rescored_overlap"
        cand, champ = r["candidate"], r["champion"]
        window = [r["weeks"][0], r["weeks"][-1]]
        note = (f"Holdout windows differ, so both stored backtests were re-scored on the {r['n_weeks']} weeks they "
                f"share ({window[0]} to {window[1]}) against the candidate's actuals. Caveat: on those weeks the "
                "models forecast from different origins.")
    deltas = {k: (None if cand[k] is None or champ[k] is None else float(cand[k] - champ[k])) for k in keys}
    label = {"item_week_wape": "item-week WAPE", "category_week_wape": "category-week WAPE"}
    pct = lambda x: "n/a" if x is None else f"{x:.1%}"
    missing = [k for k, d in deltas.items() if d is None]
    if missing:
        return out | {"verdict": "needs_override", "comparable": False, "method": "missing_metrics",
                      "window": window, "candidate_scores": cand, "champion_scores": champ, "deltas": deltas,
                      "explanation": f"{note} {', '.join(label[k] for k in missing)} is missing for one of the models, "
                                     "so they cannot be compared. Promotion needs an owner override with a reason."}
    worse = [k for k, d in deltas.items() if d > tolerance]
    verdict = "fail" if worse else "pass"
    tol_txt = f"{tolerance * 100:.1f} WAPE points"
    if verdict == "pass":
        expl = (f"{note} Candidate is within the tolerance ({tol_txt}) on both measures: "
                + ", ".join(f"{label[k]} {pct(cand[k])} vs {pct(champ[k])}" for k in keys) + ".")
    else:
        expl = (f"{note} Candidate is worse than the champion by more than {tol_txt} on "
                + ", ".join(f"{label[k]} ({pct(cand[k])} vs {pct(champ[k])})" for k in worse)
                + ". Promotion needs an owner override with a reason.")
    return out | {"verdict": verdict, "comparable": True, "method": method, "window": window,
                  "candidate_scores": cand, "champion_scores": champ, "deltas": deltas, "explanation": expl}


# --------------------------------------------------------------------------------------------------
# Promote / rollback
# --------------------------------------------------------------------------------------------------

def promote(version: str, *, override: bool = False, reason: str = "", user: str = "system",
            tolerance: float = DEFAULT_TOLERANCE) -> dict:
    """Make `version` the active model (atomic pointer swap). Raises GateBlocked unless the gate
    passes or an override with a reason is given."""
    with _lock:
        _valid(version)
        if version not in versions():
            raise UnknownVersion(f"Unknown model version {version!r}")
        prev = active()
        g = gate(version, prev, tolerance)
        if g["verdict"] == "not_ready":
            raise RegistryError(g["explanation"])
        if g["verdict"] == "champion":
            raise RegistryError(f"{version} is already the active model")
        if g["verdict"] != "pass":
            if not override:
                raise GateBlocked(g["explanation"])
            if len((reason or "").strip()) < 5:
                raise RegistryError("An override needs a reason (at least 5 characters)")
        _set_active(version)
        entry = {"action": "promote", "version": version, "previous": prev, "at": now_iso(), "user": user,
                 "reason": (reason or "").strip()[:500], "override": bool(override and g["verdict"] != "pass"),
                 "gate": {"verdict": g["verdict"], "method": g.get("method"), "deltas": g.get("deltas")}}
        _append_history(entry)
        update_manifest(version, promoted_at=entry["at"], promoted_by=user)
        return entry


def _champion_stack() -> list[str]:
    """Versions in the order they became champion, with rolled-back ones popped (from history.json)."""
    stack: list[str] = []
    for e in history():
        a, v = e.get("action"), e.get("version")
        if a == "bootstrap":
            stack = [v]
        elif a == "promote":
            stack.append(v)
        elif a == "rollback":
            if stack:
                stack.pop()
            if not stack or stack[-1] != v:
                stack.append(v)
    return stack


def rollback_target() -> str | None:
    cur = active()
    stack = _champion_stack()
    if not stack or stack[-1] != cur:
        return None
    for t in reversed(stack[:-1]):
        if t != cur and t in versions() and is_complete(t):
            return t
    return None


def rollback(*, user: str = "system", reason: str = "") -> dict:
    """Re-activate the champion that preceded the current one (no gate: it was a champion before)."""
    with _lock:
        cur = active()
        target = rollback_target()
        if not target:
            raise RegistryError("There is no previous model to roll back to")
        _set_active(target)
        entry = {"action": "rollback", "version": target, "previous": cur, "at": now_iso(), "user": user,
                 "reason": (reason or "").strip()[:500], "override": False}
        _append_history(entry)
        return entry


def list_versions(tolerance: float = DEFAULT_TOLERANCE) -> list[dict]:
    cur = active()
    out = []
    for v in reversed(versions()):
        try:
            man = read_manifest(v)
        except RegistryError:
            continue
        summ = metrics_summary(read_metrics(v)) if man.get("status") == "ready" else None
        out.append({"version": v, "active": v == cur, "manifest": man, "summary": summ,
                    "gate": gate(v, cur, tolerance) if man.get("status") == "ready" else None})
    return out


def _main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m ml.registry")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("bootstrap")
    sub.add_parser("list")
    r = sub.add_parser("register")
    r.add_argument("path")
    p = sub.add_parser("promote")
    p.add_argument("version")
    p.add_argument("--override", action="store_true")
    p.add_argument("--reason", default="")
    sub.add_parser("rollback")
    a = ap.parse_args(argv)
    if a.cmd == "bootstrap":
        print(bootstrap() or f"registry already initialised (active: {active()})")
    elif a.cmd == "list":
        for row in list_versions():
            s = row["summary"] or {}
            print(f"{'*' if row['active'] else ' '} {row['version']:<6} {row['manifest'].get('status'):<10} "
                  f"item-week {s.get('item_week_wape')}  cat-week {s.get('category_week_wape')}  "
                  f"gate {(row['gate'] or {}).get('verdict')}")
    elif a.cmd == "register":
        print(register_dir(Path(a.path), source="cli"))
    elif a.cmd == "promote":
        print(promote(a.version, override=a.override, reason=a.reason, user="cli"))
    elif a.cmd == "rollback":
        print(rollback(user="cli"))


if __name__ == "__main__":
    _main()
