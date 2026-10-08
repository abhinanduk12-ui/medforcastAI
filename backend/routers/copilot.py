"""MedForecast Copilot - a chat assistant grounded only in this system's data.

Two engines share the same tool functions over `S`:
  * claude - server-side agentic tool-use loop with the Anthropic SDK (when ANTHROPIC_API_KEY is set)
  * local  - deterministic intent detection + entity extraction, then the same tools, composed into markdown

Every number in an answer comes from a tool result; nothing is generated from thin air.
"""
from __future__ import annotations

import difflib
import json
import math
import os
import re
from datetime import date
from functools import lru_cache
from typing import Any, Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ml import config as C
from backend.core import (S, clean, season_today, next_season, season_movers, plan_rows,
                          z_for, MIN_UPLIFT, MIN_SEASON_BASE)

router = APIRouter(prefix="/api/copilot", tags=["copilot"])

MODEL = "claude-opus-5-5"
MAX_ITERATIONS = 8
MAX_QUERY_WORDS = 24   # content words fuzzy-matched per message
CONTEXT_TURNS = 8      # user turns replayed by the local engine to resolve follow-ups
Z90 = 1.645
FESTIVAL_SEASON = {"Onam": "Monsoon", "Vishu": "Summer", "Christmas/New Year": "Winter"}


# ═════════════════════════════════════════════════════════════════════════════
#  Small helpers
# ═════════════════════════════════════════════════════════════════════════════
def _n(x: float | None, d: int = 0) -> str:
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "–"
    return f"{x:,.{d}f}"


def _pct(x: float | None, d: int = 0, signed: bool = True) -> str:
    if x is None or not math.isfinite(x):
        return "–"
    s = f"{abs(x) * 100:.{d}f}%"
    if float(s[:-1]) == 0:
        return "0%"
    return (("+" if x > 0 else "−" if x < 0 else "") + s) if signed else s


def _inr(x: float | None) -> str:
    return "–" if x is None or not math.isfinite(x) else f"₹{x:,.0f}"


def _svc(x: float) -> str:
    """Service level as a percent without misleading rounding (0.975 -> '97.5%', not '98%')."""
    return f"{x * 100:.1f}".rstrip("0").rstrip(".") + "%"


def _season_name(s: str | None) -> str | None:
    if not s or not isinstance(s, str):
        return None
    for k in C.SEASON_ORDER:
        if k.lower().replace("-", "") == s.lower().replace("-", "").replace(" ", ""):
            return k
    return None


def _category_name(c: str | None) -> str | None:
    if not c or not isinstance(c, str):
        return None
    cats = S.meds["category"].unique().tolist()
    for k in cats:
        if k.lower() == c.lower():
            return k
    hit = [k for k in cats if c.lower() in k.lower()]
    return hit[0] if len(hit) == 1 else None


def _med_or_none(mid: str | None) -> str | None:
    if not mid:
        return None
    mid = str(mid).strip().upper()
    return mid if mid in S.meds.index else None


def _name(mid: str) -> str:
    return str(S.meds.at[mid, "medicine_name"])


def _spark(mid: str) -> list[float]:
    return S.hist_wide.loc[mid].iloc[-16:].fillna(0).tolist() if mid in S.hist_wide.index else []


def medicine_card(mid: str) -> dict:
    r = S.meds.loc[mid]
    return clean({"type": "medicine", "id": mid, "name": r["medicine_name"], "category": r["category"],
                  "next4": r["next4"], "spark": _spark(mid)})


class ToolError(ValueError):
    """Bad tool input - reported back to the model (or user) rather than raised as a 500."""


# ═════════════════════════════════════════════════════════════════════════════
#  Fuzzy medicine index
# ═════════════════════════════════════════════════════════════════════════════
# Words that appear in product names but say nothing about which product is meant.
MED_STOP = {"tablet", "tablets", "tab", "capsule", "capsules", "cap", "syrup", "powder", "cream", "ointment", "liquid",
            "antiseptic", "relief", "pain", "sachet", "injection", "oral", "solution", "drops", "drop", "gel", "advance",
            "duo", "plus", "and", "with", "acid", "salts", "forte", "suspension", "the", "for", "containing", "topical",
            "fluid", "mg", "ml", "mcg", "iu", "kit", "spray", "lotion", "vaccine", "whole", "fresh", "frozen"}
_INDEX: dict[str, Any] = {}


def _tokens(s: str) -> list[str]:
    return re.findall(r"[a-z][a-z\-]*[a-z]|\d+(?:\.\d+)?", s.lower())


def _med_index() -> dict:
    key = S.meta.get("generated_at"), len(S.meds)
    if _INDEX.get("key") == key:
        return _INDEX
    rows = []
    vocab: set[str] = set()
    for mid, r in S.meds.iterrows():
        nt = _tokens(str(r["medicine_name"]))
        alpha = [t for t in nt if not t[0].isdigit() and len(t) >= 3 and t not in MED_STOP]
        brand = alpha[0] if alpha else None
        gen = [t for t in _tokens(str(r["generic_name"])) if not t[0].isdigit() and len(t) >= 4 and t not in MED_STOP]
        nums = {t for t in nt if t[0].isdigit()}
        rows.append((mid, brand, set(alpha), set(gen), nums, float(r["total_units"] or 0)))
        vocab |= set(alpha) | set(gen)
    _INDEX.clear()
    _INDEX.update(key=key, rows=rows, vocab=sorted(vocab))
    return _INDEX


@lru_cache(maxsize=200_000)
def _tok_match(q: str, t: str) -> float:
    """Similarity of a query token to a product token: exact for short words, fuzzy (typos) for longer ones."""
    if q == t:
        return 1.0
    if len(q) < 5 or len(t) < 5:
        return 0.0
    if t.startswith(q) and len(q) >= 5:
        return 0.95
    r = difflib.SequenceMatcher(None, q, t).ratio()
    return r if r >= 0.84 else 0.0


def match_medicines(text: str, category: str | None = None, ignore: set[str] = frozenset(), limit: int = 8) -> list[dict]:
    """Rank medicines by fuzzy match of query tokens against brand, other name words and generic name."""
    idx = _med_index()
    q = [t for t in _tokens(text) if t not in ignore]
    # Unique words only, and at most MAX_QUERY_WORDS of them: every word is fuzzy-matched against every product,
    # so an unbounded message (4,000 chars of names) would otherwise take tens of seconds.
    qa = list(dict.fromkeys(t for t in q if not t[0].isdigit() and len(t) >= 3 and t not in QUERY_STOP))[:MAX_QUERY_WORDS]
    qn = {t for t in q if t[0].isdigit()}
    if not qa:
        return []
    out = []
    for mid, brand, alpha, gen, nums, units in idx["rows"]:
        if category and S.meds.at[mid, "category"] != category:
            continue
        score, used = 0.0, set()
        for t in qa:
            best = 0.0
            if brand:
                best = max(best, 3.0 * _tok_match(t, brand))
            best = max(best, max((1.5 * _tok_match(t, a) for a in alpha if a != brand), default=0.0))
            best = max(best, max((2.0 * _tok_match(t, g) for g in gen), default=0.0))
            if best > 0:
                score += best
                used.add(t)
        if score >= 1.9:
            if qn & nums:
                score += 1.0
            out.append({"id": mid, "score": round(score, 3), "used": used, "units": units})
    out.sort(key=lambda d: (-d["score"], -d["units"]))
    return out[:limit]


def extract_medicines(text: str, ignore: set[str] = frozenset(), k: int = 3) -> list[str]:
    """Pull up to k distinct medicines from free text (greedy: best match, drop its words, repeat)."""
    found: list[str] = []
    ign = set(ignore)
    for _ in range(k):
        m = match_medicines(text, ignore=ign, limit=1)
        if not m or m[0]["score"] < (2.5 if found else 1.9) or m[0]["id"] in found:
            break
        found.append(m[0]["id"])
        ign |= m[0]["used"]
    return found


# ═════════════════════════════════════════════════════════════════════════════
#  Tools (shared by both engines)
# ═════════════════════════════════════════════════════════════════════════════
def search_medicines(query: str, category: str | None = None, limit: int = 8) -> dict:
    query = str(query or "").strip()
    if not query:
        raise ToolError("query is required")
    cat = _category_name(category) if category else None
    if category and not cat:
        raise ToolError(f"Unknown category '{category}'. Use list_categories.")
    limit = max(1, min(int(limit or 8), 25))
    hits = match_medicines(query, cat, limit=limit)
    if not hits:  # plain substring fallback (ids, partial names)
        ql = query.lower()
        m = S.meds if not cat else S.meds[S.meds["category"] == cat]
        sub = m[m["medicine_name"].str.lower().str.contains(ql, regex=False)
                | m["generic_name"].str.lower().str.contains(ql, regex=False)
                | m.index.str.lower().str.contains(ql, regex=False)]
        hits = [{"id": i, "score": 1.0} for i in sub.sort_values("total_units", ascending=False).index[:limit]]
    rows = []
    for h in hits:
        r = S.meds.loc[h["id"]]
        rows.append({"medicine_id": h["id"], "name": r["medicine_name"], "generic": r["generic_name"],
                     "category": r["category"], "form": r["form"], "price": r["median_price"],
                     "next4_forecast": r["next4"], "last4_actual": r["last4"], "match_score": h["score"]})
    suggestions = [] if rows else difflib.get_close_matches(query.lower(), _med_index()["vocab"], n=5, cutoff=0.6)
    return clean({"query": query, "category": cat, "count": len(rows), "results": rows, "did_you_mean": suggestions})


def _backtest(mid: str) -> dict | None:
    bt = S.bt[S.bt["medicine_id"] == mid]
    if not len(bt):
        return None
    a, f = float(bt["actual"].sum()), float(bt["ensemble"].sum())
    return {"window": f"{bt['week'].min()} to {bt['week'].max()}", "weeks": int(len(bt)), "actual_units": a,
            "forecast_units": f, "total_error_pct": (f - a) / a if a else None,
            "weeks_inside_90pct_range": float(((bt["actual"] >= bt["lo"]) & (bt["actual"] <= bt["hi"])).mean())}


def get_medicine_forecast(medicine_id: str, weeks: int = 4) -> dict:
    mid = _med_or_none(medicine_id)
    if not mid:
        raise ToolError(f"Unknown medicine_id '{medicine_id}'. Use search_medicines first.")
    weeks = max(1, min(int(weeks or 4), len(S.fweeks)))
    r = S.meds.loc[mid]
    fc = S.fc[S.fc["medicine_id"] == mid].sort_values("week")

    def window(n: int) -> dict:
        f = fc.head(n)
        mu, sd = float(f["ensemble"].sum()), math.sqrt(float((f["sigma"] ** 2).sum()))
        if n == 1:  # one week: use the calibrated (asymmetric) interval itself, as the weekly table does
            lo, hi = float(f["lo"].iloc[0]), float(f["hi"].iloc[0])
        else:       # several weeks: normal approximation to the sum, weeks assumed independent
            lo, hi = max(0.0, mu - Z90 * sd), mu + Z90 * sd
        return {"weeks": n, "from": f["week"].iloc[0], "to": f["week"].iloc[-1], "units": mu, "lo90": lo, "hi90": hi}

    cur = season_today()
    last4 = float(r["last4"])
    return clean({
        "medicine_id": mid, "name": r["medicine_name"], "generic": r["generic_name"], "category": r["category"],
        "form": r["form"], "price": r["median_price"], "abc_class": r["abc"], "demand_pattern": r["demand_class"],
        "requested": window(weeks), "next4": window(min(4, len(S.fweeks))), "next12": window(len(S.fweeks)),
        "last4_actual": last4, "last12_actual": r["last12"], "avg_weekly_all_history": r["avg_weekly"],
        "trend_next4_vs_last4": (float(r["next4"]) / last4 - 1) if last4 > 0 else None,
        "weekly": [{"week": w, "forecast": e, "lo90": lo, "hi90": hi}
                   for w, e, lo, hi in fc[["week", "ensemble", "lo", "hi"]].itertuples(index=False)][:weeks],
        "current_season": cur, "current_season_index": r[f"idx_{cur}"],
        "holdout_backtest": _backtest(mid),
        "note": "Range is an approximate 90% interval from calibrated forecast error, assuming independent weeks.",
    })


def _category_uplifts(season: str) -> list[dict]:
    m = S.meds[S.meds["base_level"] > 0]
    col = f"idx_{season}"
    cat = m.assign(base=m["base_level"], exp=m["base_level"] * m[col]).groupby("category")[["base", "exp"]].sum()
    cat = cat[cat["base"] >= 1.5]
    cat["uplift"] = cat["exp"] / cat["base"] - 1
    sig = S.csi[(S.csi["season"] == season)].set_index("category")["significant"]
    cat["significant"] = sig.reindex(cat.index).fillna(False).astype(bool)
    return cat.sort_values("uplift", ascending=False).reset_index() \
        .rename(columns={"base": "base_weekly", "exp": "expected_weekly"}).to_dict("records")


def get_season_impact(season: str, category: str | None = None, n: int = 8) -> dict:
    s = _season_name(season)
    if not s:
        raise ToolError(f"Unknown season '{season}'. Use one of {C.SEASON_ORDER}.")
    cat = _category_name(category) if category else None
    if category and not cat:
        raise ToolError(f"Unknown category '{category}'. Use list_categories.")
    n = max(1, min(int(n or 8), 20))
    mv = season_movers(s, n, cat)
    keep = ["medicine_id", "medicine_name", "category", "base_level", "expected_weekly", "uplift", "extra_weekly",
            "extra_revenue_weekly"]
    cats = _category_uplifts(s)
    if cat:
        cats = [c for c in cats if c["category"] == cat]
    fest = []
    for f, fs in FESTIVAL_SEASON.items():
        if fs == s:
            d = S.fest[(S.fest["festival"] == f) & S.fest["significant"]]
            if cat:  # a category question must not be answered with another category's festival effect
                d = d[d["category"] == cat]
            fest += [{"festival": f, "category": x["category"], "uplift": x["uplift"], "z": x["z"]}
                     for x in d.to_dict("records")]
    cur = season_today()
    pool = S.meds[S.meds["base_level"] > 0]
    if cat:
        pool = pool[pool["category"] == cat]
    base = float(pool["base_level"].sum())
    overall = float((pool["base_level"] * pool[f"idx_{s}"]).sum()) / base - 1 if base > 0 else None
    return clean({
        "season": s, "months": C.SEASON_META[s]["months"], "drivers": C.SEASON_META[s]["drivers"],
        "is_current": s == cur, "current_season": cur, "category_filter": cat,
        "overall_uplift": overall,
        "overall_note": f"Net change in typical weekly units across {'the ' + cat + ' category' if cat else 'the whole store'} "
                        f"in {s} vs a typical week (base-level weighted).",
        "threshold": f"Only medicines selling >= {MIN_SEASON_BASE} unit/week and moving >= {MIN_UPLIFT:.0%} are listed.",
        "rising": [{k: x[k] for k in keep} for x in mv["rising"]],
        "falling": [{k: x[k] for k in keep} for x in mv["falling"]],
        "category_uplifts": cats if cat else cats[:6] + [c for c in cats[-3:] if c not in cats[:6]],
        "significant_festival_effects": fest,
    })


def get_stock_plan(medicine_id: str | None = None, category: str | None = None, lead_time: int = 1,
                   review: int = 2, service: float = 0.95, limit: int = 10) -> dict:
    lead_time = int(lead_time if lead_time is not None else 1)
    review = int(review if review is not None else 2)
    service = float(service if service is not None else 0.95)
    if service > 1:  # accept 95 as well as 0.95
        service /= 100
    if not 0 <= lead_time <= 8:
        raise ToolError("lead_time must be 0-8 weeks")
    if not 1 <= review <= 8:
        raise ToolError("review must be 1-8 weeks")
    if not 0.5 <= service <= 0.999:
        raise ToolError("service must be between 0.5 and 0.999")
    if medicine_id:
        mid = _med_or_none(medicine_id)
        if not mid:
            raise ToolError(f"Unknown medicine_id '{medicine_id}'. Use search_medicines first.")
        m = S.meds.loc[[mid]]
        cat = None
    elif category:
        cat = _category_name(category)
        if not cat:
            raise ToolError(f"Unknown category '{category}'. Use list_categories.")
        m = S.meds[S.meds["category"] == cat]
    else:
        raise ToolError("Give either medicine_id or category")
    p = plan_rows(lead_time, review, service, m)
    p = p.sort_values("stock_value", ascending=False)
    rows = [{"medicine_id": i, "name": r["medicine_name"], "weekly_rate": r["weekly_rate"],
             "cover_demand": r["cover_demand"], "safety_stock": r["safety_stock"], "order_up_to": r["order_up_to"],
             "stock_value": r["stock_value"], "policy": r["policy"], "last4_actual": r["last4"]}
            for i, r in p.head(max(1, min(int(limit or 10), 30))).iterrows()]
    return clean({
        "params": {"lead_time_weeks": lead_time, "review_weeks": review, "service_level": service,
                   "z": z_for(service), "cover_weeks": min(lead_time + review, len(S.fweeks)),
                   "forecast_start": S.fweeks[0]},
        "scope": {"medicine_id": medicine_id and rows[0]["medicine_id"], "category": cat},
        "summary": {"items": int(len(p)), "units": float(p["order_up_to"].sum()),
                    "safety_units": float(p["safety_stock"].sum()), "value": float(p["stock_value"].sum()),
                    "on_demand_items": int((p["policy"] == "On demand").sum())},
        "rows": rows,
        "method": "Order-up-to = forecast demand over (lead time + review) + z x combined forecast error. "
                  "Items under 0.5 units/week use an exact Poisson quantile ('On demand'). "
                  "Subtract stock on hand to get the order quantity.",
    })


def get_model_performance(category: str | None = None) -> dict:
    h = S.metrics["holdout"]
    ov = h["overall"]
    sc = h["seasonal_categories"]
    out = {
        "holdout_window": S.metrics["protocol"]["fold_b"]["test"],
        "trained_until": S.metrics["protocol"]["fold_b"]["train_until"],
        "models": {k: {"label": v["label"], "item_week_wape": v["wape"], "bias": v["bias"]} for k, v in ov.items()},
        "seasonal_categories": {"categories": sc["categories"], "share_of_units": sc["share_of_units"],
                                "category_week_wape_ensemble": sc["category_week"]["ensemble"],
                                "category_week_wape_ma8": sc["category_week"]["ma8"]},
        "all_categories_week_wape": h["aggregate"]["category_week"],
        "store_week_wape": h["aggregate"]["store_week"],
        "coverage_90": h["coverage_90"], "noise_floor_item_week_wape": h["noise_floor_wape"],
        "seasonal_direction_accuracy": h["direction_accuracy"],
        "ensemble_weights": S.metrics.get("production_weights"),
        "notes": "WAPE = total absolute error / total actual units (lower is better). The noise floor is the error a "
                 "perfect model would still make on single-medicine weekly sales because they are mostly random.",
    }
    cat = _category_name(category) if category else None
    if category and not cat:
        raise ToolError(f"Unknown category '{category}'.")
    if cat:
        bc = [c for c in h["by_category"] if c["category"] == cat]
        out["category"] = bc[0] if bc else None
    return clean(out)


def list_categories() -> dict:
    c = S.meds.groupby("category").agg(medicines=("medicine_name", "size"), units_sold=("total_units", "sum"),
                                       next12_forecast=("next12", "sum"))
    peaks = {}
    for cat in c.index:
        g = S.csi[S.csi["category"] == cat].set_index("season")["index"]
        peaks[cat] = g.idxmax() if len(g) else None
    c["peak_season"] = pd.Series(peaks)
    return clean({"count": int(len(c)), "categories": c.sort_values("units_sold", ascending=False).reset_index()
                  .to_dict("records")})


def compare_seasons(medicine_id: str) -> dict:
    mid = _med_or_none(medicine_id)
    if not mid:
        raise ToolError(f"Unknown medicine_id '{medicine_id}'. Use search_medicines first.")
    r = S.meds.loc[mid]
    msi = S.msi[S.msi["medicine_id"] == mid].set_index("season")
    rows = []
    for s in C.SEASON_ORDER:
        rows.append({"season": s, "months": C.SEASON_META[s]["months"], "index": r[f"idx_{s}"],
                     "uplift": r[f"idx_{s}"] - 1, "expected_weekly": r["base_level"] * r[f"idx_{s}"],
                     "category_index": msi.at[s, "cat_index"] if s in msi.index else None,
                     "transactions_observed": msi.at[s, "n_tx"] if s in msi.index else 0})
    best = max(rows, key=lambda x: x["index"])
    worst = min(rows, key=lambda x: x["index"])
    return clean({"medicine_id": mid, "name": r["medicine_name"], "category": r["category"],
                  "base_weekly": r["base_level"], "seasons": rows, "peak": best["season"], "low": worst["season"],
                  "current_season": season_today(), "next_season": next_season(season_today()),
                  "note": "Index 1.0 = a typical week. Indices are shrunk toward the category when data is thin."})


def get_top_medicines(category: str | None = None, by: str = "next4", n: int = 8) -> dict:
    cat = _category_name(category) if category else None
    if category and not cat:
        raise ToolError(f"Unknown category '{category}'.")
    if by not in ("next4", "next12", "growth", "revenue"):
        raise ToolError("by must be next4, next12, growth or revenue")
    n = max(1, min(int(n or 8), 20))
    m = S.meds if not cat else S.meds[S.meds["category"] == cat]
    m = m.assign(growth=np.where(m["last4"] >= 8, m["next4"] / m["last4"].replace(0, np.nan) - 1, np.nan),
                 revenue4=m["next4"] * m["median_price"])
    key = {"next4": "next4", "next12": "next12", "growth": "growth", "revenue": "revenue4"}[by]
    m = m.dropna(subset=[key]).sort_values(key, ascending=False).head(n)
    rows = [{"medicine_id": i, "name": r["medicine_name"], "category": r["category"], "next4": r["next4"],
             "next12": r["next12"], "last4": r["last4"], "growth_next4_vs_last4": r["growth"],
             "next4_revenue": r["revenue4"]} for i, r in m.iterrows()]
    return clean({"by": by, "category": cat, "rows": rows,
                  "note": "growth only ranked for medicines with >= 8 units sold in the last 4 weeks."})


TOOLS: dict[str, dict] = {
    "search_medicines": {
        "fn": search_medicines,
        "description": "Find medicines by brand or generic name (typo-tolerant). Returns medicine_id values needed by "
                       "other tools, plus a 4-week forecast. Use this first whenever the user names a medicine.",
        "schema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Brand or generic name, e.g. 'Dolo 650' or 'cetirizine'"},
            "category": {"type": "string", "description": "Optional exact category name to filter by"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 25}}, "required": ["query"]},
    },
    "get_medicine_forecast": {
        "fn": get_medicine_forecast,
        "description": "Ensemble demand forecast for one medicine: units for the requested number of weeks, next 4 and "
                       "next 12 weeks with an approximate 90% range, last 4/12 weeks actual sales, trend, the current "
                       "season index and its holdout backtest accuracy.",
        "schema": {"type": "object", "properties": {
            "medicine_id": {"type": "string", "description": "e.g. MED00390"},
            "weeks": {"type": "integer", "minimum": 1, "maximum": 12, "description": "Horizon to sum, default 4"}},
            "required": ["medicine_id"]},
    },
    "get_season_impact": {
        "fn": get_season_impact,
        "description": "Which medicines rise or fall in a Kerala season (Winter Dec-Feb, Summer Mar-May, Monsoon "
                       "Jun-Sep, Post-Monsoon Oct-Nov), category uplifts with significance, and significant festival "
                       "effects (Onam, Vishu, Christmas/New Year).",
        "schema": {"type": "object", "properties": {
            "season": {"type": "string", "enum": C.SEASON_ORDER},
            "category": {"type": "string", "description": "Optional exact category name"},
            "n": {"type": "integer", "minimum": 1, "maximum": 20}}, "required": ["season"]},
    },
    "get_stock_plan": {
        "fn": get_stock_plan,
        "description": "Order-up-to stock levels for one medicine or a whole category given supplier lead time, review "
                       "period and service level. Give medicine_id OR category.",
        "schema": {"type": "object", "properties": {
            "medicine_id": {"type": "string"}, "category": {"type": "string"},
            "lead_time": {"type": "integer", "minimum": 0, "maximum": 8, "description": "Supplier lead time in weeks (default 1)"},
            "review": {"type": "integer", "minimum": 1, "maximum": 8, "description": "Weeks between orders (default 2)"},
            "service": {"type": "number", "minimum": 0.5, "maximum": 0.999, "description": "Target in-stock probability, default 0.95"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 30}}},
    },
    "get_model_performance": {
        "fn": get_model_performance,
        "description": "Holdout accuracy of the forecasting models (Jun-Aug 2026 monsoon, unseen in training): WAPE by "
                       "level, 90% interval coverage, noise floor, ensemble weights. Optional category.",
        "schema": {"type": "object", "properties": {"category": {"type": "string"}}},
    },
    "list_categories": {
        "fn": list_categories,
        "description": "All therapeutic categories with medicine count, units sold, 12-week forecast and peak season.",
        "schema": {"type": "object", "properties": {}},
    },
    "compare_seasons": {
        "fn": compare_seasons,
        "description": "Seasonal profile of one medicine: index and expected weekly units in each of the four seasons, "
                       "peak and low season.",
        "schema": {"type": "object", "properties": {"medicine_id": {"type": "string"}}, "required": ["medicine_id"]},
    },
    "get_top_medicines": {
        "fn": get_top_medicines,
        "description": "Top medicines by forecast volume (next4/next12), forecast growth vs the last 4 weeks, or "
                       "forecast revenue, optionally within a category.",
        "schema": {"type": "object", "properties": {
            "category": {"type": "string"}, "by": {"type": "string", "enum": ["next4", "next12", "growth", "revenue"]},
            "n": {"type": "integer", "minimum": 1, "maximum": 20}}},
    },
}


def run_tool(name: str, args: dict) -> dict:
    if name not in TOOLS:
        raise ToolError(f"Unknown tool '{name}'")
    if not isinstance(args, dict):
        raise ToolError("Tool input must be an object")
    allowed = set(TOOLS[name]["schema"]["properties"])
    try:
        return TOOLS[name]["fn"](**{k: v for k, v in args.items() if k in allowed})
    except ToolError:
        raise
    except Exception as e:  # wrong types from the model (int for a name, inf for weeks...) must never become a 500
        raise ToolError(f"Invalid input: {type(e).__name__}: {e}") from e


def tool_summary(name: str, args: dict, result: dict | None) -> str:
    """Short human label for the UI chip, e.g. 'Looked up forecast · Dolo 650mg'."""
    try:
        return _tool_summary(name, args, result)
    except Exception:  # odd argument types from the model: fall back to the bare tool name
        return name


def _tool_summary(name: str, args: dict, result: dict | None) -> str:
    def med(mid):
        m = _med_or_none(mid)
        return _name(m) if m else str(mid)
    a = args or {}
    if name == "search_medicines":
        n = (result or {}).get("count")
        return f"Searched medicines · “{a.get('query', '')}”" + (f" · {n} found" if n is not None else "")
    if name == "get_medicine_forecast":
        return f"Looked up forecast · {med(a.get('medicine_id'))}"
    if name == "get_season_impact":
        return "Season impact · " + " · ".join(x for x in [_season_name(a.get("season")) or a.get("season"),
                                                           _category_name(a.get("category"))] if x)
    if name == "get_stock_plan":
        tgt = med(a["medicine_id"]) if a.get("medicine_id") else (_category_name(a.get("category")) or "?")
        return f"Stock plan · {tgt} · {a.get('lead_time', 1)} wk lead"
    if name == "get_model_performance":
        return "Checked model accuracy"
    if name == "list_categories":
        return "Listed categories"
    if name == "compare_seasons":
        return f"Compared seasons · {med(a.get('medicine_id'))}"
    if name == "get_top_medicines":
        return f"Top medicines · by {a.get('by', 'next4')}" + (f" · {a['category']}" if a.get("category") else "")
    return name


# ═════════════════════════════════════════════════════════════════════════════
#  Local engine: intent detection + entity extraction
# ═════════════════════════════════════════════════════════════════════════════
QUERY_STOP = set("""
how much many will would sell selling sold next month months week weeks what whats about which should stock stocks
stocking for the and with lead time service level plan planning compare comparison seasons season seasonal forecast
forecasts demand rise rises rising increase spike drop fall falling in of me my is are was model models accurate accuracy
top show give tell does did do it its this that these those up on at to an by per than more less from sales units
shop store pharmacy medicine medicines drug drugs category categories order orders reorder keep shelf buy need needs
expected expect predict prediction predicted trend trending last year onam vishu christmas new safety during between
across over be can you please help list all any good best most fast fastest moving movers quarter days now today current
currently coming upcoming impact effect antibiotics antibiotic winter summer monsoon rainy rain rains post north east
northeast thulavarsham edavappathi cold hot heat dry review every percent reliable error errors wape backtest weekly
busiest busy quietest quiet slowest slow strongest weakest hello hi hey thanks thank there their they them we our us get got go going want like look looks see when where who why
also just only one two three four five six eight ten twelve stay stays normal much lot lots range uncertain
uncertainty peak low high highest lowest profile pattern patterns same other else okay ok yes no not well vs versus
vitamins vitamin supplements allergy allergies antihistamines antifungals fungal antiseptics painkillers painkiller
fever cough respiratory diabetes diabetic cardiac heart stomach gastro malaria cancer oncology vaccines skin eye
""".split())

SEASON_PATTERNS = [
    ("Post-Monsoon", r"post[\s-]?monsoon|north[\s-]?east monsoon|northeast monsoon|thulavarsham|october|november"),
    ("Monsoon", r"monsoon|rainy|\brains?\b|south[\s-]?west|edavappathi|\bonam\b|\bjune\b|\bjuly\b|\baugust\b|september"),
    ("Winter", r"winter|cold season|christmas|new year|december|january|february"),
    ("Summer", r"summer|hot season|\bheat\b|\bvishu\b|\bmarch\b|\bapril\b"),
]
FESTIVAL_PATTERNS = {"Onam": r"\bonam\b", "Vishu": r"\bvishu\b", "Christmas/New Year": r"christmas|new year"}

CATEGORY_KEYWORDS = [
    (r"antibiotics?|anti[\s-]?bacterial", "Antibiotic"),
    (r"antihistamines?|allerg(y|ies|ic)", "Antihistamine/Allergy"),
    (r"pain ?killers?|analgesics?|antipyretics?|fever", "Analgesic/Antipyretic"),
    (r"\bnsaids?\b", "NSAID"),
    (r"vitamins?|supplements?", "Vitamin/Supplement"),
    (r"anti[\s-]?fungals?|fungal", "Antifungal"),
    (r"antiseptics?|disinfectants?", "Antiseptic/Disinfectant"),
    (r"respiratory|cough|asthma", "Respiratory"),
    (r"anti[\s-]?diabetics?|diabet(es|ic)", "Antidiabetic"),
    (r"cardiac|heart|anti[\s-]?hypertensives?|blood pressure|\bbp\b", "Cardiac/Antihypertensive"),
    (r"gastro\w*|stomach|acidity|antacids?", "Gastrointestinal"),
    (r"anti[\s-]?malarials?|malaria", "Antimalarial"),
    (r"oncology|cancer|anti[\s-]?neoplastics?|chemo\w*", "Antineoplastic (Oncology)"),
    (r"vaccines?|immunological", "Vaccine/Immunological"),
    (r"anti[\s-]?retrovirals?|\bart\b|\bhiv\b", "Antiretroviral (ART Program)"),
    (r"anti[\s-]?virals?", "Antiviral"),
    (r"neuro\w*|psychiatric|anti[\s-]?depressants?", "Neuro/Psychiatric"),
    (r"anti[\s-]?epileptics?|epilepsy|seizures?", "Antiepileptic"),
    (r"dermatolog\w*|\bskin\b", "Dermatological"),
    (r"ophthalmic|\beye\b", "Ophthalmic"),
    (r"hormon\w*|endocrine|thyroid", "Hormone/Endocrine"),
]

CLINICAL = r"\b(dose|dosage|side[\s-]?effects?|interactions?|contraindicat\w*|prescribe|safe (for|in|during)|pregnan\w*|cure|treat(ment)?|overdose)\b"
INTENTS = [  # (intent, pattern) in priority order
    ("help", r"^\s*(help|hi|hello|hey|what can you do|what can i ask|how do(es)? (this|you) work)\b"),
    ("accuracy", r"accura\w*|\berrors?\b|\bwape\b|reliab\w*|trust|backtest|how good is|model perf\w*|how well does the model"),
    ("categories", r"\b(list|show|which|what) (all )?(the )?categories\b|categories (do|are)"),
    ("compare", r"compar\w*|which season|best season|peak season|seasonal (pattern|profile)|across (the )?seasons|by season|every season|all seasons|(busiest|quietest|slowest|strongest) (season|time|months?)|when (is|are|do|does) .{0,30}(busiest|quietest|slowest)"),
    ("stock", r"\bstock (plan|level)|plan (the )?stock|plan stock|reorder|order[- ]up[- ]to|safety stock|lead[\s-]?time|service level|how (much|many) (should i|to) (keep|order|stock|hold)|\bshelf\b|\bplan\b"),
    ("top", r"\btop\b|best[\s-]?sell\w*|fastest|most (sold|selling|popular|demand)|highest (demand|forecast)|biggest|growing|trending"),
    ("season", r"stock up|\bris(e|es|ing)\b|\bincreas\w*|\bspik\w*|\bdrop\w*|\bfall(s|ing)?\b|\bdecreas\w*|season(al)? (impact|effect)|what sells|prepare|get ready"),
    ("forecast", r"forecast|how (much|many)|\bsell\b|\bsales\b|demand|expect|predict|next (week|month|quarter|\d+ weeks)"),
]


def _detect_season(t: str) -> tuple[str | None, list[str]]:
    fest = [f for f, p in FESTIVAL_PATTERNS.items() if re.search(p, t)]
    if re.search(r"\b(this|current) season\b|right now|\bcurrently\b", t):
        return season_today(), fest
    if re.search(r"\b(next|coming|upcoming) season\b", t):
        return next_season(season_today()), fest
    for s, p in SEASON_PATTERNS:
        if re.search(p, t):
            return s, fest
    return None, fest


def _detect_category(t: str) -> tuple[str | None, set[str]]:
    for p, cat in CATEGORY_KEYWORDS:
        m = re.search(p, t)
        if m:
            return cat, set(_tokens(m.group(0)))
    for cat in S.meds["category"].unique():
        head = cat.split("/")[0].split(" (")[0].lower()
        if len(head) >= 5 and re.search(r"\b" + re.escape(head), t):
            return cat, set(_tokens(head))
    return None, set()


def _detect_numbers(t: str) -> dict:
    out: dict[str, Any] = {}
    m = re.search(r"lead[\s-]?time\D{0,12}?(\d+)\s*(?:wk|week)?|(\d+)[\s-]*(?:wk|week)s?\W+lead", t)
    if m:
        out["lead_time"] = int(m.group(1) or m.group(2))
    m = re.search(r"(?:review|order)\w*\s+(?:period\s+)?(?:of\s+|every\s+)?(\d+)\s*(?:wk|week)|every\s+(\d+)\s*(?:wk|week)", t)
    if m:
        out["review"] = int(m.group(1) or m.group(2))
    m = re.search(r"(\d{2}(?:\.\d+)?)\s*%", t)
    if m and 50 <= float(m.group(1)) < 100:
        out["service"] = float(m.group(1)) / 100
    if re.search(r"next week\b|this week\b", t):
        out["weeks"] = 1
    elif re.search(r"next (3|three) months|quarter|next 12 weeks|this season|next season|rest of the season", t):
        out["weeks"] = 12
    elif re.search(r"next (2|two) months", t):
        out["weeks"] = 8
    elif re.search(r"next month|this month|coming month|4 weeks|four weeks", t):
        out["weeks"] = 4
    else:
        m = re.search(r"next (\d+) weeks?", t)
        if m:
            out["weeks"] = max(1, min(int(m.group(1)), 12))
    return out


def parse_message(text: str) -> dict:
    t = text.lower().strip()
    intent = None
    for name, p in INTENTS:
        if re.search(p, t):
            intent = name
            break
    if re.search(CLINICAL, t):
        intent = "clinical"
    season, fest = _detect_season(t)
    cat, cat_tokens = _detect_category(t)
    nums = _detect_numbers(t)
    meds = extract_medicines(text, ignore=cat_tokens)
    # "Stock up for winter" / "what to order for monsoon" is a seasonal question, not a stock plan.
    if intent == "stock" and season and not meds and not nums.get("lead_time") and re.search(r"stock up|order for|for (the )?\w+ season", t):
        intent = "season"
    pronoun = bool(re.search(r"\b(it|its|this one|that one|same|them|this medicine|that medicine)\b", t))
    followup = bool(re.search(r"^\s*(and|what about|how about|and what about|same for|now|ok|okay|also)\b", t)) or \
        (intent is None and len(t.split()) <= 6)
    return {"text": text, "intent": intent, "season": season, "festivals": fest, "category": cat, "meds": meds,
            "nums": nums, "pronoun": pronoun, "followup": followup}


def resolve(messages: list[dict]) -> dict:
    """Walk the user turns, carrying context forward so follow-ups ('what about winter?') resolve."""
    state: dict[str, Any] = {"intent": None, "season": None, "category": None, "meds": [], "nums": {}, "festivals": []}
    cur: dict = {}
    users = [m for m in messages if m["role"] == "user"][-CONTEXT_TURNS:]  # older turns cannot change the outcome much
    for msg in users:
        p = parse_message(msg["content"])
        new = dict(state)
        if p["intent"] and not p["followup"]:
            # A fresh question: keep only the medicine (for pronouns) and drop the other filters.
            new = {"intent": p["intent"], "season": None, "category": None, "nums": {}, "festivals": [],
                   "meds": state["meds"] if (p["pronoun"] or not p["meds"]) and p["intent"] in
                   ("forecast", "stock", "compare", "accuracy") and not p["category"] else []}
        elif p["intent"]:
            new["intent"] = p["intent"]
        if p["meds"]:
            new["meds"] = p["meds"]
            if not p["category"] and p["intent"] is None and state.get("category"):
                new["category"] = None
        if p["category"]:
            new["category"] = p["category"]
            if not p["meds"] and p["intent"] not in ("forecast", "compare", "accuracy"):
                new["meds"] = []
        if p["season"]:
            new["season"] = p["season"]
        if p["festivals"]:
            new["festivals"] = p["festivals"]
        new["nums"] = {**(state["nums"] if p["followup"] or not p["intent"] else {}), **p["nums"]}
        # No intent at all: infer from what was mentioned.
        if not new["intent"]:
            new["intent"] = "forecast" if new["meds"] else ("season" if new["season"] else None)
        state = new
        cur = p
    state["last"] = cur
    # Medicine + season together = how this medicine behaves in that season. A medicine named as a follow-up
    # to a season question ("Which antibiotics rise in monsoon?" -> "what about Allegra?") counts too.
    if state["meds"] and (state["intent"] in ("forecast", "compare", "season") and cur.get("season")
                          or state["intent"] == "season" and state["season"] and cur.get("meds")):
        state["intent"] = "med_season"
    if state["intent"] == "season" and not state["season"]:
        state["season"] = next_season(season_today())
    return state


# ─────────────────────────── composing answers ───────────────────────────
class Recorder:
    """Calls tools and records each call for the UI (name, input, summary)."""
    def __init__(self):
        self.calls: list[dict] = []
        self.med_ids: list[str] = []

    def __call__(self, name: str, **args) -> dict:
        args = {k: v for k, v in args.items() if v is not None}
        res = run_tool(name, args)
        self.calls.append({"name": name, "input": args, "summary": tool_summary(name, args, res)})
        return res

    def card(self, mid: str):
        if mid and mid not in self.med_ids:
            self.med_ids.append(mid)


def _fc_answer(rec: Recorder, mids: list[str], weeks: int) -> str:
    if len(mids) > 1:
        lines = [f"**Forecast for the next {weeks} week{'s' if weeks > 1 else ''}** (from {S.fweeks[0]}):", "",
                 "| Medicine | Forecast | 90% range | Last 4 wk sold | Trend |", "|---|---:|---:|---:|---:|"]
        for mid in mids:
            f = rec("get_medicine_forecast", medicine_id=mid, weeks=weeks)
            rec.card(mid)
            q = f["requested"]
            lines.append(f"| {f['name']} | **{_n(q['units'])}** | {_n(q['lo90'])}–{_n(q['hi90'])} | "
                         f"{_n(f['last4_actual'])} | {_pct(f['trend_next4_vs_last4'])} |")
        return "\n".join(lines)
    f = rec("get_medicine_forecast", medicine_id=mids[0], weeks=weeks)
    rec.card(mids[0])
    q = f["requested"]
    tr = f["trend_next4_vs_last4"]
    span = f"the next {weeks} week{'s' if weeks > 1 else ''} ({q['from']} to {q['to']})"
    out = [f"**{f['name']}** ({f['generic']}, {f['category']}): about **{_n(q['units'])} units** over {span}, "
           f"90% range **{_n(q['lo90'])}–{_n(q['hi90'])}**.", ""]
    out.append(f"- Last 4 weeks you sold **{_n(f['last4_actual'])}** units"
               + (f"; next 4 weeks is {_pct(tr)} vs that." if tr is not None else "."))
    if weeks != 12:
        out.append(f"- Next 12 weeks: **{_n(f['next12']['units'])}** units "
                   f"(range {_n(f['next12']['lo90'])}–{_n(f['next12']['hi90'])}).")
    idx = f["current_season_index"]
    if idx is not None:
        out.append(f"- {f['current_season']} (now) runs at index {idx:.2f} for this medicine "
                   f"({'about typical' if abs(idx - 1) < MIN_UPLIFT else _pct(idx - 1) + ' vs a typical week'}).")
    if f["price"]:
        out.append(f"- At ₹{f['price']:,.2f} each, that is roughly {_inr(q['units'] * f['price'])} of sales.")
    bt = f["holdout_backtest"]
    if bt and bt["actual_units"]:
        out.append(f"- Track record ({bt['window']} holdout, unseen in training): forecast {_n(bt['forecast_units'])} vs actual "
                   f"{_n(bt['actual_units'])} ({_pct(bt['total_error_pct'])} total error).")
    sib = S.meds[(S.meds["generic_name"] == f["generic"]) & (S.meds.index != mids[0])].sort_values("next4", ascending=False)
    if len(sib):
        out.append(f"- Other {f['generic']} products: " + ", ".join(
            f"{r['medicine_name']} ({_n(r['next4'])})" for _, r in sib.head(4).iterrows()) + " units in the next 4 weeks.")
    if f["demand_pattern"] in ("Intermittent", "Lumpy"):
        out.append(f"\n_Sales of this item are {f['demand_pattern'].lower()} (many zero weeks), so single weeks are "
                   f"hard to predict; trust the multi-week total more than any one week._")
    return "\n".join(out)


def _season_answer(rec: Recorder, season: str, category: str | None, festivals: list[str]) -> str:
    r = rec("get_season_impact", season=season, category=category, n=8)
    where = f" in {category}" if category else ""
    head = f"**{season}** ({r['months']}{', the current season' if r['is_current'] else ''}): {r['drivers']}."
    out = [head, ""]
    if r["rising"]:
        out += [f"**Rising{where}** – stock up on these:", "",
                "| Medicine | Uplift | Typical /wk | Expected /wk | Extra /wk |", "|---|---:|---:|---:|---:|"]
        for x in r["rising"]:
            rec.card(x["medicine_id"])
            out.append(f"| {x['medicine_name']} | {_pct(x['uplift'])} | {_n(x['base_level'], 1)} | "
                       f"{_n(x['expected_weekly'], 1)} | +{_n(x['extra_weekly'], 1)} |")
    else:
        out.append(f"**No medicine{where} rises by {MIN_UPLIFT:.0%} or more in {season}.** Demand stays close to normal, "
                   f"so there is no evidence-based stock-up list – keep ordering at your usual run-rate.")
    if r["falling"]:
        names = ", ".join(f"{x['medicine_name']} ({_pct(x['uplift'])})" for x in r["falling"][:5])
        out += ["", f"**Falling:** {names} – trim orders for these."]
    cats = r["category_uplifts"]
    if cats and not category:
        sig = [c for c in cats[:4] if c["significant"]]
        top = ", ".join(f"{c['category']} {_pct(c['uplift'])}{'*' if c['significant'] else ''}" for c in cats[:4])
        out += ["", f"**Category view:** {top}." + (" (* statistically significant)" if sig else "")]
    elif cats:
        c = cats[0]
        out += ["", f"{category} as a whole: {_pct(c['uplift'])} in {season}"
                + (" (statistically significant)." if c["significant"] else " (not statistically significant).")]
    for fx in r["significant_festival_effects"]:
        out.append(f"- Festival: **{fx['festival']}** lifts {fx['category']} by {_pct(fx['uplift'])} in festival weeks.")
    if festivals and not r["significant_festival_effects"]:
        out.append(f"- {', '.join(festivals)}: no statistically significant festival-week effect in the data beyond "
                   f"the normal {season} pattern.")
    out += ["", f"_{r['threshold']}_"]
    return "\n".join(out)


def _season_profile_answer(rec: Recorder, category: str | None) -> str:
    """'Which season is busiest (for antibiotics)?' - net change per season for the store or one category."""
    rows = [rec("get_season_impact", season=s, category=category, n=1) for s in C.SEASON_ORDER]
    scope = category or "the whole store"
    out = [f"**{category or 'Whole store'} across Kerala's seasons** (net change in weekly units vs a typical week):", "",
           "| Season | Months | Net change | Biggest riser |", "|---|---|---:|---|"]
    for r in rows:
        now = " (now)" if r["is_current"] else ""
        top = r["rising"][0] if r["rising"] else None
        if top:
            rec.card(top["medicine_id"])
        out.append(f"| {r['season']}{now} | {r['months']} | {_pct(r['overall_uplift'], 1)} | "
                   + (f"{top['medicine_name']} (+{_n(top['extra_weekly'], 1)}/wk, {_pct(top['uplift'])})" if top else "–")
                   + " |")
    valid = [r for r in rows if r["overall_uplift"] is not None]
    if valid:
        peak = max(valid, key=lambda r: r["overall_uplift"])
        low = min(valid, key=lambda r: r["overall_uplift"])
        out.append("")
        if peak["overall_uplift"] >= MIN_UPLIFT:
            out.append(f"The busiest season for {scope} is **{peak['season']}** ({_pct(peak['overall_uplift'], 1)}); "
                       f"the quietest is **{low['season']}** ({_pct(low['overall_uplift'], 1)}).")
        else:
            out.append(f"No season moves {scope} by {MIN_UPLIFT:.0%} or more overall (highest: {peak['season']}, "
                       f"{_pct(peak['overall_uplift'], 1)}); individual medicines can still move, see the biggest risers.")
    out.append(f"\n_Biggest riser = most extra units/week among medicines selling >= {MIN_SEASON_BASE} unit/week that "
               f"rise >= {MIN_UPLIFT:.0%}._")
    return "\n".join(out)


def _stock_answer(rec: Recorder, mids: list[str], category: str | None, nums: dict) -> str:
    lead, review, svc = nums.get("lead_time", 1), nums.get("review", 2), nums.get("service", 0.95)
    asked = (lead, review, svc)
    lead, review = max(0, min(lead, 8)), max(1, min(review, 8))
    svc = max(0.5, min(svc, 0.999))
    caveats = []
    if (lead, review, svc) != asked:
        caveats.append(f"Planning limits are lead time 0–8 weeks, review 1–8 weeks and service 50–99.9%, so I used "
                       f"lead {lead}, review {review}, {_svc(svc)} instead of what you asked.")
    if lead + review > len(S.fweeks):
        caveats.append(f"Lead + review is {lead + review} weeks but the forecast only covers {len(S.fweeks)}, so the "
                       f"plan covers {len(S.fweeks)} weeks and understates what you would need.")
    assumed = [x for x, k in (("lead time 1 week", "lead_time"), ("review every 2 weeks", "review"),
                              ("95% service level", "service")) if k not in nums]
    if mids:
        out = []
        for mid in mids:
            p = rec("get_stock_plan", medicine_id=mid, lead_time=lead, review=review, service=svc)
            rec.card(mid)
            x = p["rows"][0]
            pr = p["params"]
            if x["policy"] == "On demand":
                out.append(f"**{x['name']}**: sells only ~{_n(x['weekly_rate'], 2)} units/week, so it is an **on-demand** "
                           f"item – hold **{_n(x['order_up_to'])}** unit(s) (exact Poisson quantile at "
                           f"{_svc(pr['service_level'])}) and order when a prescription arrives.")
                continue
            out += [f"**{x['name']}** – keep stock up to **{_n(x['order_up_to'])} units**", "",
                    "| | Units |", "|---|---:|",
                    f"| Forecast demand over {pr['cover_weeks']} week{'s' if pr['cover_weeks'] != 1 else ''} (lead {pr['lead_time_weeks']} + review {pr['review_weeks']}) | {_n(x['cover_demand'], 1)} |",
                    f"| Safety stock at {_svc(pr['service_level'])} service (z = {pr['z']:.2f}) | +{_n(x['safety_stock'], 1)} |",
                    f"| **Order-up-to level** | **{_n(x['order_up_to'])}** |", "",
                    f"Worth about {_inr(x['stock_value'])} at the median selling price. Subtract what is on the shelf "
                    f"(and on order) to get the order quantity."]
            out.append("")
    else:
        p = rec("get_stock_plan", category=category, lead_time=lead, review=review, service=svc, limit=8)
        s, pr = p["summary"], p["params"]
        out = [f"**{category} stock plan** – {s['items']} medicines, **{_n(s['units'])} units** on the shelf "
               f"worth **{_inr(s['value'])}** ({pr['cover_weeks']}-week cover at {_svc(pr['service_level'])} service; "
               f"{s['on_demand_items']} slow movers on demand).", "",
               "| Medicine | Forecast /wk | Safety | Order-up-to | Value |", "|---|---:|---:|---:|---:|"]
        for x in p["rows"]:
            rec.card(x["medicine_id"])
            out.append(f"| {x['name']} | {_n(x['weekly_rate'], 1)} | +{_n(x['safety_stock'], 1)} | "
                       f"**{_n(x['order_up_to'])}** | {_inr(x['stock_value'])} |")
        out.append("")
        out.append("Top 8 by stock value; the Stock planner page has the full list with CSV export.")
    for c in caveats:
        out.append(f"\n> {c}")
    if assumed:
        out.append(f"\n_Assumed {', '.join(assumed)} – tell me yours (e.g. “lead time 2 weeks at 98%”) to recalculate._")
    return "\n".join(out).strip()


def _compare_answer(rec: Recorder, mid: str) -> str:
    r = rec("compare_seasons", medicine_id=mid)
    rec.card(mid)
    out = [f"**{r['name']}** across Kerala's seasons (typical week ≈ {_n(r['base_weekly'], 1)} units):", "",
           "| Season | Months | Index | vs typical | Expected /wk |", "|---|---|---:|---:|---:|"]
    for x in r["seasons"]:
        now = " (now)" if x["season"] == r["current_season"] else ""
        out.append(f"| {x['season']}{now} | {x['months']} | {x['index']:.2f} | {_pct(x['uplift'])} | {_n(x['expected_weekly'], 1)} |")
    peak = next(x for x in r["seasons"] if x["season"] == r["peak"])
    out.append("")
    if peak["uplift"] >= MIN_UPLIFT:
        out.append(f"Peak is **{r['peak']}** ({_pct(peak['uplift'])}); lowest is **{r['low']}**. Build stock ahead of "
                   f"{r['peak']} and run it down going into {r['low']}.")
    else:
        out.append(f"No season moves this medicine by {MIN_UPLIFT:.0%} or more – demand is essentially flat through the year.")
    out.append(f"\n_{r['note']}_")
    return "\n".join(out)


def _med_season_answer(rec: Recorder, mids: list[str], season: str) -> str:
    out = []
    for mid in mids:
        r = rec("compare_seasons", medicine_id=mid)
        rec.card(mid)
        x = next(s for s in r["seasons"] if s["season"] == season)
        u = x["uplift"]
        verdict = ("rises" if u >= MIN_UPLIFT else "falls" if u <= -MIN_UPLIFT else "stays close to normal")
        out.append(f"**{r['name']}** in **{season}** ({x['months']}): {verdict} – index **{x['index']:.2f}** "
                   f"({_pct(u)} vs a typical week), about **{_n(x['expected_weekly'], 1)} units/week** "
                   f"against a typical {_n(r['base_weekly'], 1)}. Its peak season is {r['peak']}.")
    return "\n\n".join(out)


def _accuracy_answer(rec: Recorder, mids: list[str], category: str | None) -> str:
    r = rec("get_model_performance", category=category)
    sc = r["seasonal_categories"]
    ens, ma8 = sc["category_week_wape_ensemble"], sc["category_week_wape_ma8"]
    item = r["models"]["ensemble"]["item_week_wape"]
    w = r["holdout_window"]
    out = [f"Tested on the **{w[0]} – {w[1]} monsoon**, which the models never saw (trained up to {r['trained_until']}):", "",
           "| Level | Ensemble error | 8-week average |", "|---|---:|---:|",
           f"| Monsoon-sensitive categories, weekly | **{_pct(ens, 1, False)}** | {_pct(ma8, 1, False)} |",
           f"| Whole store, weekly | **{_pct(r['store_week_wape']['ensemble'], 1, False)}** | {_pct(r['store_week_wape']['ma8'], 1, False)} |",
           f"| Single medicine, weekly | **{_pct(item, 1, False)}** | {_pct(r['models']['ma8']['item_week_wape'], 1, False)} |", "",
           f"- The 90% range contained the actual value **{_pct(r['coverage_90'], 0, False)}** of the time"
           + (" (well calibrated)." if r["coverage_90"] is not None and abs(r["coverage_90"] - 0.9) <= 0.05
              else f" (target 90%: the ranges are {'too wide' if (r['coverage_90'] or 0) > 0.9 else 'too narrow'})."),
           f"- Seasonal direction (up vs down) was right for **{_pct(r['seasonal_direction_accuracy'], 0, False)}** of medicines.",
           f"- Single-medicine weekly error looks high, but even a perfect model would score about "
           f"**{_pct(r['noise_floor_item_week_wape'], 0, False)}** there – weekly sales of one item are mostly random. "
           f"Rely on multi-week totals and category views."]
    if r.get("category"):
        c = r["category"]
        out.append(f"- **{c['category']}**: {_pct(c['wape_category'], 1, False)} weekly category error, "
                   f"{_pct(c['wape_item'], 1, False)} per medicine ({_n(c['units'])} units in the holdout).")
    for mid in mids[:2]:
        f = rec("get_medicine_forecast", medicine_id=mid, weeks=4)
        rec.card(mid)
        bt = f["holdout_backtest"]
        if bt and bt["actual_units"]:
            out.append(f"- **{f['name']}** holdout: forecast {_n(bt['forecast_units'])} vs actual {_n(bt['actual_units'])} "
                       f"units ({_pct(bt['total_error_pct'])}), {_pct(bt['weeks_inside_90pct_range'], 0, False)} of weeks inside the 90% range.")
    return "\n".join(out)


def _top_answer(rec: Recorder, category: str | None, text: str) -> str:
    by = "growth" if re.search(r"grow|trend|increas|rising", text.lower()) else \
        "revenue" if re.search(r"revenue|money|value|₹|rupee", text.lower()) else "next4"
    r = rec("get_top_medicines", category=category, by=by, n=8)
    label = {"next4": "forecast units, next 4 weeks", "growth": "forecast growth vs the last 4 weeks",
             "revenue": "forecast revenue, next 4 weeks"}[by]
    out = [f"**Top medicines{' in ' + category if category else ''}** by {label}:", "",
           "| # | Medicine | Next 4 wk | Last 4 wk | Change |" + (" Revenue |" if by == "revenue" else ""),
           "|---:|---|---:|---:|---:|" + ("---:|" if by == "revenue" else "")]
    for i, x in enumerate(r["rows"], 1):
        rec.card(x["medicine_id"]) if i <= 4 else None
        ch = (x["next4"] / x["last4"] - 1) if x["last4"] else None
        out.append(f"| {i} | {x['name']} | **{_n(x['next4'])}** | {_n(x['last4'])} | {_pct(ch)} |"
                   + (f" {_inr(x['next4_revenue'])} |" if by == "revenue" else ""))
    if by == "growth":
        out.append(f"\n_{r['note']}_")
    return "\n".join(out)


def _categories_answer(rec: Recorder) -> str:
    r = rec("list_categories")
    out = [f"The shop stocks **{r['count']} categories**. Largest by units sold:", "",
           "| Category | Medicines | Units sold | Next 12 wk | Peak season |", "|---|---:|---:|---:|---|"]
    for c in r["categories"][:12]:
        out.append(f"| {c['category']} | {c['medicines']} | {_n(c['units_sold'])} | {_n(c['next12_forecast'])} | {c['peak_season'] or '–'} |")
    return "\n".join(out)


HELP = ("I'm the **MedForecast Copilot**. I answer from this shop's sales history, forecasts and seasonal analysis only. Try:\n\n"
        "- **Forecasts** – “How much Dolo 650 will I sell next month?”\n"
        "- **Seasons** – “Which antibiotics rise in monsoon?”, “What should I stock up for winter?”\n"
        "- **Seasonal profile** – “Compare seasons for Cetzine”\n"
        "- **Stock plans** – “Plan stock for Augmentin with 2 week lead time at 98% service”\n"
        "- **Top movers** – “Top growing medicines”, “Best sellers in vitamins”\n"
        "- **Accuracy** – “How accurate is the model?”\n\n"
        "Follow-ups work too: “what about winter?”, “and Allegra?”, “with 3 weeks lead time”.")


def _unmatched_words(text: str) -> list[str]:
    """Content words that are not question vocabulary - probably a medicine name we failed to match."""
    return [w for w in _tokens(text) if len(w) >= 4 and w not in QUERY_STOP and not w[0].isdigit()]


def local_answer(messages: list[dict]) -> tuple[str, Recorder]:
    st = resolve(messages)
    rec = Recorder()
    last = st["last"]
    intent, mids, cat, season = st["intent"], st["meds"], st["category"], st["season"]
    weeks = st["nums"].get("weeks", 4)
    try:
        if intent == "clinical":
            ans = ("I can't advise on doses, side effects or treatment – this system only knows the shop's **sales and "
                   "demand**, not clinical information. Please check the product label, a current formulary or a "
                   "pharmacist/doctor.")
            if mids:
                ans += "\n\nWhat I *can* tell you about it:\n\n" + _fc_answer(rec, mids[:1], 4)
            return ans, rec
        if intent == "help":
            return HELP, rec
        if intent == "accuracy":
            return _accuracy_answer(rec, mids, cat), rec
        if intent == "categories":
            return _categories_answer(rec), rec
        if intent == "med_season" and mids:
            return _med_season_answer(rec, mids, last.get("season") or season), rec
        if intent == "compare" and len(mids) > 1 and not re.search(r"season", last.get("text", "").lower()):
            return _fc_answer(rec, mids[:3], weeks), rec
        if intent == "compare":
            if mids:
                return "\n\n".join(_compare_answer(rec, m) for m in mids[:2]), rec
            # No medicine: a store/category season profile - unless an unrecognised name was given (handled below).
            if cat or not _unmatched_words(last.get("text", "")):
                return _season_profile_answer(rec, cat), rec
        if intent == "stock":
            if mids or cat:
                return _stock_answer(rec, mids[:3], cat if not mids else None, st["nums"]), rec
        if intent == "season":
            return _season_answer(rec, season, cat, st["festivals"]), rec
        if intent == "top":
            return _top_answer(rec, cat, last.get("text", "")), rec
        if intent in ("forecast", "stock", "compare") and mids:
            return _fc_answer(rec, mids[:3], weeks), rec
        if cat and intent in ("forecast", "stock", "compare", None):
            if intent == "stock":
                return _stock_answer(rec, [], cat, st["nums"]), rec
            return _top_answer(rec, cat, last.get("text", "")), rec
        # Nothing resolvable: try to name what we could not find.
        words = _unmatched_words(last.get("text", ""))
        if intent in ("forecast", "stock", "compare") and words:
            s = rec("search_medicines", query=" ".join(words), limit=5)
            if s["count"]:
                for x in s["results"][:3]:
                    rec.card(x["medicine_id"])
                return ("I found these possible matches – which one did you mean?\n\n"
                        + "\n".join(f"- **{x['name']}** ({x['generic']}, {x['category']})" for x in s["results"])), rec
            sug = s["did_you_mean"]
            return (f"I couldn't find a medicine matching “{' '.join(words)}” in this shop's catalogue."
                    + (f" Did you mean: {', '.join(sug)}?" if sug else "")), rec
        if intent in ("forecast", "stock", "compare"):
            return ("Which medicine or category? For example: “How much Dolo 650 will I sell next month?” or "
                    "“Plan stock for antibiotics”."), rec
        return ("I'm not sure what you're asking, and I only answer from this shop's data.\n\n" + HELP), rec
    except ToolError as e:
        return f"I couldn't answer that: {e}", rec


# ═════════════════════════════════════════════════════════════════════════════
#  Claude engine: server-side agentic tool-use loop
# ═════════════════════════════════════════════════════════════════════════════
def system_prompt() -> str:
    cur = season_today()
    return (
        "You are MedForecast Copilot, a demand analyst for a single retail pharmacy in Kerala, India. "
        f"Today is {date.today().isoformat()}; the current Kerala season is {cur} and the next is {next_season(cur)}. "
        f"Weekly sales history runs {S.weeks[0]} to {S.weeks[-1]}; the forecast covers the 12 weeks from {S.fweeks[0]}.\n\n"
        "Answer ONLY from the tools. Every number you state must come from a tool result in this conversation; never "
        "estimate, recall or invent figures. If the tools cannot answer (clinical dosing, side effects, competitor "
        "prices, anything outside this shop's demand data), say so plainly. Always look medicines up with "
        "search_medicines before using a medicine_id. Mention uncertainty: give the 90% range with forecasts, and say "
        "when a season shows no meaningful change rather than inventing a stock-up list. When you assume planning "
        "parameters (lead time, review period, service level), say which.\n\n"
        "Write concise markdown for a busy pharmacist: lead with the answer, then a short list or a small table. "
        "Use units and ₹. No headings larger than bold text."
    )


def claude_tools() -> list[dict]:
    return [{"name": k, "description": v["description"], "input_schema": v["schema"]} for k, v in TOOLS.items()]


def _client():
    import anthropic
    return anthropic.Anthropic(timeout=90.0, max_retries=1)


def claude_answer(messages: list[dict], client=None) -> tuple[str, list[dict], list[str], str]:
    """Agentic loop: call Claude, run requested tools, feed results back, until it stops or the cap is hit."""
    client = client or _client()
    convo: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages]
    while convo and convo[0]["role"] != "user":  # the API requires the first message to be from the user
        convo.pop(0)
    calls: list[dict] = []
    med_ids: list[str] = []
    tools = claude_tools()
    text, served_by = "", MODEL
    for i in range(MAX_ITERATIONS + 1):
        kwargs = dict(model=MODEL, max_tokens=16000, system=system_prompt(), tools=tools, messages=convo,
                      output_config={"effort": "medium"},
                      betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        if i == MAX_ITERATIONS:  # cap reached: ask for a final answer from what it has
            kwargs["tool_choice"] = {"type": "none"}
        resp = client.beta.messages.create(**kwargs)
        served_by = getattr(resp, "model", None) or MODEL  # differs from MODEL when a server-side fallback answered
        text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text").strip()
        if resp.stop_reason == "refusal":
            raise RefusalError("The model declined this request.")
        if resp.stop_reason == "pause_turn":
            convo.append({"role": "assistant", "content": resp.content})
            continue
        uses = [b for b in resp.content if getattr(b, "type", "") == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses:
            break
        convo.append({"role": "assistant", "content": resp.content})
        results = []
        for u in uses:
            args = u.input if isinstance(u.input, dict) else {}
            try:
                res = run_tool(u.name, args)
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(res, ensure_ascii=False)})
                calls.append({"name": u.name, "input": args, "summary": tool_summary(u.name, args, res)})
                for mid in _mids_in(u.name, res):
                    if mid not in med_ids:
                        med_ids.append(mid)
            except ToolError as e:
                results.append({"type": "tool_result", "tool_use_id": u.id, "content": str(e), "is_error": True})
                calls.append({"name": u.name, "input": args, "summary": tool_summary(u.name, args, None) + " · error"})
        convo.append({"role": "user", "content": results})
    if not text:
        text = "_The model returned no text answer._"
    return text, calls, med_ids, served_by


class RefusalError(RuntimeError):
    pass


def _mids_in(name: str, res: dict) -> list[str]:
    """Medicines a tool result is about, for the mini-cards under the answer."""
    if isinstance(res.get("medicine_id"), str):
        return [res["medicine_id"]]
    if name == "search_medicines":
        return [r["medicine_id"] for r in res.get("results", [])[:2]]
    if name == "get_stock_plan":
        return [r["medicine_id"] for r in res.get("rows", [])[:3]]
    if name == "get_season_impact":
        return [r["medicine_id"] for r in res.get("rising", [])[:3]]
    if name == "get_top_medicines":
        return [r["medicine_id"] for r in res.get("rows", [])[:3]]
    return []


# ═════════════════════════════════════════════════════════════════════════════
#  Routes
# ═════════════════════════════════════════════════════════════════════════════
class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatIn(BaseModel):
    messages: list[Msg] = Field(min_length=1, max_length=40)
    engine: Literal["auto", "local", "claude"] = "auto"


def engine_available() -> str:
    return "claude" if os.environ.get("ANTHROPIC_API_KEY") else "local"


@router.get("/status")
def status():
    eng = engine_available()
    return clean({"engine": eng, "model": MODEL if eng == "claude" else None,
                  "today": date.today().isoformat(), "season": season_today(),
                  # the forecast window starts the week after the last sales data, which can be before today
                  "data_through": S.weeks[-1] if S.weeks else None,
                  "forecast_start": S.fweeks[0] if S.fweeks else None,
                  "tools": [{"name": k, "description": v["description"]} for k, v in TOOLS.items()]})


@router.post("/chat")
def chat(body: ChatIn):
    msgs = [m.model_dump() for m in body.messages]
    if msgs[-1]["role"] != "user":
        raise HTTPException(422, "The last message must be from the user")
    if not msgs[-1]["content"].strip():
        raise HTTPException(422, "Empty question")
    want = engine_available() if body.engine == "auto" else body.engine
    note = None
    if want == "claude":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            note = "Claude is not configured on this server (no ANTHROPIC_API_KEY), so the local engine answered."
        else:
            try:
                import anthropic
                try:
                    text, calls, mids, served_by = claude_answer(msgs)
                    cards = [medicine_card(m) for m in mids[:4]]
                    return clean({"answer": text, "tool_calls": calls, "cards": cards, "engine": "claude",
                                  "model": served_by})
                except anthropic.AuthenticationError:
                    note = "Claude rejected the API key, so the local engine answered."
                except anthropic.RateLimitError:
                    note = "Claude is rate-limited right now, so the local engine answered."
                except anthropic.APIStatusError as e:
                    note = f"Claude returned an error ({e.status_code}), so the local engine answered."
                except anthropic.APIConnectionError:
                    note = "Could not reach Claude, so the local engine answered."
                except RefusalError:
                    note = "Claude declined this request, so the local engine answered."
                except anthropic.APIError:  # timeouts, malformed responses and anything else the SDK raises
                    note = "Claude could not complete the request, so the local engine answered."
                except Exception:  # never let an unexpected response shape become a 500
                    note = "Claude returned an unexpected response, so the local engine answered."
            except ImportError:
                note = "The Anthropic SDK is not installed, so the local engine answered."
    text, rec = local_answer(msgs)
    if note:
        text = f"> {note}\n\n{text}"
    return clean({"answer": text, "tool_calls": rec.calls, "cards": [medicine_card(m) for m in rec.med_ids[:4]],
                  "engine": "local", "model": None, "note": note})
