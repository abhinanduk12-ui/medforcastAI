"""Generic substitutes engine: pharmacy-safe brand/generic substitution suggestions.

Scope and safety rules
----------------------
* Molecules are compared as *sets of normalised components*. A combination product is never a
  substitute for a single molecule (or for a different combination), and nothing is ever suggested
  across different molecules. Therapeutic alternatives (a different molecule in the same class) are
  deliberately out of scope.
* Names are normalised conservatively: lower-case, punctuation/whitespace collapsed, British/US
  spelling (sulph -> sulf) and a short list of INN / USAN / common synonyms for the *same* chemical
  entity (paracetamol == acetaminophen, aspirin == acetylsalicylic acid, ...). Different salts or
  release forms are NOT merged (e.g. "ferrous fumarate" stays distinct from "ferrous salts").
  Parenthetical qualifiers such as "(topical)" or "(low-dose)" are dropped from the molecule key but
  kept as a qualifier, and a qualifier difference blocks the "exact" tier.
* Tiers
    exact          same molecule set + same parsed strength (explicit unit) + same dosage form and no
                   catalogue inconsistency -> interchangeable brand/generic (still subject to Rx rules)
    same_molecule  same molecule set but a different/unknown strength or a different form ->
                   needs a pharmacist's dose review; never an automatic swap
* Warnings: prescription items (inferred from the share of sales lines with a prescription, not a
  regulatory schedule), narrow-therapeutic-index molecules, liquid (often paediatric) vs solid forms,
  route changes (topical vs oral, injection vs oral) and catalogue inconsistencies.
* Prices are the median selling price per unit sold in the shop's history. Price per mg is only
  computed for single-molecule products with a mass strength (mg, g, mcg).
* Stock comes from backend.inventory.on_hand (sellable, non-expired). Branch stores are simulated
  from the main shop (demand_scale) and are labelled as such.
"""
from __future__ import annotations

import math
import re
import threading
from typing import Any

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from backend import inventory as inv
from backend.auth import current_user, store_scope
from backend.core import S, clean

router = APIRouter(prefix="/api/substitutes", tags=["substitutes"])

RX_THRESHOLD = 0.30          # share of sales lines with a prescription above which we treat it as an Rx item
MAX_QTY = 100_000

RX_TEXT = ("Substitution of a prescribed brand requires the prescriber's/pharmacist's confirmation "
           "as per applicable rules.")
NTI_TEXT = "Avoid brand switching without prescriber review (narrow therapeutic index)."
SAME_MOLECULE_TEXT = ("Same molecule but a different strength or dosage form: a pharmacist must review the dose. "
                      "Never swap automatically.")
THERAPEUTIC_NOTE = ("Therapeutic alternatives (a different molecule in the same drug class) are out of scope: "
                    "they need a prescriber's decision and are never suggested here.")

# Same chemical entity under different accepted names (INN / BAN / USAN / common). Kept short on purpose.
SYNONYMS: dict[str, str] = {
    "acetaminophen": "paracetamol",
    "apap": "paracetamol",
    "aspirin": "acetylsalicylic acid",
    "asa": "acetylsalicylic acid",
    "albuterol": "salbutamol",
    "levalbuterol": "levosalbutamol",
    "lidocaine": "lignocaine",
    "epinephrine": "adrenaline",
    "norepinephrine": "noradrenaline",
    "frusemide": "furosemide",
    "ciclosporin": "cyclosporine",
    "cyclosporin": "cyclosporine",
    "phenobarbital": "phenobarbitone",
    "thiopental": "thiopentone",
    "rifampin": "rifampicin",
    "nitroglycerin": "glyceryl trinitrate",
    "glucose": "dextrose",
    "vitamin d3": "cholecalciferol",
    "vitamin c": "ascorbic acid",
    "vitamin b2": "riboflavin",
    "vitamin b6": "pyridoxine",
    "vitamin b1": "thiamine",
    "vitamin k1": "phytomenadione",
    "acetylcysteine": "n acetylcysteine",
    # Valproic acid, sodium valproate and divalproex are different salts / release forms with different
    # valproate content per mg, so they are deliberately NOT merged (and all three are NTI below).
    "oral rehydration salt": "oral rehydration salts",
    "ors": "oral rehydration salts",
}
# Named combinations that expand to their components.
COMBO_ALIASES: dict[str, list[str]] = {
    "co trimoxazole": ["sulfamethoxazole", "trimethoprim"],
    "cotrimoxazole": ["sulfamethoxazole", "trimethoprim"],
    "co amoxiclav": ["amoxicillin", "clavulanic acid"],
}
# Narrow-therapeutic-index molecules (normalised keys; matched on any component).
NTI: set[str] = {
    "phenytoin", "fosphenytoin", "carbamazepine", "valproate", "divalproex", "digoxin", "warfarin",
    "acenocoumarol", "levothyroxine", "lithium", "tacrolimus", "cyclosporine", "sirolimus", "everolimus",
    "theophylline", "aminophylline", "phenobarbitone", "flecainide", "procainamide",
    "mycophenolate mofetil", "valproic acid",
}
# NTI terms are matched as whole words inside a component, so salts are caught too
# ("sodium valproate", "lithium carbonate", "phenytoin sodium") but "diethylcarbamazine" is not.
_NTI_RX = re.compile(r"\b(" + "|".join(sorted(map(re.escape, NTI), key=len, reverse=True)) + r")\b")


def _is_nti(components: list[str]) -> bool:
    return any(_NTI_RX.search(c) for c in components)
LIQUID_FORMS = {"syrup", "suspension", "solution", "drops", "elixir", "oral drops"}
SOLID_ORAL = {"tablet", "capsule", "sachet"}
TOPICAL = {"cream", "gel", "lotion", "ointment"}
ROUTE = {**{f: "oral" for f in SOLID_ORAL | LIQUID_FORMS}, **{f: "topical" for f in TOPICAL},
         "injection": "parenteral", "inhaler": "inhaled", "eye drop": "ophthalmic"}
MASS_TO_MG = {"mg": 1.0, "g": 1000.0, "mcg": 0.001}


# ---------------------------------------------------------------------------------------------
# Normalisation & parsing
# ---------------------------------------------------------------------------------------------
def _norm_text(s: str) -> str:
    s = (s or "").lower().replace("&", " and ")
    s = re.sub(r"sulph", "sulf", s)
    s = re.sub(r"[^a-z0-9+]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _norm_component(c: str) -> list[str]:
    c = _norm_text(c)
    if not c:
        return []
    if c in COMBO_ALIASES:
        return list(COMBO_ALIASES[c])
    c = SYNONYMS.get(c, c)
    return [c]


def parse_molecule(generic: str) -> dict:
    """Normalise a generic name into a sorted component tuple plus qualifiers.

    "Co-trimoxazole [Sulphamethoxazole + Trimethoprim]" -> (sulfamethoxazole, trimethoprim)
    "Aspirin (low-dose)" -> (acetylsalicylic acid,), qualifier "low dose"
    "Cholecalciferol (Vitamin D3)" -> (cholecalciferol,): the parenthetical is a synonym, not a qualifier
    """
    raw = str(generic or "").strip()
    qualifiers: list[str] = []
    text = raw
    # Bracketed expansion of a named combination: prefer the explicit component list.
    m = re.search(r"\[([^\]]+)\]", text)
    if m and "+" in m.group(1):
        text = m.group(1)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    for p in re.findall(r"\(([^)]*)\)", text):
        pn = _norm_text(p)
        outside = _norm_text(re.sub(r"\([^)]*\)", " ", text))
        if pn and SYNONYMS.get(pn, pn) not in (outside, SYNONYMS.get(outside, outside)):
            qualifiers.append(pn)
    text = re.sub(r"\([^)]*\)", " ", text)
    fixed: list[str] = []
    seen_vitamin = False
    for part in re.split(r"\+", text):
        p = _norm_text(part)
        # "Vitamin B1+B6+B12": a bare "b6" after a vitamin component is shorthand for "vitamin b6".
        if seen_vitamin and re.fullmatch(r"[a-k]\d*", p):
            p = f"vitamin {p}"
        seen_vitamin = seen_vitamin or p.startswith("vitamin")
        fixed.extend(_norm_component(p))
    key_parts = tuple(sorted(set(x for x in fixed if x)))
    return {
        "components": list(key_parts),
        "key": " + ".join(key_parts) + (f" [{', '.join(sorted(qualifiers))}]" if qualifiers else ""),
        "molecule_key": " + ".join(key_parts),
        "qualifiers": sorted(qualifiers),
        "is_combination": len(key_parts) > 1,
        "label": re.sub(r"\s+", " ", raw),
    }


_UNIT = r"(mcg|µg|ug|mg|g|ml|iu|%)"
_RX_CONC = re.compile(rf"(\d+(?:\.\d+)?)\s*{_UNIT}\s*/\s*(\d+(?:\.\d+)?)?\s*(ml|g|l|tab|tablet|cap)\b", re.I)
_RX_PCT = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*(w/w|w/v|v/v)?", re.I)
_RX_AMT = re.compile(r"(\d+(?:\.\d+)?)\s*(mcg|µg|ug|mg|g|ml|iu)\b", re.I)
# \b before the digits: "Vitamin B12" or "Omega3" must not read as a bare strength of 12 / 3.
_RX_BARE = re.compile(r"(?<![\d.:/])\b(\d{2,5})(?![\d.:/%])\b")


def _unit(u: str) -> str:
    u = u.lower()
    return {"µg": "mcg", "ug": "mcg", "iu": "IU"}.get(u, u)


def _fmtnum(x: float) -> str:
    return f"{x:g}"


def parse_strength(name: str, generic: str = "", n_components: int = 1) -> dict:
    """Parse strength from a product name. kind: mass | concentration | percent | volume | units | unknown.

    Bare numbers ("Augmentin 625", "Dolo 650") are parsed with assumed=True and unit=None, so they can
    never satisfy the exact tier on their own. Pack volumes ("5ml") are not dose strengths.
    """
    s = str(name or "")
    g = str(generic or "")
    rest = s[len(g):] if g and s.lower().startswith(g.lower()) else s
    rest = re.sub(r"\b\d+\s*:\s*\d+\b", " ", rest)          # ratios like 30:70 are part of the identity
    out: dict[str, Any] = {"kind": "unknown", "value": None, "unit": None, "per_value": None, "per_unit": None,
                           "assumed": False, "mg": None, "label": "Strength not stated", "raw": None,
                           "components": None}
    if n_components > 1:
        # A combination is only comparable when every component's strength is stated
        # ("500mg + 125mg"). A single figure ("Abacavir + Lamivudine 300mg") is ambiguous.
        amts = [(float(a), _unit(u)) for a, u in _RX_AMT.findall(rest) if _unit(u) in MASS_TO_MG]
        if len(amts) == n_components and not _RX_CONC.search(rest) and not _RX_PCT.search(rest):
            mgs = [v * MASS_TO_MG[u] for v, u in amts]
            out.update(kind="mass_set", components=mgs, raw=rest.strip(),
                       label=" + ".join(f"{_fmtnum(v)} {u}" for v, u in amts))
            return out
    m = _RX_CONC.search(rest)
    if m:
        v, u, pv, pu = float(m.group(1)), _unit(m.group(2)), float(m.group(3) or 1), m.group(4).lower()
        pu = {"tab": "tablet", "cap": "capsule"}.get(pu, pu)
        out.update(kind="concentration", value=v, unit=u, per_value=pv, per_unit=pu, raw=m.group(0),
                   label=f"{_fmtnum(v)} {u}/{'' if pv == 1 else _fmtnum(pv) + ' '}{pu}")
        return out
    m = _RX_PCT.search(rest)
    if m:
        v = float(m.group(1))
        out.update(kind="percent", value=v, unit="%", per_unit=(m.group(2) or "").lower() or None, raw=m.group(0),
                   label=f"{_fmtnum(v)}%" + (f" {m.group(2).lower()}" if m.group(2) else ""))
        return out
    m = _RX_AMT.search(rest)
    if m:
        v, u = float(m.group(1)), _unit(m.group(2))
        if u == "ml":
            out.update(kind="volume", value=v, unit="ml", raw=m.group(0),
                       label=f"{_fmtnum(v)} ml pack (dose strength not stated)")
        elif u == "IU":
            out.update(kind="units", value=v, unit="IU", raw=m.group(0), label=f"{_fmtnum(v)} IU")
        else:
            out.update(kind="mass", value=v, unit=u, raw=m.group(0), mg=v * MASS_TO_MG[u], label=f"{_fmtnum(v)} {u}")
        return out
    m = _RX_BARE.search(rest)
    if m:
        v = float(m.group(1))
        out.update(kind="mass", value=v, unit=None, assumed=True, raw=m.group(0),
                   label=f"{_fmtnum(v)} (unit not stated)")
    return out


def _strength_key(st: dict, is_combination: bool = False):
    """Comparable strength identity, or None when it cannot be verified (never exact then)."""
    if st["kind"] in ("unknown", "volume") or st["assumed"]:
        return None
    if st["kind"] == "mass_set":
        return ("mass_set", tuple(round(x, 6) for x in st["components"]))
    if is_combination:
        return None          # one figure for several components: which one is it?
    if st["kind"] == "mass":
        return ("mass", round(st["mg"], 6))
    if st["kind"] == "concentration":
        # Normalise to amount per single unit so 5 mg/5 ml == 1 mg/ml and 0.5 g/5 ml == 100 mg/ml.
        if st["unit"] in MASS_TO_MG and st["per_value"]:
            return ("conc", round(st["value"] * MASS_TO_MG[st["unit"]] / st["per_value"], 6), "mg", st["per_unit"])
        return ("conc", round(st["value"] / (st["per_value"] or 1), 6), st["unit"], st["per_unit"])
    return (st["kind"], st["value"], st["unit"], st["per_unit"])


def _form_key(form: str) -> str:
    return _norm_text(form)


def _form_conflict(form: str, st: dict) -> str | None:
    """A liquid concentration on a solid form (or vice versa) means the catalogue record is inconsistent."""
    f = _form_key(form)
    if st["kind"] == "concentration" and st["per_unit"] == "ml" and f in SOLID_ORAL:
        return (f"The name shows a liquid concentration ({st['label']}) but the catalogue form is {form}. "
                "Verify the actual pack before any substitution.")
    return None


# ---------------------------------------------------------------------------------------------
# Catalogue index (cached per loaded S.meds)
# ---------------------------------------------------------------------------------------------
_lock = threading.Lock()
_cache: dict[str, Any] = {"id": None, "index": None}


def _index() -> dict:
    meds = S.meds
    with _lock:
        if _cache["id"] == id(meds) and _cache["index"] is not None:
            return _cache["index"]
        prods: dict[str, dict] = {}
        groups: dict[str, list[str]] = {}
        for mid, r in meds.iterrows():
            mol = parse_molecule(r["generic_name"])
            st = parse_strength(r["medicine_name"], r["generic_name"], len(mol["components"]))
            fk = _form_key(r["form"])
            rx_share = float(r["rx_share"]) if pd.notna(r["rx_share"]) else None
            price = float(r["median_price"]) if pd.notna(r["median_price"]) and r["median_price"] > 0 else None
            p = {
                "id": mid, "name": str(r["medicine_name"]), "generic": str(r["generic_name"]),
                "category": str(r["category"]), "form": str(r["form"]), "form_key": fk,
                "price": price, "rx_share": rx_share, "rx": rx_share is not None and rx_share >= RX_THRESHOLD,
                "abc": r.get("abc"), "strength": st, "strength_label": st["label"],
                "strength_key": _strength_key(st, mol["is_combination"]),
                "molecule": mol, "nti": _is_nti(mol["components"]),
                "form_conflict": _form_conflict(str(r["form"]), st),
                # Per mg only for a single molecule with a stated mass on a non-liquid form: a mass on a
                # syrup/suspension may be per 5 ml or per bottle, so a per-mg price would be a guess.
                "price_per_mg": (price / st["mg"]) if (price and st["mg"] and st["kind"] == "mass"
                                                        and not st["assumed"] and not mol["is_combination"]
                                                        and fk not in LIQUID_FORMS) else None,
            }
            prods[mid] = p
            groups.setdefault(mol["molecule_key"], []).append(mid)
        pairs = {}
        for key, mids in groups.items():
            ps = [prods[m] for m in mids]
            pairs[key] = sum(1 for i, a in enumerate(ps) for b in ps[i + 1:] if _tier(a, b)[0] == "exact")
        idx = {"products": prods, "groups": groups, "exact_pairs": pairs}
        _cache.update(id=id(meds), index=idx)
        return idx


def _tier(a: dict, b: dict) -> tuple[str | None, list[str]]:
    """Return (tier, reasons). tier None means 'not a substitute' (different molecule set)."""
    if a["molecule"]["molecule_key"] != b["molecule"]["molecule_key"]:
        return None, []
    reasons: list[str] = []
    same_strength = a["strength_key"] is not None and a["strength_key"] == b["strength_key"]
    if not same_strength:
        if a["strength_key"] is None or b["strength_key"] is None:
            reasons.append("strength could not be verified from the product names")
        else:
            reasons.append(f"different strength ({a['strength_label']} vs {b['strength_label']})")
    if a["form_key"] != b["form_key"]:
        reasons.append(f"different dosage form ({a['form']} vs {b['form']})")
    if a["molecule"]["qualifiers"] != b["molecule"]["qualifiers"]:
        qa = ", ".join(a["molecule"]["qualifiers"]) or "none"
        qb = ", ".join(b["molecule"]["qualifiers"]) or "none"
        reasons.append(f"different product qualifier ({qa} vs {qb})")
    if a["form_conflict"] or b["form_conflict"]:
        reasons.append("catalogue form and name disagree for one of the products")
    return ("exact" if not reasons else "same_molecule"), reasons


# ---------------------------------------------------------------------------------------------
# Stock helpers
# ---------------------------------------------------------------------------------------------
def _stock() -> tuple[dict[tuple[str, str], int], dict[tuple[str, str], str | None], list[dict]]:
    stores = inv.store_list()
    oh = inv.on_hand(None)
    qty: dict[tuple[str, str], int] = {}
    exp: dict[tuple[str, str], str | None] = {}
    for r in oh.itertuples(index=False):
        if r.qty > 0:
            qty[(r.store_id, r.medicine_id)] = int(r.qty)
            exp[(r.store_id, r.medicine_id)] = r.earliest_expiry
    return qty, exp, stores


def _redact(user: dict | None) -> bool:
    """Single-store users (pharmacists) see *which* other stores hold an item, not how much (same rule as
    the Branches page, where the other branch's stock figures are redacted)."""
    return bool(user and user.get("store_id"))


def _availability(mid: str, store_id: str, qty: dict, exp: dict, stores: list[dict], redact: bool = False) -> dict:
    here = qty.get((store_id, mid), 0)
    others = [{"store_id": s["id"], "store_name": s["name"], "qty": qty.get((s["id"], mid), 0),
               "simulated": s["simulated"]}
              for s in stores if s["id"] != store_id and qty.get((s["id"], mid), 0) > 0]
    others.sort(key=lambda o: -o["qty"])
    hint = None
    if here == 0 and others:
        best = others[0]
        amount = "in stock" if redact else f"{best['qty']} units"
        hint = (f"Not in stock here. Request a transfer from {best['store_name']} ({amount}"
                f"{', simulated branch' if best['simulated'] else ''}).")
    total = here + sum(o["qty"] for o in others)
    if redact:
        others = [{**o, "qty": None} for o in others]
    return {"on_hand_here": here, "earliest_expiry_here": exp.get((store_id, mid)),
            "on_hand_other_stores": others, "on_hand_total": None if redact else total,
            "in_stock_elsewhere": bool(others), "in_stock_anywhere": here > 0 or bool(others),
            "transfer_hint": hint}


# ---------------------------------------------------------------------------------------------
# Warnings & candidate building
# ---------------------------------------------------------------------------------------------
def _w(level: str, code: str, title: str, text: str) -> dict:
    return {"level": level, "code": code, "title": title, "text": text}


def _pair_flags(orig: dict, cand: dict) -> list[dict]:
    flags: list[dict] = []
    if cand["rx"] or orig["rx"]:
        flags.append({"kind": "rx", "level": "warning", "label": "Prescription item",
                      "text": RX_TEXT})
    if cand["nti"]:
        flags.append({"kind": "nti", "level": "critical", "label": "Narrow therapeutic index", "text": NTI_TEXT})
    fo, fc = orig["form_key"], cand["form_key"]
    if fo != fc:
        liquid_solid = (fo in LIQUID_FORMS and fc in SOLID_ORAL) or (fc in LIQUID_FORMS and fo in SOLID_ORAL)
        if liquid_solid:
            flags.append({"kind": "liquid_solid", "level": "critical", "label": "Liquid vs solid form",
                          "text": "Syrups and suspensions are often paediatric doses. The dose must be recalculated "
                                  "by a pharmacist; do not swap a liquid for a tablet or capsule (or vice versa)."})
        ro, rc = ROUTE.get(fo), ROUTE.get(fc)
        if ro and rc and ro != rc:
            flags.append({"kind": "route", "level": "critical", "label": "Different route",
                          "text": f"{orig['form']} ({ro}) vs {cand['form']} ({rc}): not interchangeable without "
                                  "a prescriber's decision."})
        elif not liquid_solid:
            flags.append({"kind": "form", "level": "warning", "label": "Different form",
                          "text": f"{orig['form']} vs {cand['form']}: release profile and dosing may differ."})
    if (orig["strength_key"] is not None and cand["strength_key"] is not None
            and orig["strength_key"] != cand["strength_key"]):
        flags.append({"kind": "strength", "level": "warning", "label": "Different strength",
                      "text": f"{orig['strength_label']} vs {cand['strength_label']}: the dose per unit differs, "
                              "so the number of units must be recalculated by a pharmacist."})
    if cand["form_conflict"]:
        flags.append({"kind": "data", "level": "warning", "label": "Check pack", "text": cand["form_conflict"]})
    if cand["strength"]["assumed"] or cand["strength_key"] is None:
        why = ("The name does not state the strength of every component of this combination."
               if cand["molecule"]["is_combination"] else "Strength could not be read reliably from the product name.")
        flags.append({"kind": "strength_unknown", "level": "warning", "label": "Strength unverified",
                      "text": why + " Check the pack."})
    return flags


def _candidate(orig: dict, cand: dict, tier: str, reasons: list[str], qty_req: int, avail: dict) -> dict:
    po, pc = orig["price"], cand["price"]
    diff_pct = ((pc - po) / po) if (po and pc) else None
    ppm_o, ppm_c = orig["price_per_mg"], cand["price_per_mg"]
    # Per-mg comparisons only along the same route (an oral tablet vs an injection is not like-for-like).
    ro = ROUTE.get(orig["form_key"])
    comparable = bool(ppm_o and ppm_c and ro is not None and ro == ROUTE.get(cand["form_key"]))
    ppm_diff = ((ppm_c - ppm_o) / ppm_o) if comparable else None
    eq_cost = (ppm_c * orig["strength"]["mg"]) if comparable else None
    if tier == "exact":
        note = (f"Same molecule, same strength ({cand['strength_label']}) and same form ({cand['form']}): "
                "interchangeable brand/generic.")
        savings = ((po - pc) * qty_req) if (po and pc) else None
    else:
        note = "Same molecule; " + "; ".join(reasons) + ". Pharmacist dose review required, never an automatic swap."
        savings = None   # unit prices of different strengths/forms are not like-for-like
    return {
        "id": cand["id"], "name": cand["name"], "generic": cand["generic"], "strength": cand["strength_label"],
        "strength_parsed": cand["strength"], "form": cand["form"], "price": pc, "price_diff_pct": diff_pct,
        "price_per_mg": ppm_c, "price_per_mg_diff_pct": ppm_diff, "equivalent_dose_cost": eq_cost,
        "savings_for_qty": savings, "qty": qty_req,
        "rx": cand["rx"], "rx_share": cand["rx_share"], "nti": cand["nti"], "category": cand["category"],
        "tier": tier, "match_note": note, "reasons": reasons, "flags": _pair_flags(orig, cand),
        **avail,
    }


def _medicine_payload(p: dict, avail: dict | None = None) -> dict:
    out = {"id": p["id"], "name": p["name"], "generic": p["generic"], "strength": p["strength_label"],
           "strength_parsed": p["strength"], "form": p["form"], "price": p["price"], "rx": p["rx"],
           "rx_share": p["rx_share"], "nti": p["nti"], "category": p["category"], "abc": p["abc"],
           "price_per_mg": p["price_per_mg"], "molecule": p["molecule"], "form_conflict": p["form_conflict"]}
    if avail:
        out.update(avail)
    return out


def substitutes_for(mid: str, store_id: str, qty_req: int = 1, stock=None, redact: bool = False) -> dict:
    idx = _index()
    orig = idx["products"].get(mid)
    if orig is None:
        raise HTTPException(404, f"Unknown medicine '{mid}'")
    qty, exp, stores = stock or _stock()
    exact, same = [], []
    for cid in idx["groups"].get(orig["molecule"]["molecule_key"], []):
        if cid == mid:
            continue
        cand = idx["products"][cid]
        tier, reasons = _tier(orig, cand)
        if tier is None:
            continue
        c = _candidate(orig, cand, tier, reasons, qty_req, _availability(cid, store_id, qty, exp, stores, redact))
        (exact if tier == "exact" else same).append(c)
    rank = lambda c: (-(c["on_hand_here"] > 0), -c["in_stock_anywhere"],
                      c["price"] if c["price"] is not None else math.inf)
    exact.sort(key=rank)
    same.sort(key=rank)

    warnings: list[dict] = []
    if orig["nti"]:
        warnings.append(_w("critical", "nti", "Narrow therapeutic index", NTI_TEXT))
    if orig["rx"] or any(c["rx"] for c in exact + same):
        share = f" {round((orig['rx_share'] or 0) * 100)}% of its sales lines carried a prescription." if orig["rx"] else ""
        warnings.append(_w("warning", "rx", "Prescription item", RX_TEXT + share))
    if orig["molecule"]["is_combination"]:
        warnings.append(_w("info", "combination", "Combination product",
                           "Only products with exactly the same set of components are listed. A combination is "
                           "never a substitute for a single molecule, or vice versa."))
    if orig["form_conflict"]:
        warnings.append(_w("warning", "data", "Catalogue inconsistency", orig["form_conflict"]))
    if orig["strength_key"] is None:
        warnings.append(_w("warning", "strength_unknown", "Strength not verifiable",
                           f"The strength of {orig['name']} could not be read reliably from its name"
                           + (" (a combination needs the strength of every component)"
                              if orig["molecule"]["is_combination"] else "")
                           + ", so no product can be confirmed as an exact substitute."))
    if same:
        warnings.append(_w("warning", "same_molecule", "Dose review needed", SAME_MOLECULE_TEXT))
    if not exact and not same:
        warnings.append(_w("info", "none", "No substitutes in the catalogue",
                           "No other product in this catalogue has the same molecule set."))

    avail = _availability(mid, store_id, qty, exp, stores, redact)
    store = next((s for s in stores if s["id"] == store_id), None)
    return {
        "medicine": _medicine_payload(orig, avail),
        "store": store, "qty": qty_req,
        "exact": exact, "same_molecule": same, "warnings": warnings,
        "therapeutic_alternatives": {"included": False, "note": THERAPEUTIC_NOTE},
        "counts": {"exact": len(exact), "same_molecule": len(same),
                   "exact_in_stock_here": sum(c["on_hand_here"] > 0 for c in exact)},
        "assumptions": _assumptions(),
    }


def _assumptions() -> list[str]:
    return [
        "Prices are median selling prices per unit sold in the shop's history, not current MRP.",
        f"'Prescription item' means at least {int(RX_THRESHOLD * 100)}% of sales lines carried a prescription "
        "(inferred from sales records, not a regulatory schedule).",
        "Strength is parsed from the product name; a bare number without a unit is never treated as exact.",
        "Branch stock is simulated from the main shop's data (demand scale) and labelled as simulated.",
        THERAPEUTIC_NOTE,
    ]


# ---------------------------------------------------------------------------------------------
# Routes (fixed paths first so they are not captured by /{medicine_id})
# ---------------------------------------------------------------------------------------------
@router.get("")
def catalogue(store_id: str = Depends(store_scope),
              q: str | None = Query(None, max_length=80, description="Search molecule or product name"),
              multi_only: bool = Query(True, description="Only molecules with more than one product"),
              user: dict = Depends(current_user)):
    idx = _index()
    redact = _redact(user)
    qty, exp, stores = _stock()
    needle = _norm_text(q) if q else ""
    alias = " + ".join(_norm_component(needle)) if needle else ""
    groups = []
    for key, mids in idx["groups"].items():
        if multi_only and len(mids) < 2:
            continue
        ps = [idx["products"][m] for m in mids]
        if needle and needle not in key and alias not in key and not any(needle in _norm_text(p["name"]) or needle in _norm_text(p["generic"])
                                                    for p in ps):
            continue
        products = []
        for p in sorted(ps, key=lambda p: (p["form"], p["strength"]["mg"] or 0, p["name"])):
            a = _availability(p["id"], store_id, qty, exp, stores, redact)
            products.append({"id": p["id"], "name": p["name"], "strength": p["strength_label"], "form": p["form"],
                             "price": p["price"], "price_per_mg": p["price_per_mg"], "rx": p["rx"],
                             "rx_share": p["rx_share"], "abc": p["abc"], "form_conflict": p["form_conflict"],
                             "strength_known": p["strength_key"] is not None,
                             "on_hand_here": a["on_hand_here"], "on_hand_total": a["on_hand_total"],
                             "on_hand_other_stores": a["on_hand_other_stores"],
                             "in_stock_anywhere": a["in_stock_anywhere"]})
        pairs_exact = idx["exact_pairs"][key]
        prices = [p["price"] for p in ps if p["price"]]
        mol = ps[0]["molecule"]
        groups.append({
            "key": key, "label": " + ".join(c.title() if c.islower() else c for c in mol["components"]),
            "generic_names": sorted({p["generic"] for p in ps}), "components": mol["components"],
            "is_combination": mol["is_combination"], "nti": any(p["nti"] for p in ps),
            "rx": any(p["rx"] for p in ps), "categories": sorted({p["category"] for p in ps}),
            "n_products": len(ps), "products": products,
            "strengths": sorted({p["strength_label"] for p in ps}), "forms": sorted({p["form"] for p in ps}),
            "price_min": min(prices) if prices else None, "price_max": max(prices) if prices else None,
            "in_stock_here": sum(1 for p in products if p["on_hand_here"] > 0),
            "in_stock_anywhere": sum(1 for p in products if p["in_stock_anywhere"]),
            "exact_pairs": pairs_exact,
        })
    groups.sort(key=lambda g: (-g["exact_pairs"], -g["n_products"], g["label"]))
    multi = [k for k, v in idx["groups"].items() if len(v) > 1]
    return clean({
        "store_id": store_id, "store": next((s for s in stores if s["id"] == store_id), None),
        "groups": groups,
        "summary": {"products": len(idx["products"]), "molecules": len(idx["groups"]),
                    "multi_product_molecules": len(multi),
                    "exact_pairs": sum(idx["exact_pairs"].values()),
                    "combination_molecules": sum(1 for k in idx["groups"] if " + " in k)},
        "therapeutic_alternatives": {"included": False, "note": THERAPEUTIC_NOTE},
        "assumptions": _assumptions(),
    })


@router.get("/out-of-stock")
def out_of_stock(store_id: str = Depends(store_scope), user: dict = Depends(current_user)):
    """Medicines with zero sellable stock at the store that have an alternative in stock here or elsewhere.

    `items` = an exact substitute is available (here or at another store); `review_items` = only
    same-molecule (different strength/form) alternatives exist, which need a pharmacist's dose review."""
    idx = _index()
    stock = _stock()
    qty = stock[0]
    redact = _redact(user)
    # Expected weekly demand at THIS store (forecast x demand_scale), the same rate the rest of the app uses.
    rate = inv.forecast_rate(store_id)
    items, review = [], []
    for key, mids in idx["groups"].items():
        if len(mids) < 2:
            continue
        for mid in mids:
            if qty.get((store_id, mid), 0) > 0:
                continue
            r = substitutes_for(mid, store_id, 1, stock, redact)
            ex_here = [c for c in r["exact"] if c["on_hand_here"] > 0]
            ex_else = [c for c in r["exact"] if c["on_hand_here"] == 0 and c["on_hand_other_stores"]]
            sm = [c for c in r["same_molecule"] if c["in_stock_anywhere"]]
            meta = S.meds.loc[mid]
            wk = rate.get(mid)
            base = {"medicine": r["medicine"], "weekly_demand": float(wk) if wk is not None and pd.notna(wk) else None,
                    "abc": meta.get("abc"), "warnings": r["warnings"]}
            if ex_here or ex_else:
                items.append({**base, "available_here": bool(ex_here),
                              "best": (ex_here or ex_else)[0], "exact": r["exact"],
                              "same_molecule_in_stock": len(sm)})
            elif sm:
                review.append({**base, "available_here": any(c["on_hand_here"] > 0 for c in sm),
                               "best": sorted(sm, key=lambda c: -c["on_hand_here"])[0], "same_molecule": sm})
    key = lambda x: (not x["available_here"], -(x["weekly_demand"] or 0))
    items.sort(key=key)
    review.sort(key=key)
    return clean({"store_id": store_id, "store": next((s for s in stock[2] if s["id"] == store_id), None),
                  "items": items, "review_items": review,
                  "weekly_demand_basis": "Forecast units/week at this store over the next 4 weeks (branches: the "
                                         "main shop's forecast x demand scale, simulated).",
                  "counts": {"exact": len(items), "review": len(review),
                             "exact_here": sum(i["available_here"] for i in items)},
                  "note": "Exact substitutes are interchangeable brand/generic products (still subject to the "
                          "prescription rules). Review items only have a same-molecule product with a different "
                          "strength or form: a pharmacist must review the dose."})


@router.get("/{medicine_id}")
def substitutes(medicine_id: str, store_id: str = Depends(store_scope),
                qty: int = Query(1, ge=1, le=MAX_QTY, description="Quantity for the savings estimate"),
                user: dict = Depends(current_user)):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", medicine_id):
        raise HTTPException(404, "Unknown medicine")
    return clean(substitutes_for(medicine_id, store_id, qty, redact=_redact(user)))
