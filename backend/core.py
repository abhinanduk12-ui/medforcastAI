"""Shared state and helpers for the MedForecast API (imported by app.py and every router)."""
from __future__ import annotations

import json
import math
import threading
from datetime import date
from pathlib import Path
from functools import lru_cache
from statistics import NormalDist

import numpy as np
import pandas as pd

from ml import config as C



class _ArtifactDir:
    """Path-like handle on the artifact directory the app currently serves (follows S.reload()).

    Resolution (ml.config.artifacts_dir): env MEDFORECAST_ARTIFACTS, else the model registry's active
    version (ml/models_registry/<v>/), else ml/artifacts. `A / "file.csv"` keeps working for routers
    that imported `A` before a promotion."""

    def path(self) -> Path:
        p = getattr(S, "artifact_dir", None) if "S" in globals() else None
        return Path(p) if p else C.artifacts_dir()

    def __truediv__(self, other):
        return self.path() / other

    def __fspath__(self):
        return str(self.path())

    def __str__(self):
        return str(self.path())

    def __repr__(self):
        return f"ArtifactDir({self.path()!s})"

    def __getattr__(self, name):
        return getattr(self.path(), name)


A = _ArtifactDir()
MIN_UPLIFT = 0.08       # smallest seasonal change worth acting on
MIN_SEASON_BASE = 1.0   # units/week needed before a medicine is ranked on seasonal uplift
SLOW_MOVER_RATE = 0.5   # units/week below which a medicine is stocked "on demand"


def demand_class(row: np.ndarray) -> tuple[str, float, float]:
    """Syntetos-Boylan classification from ADI (avg inter-demand interval) and CV^2 of non-zero sizes."""
    nz = row[row > 0]
    if len(nz) == 0:
        return "No sales", np.nan, np.nan
    adi = len(row) / len(nz)
    cv2 = float((nz.std() / nz.mean()) ** 2) if len(nz) > 1 else 0.0
    if adi < 1.32:
        return ("Smooth" if cv2 < 0.49 else "Erratic"), adi, cv2
    return ("Intermittent" if cv2 < 0.49 else "Lumpy"), adi, cv2


def poisson_quantile(mu: float, p: float) -> int:
    """Smallest k with P(Poisson(mu) <= k) >= p."""
    if mu <= 0:
        return 0
    k, term = 0, math.exp(-mu)
    cdf = term
    while cdf < p and k < 10_000:
        k += 1
        term *= mu / k
        cdf += term
    return k


class Store:
    """Model artifacts + derived tables shared by every request.

    load()/reload() build a complete new state off to the side and then swap it in with one
    __dict__ rebind under a lock, so a request never sees a half-loaded store (a request that
    straddles a promotion may read the old model for one attribute and the new for the next)."""

    _lock = threading.Lock()

    def load(self, path: str | Path | None = None):
        src = Path(path) if path else C.artifacts_dir()
        fresh = Store.__new__(Store)
        fresh._read(src)
        with Store._lock:
            self.__dict__ = fresh.__dict__
        return self

    reload = load

    def _read(self, A: Path):
        self.artifact_dir = A
        self.version = A.name if A.parent.resolve() == C.registry_dir().resolve() else None
        self.meta = json.loads((A / "store.json").read_text())
        self.metrics = json.loads((A / "metrics.json").read_text())
        self.meds = pd.read_csv(A / "medicines.csv").set_index("medicine_id")
        self.hist = pd.read_csv(A / "weekly_history.csv")
        self.fc = pd.read_csv(A / "forecast.csv")
        self.bt = pd.read_csv(A / "backtest.csv")
        self.msi = pd.read_csv(A / "med_season_index.csv")
        self.csi = pd.read_csv(A / "cat_season_index.csv")
        self.fest = pd.read_csv(A / "festival_impact.csv")
        from ml.seasonality import FEST_Z
        self.fest["significant"] = self.fest["z"] >= FEST_Z
        self.imp = pd.read_csv(A / "feature_importance.csv")
        self.weeks = sorted(self.hist["week"].unique())
        self.fweeks = sorted(self.fc["week"].unique())
        self.hist_wide = self.hist.pivot(index="medicine_id", columns="week", values="units").reindex(columns=self.weeks)
        self.fc_wide = self.fc.pivot(index="medicine_id", columns="week", values="ensemble").reindex(columns=self.fweeks)
        self.sig_wide = self.fc.pivot(index="medicine_id", columns="week", values="sigma").reindex(columns=self.fweeks)
        m = self.meds
        m["next4"] = self.fc_wide.iloc[:, :4].sum(1).reindex(m.index)
        m["next12"] = self.fc_wide.sum(1).reindex(m.index)
        m["last4"] = self.hist_wide.iloc[:, -4:].sum(1).reindex(m.index)
        m["last12"] = self.hist_wide.iloc[:, -12:].sum(1).reindex(m.index)
        cls = {mid: demand_class(row) for mid, row in zip(self.hist_wide.index, self.hist_wide.to_numpy())}
        m["demand_class"] = pd.Series({k: v[0] for k, v in cls.items()}).reindex(m.index)
        m["adi"] = pd.Series({k: v[1] for k, v in cls.items()}).reindex(m.index)
        m["cv2"] = pd.Series({k: v[2] for k, v in cls.items()}).reindex(m.index)
        # ABC class by revenue (A = top 80 % of revenue, B = next 15 %, C = rest)
        r = m["total_revenue"].fillna(0).sort_values(ascending=False)
        cum = r.cumsum() / max(r.sum(), 1)
        m["abc"] = pd.Series(np.where(cum <= 0.8, "A", np.where(cum <= 0.95, "B", "C")), index=r.index).reindex(m.index)
        self.meds = m


S = Store()
S.load()


def clean(o):
    """Make pandas/numpy output JSON-safe (NaN -> None, numpy scalars -> python)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if (math.isnan(o) or math.isinf(o)) else round(float(o), 4)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def season_today(d: date | None = None) -> str:
    return C.MONTH_TO_SEASON[(d or date.today()).month]


def next_season(s: str) -> str:
    i = C.SEASON_ORDER.index(s)
    return C.SEASON_ORDER[(i + 1) % len(C.SEASON_ORDER)]


def season_movers(season: str, n: int = 8, category: str | None = None) -> dict:
    m = S.meds.copy()
    if category:
        m = m[m["category"] == category]
    col = f"idx_{season}"
    m = m[m["base_level"] >= MIN_SEASON_BASE]
    m = m.assign(index=m[col], uplift=m[col] - 1, extra_weekly=m["base_level"] * (m[col] - 1),
                 expected_weekly=m["base_level"] * m[col])
    m["extra_revenue_weekly"] = m["extra_weekly"] * m["median_price"]
    cols = ["medicine_name", "generic_name", "category", "form", "base_level", "expected_weekly", "index",
            "uplift", "extra_weekly", "extra_revenue_weekly", "median_price", "abc"]
    rising = m[m["uplift"] >= MIN_UPLIFT].sort_values("extra_weekly", ascending=False).head(n)
    falling = m[m["uplift"] <= -MIN_UPLIFT].sort_values("extra_weekly").head(n)
    out = lambda d: d[cols].reset_index().to_dict("records")
    return {"rising": out(rising), "falling": out(falling)}


def strongest_season() -> str:
    """Season with the largest total extra weekly demand from rising medicines."""
    m = S.meds
    gain = {s: float((m["base_level"] * (m[f"idx_{s}"] - 1)).clip(lower=0).sum()) for s in C.SEASON_ORDER}
    return max(gain, key=gain.get)

def z_for(service: float) -> float:
    return NormalDist().inv_cdf(min(max(service, 0.5), 0.999))


def plan_rows(lead_time: int, review: int, service: float, m: pd.DataFrame) -> pd.DataFrame:
    cover = min(lead_time + review, len(S.fweeks))
    z = z_for(service)
    d = S.fc_wide.iloc[:, :cover].sum(1)
    sd = np.sqrt((S.sig_wide.iloc[:, :cover] ** 2).sum(1))
    out = m.assign(cover_demand=d.reindex(m.index), safety_stock=(z * sd).reindex(m.index))
    out["weekly_rate"] = out["cover_demand"] / cover
    out["order_up_to"] = np.ceil(out["cover_demand"] + out["safety_stock"])
    out["policy"] = "Forecast"
    # Very slow movers: a normal buffer massively overstocks (and risks expiry on costly
    # oncology / specialty items). Hold an exact Poisson quantile instead, usually 0-1 units.
    slow = out["weekly_rate"] < SLOW_MOVER_RATE
    out.loc[slow, "policy"] = "On demand"
    out.loc[slow, "order_up_to"] = [poisson_quantile(mu, service) for mu in out.loc[slow, "cover_demand"]]
    out.loc[slow, "safety_stock"] = (out.loc[slow, "order_up_to"] - out.loc[slow, "cover_demand"]).clip(lower=0)
    out["stock_value"] = out["order_up_to"] * out["median_price"]
    return out


_SALES_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def _load_sales() -> pd.DataFrame:
    from ml.data import load_raw
    sales, _ = load_raw()
    sales["expiry_date"] = pd.to_datetime(sales["expiry_date"])
    return sales


def get_sales() -> pd.DataFrame:
    """Raw transaction lines (batch, expiry, supplier, hour...). Parsed once, cached; concurrent
    first callers wait for the single parse instead of each re-reading the workbook."""
    with _SALES_LOCK:
        return _load_sales()
