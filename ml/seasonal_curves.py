"""Batched seasonal curves for model features (point-in-time, vectorised).

Same specification as the Seasonal Intelligence engine (backend/seasonal.py), built for training:
    weekly units ~ quasi-Poisson,  log E[y] = a + sum_k c_k cos(k theta) + d_k sin(k theta),  K = 2
fitted for every medicine at once with batched IRLS (one design matrix, many series), then
    categories shrunk toward "flat" and medicines toward their category (empirical Bayes, tau^2 by moments).

`CurveBank.fit(Y, doy, cat_of)` takes only the weeks up to a forecast origin, so features built
from it never see the future. Multipliers are normalised so the average day of the year = 1.
"""
from __future__ import annotations

import numpy as np

YEAR = 365.25
K = 2              # harmonics for medicine curves
K_CAT = 3          # harmonics for category curves (more data, more detail); medicines borrow their first K
RIDGE = 1e-3
TAU2_FLOOR = 0.002
DAY_DOY = np.arange(1, 366, dtype=float)


def harmonics(doy, k_max: int = K) -> np.ndarray:
    th = 2 * np.pi * (np.asarray(doy, dtype=float) - 1) / YEAR
    return np.column_stack([f(k * th) for k in range(1, k_max + 1) for f in (np.cos, np.sin)])


_HD = harmonics(DAY_DOY)          # (365, 2K)


def batched_quasi_poisson(Y: np.ndarray, X: np.ndarray, iters: int = 30):
    """IRLS for many series sharing one design matrix. Y (m, n), X (n, p) -> beta (m, p), cov (m, p, p)."""
    m, n = Y.shape
    p = X.shape[1]
    P = np.eye(p) * RIDGE
    P[0, 0] = 0.0
    beta = np.zeros((m, p))
    beta[:, 0] = np.log(np.maximum(Y.mean(1), 1e-3))
    for _ in range(iters):
        eta = np.clip(beta @ X.T, -20, 20)
        mu = np.exp(eta)
        z = eta + (Y - mu) / mu
        A = np.einsum("np,mn,nq->mpq", X, mu, X) + P
        b = np.einsum("np,mn->mp", X, mu * z)
        new = np.linalg.solve(A, b[..., None])[..., 0]
        done = np.max(np.abs(new - beta)) < 1e-7
        beta = new
        if done:
            break
    mu = np.exp(np.clip(beta @ X.T, -20, 20))
    A = np.einsum("np,mn,nq->mpq", X, mu, X) + P
    phi = np.maximum(1.0, ((Y - mu) ** 2 / mu).sum(1) / max(n - p, 1))
    cov = np.linalg.inv(A) * phi[:, None, None]
    return beta, cov


class CurveBank:
    """Shrunk harmonic coefficients per medicine; evaluates multipliers at any day of year."""

    def __init__(self, h: np.ndarray):
        self.h = h                                               # (n_med, 2K)
        self.norm = np.exp(self.h @ _HD.T).mean(1)               # mean over the year of exp(h)

    @classmethod
    def fit(cls, Y: np.ndarray, doy: np.ndarray, cat_of: np.ndarray, tx: np.ndarray | None = None,
            min_cat_units_per_week: float = 300 / 56):
        """Y (n_med, n_weeks) units observed up to the origin; doy (n_weeks,) week-midpoint day of year;
        tx (same shape) bills per week — medicines with >= 20 bills estimate the shrinkage prior, as in the engine."""
        n_med, n = Y.shape
        nh = 2 * K
        if n < 8:                                                # too little history for a yearly shape
            return cls(np.zeros((n_med, nh)))
        X = np.column_stack([np.ones(n), harmonics(doy)])
        Xc = np.column_stack([np.ones(n), harmonics(doy, K_CAT)])
        cats = np.unique(cat_of)
        Yc = np.vstack([Y[cat_of == c].sum(0) for c in cats])
        bc, cc = batched_quasi_poisson(Yc + 1e-9, Xc)
        hc, se_c = bc[:, 1:], np.diagonal(cc, axis1=1, axis2=2)[:, 1:]
        solid = Yc.sum(1) >= min_cat_units_per_week * n
        if solid.any():
            tau2_c = np.maximum((hc[solid] ** 2).mean(0) - se_c[solid].mean(0), TAU2_FLOOR)
        else:
            tau2_c = np.full(2 * K_CAT, TAU2_FLOOR)
        hc_shrunk = hc * (tau2_c / (tau2_c + se_c))              # categories -> flat
        cat_idx = np.searchsorted(cats, cat_of)
        prior = hc_shrunk[cat_idx][:, :nh]                       # medicines borrow the category's first K harmonics

        sold = Y.sum(1) > 0
        h = prior.copy()
        if sold.any():
            bm, cm = batched_quasi_poisson(Y[sold], X)
            hm, se_m = bm[:, 1:], np.diagonal(cm, axis1=1, axis2=2)[:, 1:]
            dev = hm - prior[sold]
            busy = (tx[sold].sum(1) if tx is not None else Y[sold].sum(1)) >= 20
            if busy.any():
                tau2 = np.maximum((dev[busy] ** 2).mean(0) - se_m[busy].mean(0), TAU2_FLOOR)
            else:
                tau2 = np.full(nh, TAU2_FLOOR)
            h[sold] = prior[sold] + (tau2 / (tau2 + se_m)) * dev     # medicines -> their category
        return cls(h)

    def mult(self, doy) -> np.ndarray:
        """Multiplier for every medicine at each day of year: (n_med, len(doy))."""
        H = harmonics(np.atleast_1d(doy))
        return np.exp(self.h @ H.T) / self.norm[:, None]
