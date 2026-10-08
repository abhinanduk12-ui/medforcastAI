"""Seasonal intelligence engine: continuous seasonal curves, significance, timing, archetypes.

The four-season indices in ml/seasonality.py say *how much* a season changes demand on average.
This engine models the *shape* of the year week by week, so it can say when a surge starts,
when it peaks, how sure we are, and when to order.

Model (per category, and per medicine)
    weekly units y_t ~ quasi-Poisson,  log E[y_t] = a + sum_k (c_k cos k*theta_t + d_k sin k*theta_t)
    theta_t = 2*pi * day_of_year(week midpoint) / 365.25
Fitted by IRLS (numpy only). Overdispersion phi = Pearson chi2 / (n - p) scales the covariance,
so bands and tests are honest about lumpy pharmacy demand.

    seasonal multiplier m(day) = exp(h(day)) / mean_over_year(exp(h))   (1.0 = an average week)

Medicines borrow strength from their category (empirical Bayes on the harmonic coefficients):
    beta_med* = beta_cat + w * (beta_med - beta_cat),  w = tau^2 / (tau^2 + se^2)
with tau^2 estimated by method of moments across medicines. Sparse items fall back to their
category's shape; well-sold items keep their own.

Significance: F test of the harmonic model against a flat (intercept-only) model using the
quasi-Poisson deviance drop, then Benjamini-Hochberg FDR control across all tested medicines.
Seasonality strength (Hyndman): var(seasonal) / (var(seasonal) + var(remainder)) on the log scale.

Data limits (stated in every response): ~56 weeks of history, so each part of the year is seen
once except August (seen twice). No trend term is fitted: store-level demand is flat year over year
in this data, and with one year a trend would be confounded with the annual cycle.
"""
from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np
import pandas as pd

from backend.core import S
from ml import config as C

YEAR = 365.25
K_CATEGORY = 3          # harmonics for category curves (more data, more detail)
K_MEDICINE = 2          # harmonics for medicine curves
RIDGE = 1e-3            # tiny ridge on harmonic terms for numerical stability
BAND_DRAWS = 300        # coefficient draws for the 90% band
SEASON_THRESHOLD = 1.10 # a "season window" is where the multiplier is >= +10%
MIN_TX_TEST = 12        # medicines with fewer bills are not tested (reported as insufficient data)
FDR_Q = 0.10
TAU2_FLOOR = 0.002
CATEGORY_MIN_UNITS = 300   # categories below this are shown, but flagged as small samples

# Kochi monthly rainfall climatology, mm (ERA5 1991-2020 via Open-Meteo archive; verified 2026-10-01).
RAIN_CLIMATOLOGY_MM = [9, 13, 40, 120, 294, 521, 469, 357, 272, 287, 164, 50]
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Display grid: 52 weekly points through a generic year (doy 1, 8, 15, ...), and a daily grid for timing.
GRID_DOY = np.arange(1, 365, 7, dtype=float)[:52]
DAY_DOY = np.arange(1, 366, dtype=float)


# ─────────────────────────── maths helpers ───────────────────────────

def _theta(doy) -> np.ndarray:
    return 2 * np.pi * (np.asarray(doy, dtype=float) - 1) / YEAR


def _design(doy, K: int, intercept: bool = True) -> np.ndarray:
    th = _theta(doy)
    cols = [np.ones_like(th)] if intercept else []
    for k in range(1, K + 1):
        cols += [np.cos(k * th), np.sin(k * th)]
    return np.column_stack(cols)


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for the regularised incomplete beta (Numerical Recipes, Lentz)."""
    tiny, eps = 1e-300, 3e-14
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > tiny else tiny)
        c = 1 + aa / c; c = c if abs(c) > tiny else tiny
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d; d = 1 / (d if abs(d) > tiny else tiny)
        c = 1 + aa / c; c = c if abs(c) > tiny else tiny
        delta = d * c
        h *= delta
        if abs(delta - 1) < eps:
            break
    return h


def _betainc(a: float, b: float, x: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    if x < (a + 1) / (a + b + 2):
        return math.exp(lbt) * _betacf(a, b, x) / a
    return 1 - math.exp(lbt) * _betacf(b, a, 1 - x) / b


def f_sf(F: float, d1: float, d2: float) -> float:
    """P(F(d1, d2) > F) — survival function of the F distribution (no scipy needed)."""
    if not np.isfinite(F) or F <= 0:
        return 1.0
    return _betainc(d2 / 2, d1 / 2, d2 / (d2 + d1 * F))


def bh_qvalues(p: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg adjusted q-values (monotone)."""
    p = np.asarray(p, dtype=float)
    n = len(p)
    if n == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(q, 0, 1)
    return out


@dataclass
class Fit:
    beta: np.ndarray            # [intercept, c1, d1, ...]
    cov: np.ndarray             # quasi-Poisson covariance (phi-scaled)
    phi: float
    deviance: float
    null_deviance: float
    n: int
    mu: np.ndarray
    ok: bool = True


def fit_quasi_poisson(y: np.ndarray, X: np.ndarray, iters: int = 30) -> Fit:
    y = np.asarray(y, dtype=float)
    n, p = X.shape
    ybar = max(y.mean(), 1e-6)
    beta = np.zeros(p)
    beta[0] = math.log(ybar)
    P = np.eye(p) * RIDGE
    P[0, 0] = 0.0
    for _ in range(iters):
        eta = np.clip(X @ beta, -20, 20)
        mu = np.exp(eta)
        z = eta + (y - mu) / mu
        XtW = X.T * mu
        A = XtW @ X + P
        try:
            new = np.linalg.solve(A, XtW @ z)
        except np.linalg.LinAlgError:
            return Fit(beta, np.eye(p), 1.0, 0.0, 0.0, n, mu, ok=False)
        if np.max(np.abs(new - beta)) < 1e-8:
            beta = new
            break
        beta = new
    mu = np.exp(np.clip(X @ beta, -20, 20))
    with np.errstate(divide="ignore", invalid="ignore"):
        ylogy = np.where(y > 0, y * np.log(y / mu), 0.0)
        ylog0 = np.where(y > 0, y * np.log(y / ybar), 0.0)
    dev = float(2 * np.sum(ylogy - (y - mu)))
    dev0 = float(2 * np.sum(ylog0 - (y - ybar)))
    phi = max(1.0, float(np.sum((y - mu) ** 2 / mu)) / max(n - p, 1))
    A = (X.T * mu) @ X + P
    try:
        cov = phi * np.linalg.inv(A)
    except np.linalg.LinAlgError:
        cov = np.eye(p) * 1e3
    return Fit(beta, cov, phi, dev, dev0, n, mu)


def multiplier(h_coef: np.ndarray, doy: np.ndarray, K: int) -> np.ndarray:
    """Seasonal multiplier curve normalised so the average day of the year = 1."""
    H = _design(doy, K, intercept=False)
    Hd = _design(DAY_DOY, K, intercept=False)
    norm = np.exp(Hd @ h_coef).mean()
    return np.exp(H @ h_coef) / norm


def band(h_coef: np.ndarray, h_cov: np.ndarray, doy: np.ndarray, K: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    try:
        draws = rng.multivariate_normal(h_coef, h_cov, size=BAND_DRAWS, check_valid="ignore")
    except Exception:
        draws = np.repeat(h_coef[None, :], BAND_DRAWS, axis=0)
    H = _design(doy, K, intercept=False)
    Hd = _design(DAY_DOY, K, intercept=False)
    curves = np.exp(draws @ H.T) / np.exp(draws @ Hd.T).mean(1, keepdims=True)
    lo, hi = np.percentile(curves, [5, 95], axis=0)
    return lo, hi


def timing(m_day: np.ndarray, threshold: float = SEASON_THRESHOLD) -> dict:
    """Peak, trough and the season window (where m >= threshold) on a 365-day circular curve."""
    peak = int(np.argmax(m_day))
    trough = int(np.argmin(m_day))
    out = {"peak_doy": peak + 1, "peak_mult": float(m_day[peak]), "trough_doy": trough + 1,
           "trough_mult": float(m_day[trough]), "amplitude": float(m_day[peak] / max(m_day[trough], 1e-9)),
           "onset_doy": None, "end_doy": None, "duration_days": 0}
    if m_day[peak] < threshold:
        return out
    n = len(m_day)
    start = peak
    for _ in range(n):
        prev = (start - 1) % n
        if m_day[prev] < threshold:
            break
        start = prev
    end = peak
    for _ in range(n):
        nxt = (end + 1) % n
        if m_day[nxt] < threshold:
            break
        end = nxt
    out.update(onset_doy=start + 1, end_doy=end + 1, duration_days=int((end - start) % n + 1))
    return out


def doy_to_date(doy: int, year: int) -> date:
    return date(year, 1, 1) + timedelta(days=int(doy) - 1)


def next_occurrence(doy: int, today: date) -> date:
    d = doy_to_date(doy, today.year)
    return d if d >= today else doy_to_date(doy, today.year + 1)


def in_window(today: date, onset: int, end: int) -> bool:
    t = today.timetuple().tm_yday
    return onset <= t <= end if onset <= end else (t >= onset or t <= end)


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = pd.Series(a).rank().to_numpy()
    rb = pd.Series(b).rank().to_numpy()
    if ra.std() == 0 or rb.std() == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def monthly_profile(m_day: np.ndarray) -> np.ndarray:
    d = pd.Timestamp("2025-01-01") + pd.to_timedelta(np.arange(365), unit="D")
    return pd.Series(m_day[:365]).groupby(d.month).mean().to_numpy()


# ─────────────────────────── the engine ───────────────────────────

@dataclass
class Curve:
    key: str
    level: str                  # "category" | "medicine"
    label: str
    category: str
    K: int
    h: np.ndarray               # harmonic coefficients used (shrunk for medicines)
    h_cov: np.ndarray
    grid: np.ndarray            # multiplier on GRID_DOY
    lo: np.ndarray
    hi: np.ndarray
    day: np.ndarray             # multiplier on DAY_DOY
    strength: float
    p: float | None
    q: float | None = None
    tested: bool = True
    shrink_weight: float | None = None
    tx: int = 0
    units: float = 0.0
    timing: dict = field(default_factory=dict)
    seasonal_class: str = "Steady"
    rain_corr: float | None = None
    small_sample: bool = False


class Engine:
    def __init__(self):
        self._lock = threading.Lock()
        self._key = None
        self.cat: dict[str, Curve] = {}
        self.med: dict[str, Curve] = {}
        self.week_doy: np.ndarray = np.array([])
        self.weeks: list[str] = []
        self.Y: pd.DataFrame | None = None
        self.archetypes: dict = {}
        self.yoy: list[dict] = []
        self.summary: dict = {}

    # Recompute whenever the served model/artifacts change.
    def ensure(self) -> "Engine":
        key = (id(S.hist), S.meta.get("generated_at"))
        if key == self._key:
            return self
        with self._lock:
            if key != self._key:
                self._build()
                self._key = key
        return self

    def _build(self):
        hist = S.hist.copy()
        hist["week"] = pd.to_datetime(hist["week"])
        Y = hist.pivot(index="medicine_id", columns="week", values="units").fillna(0.0)
        TX = hist.pivot(index="medicine_id", columns="week", values="tx").fillna(0.0)
        Y = Y.reindex(S.meds.index).fillna(0.0)
        TX = TX.reindex(S.meds.index).fillna(0.0)
        weeks = list(Y.columns)
        mid = pd.DatetimeIndex(weeks) + pd.Timedelta(days=3)
        self.week_doy = mid.dayofyear.to_numpy(dtype=float)
        self.weeks = [w.strftime("%Y-%m-%d") for w in weeks]
        self.Y = Y
        cats = S.meds["category"]

        # 1. Category curves (K=3)
        Xc = _design(self.week_doy, K_CATEGORY)
        cat_fit: dict[str, Fit] = {}
        for c in sorted(cats.unique()):
            ids = cats.index[cats == c]
            y = Y.loc[ids].sum(0).to_numpy()
            if y.sum() <= 0:
                continue
            cat_fit[c] = fit_quasi_poisson(y, Xc)
        # Sparse categories (a handful of sales a month) would otherwise get wild curves, so their harmonics
        # are shrunk toward "flat" in proportion to their sampling error (same empirical-Bayes rule as medicines).
        ncat = 2 * K_CATEGORY
        units_c = {c: float(Y.loc[cats.index[cats == c]].to_numpy().sum()) for c in cat_fit}
        solid = [c for c, f in cat_fit.items() if f.ok and units_c[c] >= CATEGORY_MIN_UNITS]
        if solid:
            b2 = np.array([cat_fit[c].beta[1:] ** 2 for c in solid])
            se2 = np.array([np.diag(cat_fit[c].cov)[1:] for c in solid])
            tau2_cat = np.maximum(b2.mean(0) - se2.mean(0), TAU2_FLOOR)
        else:
            tau2_cat = np.full(ncat, TAU2_FLOOR)
        self.cat = {}
        self._cat_h: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for c, f in cat_fit.items():
            ids = cats.index[cats == c]
            w_vec = tau2_cat / (tau2_cat + np.diag(f.cov)[1:])
            h = w_vec * f.beta[1:]
            W = np.diag(w_vec)
            hcov = W @ f.cov[1:, 1:] @ W
            self._cat_h[c] = (h, hcov)
            cv = self._curve(c, "category", c, c, K_CATEGORY, h, hcov, f,
                             int(TX.loc[ids].to_numpy().sum()), units_c[c], seed=sum(map(ord, c)) % 10_000,
                             shrink_weight=float(w_vec.mean()))
            cv.small_sample = units_c[c] < CATEGORY_MIN_UNITS
            self.cat[c] = cv

        # 2. Medicine fits (K=2) and empirical-Bayes shrinkage toward the category's first two harmonics.
        Xm = _design(self.week_doy, K_MEDICINE)
        nh = 2 * K_MEDICINE
        raw: dict[str, Fit] = {}
        for mid_ in Y.index:
            y = Y.loc[mid_].to_numpy()
            if y.sum() > 0:
                raw[mid_] = fit_quasi_poisson(y, Xm)
        tx_tot = TX.sum(1)
        busy = [m for m in raw if tx_tot[m] >= 20 and cats[m] in cat_fit and raw[m].ok]
        if busy:
            dev = np.array([raw[m].beta[1:] - self._cat_h[cats[m]][0][:nh] for m in busy])
            se2 = np.array([np.diag(raw[m].cov)[1:] for m in busy])
            tau2 = np.maximum((dev ** 2).mean(0) - se2.mean(0), TAU2_FLOOR)
        else:
            tau2 = np.full(nh, TAU2_FLOOR)

        self.med = {}
        pvals: dict[str, float] = {}
        for m in S.meds.index:
            c = cats[m]
            ch = self._cat_h.get(c)
            base_h = ch[0][:nh] if ch is not None else np.zeros(nh)
            base_cov = ch[1][:nh, :nh] if ch is not None else np.eye(nh) * 0.05
            f = raw.get(m)
            tx = int(tx_tot.get(m, 0))
            if f is None or not f.ok:
                h, hcov, w, p, tested = base_h, base_cov, 0.0, None, False
            else:
                se2 = np.diag(f.cov)[1:]
                w_vec = tau2 / (tau2 + se2)
                h = base_h + w_vec * (f.beta[1:] - base_h)
                W = np.diag(w_vec)
                hcov = W @ f.cov[1:, 1:] @ W + (np.eye(nh) - W) @ base_cov @ (np.eye(nh) - W)
                w = float(w_vec.mean())
                tested = tx >= MIN_TX_TEST
                p = None
                if tested:
                    d1, d2 = nh, max(f.n - (nh + 1), 1)
                    F = max(f.null_deviance - f.deviance, 0.0) / d1 / f.phi
                    p = f_sf(F, d1, d2)
                    pvals[m] = p
            self.med[m] = self._curve(m, "medicine", str(S.meds.at[m, "medicine_name"]), c, K_MEDICINE, h, hcov, f,
                                      tx, float(Y.loc[m].sum()), seed=int(m[-5:]) if m[-5:].isdigit() else 7,
                                      p=p, tested=tested, shrink_weight=w)

        # 3. FDR across tested medicines.
        if pvals:
            ids = list(pvals)
            q = bh_qvalues(np.array([pvals[i] for i in ids]))
            for i, qi in zip(ids, q):
                self.med[i].q = float(qi)
        cat_p = {c: cv.p for c, cv in self.cat.items() if cv.p is not None}
        if cat_p:
            q = bh_qvalues(np.array(list(cat_p.values())))
            for c, qi in zip(cat_p, q):
                self.cat[c].q = float(qi)
        for cv in self.cat.values():
            cv.seasonal_class = self._classify(cv)
        for cv in self.med.values():
            cv.seasonal_class = self._classify(cv)

        self._archetypes()
        self._yoy(hist)
        tested = [cv for cv in self.med.values() if cv.tested]
        self.summary = {
            "medicines_tested": len(tested),
            "medicines_significant": int(sum(1 for cv in tested if cv.q is not None and cv.q < FDR_Q)),
            "medicines_insufficient": int(sum(1 for cv in self.med.values() if not cv.tested)),
            "categories_significant": int(sum(1 for cv in self.cat.values() if cv.q is not None and cv.q < FDR_Q)),
            "categories": len(self.cat),
            "tau2": [float(x) for x in tau2],
            "weeks": len(self.weeks), "first_week": self.weeks[0], "last_week": self.weeks[-1],
        }

    def _curve(self, key, level, label, category, K, h, hcov, fit: Fit | None, tx, units, seed,
               p=None, tested=True, shrink_weight=None) -> Curve:
        grid = multiplier(h, GRID_DOY, K)
        day = multiplier(h, DAY_DOY, K)
        lo, hi = band(h, hcov, GRID_DOY, K, seed)
        # Strength on the log scale over the observed weeks.
        strength = 0.0
        if fit is not None and fit.ok and self.Y is not None:
            H = _design(self.week_doy, K, intercept=False)
            s = H @ h
            s = s - s.mean()
            y = (self.Y.loc[key].to_numpy() if level == "medicine"
                 else self.Y.loc[S.meds.index[S.meds["category"] == key]].sum(0).to_numpy())
            mu = np.exp(np.log(max(y.mean(), 1e-6)) + s)
            r = np.log((y + 0.5) / (mu + 0.5))
            vs, vr = float(np.var(s)), float(np.var(r))
            strength = vs / (vs + vr) if vs + vr > 0 else 0.0
        if level == "category" and fit is not None and fit.ok:
            d1, d2 = 2 * K, max(fit.n - (2 * K + 1), 1)
            F = max(fit.null_deviance - fit.deviance, 0.0) / d1 / fit.phi
            p = f_sf(F, d1, d2)
        rain = spearman(monthly_profile(day), np.array(RAIN_CLIMATOLOGY_MM, dtype=float))
        return Curve(key, level, label, category, K, h, hcov, grid, lo, hi, day, float(strength), p, None, tested,
                     shrink_weight, tx, units, timing(day), rain_corr=None if math.isnan(rain) else rain)

    def _classify(self, cv: Curve) -> str:
        """Seasonal class plus where the evidence comes from (own sales vs. its category)."""
        amp = cv.timing.get("amplitude", 1.0)
        own = cv.q is not None and cv.q < FDR_Q
        if own and amp >= 1.5:
            return "Strongly seasonal"
        if own and amp >= 1.2:
            return "Seasonal"
        if cv.level == "medicine" and amp >= 1.2:
            cat = self.cat.get(cv.category)
            if cat is not None and cat.q is not None and cat.q < FDR_Q:
                return "Seasonal (category evidence)"
            return "Possible pattern (weak evidence)"
        if cv.level == "category" and amp >= 1.2:
            return "Possible pattern (weak evidence)"
        return "Steady"

    # k-means on 12-month log-multiplier profiles; k chosen by silhouette (numpy only).
    def _archetypes(self):
        rows, ids = [], []
        for m, cv in self.med.items():
            if cv.tx >= 20:
                rows.append(np.log(monthly_profile(cv.day)))
                ids.append(m)
        if len(rows) < 12:
            self.archetypes = {"k": 0, "clusters": [], "silhouette": None}
            return
        X = np.array(rows)
        D = np.sqrt(((X[:, None, :] - X[None, :, :]) ** 2).sum(-1))

        def kmeans(k, seed):
            rng = np.random.default_rng(seed)
            cen = X[[rng.integers(len(X))]]
            for _ in range(1, k):            # k-means++ initialisation
                d2 = ((X[:, None, :] - cen[None]) ** 2).sum(-1).min(1)
                cen = np.vstack([cen, X[rng.choice(len(X), p=d2 / d2.sum() if d2.sum() > 0 else None)]])
            for _ in range(100):
                lab = ((X[:, None, :] - cen[None]) ** 2).sum(-1).argmin(1)
                new = np.array([X[lab == j].mean(0) if np.any(lab == j) else cen[j] for j in range(k)])
                if np.allclose(new, cen):
                    break
                cen = new
            inertia = float(((X - cen[lab]) ** 2).sum())
            return lab, cen, inertia

        def silhouette(lab):
            s = []
            for i in range(len(X)):
                same = lab == lab[i]
                if same.sum() <= 1:
                    s.append(0.0)
                    continue
                a = D[i, same].sum() / (same.sum() - 1)
                b = min(D[i, lab == j].mean() for j in set(lab.tolist()) if j != lab[i])
                s.append((b - a) / max(a, b) if max(a, b) > 0 else 0.0)
            return float(np.mean(s))

        best = None
        for k in range(3, 7):
            lab, cen, inertia = min((kmeans(k, seed) for seed in range(8)), key=lambda t: t[2])
            if len(set(lab.tolist())) < k:
                continue
            sil = silhouette(lab)
            if best is None or sil > best[3]:
                best = (k, lab, cen, sil)
        k, lab, cen, sil = best
        clusters = []
        used = set()
        for j in range(k):
            members = [ids[i] for i in range(len(ids)) if lab[i] == j]
            prof = np.exp(cen[j])
            prof = prof / prof.mean()
            amp = float(prof.max() / prof.min())
            peak_m = int(np.argmax(prof))
            if amp < 1.15:
                name = "Steady year-round"
            else:
                season = C.MONTH_TO_SEASON[peak_m + 1]
                name = f"{season} peak ({MONTH_NAMES[peak_m]})"
            if name in used:
                name = f"{name} · {len(used) + 1}"
            used.add(name)
            members.sort(key=lambda m: -self.med[m].units)
            cat_mix = pd.Series([self.med[m].category for m in members]).value_counts().head(3)
            clusters.append({
                "id": j, "name": name, "size": len(members), "amplitude": amp, "peak_month": MONTH_NAMES[peak_m],
                "profile": [float(x) for x in prof], "months": MONTH_NAMES,
                "rain_corr": spearman(prof, np.array(RAIN_CLIMATOLOGY_MM, dtype=float)),
                "top_categories": [{"category": c, "n": int(n)} for c, n in cat_mix.items()],
                "members": [{"id": m, "name": self.med[m].label, "category": self.med[m].category,
                             "units": self.med[m].units, "class": self.med[m].seasonal_class} for m in members[:25]],
            })
        clusters.sort(key=lambda c: (-c["amplitude"], -c["size"]))
        self.archetypes = {"k": k, "silhouette": sil, "clustered": len(ids), "clusters": clusters}

    def _yoy(self, hist: pd.DataFrame):
        """August was observed in both 2025 and 2026: the only month we can check for repeatability."""
        h = hist.merge(S.meds[["category"]], left_on="medicine_id", right_index=True)
        h["month"] = h["week"].dt.month
        h["year"] = h["week"].dt.year
        aug = h[h["month"] == 8]
        rows = []
        for c, g in aug.groupby("category"):
            w = g.groupby(["year", "week"])["units"].sum().groupby("year").mean()
            if 2025 in w.index and 2026 in w.index and w[2025] > 0:
                rows.append({"category": c, "aug_2025": float(w[2025]), "aug_2026": float(w[2026]),
                             "ratio": float(w[2026] / w[2025])})
        tot = aug.groupby(["year", "week"])["units"].sum().groupby("year").mean()
        self.yoy = sorted(rows, key=lambda r: -r["aug_2025"])
        self.summary_yoy_store = (float(tot.get(2026, 0) / tot.get(2025, 1)) if 2025 in tot.index else None)


ENGINE = Engine()


def engine() -> Engine:
    return ENGINE.ensure()


def warm():
    try:
        ENGINE.ensure()
    except Exception:
        pass
