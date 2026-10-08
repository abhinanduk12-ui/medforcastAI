"""Seasonal impact analytics.

A seasonal index answers: "in season S, how much more (or less) of this item does the
shop sell per week than in a typical week?"  index = 1.30 means +30 % demand.

Per-medicine histories are short and sparse, so a raw per-medicine index is noisy.
We use empirical-Bayes shrinkage: each medicine's index is pulled toward its
category's index in proportion to how little evidence (transactions) it has.
Category indices themselves are shrunk toward 1.0 when a season has few weeks.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C

K_MED = 25.0      # pseudo-transactions of category prior per medicine
K_WEEKS = 3.0     # pseudo-weeks of "no effect" prior per category-season
K_CAT_TX = 40.0   # pseudo-transactions of "no effect" prior per category-season
TAU2_FLOOR = 0.003   # min prior variance of medicine-vs-category seasonal deviation
MIN_FEST_BASE = 10.0
FEST_Z = 3.0          # ~Bonferroni for ~90 festival x category tests at alpha 0.05  # min baseline units/week for a festival effect to be reported


def _balanced_index(weekly: pd.DataFrame, value: str, by: list[str]) -> pd.DataFrame:
    """Season mean / mean-of-season-means (balanced so uneven season coverage doesn't bias)."""
    sm = weekly.groupby(by + ["season"], observed=True)[value].agg(["mean", "size"]).reset_index()
    base = sm.groupby(by, observed=True)["mean"].transform("mean") if by else sm["mean"].mean()
    sm["raw_index"] = np.where(base > 0, sm["mean"] / base, 1.0)
    return sm.rename(columns={"mean": "season_mean", "size": "n_weeks"})


def category_index(panel: pd.DataFrame) -> pd.DataFrame:
    cat_week = panel.groupby(["category", "week", "season"], observed=True)[["units", "tx"]].sum().reset_index()
    ci = _balanced_index(cat_week, "units", ["category"])
    tx = cat_week.groupby(["category", "season"])["tx"].sum().rename("n_tx").reset_index()
    ci = ci.merge(tx, on=["category", "season"])
    w = ci["n_weeks"] / (ci["n_weeks"] + K_WEEKS) * ci["n_tx"] / (ci["n_tx"] + K_CAT_TX)
    ci["index"] = w * ci["raw_index"] + (1 - w) * 1.0
    return ci[["category", "season", "index", "raw_index", "n_weeks", "season_mean"]]


def medicine_index(panel: pd.DataFrame, cat_idx: pd.DataFrame) -> pd.DataFrame:
    mi = _balanced_index(panel, "units", ["medicine_id", "category"])
    tx = panel.groupby(["medicine_id", "season"], observed=True)["tx"].sum().rename("n_tx").reset_index()
    mi = mi.merge(tx, on=["medicine_id", "season"]).merge(
        cat_idx[["category", "season", "index"]].rename(columns={"index": "cat_index"}), on=["category", "season"])
    # Normal-normal empirical Bayes. The sampling error of a raw index is driven by how
    # lumpy the medicine's weekly units are (CV) and how many weeks the season covers;
    # tau^2 (true spread of medicine effects around their category) is estimated per
    # season by the method of moments. Pure-noise deviations get shrunk away.
    stats = panel.groupby("medicine_id")["units"].agg(["mean", "std"])
    cv = (stats["std"] / stats["mean"].clip(lower=1e-6)).clip(upper=6)
    mi["se2"] = mi["medicine_id"].map(cv).fillna(6.0) ** 2 / mi["n_weeks"].clip(lower=1)
    dev = mi["raw_index"] - mi["cat_index"]
    busy = mi["n_tx"] >= 20
    tau2 = {}
    for s, g in mi[busy].groupby("season"):
        tau2[s] = max(float((dev[g.index] ** 2).mean() - g["se2"].mean()), TAU2_FLOOR)
    t2 = mi["season"].map(tau2).fillna(TAU2_FLOOR)
    w = t2 / (t2 + mi["se2"]) * mi["n_tx"] / (mi["n_tx"] + K_MED)
    mi["index"] = mi["cat_index"] + w * dev
    mi["weight"] = w
    return mi[["medicine_id", "category", "season", "index", "raw_index", "cat_index", "n_tx", "season_mean", "weight"]]


def index_lookup(panel: pd.DataFrame):
    """Return (medicine x season) and (category x season) index matrices, filling unseen seasons with priors."""
    ci = category_index(panel)
    mi = medicine_index(panel, ci)
    cat_mat = ci.pivot(index="category", columns="season", values="index").reindex(columns=C.SEASON_ORDER).fillna(1.0)
    med_mat = mi.pivot(index="medicine_id", columns="season", values="index").reindex(columns=C.SEASON_ORDER)
    cats = panel.drop_duplicates("medicine_id").set_index("medicine_id")["category"]
    for s in C.SEASON_ORDER:
        med_mat[s] = med_mat[s].fillna(cats.reindex(med_mat.index).map(cat_mat[s]))
    return med_mat.fillna(1.0), cat_mat, mi, ci


def bootstrap_category_ci(panel: pd.DataFrame, n_boot: int = 400, seed: int = C.SEED) -> pd.DataFrame:
    """90 % bootstrap CI for each category's seasonal uplift (resampling weeks within season)."""
    rng = np.random.default_rng(seed)
    cat_week = panel.groupby(["category", "week", "season"], observed=True)["units"].sum().reset_index()
    rows = []
    for cat, g in cat_week.groupby("category"):
        by_season = {s: g.loc[g["season"] == s, "units"].to_numpy() for s in C.SEASON_ORDER}
        by_season = {s: v for s, v in by_season.items() if len(v)}
        boots = {s: [] for s in by_season}
        for _ in range(n_boot):
            means = {s: rng.choice(v, len(v)).mean() for s, v in by_season.items()}
            base = np.mean(list(means.values()))
            for s in by_season:
                boots[s].append(means[s] / base if base > 0 else 1.0)
        for s, b in boots.items():
            lo, hi = np.percentile(b, [5, 95])
            rows.append({"category": cat, "season": s, "ci_lo": lo, "ci_hi": hi,
                         "significant": bool(lo > 1.0 or hi < 1.0)})
    return pd.DataFrame(rows)


def festival_impact(panel: pd.DataFrame, cal: pd.DataFrame) -> pd.DataFrame:
    """Uplift in festival weeks vs non-festival weeks of the same season, per category."""
    fest_cols = {"Onam": "fest_onam", "Vishu": "fest_vishu", "Christmas/New Year": "fest_xmas"}
    cat_week = (panel.groupby(["category", "week"], observed=True)["units"].sum().reset_index()
                .merge(cal, on="week"))
    rows = []
    for fest, col in fest_cols.items():
        fw = cat_week[cat_week[col] >= 3 / 7]
        if fw.empty:
            continue
        seasons = fw["season"].unique()
        for cat, g in cat_week[cat_week["season"].isin(seasons)].groupby("category"):
            on = g[g[col] >= 3 / 7]["units"]
            off = g[(g["fest_any"] == 0)]["units"]
            if len(on) == 0 or len(off) < 2 or off.mean() < MIN_FEST_BASE:
                continue
            # z-score of the festival-week mean against normal week-to-week variability
            z = (on.mean() - off.mean()) / max(off.std(ddof=1) / np.sqrt(len(on)), 1e-9)
            rows.append({"festival": fest, "category": cat, "festival_weekly": on.mean(),
                         "baseline_weekly": off.mean(), "uplift": on.mean() / off.mean() - 1, "n_weeks": len(on),
                         "z": z, "significant": bool(z >= FEST_Z)})
    return pd.DataFrame(rows)


def deseasonalised_level(panel: pd.DataFrame, med_mat: pd.DataFrame, last_n: int = 12) -> pd.Series:
    """Recent weekly demand with the season effect divided out = the underlying run-rate."""
    T = panel["t"].max()
    recent = panel[panel["t"] > T - last_n].copy()
    recent["idx"] = [med_mat.at[m, s] for m, s in zip(recent["medicine_id"], recent["season"])]
    recent["adj"] = recent["units"] / recent["idx"].clip(lower=0.25)
    longrun = panel.groupby("medicine_id")["units"].mean()
    lvl = recent.groupby("medicine_id")["adj"].mean()
    # Blend recent level with long-run mean for stability on sparse items.
    return 0.6 * lvl + 0.4 * longrun.reindex(lvl.index)
