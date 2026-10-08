"""Forecast accuracy metrics suited to intermittent count demand."""
from __future__ import annotations

import numpy as np


def wape(y, p):
    """Weighted absolute % error - robust to zeros, the standard retail-demand metric."""
    return float(np.abs(y - p).sum() / max(np.sum(y), 1e-9))


def summary(y, p) -> dict:
    y, p = np.asarray(y, float), np.asarray(p, float)
    return {
        "wape": wape(y, p),
        "mae": float(np.mean(np.abs(y - p))),
        "rmse": float(np.sqrt(np.mean((y - p) ** 2))),
        "bias": float((p.sum() - y.sum()) / max(y.sum(), 1e-9)),
        "accuracy": float(max(0.0, 1 - wape(y, p))),
    }
