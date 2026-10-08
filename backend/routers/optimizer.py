"""Budget-constrained purchase optimizer: which units to buy with a fixed cash budget, grouped into supplier POs.

Model
-----
Demand of medicine i over the cover window (lead time + review period) is D_i ~ Normal(mu_i, sigma_i), built
from the ensemble forecast and its calibrated weekly sigma (same inputs as the stock planner). Slow movers
(mu_i < 5 units in the window) use Poisson(mu_i) instead, because a normal curve is meaningless near zero.

The k-th unit on the shelf sells with probability P(D_i >= k). Buying it is worth
    profit objective:     P(D>=k) * margin_value  -  (1 - P(D>=k)) * holding_cost
    fill-rate objective:  P(D>=k)                     (expected units served)
per rupee of unit cost. Units already on hand are free, so candidates start at k = on_hand + 1, and no item is
bought beyond its service-cap quantile.

Because P(D>=k) falls with k, every item's value curve is concave; the objective is a sum of separable concave
functions under one linear budget. For that problem, taking units in descending benefit/cost order is optimal
(exactly so for the continuous relaxation, and within one unit's cost of optimal for whole units). The candidate
list is computed once and sorted - equivalent to draining a max-heap of each item's next unit - so the efficient
frontier is just prefix sums over the same sorted list.
"""
from __future__ import annotations

import math
import threading
from functools import lru_cache
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from backend.core import S, clean, get_sales, z_for

router = APIRouter(prefix="/api/optimizer", tags=["optimizer"])

POISSON_BELOW = 5.0     # mu over the cover window below which demand is modelled as Poisson
SD_FLOOR = 0.5          # guard against a degenerate sigma
TAIL_Z = 8.0            # enumerate units to mu + 8 sd, beyond which P(D>=k) is ~0
FRONTIER_POINTS = 13    # budgets 0 .. 2x unconstrained spend


class PlanIn(BaseModel):
    budget: float = Field(50_000, ge=0, le=1e9, description="Cash available for this order (₹)")
    lead_time: int = Field(1, ge=0, le=8, description="Supplier lead time (weeks)")
    review: int = Field(2, ge=1, le=8, description="Weeks until the next order")
    service_cap: float = Field(0.95, ge=0.5, le=0.995, description="Never stock beyond this demand quantile")
    margin_pct: float = Field(20, ge=1, le=90, description="Gross margin as % of selling price")
    holding_pct: float = Field(2, ge=0, le=50, description="Carrying / expiry cost per cycle, % of unit cost")
    objective: Literal["profit", "fill_rate"] = "profit"
    on_hand: dict[str, float] = Field(default_factory=dict, max_length=5000)
    categories: list[str] | None = Field(None, max_length=100)
    abc: str | None = Field(None, max_length=3)

    @field_validator("on_hand")
    @classmethod
    def _stock(cls, v: dict[str, float]):
        for k, q in v.items():
            if not (0 <= q <= 1e6) or math.isnan(q):
                raise ValueError(f"on_hand for {k} must be between 0 and 1,000,000")
        return {k.strip().upper(): math.floor(q) for k, q in v.items()}

    @field_validator("abc")
    @classmethod
    def _abc(cls, v: str | None):
        if v is None or v == "":
            return None
        v = v.upper()
        if not set(v) <= set("ABC"):
            raise ValueError("abc must contain only the letters A, B, C")
        return v


# ─────────────────────────── supplier inference (cached) ───────────────────────────
_SUP_LOCK = threading.Lock()


@lru_cache(maxsize=1)
def _preferred_suppliers() -> pd.DataFrame:
    s = get_sales()
    g = s.groupby(["medicine_id", "supplier_id"]).size().unstack(fill_value=0)
    return pd.DataFrame({"supplier_id": g.idxmax(axis=1), "share": g.max(axis=1) / g.sum(axis=1),
                         "n_suppliers": (g > 0).sum(axis=1).astype(int)})


def preferred_suppliers() -> pd.DataFrame:
    """Supplier with the most sales lines per medicine, and its share of that medicine's sales lines.

    The lock makes a request that arrives during the warm-up wait for it instead of parsing the sales file twice.
    If the raw sales cannot be read, every medicine comes back "Unassigned" rather than failing the plan.
    """
    with _SUP_LOCK:
        try:
            return _preferred_suppliers()
        except Exception:   # noqa: BLE001 - missing/corrupt raw file must not turn into a 500
            return pd.DataFrame(columns=["supplier_id", "share", "n_suppliers"])


# Raw sales take a few seconds to parse; warm the cache so the first plan request stays fast.
threading.Thread(target=preferred_suppliers, daemon=True).start()


# ─────────────────────────── probability helpers ───────────────────────────
def _norm_sf(x: np.ndarray) -> np.ndarray:
    """1 - Phi(x), vectorised (erfc via Numerical Recipes' Chebyshev fit, |err| < 1.2e-7)."""
    z = np.abs(x) / math.sqrt(2)
    t = 1 / (1 + 0.5 * z)
    poly = (-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
            + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
    erfc = t * np.exp(poly)
    return np.where(x >= 0, 0.5 * erfc, 1 - 0.5 * erfc)


def _grid(mu: np.ndarray, sd: np.ndarray, pois: np.ndarray, cap: np.ndarray):
    """Ragged grid of units k = 1..K_i per item with survival P(D_i >= k)."""
    K = np.where(pois, np.ceil(mu + TAIL_Z * np.sqrt(np.maximum(mu, 1e-9))) + 2, np.ceil(mu + TAIL_Z * sd) + 1)
    K = np.maximum(K, cap).astype(int)
    K = np.maximum(K, 1)
    item = np.repeat(np.arange(len(mu)), K)
    start = np.concatenate([[0], np.cumsum(K)[:-1]])
    k = np.arange(K.sum()) - np.repeat(start, K) + 1
    m, s = mu[item], sd[item]
    surv = _norm_sf((k - 0.5 - m) / s)   # continuity correction: P(D >= k) = P(X > k - 0.5)
    # Poisson: P(D >= k) = 1 - CDF(k - 1), from log-pmf (lgamma) and a per-item cumulative sum.
    pm = pois[item]
    if pm.any():
        mp = np.maximum(m[pm], 1e-12)
        j = k[pm] - 1                                    # pmf of j = 0..K-1
        lg = np.array([math.lgamma(x + 1) for x in range(int(j.max()) + 1)])
        pmf = np.exp(j * np.log(mp) - mp - lg[j])
        it = item[pm]
        cdf = np.cumsum(pmf)
        first = np.r_[True, it[1:] != it[:-1]]
        base = np.maximum.accumulate(np.where(first, np.r_[0, cdf[:-1]], 0))
        surv[pm] = np.clip(1 - (cdf - base), 0, 1)  # P(D >= k) = 1 - P(D <= k-1)
        surv[pm & (m <= 0)] = 0
    return item, k, surv, K, start


def _poisson_cap(mu: float, p: float) -> int:
    if mu <= 0:
        return 0
    k, term = 0, math.exp(-mu)
    cdf = term
    while cdf < p and k < 10_000:
        k += 1
        term *= mu / k
        cdf += term
    return k


def _greedy(cost: np.ndarray, budget: float, item: np.ndarray, tail_min: np.ndarray) -> np.ndarray:
    """Take sorted candidates while they fit; once an item's unit is skipped, its later units are skipped too."""
    take = np.zeros(len(cost), bool)
    if budget <= 0 or not len(cost):
        return take
    tol = 1e-9 * max(1.0, budget)     # relative: cumulative sums of rupee costs carry float error
    cum = np.cumsum(cost)
    n = int(np.searchsorted(cum, budget + tol, side="right"))
    take[:n] = True
    left = budget - (cum[n - 1] if n else 0.0)
    blocked: set[int] = set()
    for j in range(n, len(cost)):
        if left < tail_min[j] - tol:
            break
        i = int(item[j])
        if i in blocked:
            continue
        if cost[j] <= left + tol:
            take[j] = True
            left -= cost[j]
        else:
            blocked.add(i)
    return take


# ─────────────────────────── endpoint ───────────────────────────
@router.post("/plan")
def plan(p: PlanIn):
    m = S.meds
    if p.categories:
        bad = sorted(set(p.categories) - set(m["category"].unique()))
        if bad:
            raise HTTPException(422, f"Unknown categories: {', '.join(bad)}")
        m = m[m["category"].isin(p.categories)]
    if p.abc:
        m = m[m["abc"].isin(list(p.abc))]
    if m.empty:
        raise HTTPException(404, "No medicines match these filters")

    ids = m.index
    cover = min(p.lead_time + p.review, len(S.fweeks))
    mu = S.fc_wide.iloc[:, :cover].sum(axis=1).reindex(ids).fillna(0).to_numpy(float)
    sd = np.sqrt((S.sig_wide.iloc[:, :cover] ** 2).sum(axis=1)).reindex(ids).fillna(0).to_numpy(float)
    sd = np.maximum(sd, SD_FLOOR)
    pois = mu < POISSON_BELOW
    z = z_for(p.service_cap)
    cap = np.where(pois, [_poisson_cap(x, p.service_cap) for x in mu], np.ceil(np.maximum(mu + z * sd, 0))).astype(int)

    known = set(S.meds.index)
    unknown = sorted(k for k in p.on_hand if k not in known)
    oh = pd.Series(p.on_hand, dtype=float).reindex(ids).fillna(0).to_numpy(float).astype(int)

    price = m["median_price"].to_numpy(float)
    margin = p.margin_pct / 100
    unit_cost = price * (1 - margin)
    margin_val = price * margin
    hold = unit_cost * p.holding_pct / 100

    item, k, surv, K, start = _grid(mu, sd, pois, cap)
    # E[D+] and E[min(D, S)] = sum_{k<=S} P(D >= k), exact for integer demand.
    ed = np.bincount(item, weights=surv, minlength=len(ids))
    cum = np.cumsum(surv)
    off = np.r_[0, cum[start[1:] - 1]] if len(ids) > 1 else np.array([0.0])

    def served(stock: np.ndarray) -> np.ndarray:
        s = np.minimum(stock, K).astype(int)
        return np.where(s > 0, cum[start + np.maximum(s, 1) - 1] - off, 0.0)

    served0 = served(oh)

    # Candidate units: above on-hand, up to the service cap.
    cand = (k > oh[item]) & (k <= cap[item])
    ci, ck, cp = item[cand], k[cand], surv[cand]
    cc = unit_cost[ci]
    profit = cp * margin_val[ci] - (1 - cp) * hold[ci]
    benefit = profit if p.objective == "profit" else cp
    keep = (benefit > 1e-12) & np.isfinite(cc) & (cc > 0)   # a missing/zero price can't be ranked per rupee
    ci, ck, cp, cc, profit, benefit = ci[keep], ck[keep], cp[keep], cc[keep], profit[keep], benefit[keep]
    # Sort by value per rupee (0.1% buckets so near-certain units tie), then unit number, so ties spread the
    # budget across medicines (every first unit before any second unit) rather than by medicine id.
    bucket = np.round(np.log(benefit / cc) * 1000)
    order = np.lexsort((ci, ck, -bucket))
    ci, ck, cp, cc, profit, ratio = ci[order], ck[order], cp[order], cc[order], profit[order], (benefit / cc)[order]
    tail_min = np.minimum.accumulate(cc[::-1])[::-1] if len(cc) else cc
    unconstrained = float(cc.sum())

    total_ed = float(ed.sum())

    def evaluate(take: np.ndarray):
        qty = np.bincount(ci[take], minlength=len(ids)).astype(int)
        sv = served(oh + qty)
        return qty, sv, float(sv.sum() / total_ed) if total_ed > 0 else 1.0, float(profit[take].sum()), float(cc[take].sum())

    take = _greedy(cc, p.budget, ci, tail_min)
    qty, sv, fill, exp_profit, spend = evaluate(take)
    # Value of the next rupee: ratio of the best unit the budget could not buy (the list is sorted, so the first
    # untaken one). None once every worthwhile unit is bought - extra budget is then worth nothing.
    nxt = np.flatnonzero(~take)
    shadow = float(ratio[nxt[0]]) if len(nxt) else None

    # Efficient frontier: same sorted list, re-cut at evenly spaced budgets.
    frontier = []
    hi = max(unconstrained * 2, 1.0)
    for b in np.linspace(0, hi, FRONTIER_POINTS):
        _, _, f, pr, sp = evaluate(_greedy(cc, float(b), ci, tail_min))
        frontier.append({"budget": float(b), "fill_rate": f, "profit": pr, "spend": sp})

    # Per-medicine rows
    sup_all = preferred_suppliers()
    sup = sup_all.reindex(ids)
    lines = pd.DataFrame({
        "medicine_id": ids, "medicine_name": m["medicine_name"].to_numpy(), "category": m["category"].to_numpy(),
        "abc": m["abc"].to_numpy(), "form": m["form"].to_numpy(), "price": price, "unit_cost": unit_cost,
        "on_hand": oh, "qty": qty, "cap_qty": np.maximum(cap - oh, 0), "cost": qty * unit_cost,
        "demand_mu": mu, "demand_sd": np.where(pois, np.sqrt(mu), sd), "model": np.where(pois, "Poisson", "Normal"),
        "served": sv, "added_served": sv - served0, "fill_rate": np.where(ed > 0, sv / np.where(ed > 0, ed, 1), 1.0),
        "supplier_id": sup["supplier_id"].fillna("Unassigned").to_numpy(),
        "supplier_share": sup["share"].to_numpy(), "n_suppliers": sup["n_suppliers"].fillna(0).astype(int).to_numpy(),
    })
    lines["expected_profit"] = pd.Series(np.bincount(ci[take], weights=profit[take], minlength=len(ids)))
    bought = lines[lines["qty"] > 0].sort_values("cost", ascending=False)
    short = int(((lines["qty"] < lines["cap_qty"]) & (lines["cap_qty"] > 0)).sum())

    pos = []
    for sid, g in bought.groupby("supplier_id"):
        pos.append({"supplier_id": sid, "lines": int(len(g)), "units": int(g["qty"].sum()), "total": float(g["cost"].sum()),
                    "expected_profit": float(g["expected_profit"].sum()),
                    "items": g[["medicine_id", "medicine_name", "category", "form", "qty", "unit_cost", "cost",
                                "supplier_share"]].to_dict("records")})
    pos.sort(key=lambda x: -x["total"])

    return clean({
        "params": {**p.model_dump(exclude={"on_hand"}), "cover_weeks": cover, "forecast_start": S.fweeks[0],
                   "on_hand_items": int((oh > 0).sum()), "unknown_on_hand_ids": unknown[:50],
                   "unknown_on_hand_count": len(unknown)},
        "totals": {
            "budget": p.budget, "spend": spend, "utilisation": spend / p.budget if p.budget > 0 else None,
            "unconstrained_spend": unconstrained, "lines": int(len(bought)), "units": int(qty.sum()),
            "fill_rate": fill, "fill_rate_on_hand_only": float(served0.sum() / total_ed) if total_ed > 0 else 1.0,
            "expected_profit": exp_profit, "expected_demand": total_ed, "expected_served": float(sv.sum()),
            "items_considered": int(len(ids)), "items_short_of_cap": short,
            "marginal_value_per_rupee": shadow,
            # clean() rounds to 4 dp, which wipes out "units per ₹" values; per ₹1,000 keeps the precision.
            "marginal_value_per_1000": shadow * 1000 if shadow is not None else None,
            "marginal_unit": "₹ expected profit per ₹ spent" if p.objective == "profit" else "expected units served per ₹ spent",
        },
        "frontier": frontier,
        "lines": bought.to_dict("records"),
        "purchase_orders": pos,
        "notes": {
            "supplier": "Supplier history could not be read, so every line is listed as Unassigned." if sup_all.empty else
                        "Supplier assignment is inferred: each medicine goes to the supplier whose stock appears on the "
                        "most of its sales lines in the history. The shop buys most medicines from about a dozen "
                        "suppliers, so treat this as a starting point and confirm with your distributor.",
            "method": "Greedy marginal analysis: each candidate unit is valued by its probability of selling within the "
                      "cover window, divided by its cost. Optimal for this separable concave objective.",
            "costs": f"Unit cost assumes a {p.margin_pct:g}% gross margin on the median selling price.",
        },
    })
