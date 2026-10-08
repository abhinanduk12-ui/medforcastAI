"""Compute-device selection for training (GPU when available, CPU otherwise).

    MEDFORECAST_DEVICE=auto (default) | cpu | cuda

`auto` uses CUDA only after a real probe succeeds, so a machine without a GPU, without a
CUDA build of PyTorch, or with a broken driver silently trains on the CPU instead of failing.
"""
from __future__ import annotations

import os
from functools import lru_cache

# Deterministic cuBLAS kernels; must be set before CUDA initialises.
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")


def _wanted() -> str:
    v = os.environ.get("MEDFORECAST_DEVICE", "auto").strip().lower()
    return v if v in ("auto", "cpu", "cuda") else "auto"


@lru_cache(maxsize=None)
def torch_device() -> str:
    """'cuda' or 'cpu' for PyTorch."""
    if _wanted() == "cpu":
        return "cpu"
    try:
        import torch
        if torch.cuda.is_available():
            torch.zeros(1, device="cuda").sum().item()   # probe: driver + kernels actually work
            return "cuda"
    except Exception:
        pass
    if _wanted() == "cuda":
        raise RuntimeError("MEDFORECAST_DEVICE=cuda but PyTorch cannot use a CUDA GPU (CPU-only build or no driver).")
    return "cpu"


@lru_cache(maxsize=None)
def xgb_device() -> str:
    """'cuda' or 'cpu' for XGBoost (needs a CUDA-enabled XGBoost build and a working GPU)."""
    if _wanted() == "cpu":
        return "cpu"
    try:
        import numpy as np
        import xgboost as xgb
        if xgb.build_info().get("USE_CUDA"):
            d = xgb.DMatrix(np.arange(8, dtype=float).reshape(4, 2), label=np.arange(4, dtype=float))
            xgb.train({"device": "cuda", "tree_method": "hist", "verbosity": 0}, d, num_boost_round=1)
            return "cuda"
    except Exception:
        pass
    if _wanted() == "cuda":
        raise RuntimeError("MEDFORECAST_DEVICE=cuda but XGBoost cannot use a CUDA GPU.")
    return "cpu"


def describe() -> dict:
    info = {"requested": _wanted(), "torch": torch_device(), "xgboost": xgb_device()}
    try:
        import torch
        if info["torch"] == "cuda":
            info["gpu"] = torch.cuda.get_device_name(0)
    except Exception:
        pass
    return info
