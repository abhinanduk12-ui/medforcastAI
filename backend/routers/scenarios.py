"""Scenario Lab: what-if simulation layered on the 12-week ensemble forecast.

Every scenario is a per-medicine, per-week multiplier m[i, t] on the ensemble forecast:

    m = seasonal_factor * outbreak_factor * price_factor

* Seasonal intensity k rescales each forecast week's seasonal deviation. With the medicine's
  shrunk season index I for that week's season, the forecast implies a de-seasonalised level
  f / I, and the scenario uses the factor 1 + k (I - 1) in place of I:
      f_scen = f * (1 + k (I - 1)) / I  =  f * (1 + (k - 1)(I - 1) / I)
  The second form is used so k = 1 gives a factor of exactly 1.0 in floating point.
* Outbreaks add an epidemic-curve-shaped uplift: 1 + sum_j intensity_j * uplift_j(med) * curve_j(t).
* Price changes use constant own-price elasticity: (1 + p) ** e.

Forecast uncertainty is propagated by scaling each sigma by the same multiplier. The scenario
parameters themselves are treated as known (the bands show forecast error only).
"""
from __future__ import annotations

import math
from statistics import NormalDist
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator

from ml import config as C
from backend.core import S, clean, plan_rows, poisson_quantile, z_for, SLOW_MOVER_RATE

router = APIRouter(prefix="/api/scenarios", tags=["scenarios"])

Z90 = 1.6448536269514722
RISK_FLAG = 0.20          # stockout probability above which a medicine is flagged
TOPICAL = {"Cream", "Gel", "Lotion"}

# ── Outbreak catalogue ──────────────────────────────────────────────────────────────────────
# Each rule gives the peak uplift at intensity 1 (e.g. 0.6 = +60 % at the epidemic peak).
# Rules are checked in order and the first match wins, so molecule rules placed before a
# category rule override it. "generic" matches a substring of the generic name (case-insensitive).
Rule = dict  # {"match", "value", "uplift", "why", optional "exclude_forms" / "only_categories" sets}

OUTBREAKS: dict[str, dict] = {
    "dengue": {
        "label": "Dengue outbreak",
        "summary": "Fever care shifts to paracetamol and fluids; NSAIDs and aspirin are avoided.",
        "rules": [
            {"match": "generic", "value": ["Ibuprofen", "Aceclofenac", "Diclofenac", "Mefenamic", "Acetylsalicylic"],
             "uplift": -0.15, "exclude_forms": TOPICAL,
             "why": "WHO dengue guidance: avoid NSAIDs and aspirin (bleeding risk), so oral NSAIDs lose share to paracetamol. Topical forms excluded."},
            {"match": "generic", "value": ["Paracetamol"], "uplift": 0.60, "only_categories": {"Analgesic/Antipyretic"},
             "why": "Plain paracetamol is the only recommended antipyretic/analgesic in dengue. Cold combinations are not included."},
            {"match": "generic", "value": ["Oral rehydration"], "uplift": 0.50,
             "why": "Oral fluids are first-line management in the febrile and critical phase."},
            {"match": "generic", "value": ["Ringer", "Sodium chloride", "Glucose"], "uplift": 0.30,
             "why": "Crystalloid IV fluids for patients with warning signs or plasma leakage."},
            {"match": "generic", "value": ["Platelet", "Whole blood"], "uplift": 0.40,
             "why": "Transfusion for severe bleeding or very low platelets (small volumes, Rx only)."},
            {"match": "generic", "value": ["Ondansetron", "Domperidone"], "uplift": 0.20,
             "why": "Persistent vomiting is a common dengue symptom."},
            {"match": "category", "value": "Antimalarial", "uplift": 0.05,
             "why": "Some extra malaria testing and empiric treatment of undifferentiated fever. Kept small because malaria is rare in Kerala."},
            {"match": "category", "value": "Vitamin/Supplement", "uplift": 0.10,
             "why": "Consumer behaviour: patients buy multivitamins during recovery. This is weak clinical evidence, so it is kept modest."},
        ],
    },
    "influenza": {
        "label": "Influenza wave",
        "summary": "Symptomatic cold and fever relief, respiratory flare-ups and some secondary bacterial infection.",
        "rules": [
            {"match": "generic", "value": ["Paracetamol"], "uplift": 0.40,
             "why": "Fever and myalgia are the main influenza symptoms."},
            {"match": "category", "value": "Antihistamine/Allergy", "uplift": 0.40,
             "why": "Cold combination products (cetirizine or phenylephrine) for rhinorrhoea and congestion."},
            {"match": "category", "value": "Respiratory", "uplift": 0.35,
             "why": "Cough syrups, plus bronchodilators and inhaled steroids for flu-triggered asthma or COPD exacerbations."},
            {"match": "generic", "value": ["Ibuprofen"], "uplift": 0.20, "exclude_forms": TOPICAL,
             "why": "Alternative antipyretic for adults."},
            {"match": "generic", "value": ["Azithromycin", "Amoxicillin", "Cefixime", "Cefuroxime", "Levofloxacin"],
             "uplift": 0.15,
             "why": "Secondary bacterial sinusitis, otitis or pneumonia, plus real-world over-prescribing for viral illness."},
            {"match": "generic", "value": ["Ascorbic", "Zinc"], "uplift": 0.10,
             "why": "Consumer self-care purchases (vitamin C, zinc), not evidence-based treatment."},
            {"match": "category", "value": "Antiviral", "uplift": 0.0,
             "why": "No effect: this store's antivirals (acyclovir, entecavir, sofosbuvir) are not flu drugs, and oseltamivir is not stocked."},
        ],
    },
    "heatwave": {
        "label": "Heatwave",
        "summary": "Dehydration, heat illness, water- and food-borne GI infection and sweat-related skin problems.",
        "rules": [
            {"match": "generic", "value": ["Oral rehydration"], "uplift": 0.60,
             "why": "Dehydration and heat exhaustion are the commonest heatwave presentations."},
            {"match": "generic", "value": ["Ringer", "Sodium chloride", "Glucose", "Potassium chloride"], "uplift": 0.20,
             "why": "IV fluid and electrolyte replacement for heat exhaustion or heat stroke."},
            {"match": "generic", "value": ["Loperamide", "Ondansetron", "Lactobacillus", "Bacillus"], "uplift": 0.25,
             "why": "Higher rates of acute gastroenteritis in hot weather (food spoilage, water quality)."},
            {"match": "category", "value": "Gastrointestinal", "uplift": 0.10,
             "why": "General GI upset, including acidity and indigestion remedies."},
            {"match": "generic", "value": ["Calamine"], "uplift": 0.40,
             "why": "Prickly heat (miliaria) and sunburn relief."},
            {"match": "category", "value": "Dermatological", "uplift": 0.15,
             "why": "Sweat-related skin irritation."},
            {"match": "category", "value": "Antifungal", "uplift": 0.15,
             "why": "Tinea and candidal intertrigo flare with heat and sweating."},
            {"match": "category", "value": "Vitamin/Supplement", "uplift": 0.08,
             "why": "Multivitamin and electrolyte supplement purchases. Small effect."},
        ],
    },
    "conjunctivitis": {
        "label": "Conjunctivitis outbreak",
        "summary": "Mostly viral 'Madras eye': lubricant drops, antihistamines and empiric topical antibiotics.",
        "rules": [
            {"match": "generic", "value": ["Hydroxypropyl"], "uplift": 0.80,
             "why": "Lubricant eye drops (HPMC) are the mainstay of symptomatic relief in viral conjunctivitis."},
            {"match": "generic", "value": ["Moxifloxacin", "Ciprofloxacin", "Gentamicin", "Framycetin", "Fusidic"],
             "uplift": 0.30,
             "why": "These molecules are the usual topical eye antibiotics, prescribed widely in practice. The catalogue does not record which items are eye drops, so all forms are matched."},
            {"match": "category", "value": "Antihistamine/Allergy", "uplift": 0.10,
             "why": "Oral antihistamines for itching or an allergic component."},
            {"match": "category", "value": "Ophthalmic", "uplift": 0.0,
             "why": "No effect: this store's 'Ophthalmic' items are pilocarpine and timolol, which are chronic glaucoma drugs."},
        ],
    },
}
OutbreakType = Literal["dengue", "influenza", "heatwave", "conjunctivitis"]

# ── Own-price elasticity ────────────────────────────────────────────────────────────────────
# Constant-elasticity demand. Values are conservative, mid-range assumptions in line with the
# published literature, where pharmaceutical demand is inelastic and OTC is more elastic than Rx.
ELASTICITY_GROUPS = [
    {"group": "Chronic / maintenance Rx", "e": -0.10,
     "categories": ["Cardiac/Antihypertensive", "Antidiabetic", "Antiepileptic", "Neuro/Psychiatric", "Hormone/Endocrine",
                    "Endocrine/Metabolic", "Antiretroviral (ART Program)", "Antineoplastic (Oncology)", "Immunosuppressant",
                    "Anticoagulant", "Antitubercular", "Reproductive/Hormonal Health"],
     "why": "Patients on long-term therapy rarely skip doses over price."},
    {"group": "Acute Rx", "e": -0.20,
     "categories": ["Antibiotic", "Antimalarial", "Antiviral", "Respiratory", "Antifungal", "Ophthalmic", "Muscle Relaxant"],
     "why": "These are prescribed for a short course. Some patients substitute brands or shops."},
    {"group": "Hospital / emergency", "e": -0.05,
     "categories": ["Blood Product/Coagulation", "Anesthetic", "Antidote/Emergency", "Diagnostic/Contrast Agent",
                    "Opioid Analgesic", "Vaccine/Immunological"],
     "why": "Demand is set by the clinical event and is almost price-insensitive."},
    {"group": "OTC / self-care", "e": -0.50,
     "categories": ["Vitamin/Supplement", "Analgesic/Antipyretic", "NSAID", "Gastrointestinal", "Antihistamine/Allergy",
                    "Antiseptic/Disinfectant", "Dermatological"],
     "why": "Discretionary purchases where shoppers can switch shop, delay or do without."},
]
_CAT_E = {c: g["e"] for g in ELASTICITY_GROUPS for c in g["categories"]}
MIXED_RULE = "Other categories: Rx share × −0.10 + OTC share × −0.50 (from each medicine's own prescription share)."

# ── Presets ─────────────────────────────────────────────────────────────────────────────────
PRESETS = [
    {"id": "baseline", "name": "Baseline", "icon": "circle-dot",
     "rationale": "The ensemble forecast as it stands, with no adjustments.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [], "price_change_pct": 0}},
    {"id": "strong-monsoon", "name": "Strong monsoon", "icon": "cloud-rain",
     "rationale": "A wetter late SW and NE monsoon. Every seasonal swing in the window, up or down, is 50% larger than usual.",
     "params": {"seasonal_intensity": 1.5, "outbreaks": [], "price_change_pct": 0}},
    {"id": "weak-monsoon", "name": "Weak monsoon", "icon": "cloud-sun",
     "rationale": "A dry year. Seasonal swings are 40% smaller, so demand stays closer to each medicine's annual average.",
     "params": {"seasonal_intensity": 0.6, "outbreaks": [], "price_change_pct": 0}},
    {"id": "dengue", "name": "Dengue outbreak", "icon": "bug",
     "rationale": "Post-monsoon breeding peak. Paracetamol, ORS and IV fluids rise, while NSAIDs fall.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [{"type": "dengue", "intensity": 1.5, "start_week": 3, "duration_weeks": 8}],
                "price_change_pct": 0}},
    {"id": "influenza", "name": "Influenza wave", "icon": "thermometer",
     "rationale": "Kerala has a second flu peak in Oct–Nov. Cold, cough and fever lines rise.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [{"type": "influenza", "intensity": 1.0, "start_week": 5, "duration_weeks": 6}],
                "price_change_pct": 0}},
    {"id": "heatwave", "name": "Heatwave", "icon": "sun",
     "rationale": "An unseasonal hot spell. ORS, GI remedies and skin products rise.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [{"type": "heatwave", "intensity": 1.0, "start_week": 1, "duration_weeks": 4}],
                "price_change_pct": 0}},
    {"id": "conjunctivitis", "name": "Conjunctivitis outbreak", "icon": "eye",
     "rationale": "A fast 'Madras eye' wave. Lubricant drops and eye antibiotics rise.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [{"type": "conjunctivitis", "intensity": 2.0, "start_week": 2, "duration_weeks": 4}],
                "price_change_pct": 0}},
    {"id": "price-rise", "name": "Price rise 10%", "icon": "indian-rupee",
     "rationale": "MRP revision or supplier pass-through. OTC volume falls; chronic Rx barely moves.",
     "params": {"seasonal_intensity": 1.0, "outbreaks": [], "price_change_pct": 10}},
]


# ── Request model ───────────────────────────────────────────────────────────────────────────
class Outbreak(BaseModel):
    type: OutbreakType
    intensity: float = Field(1.0, ge=0, le=3)
    start_week: int = Field(1, ge=1, le=12)
    duration_weeks: int = Field(6, ge=1, le=12)


def _finite_or_tag(v):
    """Replace NaN/±Infinity (valid in Python's JSON parser) with a string, so validation fails
    with a 422 whose echoed input is still JSON-serialisable (a raw NaN makes the 422 itself a 500)."""
    if isinstance(v, float) and not math.isfinite(v):
        return "non-finite number"
    if isinstance(v, dict):
        return {k: _finite_or_tag(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite_or_tag(x) for x in v]
    return v


class SimRequest(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def _reject_non_finite(cls, data):
        return _finite_or_tag(data)

    seasonal_intensity: float = Field(1.0, ge=0, le=2.5)
    outbreaks: list[Outbreak] = Field(default_factory=list, max_length=6)
    price_change_pct: float = Field(0, ge=-30, le=30)
    horizon: int = Field(12, ge=4, le=12)
    lead_time: int = Field(1, ge=0, le=8)
    review: int = Field(2, ge=1, le=8)
    service: float = Field(0.95, ge=0.5, le=0.999)
    rank_by: Literal["units", "value", "risk"] = "units"


# ── Building blocks ─────────────────────────────────────────────────────────────────────────
def epidemic_curve(n_weeks: int, start: int, duration: int) -> np.ndarray:
    """Relative intensity (peak = 1) per forecast week: gamma-like rise to a peak ~35 % into the
    window, then a slower decay. Zero outside [start, start + duration). The full curve is
    normalised before it is cut at the forecast window, so an outbreak that runs past week
    n_weeks keeps its true early-phase values instead of having its visible tail rescaled to 1."""
    p, a = 0.35, 2.0
    x = (np.arange(duration) + 0.5) / duration
    shape = np.ones(1) if duration == 1 else (x / p) ** a * np.exp(a * (1 - x / p))
    shape = shape / shape.max()
    out = np.zeros(n_weeks)
    for j, v in enumerate(shape):
        t = start - 1 + j
        if 0 <= t < n_weeks:
            out[t] = v
    return out


def _rule_mask(m: pd.DataFrame, rule: Rule) -> pd.Series:
    if rule["match"] == "category":
        mask = m["category"] == rule["value"]
    else:
        g = m["generic_name"].fillna("").str.lower()
        mask = pd.Series(False, index=m.index)
        for v in rule["value"]:
            mask |= g.str.contains(v.lower(), regex=False)
    if rule.get("only_categories"):
        mask &= m["category"].isin(rule["only_categories"])
    if rule.get("exclude_forms"):
        mask &= ~m["form"].isin(rule["exclude_forms"])
    return mask


def outbreak_uplifts(kind: str, m: pd.DataFrame) -> tuple[pd.Series, list[dict]]:
    """Peak uplift per medicine at intensity 1 (first matching rule wins) + per-rule match counts."""
    up = pd.Series(0.0, index=m.index)
    taken = pd.Series(False, index=m.index)
    applied = []
    for r in OUTBREAKS[kind]["rules"]:
        hit = _rule_mask(m, r) & ~taken
        up[hit] = r["uplift"]
        taken |= hit
        applied.append({"target": r["value"] if isinstance(r["value"], str) else " / ".join(r["value"]),
                        "match": r["match"], "uplift": r["uplift"], "medicines": int(hit.sum()), "why": r["why"],
                        "examples": m.loc[hit, "medicine_name"].head(4).tolist()})
    return up, applied


def elasticities(m: pd.DataFrame) -> pd.Series:
    mixed = -0.10 * m["rx_share"].fillna(0.5) - 0.50 * (1 - m["rx_share"].fillna(0.5))
    return m["category"].map(_CAT_E).fillna(mixed).astype(float)


def plan_from(d: pd.Series, sd: pd.Series, cover: int, service: float) -> pd.DataFrame:
    """Same order-up-to logic as backend.core.plan_rows, from arbitrary cover-demand arrays."""
    z = z_for(service)
    out = pd.DataFrame({"cover_demand": d, "sd": sd})
    out["order_up_to"] = np.ceil(d + z * sd)
    slow = (d / cover) < SLOW_MOVER_RATE
    out["policy"] = np.where(slow, "On demand", "Forecast")
    out.loc[slow, "order_up_to"] = [poisson_quantile(mu, service) for mu in d[slow]]
    return out


def poisson_sf(k: float, mu: float) -> float:
    """P(X > k) for X ~ Poisson(mu)."""
    if mu <= 0:
        return 0.0
    k = int(k)
    term = math.exp(-mu)
    cdf = term
    for i in range(1, k + 1):
        term *= mu / i
        cdf += term
    return max(0.0, 1.0 - cdf)


def stockout_risk(stock: np.ndarray, d: np.ndarray, sd: np.ndarray, slow: np.ndarray) -> np.ndarray:
    """P(demand over the cover period > stock): normal approximation, Poisson for slow movers."""
    nd = NormalDist()
    out = np.empty(len(stock))
    for i, (s, mu, sg, sl) in enumerate(zip(stock, d, sd, slow)):
        if mu <= 0:
            out[i] = 0.0
        elif sl or sg <= 0:
            out[i] = poisson_sf(s, mu)
        else:
            out[i] = 1 - nd.cdf((s - mu) / sg)
    return out


def season_factor(k: float, m: pd.DataFrame, weeks: list[str]) -> tuple[np.ndarray, list[dict]]:
    seasons = [C.season_of(w) for w in weeks]
    fac = np.ones((len(m), len(weeks)))
    for t, s in enumerate(seasons):
        idx = m[f"idx_{s}"].fillna(1.0).clip(lower=0.05).to_numpy()
        fac[:, t] = np.maximum(0.0, 1 + (k - 1) * (idx - 1) / idx)
    used = []
    for s in dict.fromkeys(seasons):
        idx = m[f"idx_{s}"].fillna(1.0)
        used.append({"season": s, "weeks": seasons.count(s),
                     "mean_index": float(idx.mean()), "mean_scenario_index": float((1 + k * (idx - 1)).clip(lower=0).mean())})
    return fac, used


# ── Routes ──────────────────────────────────────────────────────────────────────────────────
@router.get("/presets")
def presets():
    return clean({
        "presets": PRESETS,
        "outbreak_types": [{"type": k, "label": v["label"], "summary": v["summary"],
                            "rules": [{"target": r["value"] if isinstance(r["value"], str) else " / ".join(r["value"]),
                                       "match": r["match"], "uplift": r["uplift"], "why": r["why"]} for r in v["rules"]]}
                           for k, v in OUTBREAKS.items()],
        "elasticity_groups": ELASTICITY_GROUPS, "elasticity_other": MIXED_RULE,
        "weeks": S.fweeks, "seasons": [C.season_of(w) for w in S.fweeks],
        "curve": {"peak_at": 0.35, "shape": "gamma-like rise and decay, peak = 1"},
    })


@router.post("/simulate")
def simulate(req: SimRequest):
    m = S.meds
    ids = m.index
    weeks = S.fweeks
    H = req.horizon
    base = S.fc_wide.reindex(ids).fillna(0.0).to_numpy()
    sig = S.sig_wide.reindex(ids).fillna(0.0).to_numpy()

    # 1. Multipliers
    seas, seasons_used = season_factor(req.seasonal_intensity, m, weeks)
    outb = np.ones_like(base)
    outbreak_info = []
    for o in req.outbreaks:
        curve = epidemic_curve(len(weeks), o.start_week, o.duration_weeks)
        up, applied = outbreak_uplifts(o.type, m)
        outb += o.intensity * np.outer(up.to_numpy(), curve)
        outbreak_info.append({"type": o.type, "label": OUTBREAKS[o.type]["label"], "intensity": o.intensity,
                              "start_week": o.start_week, "duration_weeks": o.duration_weeks,
                              "curve": curve.tolist(),
                              "rules": [{**a, "peak_uplift": a["uplift"] * o.intensity} for a in applied]})
    outb = np.maximum(outb, 0.0)
    p = req.price_change_pct / 100
    el = elasticities(m)
    price_fac = np.power(1 + p, el.to_numpy()) if p != 0 else np.ones(len(m))
    mult = seas * outb * price_fac[:, None]

    scen = base * mult
    sig_s = sig * mult
    price = m["median_price"].fillna(0).to_numpy()
    new_price = price * (1 + p)

    # 2. Store-level weekly totals with 90 % bands (independent errors across medicines)
    series = []
    for t in range(H):
        b, s = base[:, t].sum(), scen[:, t].sum()
        bsd, ssd = math.sqrt((sig[:, t] ** 2).sum()), math.sqrt((sig_s[:, t] ** 2).sum())
        series.append({"week": weeks[t], "season": C.season_of(weeks[t]), "baseline": b, "scenario": s,
                       "base_lo": max(0.0, b - Z90 * bsd), "base_hi": b + Z90 * bsd,
                       "lo": max(0.0, s - Z90 * ssd), "hi": s + Z90 * ssd})

    # 3. Per-medicine and per-category deltas over the horizon
    bu, su = base[:, :H].sum(1), scen[:, :H].sum(1)
    per = pd.DataFrame({"category": m["category"], "base_units": bu, "scen_units": su,
                        "base_rev": bu * price, "scen_rev": su * new_price}, index=ids)
    cat = per.groupby("category")[["base_units", "scen_units", "base_rev", "scen_rev"]].sum()
    cat["delta_units"] = cat["scen_units"] - cat["base_units"]
    cat["delta_rev"] = cat["scen_rev"] - cat["base_rev"]
    cat["pct"] = np.where(cat["base_units"] > 0, cat["scen_units"] / cat["base_units"].where(cat["base_units"] > 0) - 1, 0.0)
    cat = cat[cat["base_units"] >= 1].sort_values("pct", ascending=False)

    # 4. Inventory. The baseline plan is the Stock planner's order-up-to level. A periodic-review
    #    shop re-plans every cycle, so the check rolls the cover window across the horizon: in each
    #    window w, baseline order-up-to (from the baseline forecast) vs scenario demand. A disruption
    #    that starts in week 5 is caught in the window where it bites, not only in week 1.
    cover = min(req.lead_time + req.review, len(weeks))
    starts = range(max(1, H - cover + 1))
    bp = plan_rows(req.lead_time, req.review, req.service, m)   # window 0, identical to the Stock planner
    n = len(m)
    risk = np.zeros(n); risk_base = np.zeros(n); peak_w = np.zeros(n, dtype=int)
    extra = np.zeros(n); freed = np.zeros(n)
    for w in starts:
        sl = slice(w, w + cover)
        d_b = pd.Series(base[:, sl].sum(1), index=ids)
        sd_b = pd.Series(np.sqrt((sig[:, sl] ** 2).sum(1)), index=ids)
        d_s = pd.Series(scen[:, sl].sum(1), index=ids)
        sd_s = pd.Series(np.sqrt((sig_s[:, sl] ** 2).sum(1)), index=ids)
        pb = plan_from(d_b, sd_b, cover, req.service)
        ps = plan_from(d_s, sd_s, cover, req.service)
        b_out, s_out = pb["order_up_to"].to_numpy(), ps["order_up_to"].to_numpy()
        slow = (pb["policy"] == "On demand").to_numpy() | (ps["policy"] == "On demand").to_numpy()
        # The baseline risk uses the baseline plan's own policy only, so it never depends on the scenario
        r_b = stockout_risk(b_out, d_b.to_numpy(), sd_b.to_numpy(), (pb["policy"] == "On demand").to_numpy())
        r_s = stockout_risk(b_out, d_s.to_numpy(), sd_s.to_numpy(), slow)
        worse = r_s > risk
        peak_w[worse] = w
        risk = np.maximum(risk, r_s)
        risk_base = np.maximum(risk_base, r_b)
        extra = np.maximum(extra, s_out - b_out)
        freed = np.maximum(freed, b_out - s_out)
        if w == 0:
            base_out, scen_out = b_out, s_out
    extra = np.clip(extra, 0, None)
    freed = np.clip(freed, 0, None)
    slow_now = (bp["policy"] == "On demand").to_numpy()

    meds = pd.DataFrame({
        "medicine_id": ids, "medicine_name": m["medicine_name"].to_numpy(), "category": m["category"].to_numpy(),
        "abc": m["abc"].to_numpy(), "price": price, "base_units": bu, "scen_units": su,
        "delta_units": su - bu, "pct": np.where(bu > 0, su / np.where(bu > 0, bu, 1) - 1, 0.0),
        "delta_value": su * new_price - bu * price, "base_order_up_to": base_out, "scen_order_up_to": scen_out,
        "extra_units": np.where(extra > 0, extra, -freed), "risk_baseline": risk_base, "risk": risk,
        "risk_week": [weeks[i] for i in peak_w],
        "policy": np.where(slow_now, "On demand", "Forecast"), "elasticity": el.to_numpy(),
    })
    key = {"units": meds["delta_units"].abs(), "value": meds["delta_value"].abs(), "risk": meds["risk"]}[req.rank_by]
    top = meds.assign(_k=key)
    top = top[(top["base_units"] > 0) | (top["scen_units"] > 0)].sort_values("_k", ascending=False).head(15).drop(columns="_k")

    at_risk = int((risk > RISK_FLAG).sum())
    at_risk_base = int((risk_base > RISK_FLAG).sum())
    tb, ts = float(bu.sum()), float(su.sum())

    # Elasticity assumptions actually in force (only meaningful with a price change)
    price_groups = []
    if p != 0:
        for g in ELASTICITY_GROUPS:
            n = int(m["category"].isin(g["categories"]).sum())
            price_groups.append({"group": g["group"], "elasticity": g["e"], "medicines": n,
                                 "volume_change": (1 + p) ** g["e"] - 1, "why": g["why"]})
        other = ~m["category"].isin(_CAT_E)
        if other.any():
            e_o = float(el[other].mean())
            price_groups.append({"group": "Mixed (General/Other)", "elasticity": e_o, "medicines": int(other.sum()),
                                 "volume_change": (1 + p) ** e_o - 1, "why": MIXED_RULE})

    return clean({
        "params": req.model_dump(),
        "horizon_weeks": weeks[:H], "cover_weeks": cover, "z": z_for(req.service),
        # The risk windows reach week max(H, cover), so a change there is not "baseline" either
        "is_baseline": bool(np.all(mult[:, :max(H, cover)] == 1.0)),
        "summary": {
            "baseline_units": tb, "scenario_units": ts, "delta_units": ts - tb,
            "pct": (ts / tb - 1) if tb > 0 else 0.0,
            "baseline_revenue": float(per["base_rev"].sum()), "scenario_revenue": float(per["scen_rev"].sum()),
            "extra_stock_units": float(extra.sum()), "extra_stock_value": float((extra * price).sum()),
            "freed_stock_units": float(freed.sum()), "freed_stock_value": float((freed * price).sum()),
            "baseline_stock_value": float((base_out * price).sum()), "scenario_stock_value": float((scen_out * price).sum()),
            "at_risk": at_risk, "at_risk_baseline": at_risk_base, "risk_threshold": RISK_FLAG,
            "medicines_changed": int((np.abs(su - bu) > 1e-9).sum()),
        },
        "series": series,
        "categories": cat.reset_index().to_dict("records"),
        "medicines": top.to_dict("records"),
        "assumptions": {
            "seasonal": {"intensity": req.seasonal_intensity, "seasons": seasons_used,
                         "formula": "scenario = forecast × (1 + k·(I − 1)) / I, where I is the medicine's season index for that week"},
            "outbreaks": outbreak_info,
            "price": {"change_pct": req.price_change_pct, "groups": price_groups,
                      "formula": "volume × (1 + Δprice)^elasticity; revenue at the new price"},
            "uncertainty": "Each 90% band scales the model's calibrated forecast error by the scenario multiplier. It does not cover uncertainty in the scenario inputs themselves.",
            "inventory": f"The baseline plan is the Stock planner's order-up-to level ({req.lead_time} wk lead + {req.review} wk review, "
                         f"{req.service:.0%} service), re-planned from the baseline forecast every cycle. Stockout risk is the worst-case "
                         f"P(scenario demand over a {cover}-week window > that level) across the {len(starts)} rolling window(s) in the horizon. "
                         f"The normal approximation is used, with Poisson for slow movers. Extra stock is the largest increase in order-up-to "
                         f"level any window needs, valued at the current median price.",
        },
    })
