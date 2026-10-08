"""Global gradient-boosted trees (XGBoost, Poisson objective for count-valued demand)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import xgboost as xgb

from .. import config as C
from ..device import xgb_device
from ..features import CAT_FEATURES, FEATURES


class GBMForecaster:
    name = "Gradient Boosting (Poisson)"

    params = dict(objective="count:poisson", eta=0.04, max_depth=6, min_child_weight=8,
                  subsample=0.85, colsample_bytree=0.8, reg_lambda=1.0, max_delta_step=0.7,
                  tree_method="hist", max_cat_to_onehot=1, seed=C.SEED, nthread=0)

    def __init__(self):
        # Train on the GPU when one is usable (same hist algorithm, ~10-20x faster); predict on the
        # CPU so pandas-backed DMatrix inputs never trigger device-mismatch copies.
        self.device = xgb_device()
        self.params = {**GBMForecaster.params, "device": self.device}
        self.booster = None
        self.best_rounds = 600
        self.curve: list[float] = []

    @staticmethod
    def _matrix(rows: pd.DataFrame, with_label=True) -> xgb.DMatrix:
        X = rows[FEATURES].copy()
        for c in CAT_FEATURES:
            X[c] = pd.Categorical(X[c].astype(int), categories=range(64))
        return xgb.DMatrix(X, label=rows["y"].to_numpy() if with_label else None, enable_categorical=True)

    def fit(self, rows: pd.DataFrame, val: pd.DataFrame | None = None, rounds: int | None = None):
        dtrain = self._matrix(rows)
        if val is not None:
            ev = {}
            self.booster = xgb.train(self.params | {"eval_metric": "mae"}, dtrain, num_boost_round=1500,
                                     evals=[(self._matrix(val), "val")], early_stopping_rounds=60,
                                     evals_result=ev, verbose_eval=False)
            self.best_rounds = self.booster.best_iteration + 1
            self.curve = [float(x) for x in ev["val"]["mae"]]
        else:
            self.booster = xgb.train(self.params, dtrain, num_boost_round=rounds or self.best_rounds)
            self.best_rounds = rounds or self.best_rounds
        self.booster.set_param({"device": "cpu"})
        return self

    def predict(self, rows: pd.DataFrame) -> np.ndarray:
        it = (0, self.best_rounds)
        return np.clip(self.booster.predict(self._matrix(rows, False), iteration_range=it), 0, None)

    def importance(self, rows: pd.DataFrame, n: int = 15000, repeats: int = 3) -> pd.DataFrame:
        """Permutation importance: increase in MAE when one feature is shuffled."""
        rng = np.random.default_rng(C.SEED)
        s = rows.sample(min(n, len(rows)), random_state=C.SEED).reset_index(drop=True)
        base = np.abs(self.predict(s) - s["y"]).mean()
        out = []
        for f in FEATURES:
            deltas = []
            for _ in range(repeats):
                p = s.copy()
                p[f] = rng.permutation(p[f].to_numpy())
                deltas.append(np.abs(self.predict(p) - p["y"]).mean() - base)
            out.append({"feature": f, "importance": float(np.mean(deltas)), "std": float(np.std(deltas))})
        return pd.DataFrame(out).sort_values("importance", ascending=False)
