"""Smart Alert Center: statistically justified, prioritised actions for the pharmacist.

Every alert type has an explicit test or threshold (constants below), so the inbox stays
quiet unless the data really says something:

  season     next season is close and categories / medicines rise >= MIN_UPLIFT vs typical
  anomaly    recent weeks fall outside the forecast distribution (purchase-scaled negative-
             binomial tail test on the holdout backtest, Benjamini-Hochberg FDR across all tests)
  trend      forecast run-rate differs from the last-12-week rate by a large AND significant step
  stockout   A-class items where "reorder what sold last month" would likely run short
  expiry     the planned shelf quantity (or even a single unit) outlives typical shelf life; and, from the
             live stock ledger of the selected store: expired stock still on the shelf (critical) and
             batches expiring within LEDGER_EXPIRY_DAYS that a FEFO sell-through projection at the
             forecast rate says will NOT sell out (severity by rupees at risk)
  stockout_now  A/B items whose sellable on-hand stock (ledger) is below forecast demand over the
             supplier lead time at the selected store
  data       medicines never sold, or that stopped selling when silence is very unlikely
"""
from __future__ import annotations

import hashlib
import math
import threading
from datetime import date, timedelta
from functools import lru_cache
from statistics import NormalDist
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from ml import config as C
from backend.core import (S, clean, get_sales, next_season, plan_rows, MIN_SEASON_BASE, MIN_UPLIFT)
from backend.auth import current_user, resolve_store

router = APIRouter(prefix="/api/alerts", tags=["alerts"])

SEVERITIES = ("critical", "serious", "warning", "info")
TYPES = ("season", "anomaly", "trend", "stockout", "stockout_now", "expiry", "data")
TYPE_LABEL = {"season": "Season transition", "anomaly": "Demand anomaly", "trend": "Trend shift",
              "stockout": "Stockout risk", "stockout_now": "Stockout now", "expiry": "Expiry risk", "data": "Data quality"}

# Season transition ---------------------------------------------------------------
SEASON_WINDOW_WEEKS = 13      # only warn about the next season once it is within ~a quarter
SEASON_CAT_BASE = 1.5         # units/week a category needs before its uplift is ranked (as /api/seasons)
SEASON_MED_CAP = 8            # medicine-level season alerts shown (rest counted)

# Demand anomaly -----------------------------------------------------------------
ANOMALY_WINDOWS = (1, 2, 3)   # trailing windows (weeks) tested per medicine
FDR_Q = 0.05                  # Benjamini-Hochberg false discovery rate across all tests
ANOMALY_MIN_GAP = 3           # units: ignore "significant" gaps smaller than this (no action value)

# Trend shift --------------------------------------------------------------------
TREND_MIN_RATE = 1.0          # units/week over the last 12 weeks to count as active
TREND_MIN_CHANGE = 0.25       # |forecast rate / recent rate - 1| must be at least 25 %
TREND_Z = 2.58                # and the step must be significant at ~99 % (two-sided)

# Stockout risk ------------------------------------------------------------------
STOCKOUT_P = 0.80             # P(next-4-week demand > last-4-week sales) at which we warn
STOCKOUT_MIN_SHORT = 2        # expected shortfall (units) worth acting on...
STOCKOUT_MIN_SHORT_REL = 0.20 # ...and at least 20 % of last month's sales

# Expiry risk --------------------------------------------------------------------
EXPIRY_PCTL = 0.10            # shelf life = 10th percentile of days-to-expiry at sale
EXPIRY_SAFE_FRACTION = 0.5    # hold at most half the remaining shelf life in cover
EXPIRY_MIN_SALES = 5          # sale lines needed to estimate shelf life
PLAN_DEFAULT = (1, 2, 0.95)   # lead time, review period, service level (planner defaults)

# Ledger (live stock of the selected store) ----------------------------------------
LEDGER_EXPIRY_DAYS = 90       # look-ahead for batches that will not sell out before expiry
LEDGER_EXPIRY_MIN_UNITS = 1   # projected unsold units worth an alert
LEDGER_SERIOUS_INR = 5000     # rupees at risk (at cost) for "serious"
LEDGER_WARNING_INR = 1000     # ... and for "warning" (below: info)
STOCKOUT_NOW_MIN_LEAD = 1     # weeks of demand the shelf must cover even with a 0-week lead time

# Data quality -------------------------------------------------------------------
DORMANT_WEEKS = 8             # trailing weeks with no sales
DORMANT_P = 0.01              # P(that silence | earlier selling frequency) must be below this

TYPE_CAP = 25                 # max alerts returned per type (totals are always reported)
SEV_RANK = {s: i for i, s in enumerate(SEVERITIES)}


def _id(kind: str, key: str) -> str:
    return hashlib.sha1(f"{kind}:{key}".encode()).hexdigest()[:12]


def _alert(kind, severity, title, detail, action, impact, metric, key, mid=None, category=None, href=None):
    r = S.meds.loc[mid] if mid is not None else None
    return {
        "id": _id(kind, key), "type": kind, "type_label": TYPE_LABEL[kind], "severity": severity,
        "title": title, "detail": detail, "action": action, "impact_inr": float(max(impact, 0.0)),
        "metric": metric, "medicine_id": mid,
        "medicine_name": r["medicine_name"] if r is not None else None,
        "abc": r["abc"] if r is not None else None,
        "category": category if category is not None else (r["category"] if r is not None else None),
        "href": href or (f"/medicines/{mid}" if mid else "/"),
    }


# ── statistics ────────────────────────────────────────────────────────────────

def _count_pmf(mu: float, var: float, kmax: int) -> np.ndarray:
    """P(X = 0..kmax) for a count with mean mu and variance var.

    Negative binomial matched on the two moments (Poisson when var <= mu). Computed in
    log space by recursion so large counts don't underflow; no scipy needed."""
    mu = max(mu, 1e-6)
    k = np.arange(1, kmax + 1, dtype=float)
    if var <= mu * 1.0001:
        logp = np.concatenate([[-mu], -mu + np.cumsum(np.log(mu) - np.log(k))])
    else:
        r = mu * mu / (var - mu)
        p = r / (r + mu)
        logp = np.concatenate([[r * math.log(p)], r * math.log(p) + np.cumsum(np.log((k - 1 + r) / k) + math.log1p(-p))])
    pm = np.exp(logp - logp.max())
    return pm / pm.sum()


def count_test(x: float, mu: float, var: float, size: float) -> dict:
    """Two-sided tail test of an observed window total x against a forecast (mean mu, variance var).

    Pharmacy demand arrives in purchases of several units (a strip, a course), so a plain
    count model puts far too little mass on "no sale at all" for lumpy items: an intermittent
    seller with three empty weeks looked like a 1-in-100,000 event. Instead the total is
    modelled on a purchase scale, X / phi ~ NB(mu / phi, var / phi^2), with
    phi = clip(var / mu, 1, mean units per purchase). This keeps the forecast's own mean and
    variance exactly and never puts more mass on zero than a compound-Poisson purchase process
    would. Tails are interpolated between neighbouring purchase counts; the 90% range is the
    5th-95th percentile of the same distribution, in units."""
    mu = max(mu, 1e-6)
    phi = float(min(max(var / mu, 1.0), max(size, 1.0)))
    m, v, xs = mu / phi, var / phi ** 2, max(x, 0.0) / phi
    fl = math.floor(xs)
    f = xs - fl
    pm = _count_pmf(m, v, int(max(fl + 2, m + 40 * math.sqrt(max(v, m)) + 50)))
    cdf = np.cumsum(pm)
    sf = lambda k: float(pm[k:].sum())          # P(X' >= k)
    up = (1 - f) * sf(fl) + f * sf(fl + 1)
    lo = (1 - f) * float(cdf[fl]) + f * float(cdf[fl + 1])
    q = lambda a: float(np.searchsorted(cdf, a)) * phi
    return {"p_up": min(up, 1.0), "p_lo": min(lo, 1.0), "p": min(1.0, 2 * min(up, lo)),
            "lo90": q(0.05), "hi90": q(0.95), "phi": phi}


@lru_cache(maxsize=1)
def err_corr() -> float:
    """Correlation of standardised forecast errors between weeks 1-2 apart (holdout backtest).

    Used to add up weekly forecast variances over a multi-week window:
    var = (1 - rho) * sum(sigma^2) + rho * (sum sigma)^2 (equal correlation rho between weeks)."""
    z = S.bt.assign(z=(S.bt["actual"] - S.bt["ensemble"]) / S.bt["sigma"]).pivot(
        index="medicine_id", columns="week", values="z").sort_index(axis=1)
    rs = []
    for lag in (1, 2):
        a, b = z.iloc[:, :-lag].to_numpy().ravel(), z.iloc[:, lag:].to_numpy().ravel()
        ok = np.isfinite(a) & np.isfinite(b)
        if ok.sum() > 10:
            rs.append(float(np.corrcoef(a[ok], b[ok])[0, 1]))
    r = float(np.mean(rs)) if rs else 0.0
    return min(max(r if np.isfinite(r) else 0.0, 0.0), 1.0)


def window_var(sig: pd.DataFrame) -> pd.Series:
    """Variance of a multi-week forecast total from weekly sigmas (columns = weeks)."""
    rho = err_corr()
    return (1 - rho) * (sig ** 2).sum(1) + rho * sig.sum(1) ** 2


def purchase_size() -> pd.Series:
    """Mean units per sale transaction, per medicine (>= 1)."""
    s = (S.meds["total_units"] / S.meds["total_tx"]).replace([np.inf, -np.inf], np.nan)
    return s.where(s >= 1, 1.0).fillna(1.0)


def bh_qvalues(p: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg adjusted p-values (q-values)."""
    n = len(p)
    if n == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1.0)
    return out


def _p(v: float) -> str:
    """p/q-values in plain notation for pharmacists: '< 0.0001' rather than '9.4e-06'."""
    return "< 0.0001" if v < 1e-4 else f"{v:.4f}".rstrip("0").rstrip(".")


def _span(start: str, end: str) -> str:
    f = lambda w: pd.Timestamp(w).strftime("%d %b")
    return f"week of {f(start)}" if start == end else f"weeks of {f(start)} to {f(end)}"


# ── 1. season transition ─────────────────────────────────────────────────────

def season_start(season: str, today: date) -> date:
    first = C.SEASONS[season][0]
    y = today.year if first > today.month else today.year + 1
    return date(y, first, 1)


def season_alerts(today: date, lead_time: int) -> list[dict]:
    cur = C.MONTH_TO_SEASON[today.month]
    nxt = next_season(cur)
    start = season_start(nxt, today)
    weeks = (start - today).days / 7
    if weeks > SEASON_WINDOW_WEEKS:
        return []
    order_by = start - timedelta(weeks=lead_time + 1)   # one review cycle of slack before delivery
    days_left = (order_by - today).days
    sev_time = "serious" if days_left <= 7 else "warning" if days_left <= 28 else "info"
    late = days_left < 0
    order_txt = "now (order-by date has passed)" if late else f"by {order_by:%d %b}"
    if weeks >= 1:
        in_txt = f"in {(n := round(weeks))} week{'' if n == 1 else 's'}"
    else:
        in_txt = f"in {(d := max((start - today).days, 0))} day{'' if d == 1 else 's'}"
    href = f"/seasons?season={nxt}"
    col, ccol = f"idx_{nxt}", f"idx_{cur}"
    m = S.meds[S.meds["base_level"] > 0]
    weeks_in = round(len(C.SEASONS[nxt]) * 4.345)
    csi = S.csi[S.csi["season"] == nxt].set_index("category")
    cat = m.assign(base=m["base_level"], exp=m["base_level"] * m[col], now=m["base_level"] * m[ccol],
                   rev=m["base_level"] * (m[col] - 1) * m["median_price"]).groupby("category")[["base", "exp", "now", "rev"]].sum()
    cat = cat[cat["base"] >= SEASON_CAT_BASE]
    cat["uplift"] = cat["exp"] / cat["base"] - 1
    cat["vs_now"] = cat["exp"] / cat["now"] - 1

    meds = m[m["base_level"] >= MIN_SEASON_BASE]
    meds = meds.assign(uplift=meds[col] - 1, vs_now=meds[col] / meds[ccol] - 1,
                       extra=meds["base_level"] * (meds[col] - 1))
    rising_m = meds[meds["uplift"] >= MIN_UPLIFT].sort_values("extra", ascending=False)
    rising_c = cat[cat["uplift"] >= MIN_UPLIFT].sort_values("uplift", ascending=False)
    falling_c = cat[cat["uplift"] <= -MIN_UPLIFT].sort_values("uplift")

    def sig_dir(c: str, up: bool) -> bool:
        """Bootstrap interval of the category index excludes 1 on the same side as the change."""
        if c not in csi.index or not bool(csi.at[c, "significant"]):
            return False
        return bool(csi.at[c, "ci_lo"] > 1) if up else bool(csi.at[c, "ci_hi"] < 1)

    out = []
    when = f"{nxt} starts {start:%d %b %Y}, {in_txt}"
    more = len(rising_m) - SEASON_MED_CAP
    listed = f" The top {SEASON_MED_CAP} medicines by extra units are listed; the Seasons page has all {len(rising_m)}." if more > 0 else ""
    summary_metric = {"weeks_to_start": weeks, "days_to_order_by": days_left, "season_start": start.isoformat(), "order_by": order_by.isoformat(),
                      "rising_categories": len(rising_c), "rising_medicines": len(rising_m), "lead_time_weeks": lead_time}
    if not len(rising_c) and not len(rising_m):
        out.append(_alert("season", "info", f"{nxt} is coming: demand stays close to normal",
                          f"{when}. No category or medicine (at >= {MIN_SEASON_BASE:g} unit/week) rises by "
                          f"{MIN_UPLIFT:.0%} or more, so the regular forecast is enough.",
                          "No seasonal stock-up needed", 0, summary_metric, f"{nxt}:{start}:none", href=href))
    else:
        out.append(_alert("season", sev_time, f"{nxt} starts {in_txt}: order rising lines {order_txt}",
                          f"{when}. {len(rising_c)} {'category' if len(rising_c) == 1 else 'categories'} and "
                          f"{len(rising_m)} {'medicine' if len(rising_m) == 1 else 'medicines'} rise by {MIN_UPLIFT:.0%} or more "
                          f"vs a typical week. The order-by date ({order_by:%d %b}) allows a {lead_time}-week supplier lead time plus a week's slack.{listed}",
                          f"Review the {nxt} stock-up list", float(rising_m["extra"].mul(rising_m["median_price"]).sum() * weeks_in),
                          summary_metric, f"{nxt}:{start}:summary", href=href))
    for c, r in rising_c.iterrows():
        sig = sig_dir(c, up=True)
        out.append(_alert("season", sev_time if sig else "info", f"{c}: +{r['uplift']:.0%} in {nxt}",
                          f"Category demand rises from {r['base']:.1f} to {r['exp']:.1f} units/week vs typical "
                          f"({r['vs_now']:+.0%} vs {cur} now). " +
                          ("The 90% bootstrap interval excludes no change." if sig else
                           "The 90% bootstrap interval still includes no change, so treat it as a soft signal."),
                          f"Raise {c} orders {order_txt}", float(r["rev"] * weeks_in),
                          {"uplift": r["uplift"], "vs_now": r["vs_now"], "base_weekly": r["base"], "expected_weekly": r["exp"],
                           "significant": sig, "order_by": order_by.isoformat()},
                          f"{nxt}:{start}:cat:{c}", category=c, href=href))
    for mid, r in rising_m.head(SEASON_MED_CAP).iterrows():
        extra4 = r["extra"] * 4
        out.append(_alert("season", sev_time if r["abc"] == "A" else "info", f"{r['medicine_name']}: +{r['uplift']:.0%} in {nxt}",
                          f"Expected {r['base_level'] * r[col]:.1f} units/week vs {r['base_level']:.1f} typical "
                          f"({r['vs_now']:+.0%} vs now), about {extra4:.0f} extra units per 4 weeks.",
                          f"Order ~{math.ceil(extra4)} extra units {order_txt}",
                          float(r["extra"] * r["median_price"] * weeks_in),
                          {"uplift": r["uplift"], "vs_now": r["vs_now"], "base_weekly": r["base_level"],
                           "expected_weekly": r["base_level"] * r[col], "order_by": order_by.isoformat()},
                          f"{nxt}:{start}:med:{mid}", mid=mid))
    for c, r in falling_c.iterrows():
        if not sig_dir(c, up=False):
            continue   # only call out drops we are confident about; cutting stock on noise is risky
        out.append(_alert("season", "info", f"{c}: {r['uplift']:.0%} in {nxt}",
                          f"Category demand falls to {r['exp']:.1f} from {r['base']:.1f} units/week vs typical, and the 90% "
                          f"bootstrap interval excludes no change.",
                          "Trim reorders to avoid excess stock", float(-r["rev"] * weeks_in),
                          {"uplift": r["uplift"], "vs_now": r["vs_now"], "base_weekly": r["base"], "expected_weekly": r["exp"],
                           "significant": True}, f"{nxt}:{start}:catdown:{c}", category=c, href=href))
    return out


# ── 2. demand anomaly ────────────────────────────────────────────────────────

def anomaly_tests() -> pd.DataFrame:
    """One two-sided tail test per medicine x trailing window on the holdout backtest."""
    bt = S.bt.sort_values("week")
    weeks = sorted(bt["week"].unique())
    act = bt.pivot(index="medicine_id", columns="week", values="actual").reindex(columns=weeks)
    mu = bt.pivot(index="medicine_id", columns="week", values="ensemble").reindex(columns=weeks)
    sg = bt.pivot(index="medicine_id", columns="week", values="sigma").reindex(columns=weeks)
    size = purchase_size()
    rows = []
    for w in ANOMALY_WINDOWS:
        if w > len(weeks):
            continue
        a = act.iloc[:, -w:].sum(1, min_count=w)
        e = mu.iloc[:, -w:].sum(1, min_count=w)
        # Forecast errors of nearby weeks are slightly correlated (rho estimated on the backtest).
        v = window_var(sg.iloc[:, -w:])
        for mid in act.index:
            if pd.isna(a[mid]) or pd.isna(e[mid]) or not np.isfinite(v[mid]):
                continue
            t = count_test(float(a[mid]), float(e[mid]), float(v[mid]), float(size.get(mid, 1.0)))
            rows.append({"medicine_id": mid, "window": w, "actual": float(a[mid]), "expected": float(e[mid]),
                         "sd": math.sqrt(float(v[mid])), **t, "start": weeks[-w], "end": weeks[-1]})
    t = pd.DataFrame(rows)
    if len(t):
        t["q"] = bh_qvalues(t["p"].to_numpy())
    return t


def anomaly_alerts() -> list[dict]:
    t = anomaly_tests()
    if not len(t):
        return []
    hits = t[(t["q"] <= FDR_Q) & ((t["actual"] - t["expected"]).abs() >= ANOMALY_MIN_GAP)]
    hits = hits.sort_values("q").drop_duplicates("medicine_id")    # strongest window per medicine
    out = []
    for _, h in hits.iterrows():
        mid = h["medicine_id"]
        if mid not in S.meds.index:
            continue
        r = S.meds.loc[mid]
        spike = h["actual"] > h["expected"]
        ratio = h["actual"] / max(h["expected"], 1e-6)
        gap = abs(h["actual"] - h["expected"])
        sev = "critical" if h["q"] <= 0.001 and r["abc"] == "A" else "serious" if h["q"] <= 0.01 else "warning"
        wk = "week" if h["window"] == 1 else f"{int(h['window'])} weeks"
        out.append(_alert(
            "anomaly", sev,
            f"{r['medicine_name']}: {'spike' if spike else 'drop'} in the last {wk}",
            f"Sold {h['actual']:.0f} units in the {_span(h['start'], h['end'])} vs {h['expected']:.1f} forecast "
            f"({ratio:.1f}x; forecast 90% range {h['lo90']:.0f}-{h['hi90']:.0f}). Chance of a gap this large if the "
            f"forecast were right: p {_p(h['p']) if _p(h['p']).startswith('<') else '= ' + _p(h['p'])}; after false-discovery control across {len(t)} tests "
            f"({t['medicine_id'].nunique()} medicines x {t['window'].nunique()} windows), q = {_p(h['q'])}.",
            ("Check for an outbreak, a new prescriber or a bulk buyer, and top up stock"
             if spike else "Check shelf availability, a substitute or a lost customer before reordering"),
            gap * r["median_price"],
            {"actual": h["actual"], "expected": h["expected"], "sd": h["sd"], "lo90": h["lo90"], "hi90": h["hi90"],
             "ratio": ratio, "p": _p(h["p"]), "q": _p(h["q"]),
             "window_weeks": int(h["window"]), "direction": "spike" if spike else "drop",
             "start": h["start"], "end": h["end"]},
            f"{mid}:{h['end']}", mid=mid))
    return out


# ── 3. trend shift ───────────────────────────────────────────────────────────

def trend_alerts() -> list[dict]:
    hw = S.hist_wide.iloc[:, -12:]
    out = []
    for mid, r in S.meds.iterrows():
        if mid not in hw.index:
            continue
        x = hw.loc[mid].fillna(0).to_numpy(float)
        rate = x.mean()
        if rate < TREND_MIN_RATE:
            continue
        nxt = float(r["next4"]) / 4
        change = nxt / rate - 1
        if abs(change) < TREND_MIN_CHANGE:
            continue
        # Standard error of the recent run-rate. The weekly sd is floored at Poisson and at the
        # forecast's own weekly sigma (the noise expected if there were no shift), so a lumpy item
        # whose recent weeks happen to be quiet can't fake precision.
        sig = float(S.sig_wide.loc[mid].iloc[:4].mean()) if mid in S.sig_wide.index else 0.0
        sd = max(x.std(ddof=1), math.sqrt(rate), sig if np.isfinite(sig) else 0.0)
        z = (nxt - rate) / (sd / math.sqrt(len(x)))
        if abs(z) < TREND_Z:
            continue
        up = change > 0
        delta4 = (nxt - rate) * 4
        sev = "serious" if (abs(change) >= 0.5 and r["abc"] == "A") else "warning" if r["abc"] in ("A", "B") else "info"
        out.append(_alert(
            "trend", sev, f"{r['medicine_name']}: forecast {'up' if up else 'down'} {abs(change):.0%}",
            f"The model expects {nxt:.1f} units/week over the next 4 forecast weeks vs {rate:.1f} sold per week over "
            f"the last 12 weeks (z = {z:+.1f}). The recent rate alone would {'under' if up else 'over'}-order by about {abs(delta4):.0f} units a month.",
            f"{'Raise' if up else 'Lower'} the standing order to ~{math.ceil(nxt * 4)} units per 4 weeks",
            abs(delta4) * r["median_price"],
            {"recent_weekly": rate, "forecast_weekly": nxt, "change": change, "z": z},
            f"{mid}:{S.fweeks[0]}:{'up' if up else 'down'}", mid=mid))
    return out


# ── 4. stockout risk (A class) ───────────────────────────────────────────────

def stockout_alerts() -> list[dict]:
    m = S.meds[S.meds["abc"] == "A"]
    sd4 = np.sqrt(window_var(S.sig_wide.iloc[:, :4]))   # same week-to-week error correlation as the anomaly test
    nd = NormalDist()
    out = []
    for mid, r in m.iterrows():
        mu, sd, last = float(r["next4"]), float(sd4.get(mid, np.nan)), float(r["last4"])
        if not np.isfinite(sd) or sd <= 0:
            continue
        p = 1 - nd.cdf((last + 0.5 - mu) / sd)     # continuity-corrected P(demand > last4)
        short = mu - last
        if p < STOCKOUT_P or short < max(STOCKOUT_MIN_SHORT, STOCKOUT_MIN_SHORT_REL * last):
            continue
        sev = "critical" if p >= 0.97 else "serious" if p >= 0.90 else "warning"
        out.append(_alert(
            "stockout", sev, f"{r['medicine_name']}: {p:.0%} chance last month's order runs short",
            f"A-class item. Forecast {mu:.0f} units for the next 4 weeks (±{1.645 * sd:.0f} at 90%) vs {last:.0f} sold in "
            f"the last 4. Reordering what sold last month leaves an expected gap of {short:.0f} units.",
            f"Order ~{math.ceil(mu + 1.645 * sd)} units (95% cover) instead of {last:.0f}",
            short * r["median_price"],
            {"p_short": p, "forecast_4w": mu, "sd_4w": sd, "last_4w": last, "expected_short": short},
            f"{mid}:{S.fweeks[0]}", mid=mid))
    return out


# ── 5. expiry risk ───────────────────────────────────────────────────────────

_sales_lock = threading.Lock()


@lru_cache(maxsize=1)
def shelf_life() -> pd.DataFrame:
    with _sales_lock:   # a request arriving during warm-up waits instead of parsing the raw file twice
        s = get_sales()
    dte = (s["expiry_date"] - pd.to_datetime(s["sale_date"])).dt.days
    g = pd.DataFrame({"medicine_id": s["medicine_id"], "dte": dte}).dropna().groupby("medicine_id")["dte"]
    return pd.DataFrame({"shelf_days": g.quantile(EXPIRY_PCTL), "lines": g.size()})


def _warm():
    try:
        shelf_life()
    except Exception:   # the request path will surface any real error
        pass


# Raw sales take several seconds to parse; warm the cache so the first inbox request stays fast.
threading.Thread(target=_warm, daemon=True).start()


def expiry_alerts() -> list[dict]:
    lead, review, service = PLAN_DEFAULT
    p = plan_rows(lead, review, service, S.meds).join(shelf_life(), how="left")
    out = []
    for mid, r in p.iterrows():
        if pd.isna(r["shelf_days"]) or r["lines"] < EXPIRY_MIN_SALES:
            continue
        rate_day = max(float(r["weekly_rate"]), 1e-6) / 7
        life = float(r["shelf_days"])
        safe = EXPIRY_SAFE_FRACTION * life
        one_unit_days = 1 / rate_day
        held = float(r["order_up_to"])
        cover_days = held / rate_day if held > 0 else 0.0
        price = float(r["median_price"])
        if one_unit_days > life:
            # Even a single unit is expected to outlive its shelf life: never hold it.
            out.append(_alert(
                "expiry", "serious" if price >= 1000 else "warning",
                f"{r['medicine_name']}: one unit outlasts its shelf life",
                f"Sells about {r['weekly_rate']:.2f} units/week, so one unit takes ~{one_unit_days:.0f} days to sell, "
                f"but batches typically have only {life:.0f} days left when sold (10th percentile).",
                "Order only against a prescription; do not keep on the shelf", price,
                {"shelf_days": life, "days_per_unit": one_unit_days, "order_up_to": held, "weekly_rate": r["weekly_rate"]},
                f"{mid}:oneunit", mid=mid))
        elif held > 0 and cover_days > safe:
            sellable = rate_day * safe
            excess = max(held - sellable, 0)
            share = cover_days / life
            out.append(_alert(
                "expiry", "serious" if share >= 0.8 else "warning",
                f"{r['medicine_name']}: planned stock covers {share:.0%} of shelf life",
                f"The planner's order-up-to of {held:.0f} units lasts ~{cover_days:.0f} days at {r['weekly_rate']:.2f} units/week, "
                f"more than {EXPIRY_SAFE_FRACTION:.0%} of the {life:.0f}-day shelf life batches typically have left.",
                f"Cap stock at {max(math.floor(sellable), 1)} units and reorder more often",
                excess * price,
                {"shelf_days": life, "cover_days": cover_days, "order_up_to": held, "safe_units": sellable,
                 "weekly_rate": r["weekly_rate"]},
                f"{mid}:cover", mid=mid))
    return out


# ── 5b. live ledger: expiry on shelf & stockout now (selected store) ─────────

def _n(x: float, word: str, plural: str | None = None) -> str:
    """'1 unit' / '3 units' (x rounded to a whole number first)."""
    k = int(round(float(x)))
    return f"{k} {word if k == 1 else (plural or word + 's')}"


def _store_note(st: dict) -> str:
    return (f" {st['name']} is a simulated branch: demand = main-shop forecast x {float(st['demand_scale']):g}."
            if not st["is_main"] else "")


def ledger_expiry_alerts(st: dict) -> list[dict]:
    """Expired stock still on the shelf (critical) and batches expiring within LEDGER_EXPIRY_DAYS that a
    FEFO sell-through projection says will not sell out (severity by rupees at risk, at cost)."""
    from backend.routers.stock import expiring_report
    rep = expiring_report(st["id"], float(st["demand_scale"]), LEDGER_EXPIRY_DAYS, include_expired=True)
    out, note = [], _store_note(st)

    def href(mid: str) -> str:
        return f"/stock?tab=expiring&focus={mid}"

    by_med: dict[str, list[dict]] = {}
    for r in rep["rows"]:
        if r["expired"]:
            by_med.setdefault(r["medicine_id"], []).append(r)
    for mid, rs in by_med.items():
        units, value = sum(r["qty"] for r in rs), sum(r["value"] for r in rs)
        listed = ", ".join(f"{r['batch_no']} exp {pd.Timestamp(r['expiry_date']).strftime('%d %b %Y').lstrip('0')}" for r in rs[:3])
        out.append(_alert(
            "expiry", "critical", f"{rs[0]['medicine_name']}: {units} expired unit{'s' if units != 1 else ''} still on the shelf",
            f"{len(rs)} batch{'es' if len(rs) != 1 else ''} at {st['name']} passed expiry ({listed}). Expired stock is never "
            f"sold (FEFO skips it) but must be quarantined and written off.{note}",
            "Remove from the shelf, quarantine it, and write it off on the Stock page", value,
            {"source": "ledger", "store_id": st["id"], "expired_units": units, "expired_value": value, "batches": len(rs)},
            f"ledger:expired:{st['id']}:{mid}:{rs[0]['expiry_date']}", mid=mid if mid in S.meds.index else None,
            href=href(mid)))
    for r in rep["rows"]:
        if r["expired"] or r["proj_unsold"] < LEDGER_EXPIRY_MIN_UNITS:
            continue
        risk = float(r["loss_value"])
        sev = "serious" if risk >= LEDGER_SERIOUS_INR else "warning" if risk >= LEDGER_WARNING_INR else "info"
        mid = r["medicine_id"]
        out.append(_alert(
            "expiry", sev,
            f"{r['medicine_name']}: ~{r['proj_unsold']:.0f} of {_n(r['qty'], 'unit')} may expire unsold",
            f"Batch {r['batch_no']} expires {r['expiry_date']} (in {_n(r['days_left'], 'day')}). Selling earliest-expiry first at the "
            f"forecast rate, about {_n(r['proj_sold'], 'unit')} sell{'s' if round(float(r['proj_sold'])) == 1 else ''} before then and {r['proj_unsold']:.0f} would be left "
            f"(up to {r['proj_unsold_slow']:.0f} if demand runs at the low end of the forecast). This is a projection, "
            f"not a certainty.{note}",
            "Move it to the front of the shelf, transfer it to a busier branch, or ask the supplier about returns",
            risk,
            {"source": "ledger", "store_id": st["id"], "batch_no": r["batch_no"], "expiry_date": r["expiry_date"],
             "days_left": r["days_left"], "qty": r["qty"], "proj_unsold": r["proj_unsold"],
             "proj_unsold_slow": r["proj_unsold_slow"], "loss_value_slow": r["loss_value_slow"]},
            f"ledger:batch:{st['id']}:{r['batch_id']}:{r['expiry_date']}", mid=mid if mid in S.meds.index else None,
            href=href(mid)))
    return out


def stockout_now_alerts(st: dict, lead_time: int) -> list[dict]:
    """A/B items whose sellable stock at the store is below forecast demand over the supplier lead time."""
    from backend import inventory as inv
    weeks = max(lead_time, STOCKOUT_NOW_MIN_LEAD)
    pos = inv.stock_position(st["id"], weeks=4)
    scale = float(st["demand_scale"])
    lt_demand = S.fc_wide.iloc[:, :weeks].sum(1).reindex(pos.index).fillna(0) * scale
    note = _store_note(st)
    out = []
    for mid, r in pos[pos["abc"].isin(["A", "B"])].iterrows():
        need = float(lt_demand.get(mid, 0.0))
        qty = int(r["qty"])
        if need < 1 or qty >= need:
            continue
        short = need - qty
        if r["abc"] == "A":
            sev = "critical" if qty == 0 else "serious"
        else:
            sev = "serious" if qty == 0 else "warning"
        state = "out of stock" if qty == 0 else f"only {qty} on hand"
        units_txt = "unit is" if qty == 1 else "units are"
        out.append(_alert(
            "stockout_now", sev, f"{r['medicine_name']}: {state} at {st['name']}",
            f"{r['abc']}-class item. Forecast demand over the {weeks}-week supplier lead time is about {_n(need, 'unit')}, "
            f"but only {qty} sellable {units_txt} on the shelf (expired stock excluded), so roughly {_n(short, 'unit')} "
            f"of demand could go unserved before a new order arrives.{note}",
            f"Order now or request a transfer from another branch (at least ~{_n(math.ceil(short), 'unit')})",
            short * float(r["median_price"]),
            {"source": "ledger", "store_id": st["id"], "on_hand": qty, "lead_time_demand": need, "short": short,
             "lead_time_weeks": weeks, "weekly_rate": float(r["weekly_rate"])},
            f"ledger:stockout:{st['id']}:{mid}:{qty == 0}", mid=mid, href=f"/stock?tab=low&focus={mid}"))
    return out


# ── 6. data quality ──────────────────────────────────────────────────────────

def data_alerts() -> list[dict]:
    hw = S.hist_wide.fillna(0)
    out = []
    for mid, r in S.meds.iterrows():
        if (r["total_units"] or 0) <= 0:
            out.append(_alert("data", "info", f"{r['medicine_name']}: never sold",
                              "Listed in the catalogue but has no sales in the whole history, so no forecast is possible.",
                              "Confirm it is still stocked, or delist it", 0, {"total_units": 0},
                              f"{mid}:never", mid=mid))
            continue
        if mid not in hw.index:
            continue
        x = hw.loc[mid].to_numpy(float)
        recent, before = x[-DORMANT_WEEKS:], x[:-DORMANT_WEEKS]
        if recent.sum() > 0 or not len(before):
            continue
        freq = (before > 0).mean()                       # share of earlier weeks with any sale
        p_silence = (1 - freq) ** DORMANT_WEEKS
        if p_silence >= DORMANT_P:
            continue
        lost = before.mean() * DORMANT_WEEKS * r["median_price"]
        out.append(_alert(
            "data", "serious" if r["abc"] == "A" else "warning", f"{r['medicine_name']}: no sales for {DORMANT_WEEKS} weeks",
            f"It sold in {freq:.0%} of earlier weeks ({before.mean():.1f} units/week), so {DORMANT_WEEKS} silent weeks "
            f"would happen by chance with p {_p(p_silence) if _p(p_silence).startswith('<') else '= ' + _p(p_silence)}. Likely out of stock, delisted or mis-coded.",
            "Check shelf and supplier; fix the item code if sales go elsewhere", lost,
            {"weeks_silent": DORMANT_WEEKS, "earlier_weekly": before.mean(), "sell_week_share": freq, "p": _p(p_silence)},
            f"{mid}:dormant", mid=mid))
    return out


# ── endpoint ─────────────────────────────────────────────────────────────────

def build(today: date, lead_time: int, store: dict | None = None) -> list[dict]:
    alerts = (season_alerts(today, lead_time) + anomaly_alerts() + trend_alerts() + stockout_alerts()
              + expiry_alerts() + data_alerts())
    if store is not None:
        # Live ledger of one store. The ledger has no history, so these always use the real today.
        alerts += ledger_expiry_alerts(store) + stockout_now_alerts(store, lead_time)
    return sorted(alerts, key=lambda a: (SEV_RANK[a["severity"]], -a["impact_inr"]))


def _ledger_store(user: dict, store_id: str | None) -> dict | None:
    """The store whose live stock feeds the ledger alerts (None if no stores exist yet)."""
    from backend import inventory as inv
    sid = resolve_store(user, store_id)      # 403 / 404 for an inaccessible or unknown store
    if sid is None:
        return None
    try:
        return inv.get_store(sid)
    except inv.InventoryError:
        return None


@router.get("")
def alerts(severity: Literal["critical", "serious", "warning", "info"] | None = None,
           type: Literal["season", "anomaly", "trend", "stockout", "stockout_now", "expiry", "data"] | None = None,
           lead_time: int = Query(1, ge=0, le=8, description="Supplier lead time (weeks) for order-by dates"),
           as_of: date | None = Query(None, description="Override today's date (YYYY-MM-DD)"),
           store_id: str | None = Query(None, max_length=32, description="Store for live-ledger alerts (default: selected store)"),
           user: dict = Depends(current_user)):
    today = as_of or date.today()
    if not date(2020, 1, 1) <= today <= date(2035, 12, 31):
        raise HTTPException(422, "as_of out of range")
    store = _ledger_store(user, store_id)
    all_alerts = build(today, lead_time, store)

    counts = {"severity": {s: 0 for s in SEVERITIES}, "type": {t: 0 for t in TYPES}, "total": len(all_alerts)}
    for a in all_alerts:
        counts["severity"][a["severity"]] += 1
        counts["type"][a["type"]] += 1

    sel = [a for a in all_alerts if (severity is None or a["severity"] == severity) and (type is None or a["type"] == type)]
    shown, per = [], {t: 0 for t in TYPES}
    for a in sel:
        if per[a["type"]] < TYPE_CAP:
            shown.append(a)
            per[a["type"]] += 1
    hidden = {t: n for t in TYPES if (n := sum(a["type"] == t for a in sel) - per[t]) > 0}
    return clean({
        "generated_at": S.meta["generated_at"], "as_of": today.isoformat(),
        "store": ({"id": store["id"], "name": store["name"], "demand_scale": float(store["demand_scale"]),
                   "simulated": not store["is_main"]} if store else None),
        "history_end": S.weeks[-1], "forecast_start": S.fweeks[0],
        "counts": counts, "matched": len(sel), "hidden": hidden, "cap_per_type": TYPE_CAP,
        "type_labels": TYPE_LABEL,
        "thresholds": {"min_uplift": MIN_UPLIFT, "fdr_q": FDR_Q, "trend_min_change": TREND_MIN_CHANGE, "trend_z": TREND_Z,
                       "stockout_p": STOCKOUT_P, "expiry_safe_fraction": EXPIRY_SAFE_FRACTION, "expiry_pctl": EXPIRY_PCTL,
                       "dormant_weeks": DORMANT_WEEKS, "dormant_p": DORMANT_P, "season_window_weeks": SEASON_WINDOW_WEEKS,
                       "ledger_expiry_days": LEDGER_EXPIRY_DAYS, "ledger_serious_inr": LEDGER_SERIOUS_INR,
                       "ledger_warning_inr": LEDGER_WARNING_INR},
        "alerts": shown,
    })


@router.get("/calibration")
def calibration():
    """Null check for the anomaly test: run it on earlier backtest windows of every tested length
    (non-overlapping, all ending before the trailing 3-week alert window).

    If the test is calibrated, about 5% of raw p-values fall below 0.05 there and 1% below 0.01
    (fewer means conservative). Real anomalies can occur in these windows too, so FDR hits there
    are an upper bound on false alarms, not a pure null count."""
    bt = S.bt
    weeks = sorted(bt["week"].unique())
    act = bt.pivot(index="medicine_id", columns="week", values="actual").reindex(columns=weeks)
    mu = bt.pivot(index="medicine_id", columns="week", values="ensemble").reindex(columns=weeks)
    sg = bt.pivot(index="medicine_id", columns="week", values="sigma").reindex(columns=weeks)
    size = purchase_size()
    stop = len(weeks) - max(ANOMALY_WINDOWS)                # first week of the live alert window
    out = []
    for w in ANOMALY_WINDOWS:
        for end in range(w, stop + 1, w):
            cols = weeks[end - w:end]
            a, e, v = act[cols].sum(1, min_count=w), mu[cols].sum(1, min_count=w), window_var(sg[cols])
            ok = a.notna() & e.notna() & np.isfinite(v)
            p = np.array([count_test(float(a[m]), float(e[m]), float(v[m]), float(size.get(m, 1.0)))["p"]
                          for m in a.index[ok]])
            if not len(p):
                continue
            out.append({"window_weeks": w, "window": f"{cols[0]}..{cols[-1]}", "tests": len(p),
                        "share_p05": float((p < 0.05).mean()), "share_p01": float((p < 0.01).mean()),
                        "fdr_hits": int((bh_qvalues(p) <= FDR_Q).sum())})
    agg = lambda k: float(np.mean([o[k] for o in out])) if out else None
    return clean({"error_correlation": err_corr(), "windows": out,
                  "mean_share_p05": agg("share_p05"), "mean_share_p01": agg("share_p01")})
