"""Direct multi-horizon feature construction.

One training row = (medicine i, forecast origin o, horizon h). Features only use
information available at the end of week o, plus calendar facts about the target
week o+h that are known in advance (season, festivals, week-of-year).  A single
global model therefore learns all 12 horizons and shares strength across all
medicines - essential when each individual series is short and sparse.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import config as C
from .data import calendar_frame
from .seasonal_curves import CurveBank
from .seasonality import index_lookup

CAT_FEATURES_ALL = ["category_code", "form_code", "season_code"]


@dataclass
class Context:
    """Everything derived from the training window (t <= cutoff) needed to build features."""
    med_ids: np.ndarray
    Y: np.ndarray                 # [n_med, T] units
    cat_of: np.ndarray            # [n_med] category code
    form_of: np.ndarray
    Ycat: np.ndarray              # [n_cat, T]
    Ystore: np.ndarray            # [T]
    med_season_idx: np.ndarray    # [n_med, 4] (fit on t <= cutoff)
    cat_season_idx: np.ndarray    # [n_cat, 4]
    log_price: np.ndarray
    rx_share: np.ndarray
    scale: np.ndarray             # [n_med] mean weekly units on training window (>= 0.1)
    cutoff: int
    week_index: pd.DatetimeIndex  # weeks covering history + forecast horizon
    cal: pd.DataFrame             # calendar rows aligned with week_index
    categories: list
    forms: list
    panel: pd.DataFrame = None
    _idx_cache: dict = None
    TX: np.ndarray = None         # [n_med, T] bills per week (for the curve shrinkage prior)
    doy: np.ndarray = None        # [len(week_index)] day of year of each week's midpoint
    _curve_cache: dict = None

    def curves_at(self, o: int) -> CurveBank:
        """Point-in-time smooth seasonal curves (same model as Seasonal Intelligence) from weeks <= o."""
        o = min(o, self.cutoff)
        if o not in self._curve_cache:
            self._curve_cache[o] = CurveBank.fit(self.Y[:, : o + 1], self.doy[: o + 1], self.cat_of, tx=self.TX[:, : o + 1])
        return self._curve_cache[o]

    def season_idx_at(self, o: int):
        """Point-in-time seasonal indices using only weeks <= o (no look-ahead, even inside training)."""
        o = min(o, self.cutoff)
        if o not in self._idx_cache:
            med_mat, cat_mat, _, _ = index_lookup(self.panel[self.panel["t"] <= o])
            self._idx_cache[o] = (med_mat.reindex(self.med_ids).fillna(1.0)[C.SEASON_ORDER].to_numpy(),
                                  cat_mat.reindex(self.categories).fillna(1.0)[C.SEASON_ORDER].to_numpy())
        return self._idx_cache[o]


def build_context(panel: pd.DataFrame, master: pd.DataFrame, weeks: pd.DatetimeIndex, cutoff: int) -> Context:
    med_ids = master["medicine_id"].to_numpy()
    wide = panel.pivot(index="medicine_id", columns="t", values="units").reindex(med_ids)
    Y = wide.to_numpy(dtype=float)
    categories = sorted(master["category"].unique())
    forms = sorted(master["form"].unique())
    cat_of = master["category"].map({c: i for i, c in enumerate(categories)}).to_numpy()
    form_of = master["form"].map({f: i for i, f in enumerate(forms)}).to_numpy()
    Ycat = np.vstack([Y[cat_of == k].sum(0) for k in range(len(categories))])

    med_mat, cat_mat, _, _ = index_lookup(panel[panel["t"] <= cutoff])
    med_si = med_mat.reindex(med_ids).fillna(1.0)[C.SEASON_ORDER].to_numpy()
    cat_si = cat_mat.reindex(categories).fillna(1.0)[C.SEASON_ORDER].to_numpy()

    future = pd.date_range(weeks[-1] + pd.Timedelta(days=7), periods=C.HORIZON, freq="7D")
    week_index = weeks.append(future)
    TX = panel.pivot(index="medicine_id", columns="t", values="tx").reindex(med_ids).to_numpy(dtype=float)
    doy = (pd.DatetimeIndex(week_index) + pd.Timedelta(days=3)).dayofyear.to_numpy(dtype=float)
    return Context(
        med_ids=med_ids, Y=Y, cat_of=cat_of, form_of=form_of, Ycat=Ycat, Ystore=Y.sum(0),
        med_season_idx=med_si, cat_season_idx=cat_si,
        log_price=np.log1p(master["median_price"].to_numpy()), rx_share=master["rx_share"].to_numpy(),
        scale=np.maximum(Y[:, : cutoff + 1].mean(1), 0.1), cutoff=cutoff,
        week_index=week_index, cal=calendar_frame(week_index), categories=categories, forms=forms,
        panel=panel[["medicine_id", "category", "week", "season", "t", "units", "tx"]], _idx_cache={},
        TX=TX, doy=doy, _curve_cache={},
    )


def _season_codes(ctx: Context) -> np.ndarray:
    return ctx.cal["season"].map({s: i for i, s in enumerate(C.SEASON_ORDER)}).to_numpy()


def origin_features(ctx: Context, o: int) -> dict[str, np.ndarray]:
    """Per-medicine features summarising history up to and including week o."""
    Y = ctx.Y[:, : o + 1]
    n = Y.shape[1]

    def tail(k):
        return Y[:, max(0, n - k):]

    f = {}
    for k in range(1, 5):
        f[f"lag_{k}"] = Y[:, n - k] if n - k >= 0 else np.full(len(Y), np.nan)
    for k in (4, 8, 12):
        f[f"ma_{k}"] = tail(k).mean(1)
    f["hist_mean"] = Y.mean(1)
    f["std_8"] = tail(8).std(1)
    f["nz_8"] = (tail(8) > 0).mean(1)
    nz = Y > 0
    last = np.where(nz.any(1), n - 1 - np.argmax(nz[:, ::-1], axis=1), n)
    f["weeks_since_sale"] = np.minimum(last, 26)
    ema = np.zeros(len(Y))
    for j in range(n):
        ema = 0.3 * Y[:, j] + 0.7 * ema if j else Y[:, 0].astype(float)
    f["ema"] = ema
    f["momentum"] = f["ma_4"] / np.maximum(f["hist_mean"], 0.05)

    cat_hist = ctx.Ycat[:, : o + 1]
    cat_mom = cat_hist[:, -4:].mean(1) / np.maximum(cat_hist.mean(1), 1e-6)
    f["cat_momentum"] = cat_mom[ctx.cat_of]
    st = ctx.Ystore[: o + 1]
    f["store_momentum"] = np.full(len(Y), st[-4:].mean() / max(st.mean(), 1e-6))

    # Season the recent window sat in (avg index of last 8 weeks) - used to de-seasonalise.
    sc = _season_codes(ctx)
    recent = sc[max(0, o - 7): o + 1]
    med_si, _ = ctx.season_idx_at(o)
    f["recent_season_idx"] = med_si[:, recent].mean(1)
    f["deseason_level"] = f["ma_8"] / np.maximum(f["recent_season_idx"], 0.25)

    # Smooth week-by-week seasonal curves (no step at season boundaries), fitted on weeks <= o only.
    bank = ctx.curves_at(o)
    f["recent_curve_mult"] = bank.mult(ctx.doy[max(0, o - 7): o + 1]).mean(1)
    f["curve_level"] = f["ma_8"] / np.maximum(f["recent_curve_mult"], 0.25)
    return f


def build_rows(ctx: Context, origins: list[int], horizons=range(1, C.HORIZON + 1), require_target=True) -> pd.DataFrame:
    sc = _season_codes(ctx)
    cal = ctx.cal
    blocks = []
    n_med = len(ctx.med_ids)
    T_obs = ctx.Y.shape[1]
    for o in origins:
        base = origin_features(ctx, o)
        med_si, cat_si = ctx.season_idx_at(o)
        bank = ctx.curves_at(o)
        for h in horizons:
            tgt = o + h
            if require_target and tgt >= T_obs:
                continue
            s = sc[tgt]
            d = dict(base)
            d.update({
                "med": np.arange(n_med), "origin": np.full(n_med, o), "h": np.full(n_med, h), "target_t": np.full(n_med, tgt),
                "category_code": ctx.cat_of, "form_code": ctx.form_of, "season_code": np.full(n_med, s),
                "log_price": ctx.log_price, "rx_share": ctx.rx_share,
                "target_med_season_idx": med_si[:, s],
                "target_cat_season_idx": cat_si[ctx.cat_of, s],
                "woy_sin": np.full(n_med, cal["woy_sin"].iat[tgt]), "woy_cos": np.full(n_med, cal["woy_cos"].iat[tgt]),
                "month": np.full(n_med, cal["month"].iat[tgt]),
                "fest_onam": np.full(n_med, cal["fest_onam"].iat[tgt]), "fest_vishu": np.full(n_med, cal["fest_vishu"].iat[tgt]),
                "fest_xmas": np.full(n_med, cal["fest_xmas"].iat[tgt]),
            })
            d["season_shift"] = d["target_med_season_idx"] / np.maximum(d["recent_season_idx"], 0.25)
            d["seasonal_naive"] = d["deseason_level"] * d["target_med_season_idx"]
            d["target_curve_mult"] = bank.mult(ctx.doy[tgt])[:, 0]
            d["curve_shift"] = d["target_curve_mult"] / np.maximum(d["recent_curve_mult"], 0.25)
            d["curve_naive"] = d["curve_level"] * d["target_curve_mult"]
            d["y"] = ctx.Y[:, tgt] if tgt < T_obs else np.full(n_med, np.nan)
            blocks.append(pd.DataFrame(d))
    return pd.concat(blocks, ignore_index=True)


ALL_FEATURES = [
    "lag_1", "lag_2", "lag_3", "lag_4", "ma_4", "ma_8", "ma_12", "hist_mean", "std_8", "nz_8",
    "weeks_since_sale", "ema", "momentum", "cat_momentum", "store_momentum", "recent_season_idx",
    "deseason_level", "h", "category_code", "form_code", "season_code", "log_price", "rx_share",
    "target_med_season_idx", "target_cat_season_idx", "woy_sin", "woy_cos", "month",
    "fest_onam", "fest_vishu", "fest_xmas", "season_shift", "seasonal_naive",
    "recent_curve_mult", "target_curve_mult", "curve_shift", "curve_naive", "curve_level",
]

# Step-function season inputs: constant inside a season, jumping at its boundary. Default "both": the models
# see the smooth week-by-week curves AND the Kerala season calendar. Measured on the 2026-monsoon holdout,
# "smooth" alone wins item-week WAPE (0.656 vs 0.665) but loses badly on seasonal categories (0.258 vs 0.197):
# with under a year of history at the origin the curve has never seen June-July, while the calendar knows the
# monsoon starts in June. Env MEDFORECAST_SEASON_FEATURES = both (default) | smooth.
STEP_SEASON_FEATURES = {"season_code", "target_med_season_idx", "target_cat_season_idx", "recent_season_idx",
                        "season_shift", "seasonal_naive", "month", "deseason_level"}
SEASON_MODE = os.environ.get("MEDFORECAST_SEASON_FEATURES", "both").strip().lower()
if SEASON_MODE not in ("smooth", "both"):
    SEASON_MODE = "both"
FEATURES = [f for f in ALL_FEATURES if not (SEASON_MODE == "smooth" and f in STEP_SEASON_FEATURES)
            and not (SEASON_MODE == "both" and f == "curve_level")]
CAT_FEATURES = [c for c in CAT_FEATURES_ALL if c in FEATURES]


def training_origins(cutoff: int) -> list[int]:
    return list(range(C.MIN_HISTORY - 1, cutoff))


def sequences(ctx: Context, rows: pd.DataFrame) -> np.ndarray:
    """[n_rows, SEQ_LEN, 5] lookback tensors for the deep model (scaled units, category, store, seasonal curve, mask)."""
    L = C.SEQ_LEN
    sc = _season_codes(ctx)
    cat_scale = np.maximum(ctx.Ycat[:, : ctx.cutoff + 1].mean(1), 1e-3)
    st_scale = max(ctx.Ystore[: ctx.cutoff + 1].mean(), 1e-3)
    out = np.zeros((len(rows), L, 5), dtype=np.float32)
    med = rows["med"].to_numpy()
    org = rows["origin"].to_numpy()
    # Seasonal channel = the smooth curve multiplier of each lookback week, from curves fitted on weeks <= origin.
    cv = np.zeros((len(rows), L), dtype=np.float32)
    for o in np.unique(org):
        m = org == o
        Mo = ctx.curves_at(int(o)).mult(ctx.doy[: int(o) + 1])
        idx = np.arange(int(o) - L + 1, int(o) + 1)
        ok = idx >= 0
        vals = np.zeros((int(m.sum()), L), dtype=np.float32)
        vals[:, ok] = Mo[med[m]][:, idx[ok]]
        cv[m] = vals
    for j in range(L):
        t = org - (L - 1 - j)
        valid = t >= 0
        tt = np.where(valid, t, 0)
        out[:, j, 0] = np.where(valid, np.log1p(ctx.Y[med, tt] / ctx.scale[med]), 0)
        out[:, j, 1] = np.where(valid, np.log1p(ctx.Ycat[ctx.cat_of[med], tt] / cat_scale[ctx.cat_of[med]]), 0)
        out[:, j, 2] = np.where(valid, ctx.Ystore[tt] / st_scale, 0)
        out[:, j, 3] = np.where(valid, cv[:, j], 0)
        out[:, j, 4] = valid.astype(np.float32)
    return out
