"""Early-warning signals: weather (NASA POWER observed, Open-Meteo forecast/seasonal) and DHS Kerala IDSP
disease reports, turned into an outbreak watch list linked to Scenario Lab presets.

Every GET serves cached data only (never the network). POST /refresh starts a background refresh.
A daemon scheduler (ml.signals.start_scheduler) refreshes what is due every few hours unless
MEDFORECAST_SIGNALS_AUTOFETCH=0.

Cross-feature contract: `brief_summary()` returns a small dict from cached data and never raises.
"""
from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Literal, Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, StrictInt

from backend import db
from backend.auth import current_user, require_perm, require_role
from backend.core import S, clean
from backend.routers.scenarios import OUTBREAKS, _rule_mask, outbreak_uplifts
from ml import signals as SG

router = APIRouter(prefix="/api/signals", tags=["signals"])

LEVEL_RANK = {"high": 3, "elevated": 2, "watch": 1, "normal": 0, "insufficient": -1}
LEVEL_INTENSITY = {"watch": 1.0, "elevated": 1.5, "high": 2.0}
OUTBREAK_DURATION = 6
MAX_UPLOAD_BYTES = 1_000_000
OBS_RECENT_DAYS = 12        # weather rules only use observed weeks that ended this recently
SQLITE_MAX_INT = 2 ** 63 - 1

# How each disease maps onto stock. Preset-backed diseases reuse the Scenario Lab outbreak rules
# (backend/routers/scenarios.py); the others list medicines that are likely to move without
# quantifying an uplift, because no validated effect size exists for them.
DISEASE_LINKS: dict[str, dict] = {
    "dengue": {"preset": "dengue",
               "caution": "Advise paracetamol only for suspected dengue; NSAIDs and aspirin are avoided (bleeding risk). "
                          "Refer warning signs (abdominal pain, persistent vomiting, bleeding, drowsiness) to a doctor."},
    "fever": {"preset": "influenza",
              "note": "Fever counts are undifferentiated. The Influenza wave preset is the closest Scenario Lab match.",
              "caution": "Fever has many causes (dengue, lepto, flu). Antipyretic advice and referral are the pharmacist's call."},
    "influenza": {"preset": "influenza",
                  "caution": "Antibiotics need a prescription and do not treat influenza; do not over-stock them on flu signals alone."},
    "ili": {"preset": "influenza", "caution": "Antibiotics need a prescription and do not treat viral illness."},
    "add": {"preset": "heatwave",
            "note": "Closest preset: Heatwave, whose ORS and GI-infection rules match diarrhoeal disease. It also raises "
                    "skin products, which are not relevant here.",
            "caution": "ORS (with zinc for children) comes first. Antimotility drugs such as loperamide are not for children or "
                       "bloody diarrhoea; the pharmacist advises."},
    "lepto": {"rules": [
        {"match": "generic", "value": ["Doxycycline"],
         "why": "Treatment and prophylaxis of leptospirosis (prescription only; Kerala also distributes free prophylaxis)."},
        {"match": "generic", "value": ["Benzylpenicillin", "Penicillin", "Ceftriaxone", "Azithromycin", "Amoxicillin"],
         "why": "Antibiotics prescribed for leptospirosis."},
        {"match": "generic", "value": ["Paracetamol"], "only_categories": {"Analgesic/Antipyretic"}, "why": "Fever and myalgia relief."},
    ], "note": "No Scenario Lab preset for leptospirosis, so no uplift is quantified.",
        "caution": "All antibiotics here are prescription only. Suspected lepto (fever after flood or field exposure) needs a doctor."},
    "hepatitis_a": {"rules": [
        {"match": "generic", "value": ["Oral rehydration"], "why": "Fluids for vomiting and poor intake."},
        {"match": "generic", "value": ["Ondansetron", "Domperidone"], "why": "Antiemetics, on prescription."},
    ], "note": "No Scenario Lab preset for hepatitis A, so no uplift is quantified.",
        "caution": "Care is supportive. Paracetamol and other liver-metabolised OTC drugs need the pharmacist's dosing advice; refer jaundice to a doctor."},
    "chikungunya": {"rules": [
        {"match": "generic", "value": ["Paracetamol"], "only_categories": {"Analgesic/Antipyretic"},
         "why": "First-line relief for fever and joint pain."},
        {"match": "generic", "value": ["Oral rehydration"], "why": "Fluids during the febrile phase."},
    ], "note": "No Scenario Lab preset for chikungunya, so no uplift is quantified.",
        "caution": "NSAIDs only after a doctor has ruled out dengue."},
    "other": {"note": "Manual entries only; no medicine mapping."},
}


# ── Helpers ──────────────────────────────────────────────────────────────────────────────────

def _current_fweek() -> int | None:
    """1-based Scenario Lab forecast week containing today, or None when today is outside the window."""
    t = date.today().isoformat()
    idx = sum(1 for w in S.fweeks if w <= t)
    if idx == 0:
        return 1
    last_end = date.fromisoformat(S.fweeks[-1]) + timedelta(days=6)
    return None if date.today() > last_end else idx


def simulator_href(preset: str, level: str) -> str | None:
    start = _current_fweek()
    if start is None or preset not in OUTBREAKS:
        return None
    k = LEVEL_INTENSITY.get(level, 1.0)
    return f"/simulator?ob={preset}:{k:g}:{start}:{OUTBREAK_DURATION}"


def disease_impact(disease: str, level: str = "watch", n: int = 8) -> dict:
    link = DISEASE_LINKS.get(disease, {})
    m = S.meds
    preset = link.get("preset")
    out = {"preset": None, "note": link.get("note"), "caution": link.get("caution"), "categories": [], "medicines": [], "rules": []}
    if preset:
        up, applied = outbreak_uplifts(preset, m)
        pos = up[up > 0]
        extra = (m.loc[pos.index, "base_level"].fillna(0) * pos).sort_values(ascending=False)
        meds = extra[extra > 0].head(n).index
        out["medicines"] = [{"medicine_id": i, "medicine_name": m.at[i, "medicine_name"], "category": m.at[i, "category"],
                             "uplift_at_peak": float(up[i]), "base_weekly": float(m.at[i, "base_level"] or 0)} for i in meds]
        cats = (m.loc[pos.index].assign(extra=m.loc[pos.index, "base_level"].fillna(0) * pos)
                .groupby("category")["extra"].sum().sort_values(ascending=False))
        out["categories"] = [c for c, v in cats.items() if v > 0][:6]
        neg = up[up < 0]
        out["falling"] = sorted(set(m.loc[neg.index, "category"]))
        out["rules"] = [{"target": a["target"], "uplift": a["uplift"], "why": a["why"], "medicines": a["medicines"]}
                        for a in applied if a["medicines"] > 0]
        href = simulator_href(preset, level)
        out["preset"] = {"type": preset, "label": OUTBREAKS[preset]["label"], "href": href,
                         "intensity": LEVEL_INTENSITY.get(level, 1.0), "start_week": _current_fweek(),
                         "duration_weeks": OUTBREAK_DURATION,
                         "unavailable_reason": None if href else "Today is outside the 12-week forecast window; retrain the model to simulate."}
    elif link.get("rules"):
        hit = pd.Series(False, index=m.index)
        for r in link["rules"]:
            mk = _rule_mask(m, r)
            out["rules"].append({"target": " / ".join(r["value"]), "uplift": None, "why": r["why"], "medicines": int(mk.sum())})
            hit |= mk
        sel = m[hit].sort_values("base_level", ascending=False).head(n)
        out["medicines"] = [{"medicine_id": i, "medicine_name": r["medicine_name"], "category": r["category"],
                             "uplift_at_peak": None, "base_weekly": float(r["base_level"] or 0)} for i, r in sel.iterrows()]
        out["categories"] = list(dict.fromkeys(m[hit].sort_values("base_level", ascending=False)["category"]))[:6]
    return out


def _fmt_pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x * 100:+.0f}%"


def build_watch(dv: dict | None = None, wv: dict | None = None) -> dict:
    dv = dv or SG.disease_view()
    items = []
    for region in ("EKM", "KERALA"):
        for dis, s in (dv.get("series", {}).get(region) or {}).items():
            if LEVEL_RANK.get(s["level"], -1) < 1:
                continue
            if region == "KERALA":
                ekm = (dv["series"].get("EKM") or {}).get(dis)
                # State-wide items only when the state is elevated and Ernakulam is not already listed
                if LEVEL_RANK[s["level"]] < 2 or (ekm and LEVEL_RANK.get(ekm["level"], -1) >= 1):
                    continue
            imp = disease_impact(dis, s["level"])
            why = (f"{s['last7']:.0f} cases in the 7 days to {dv['as_of']} vs a typical {s['baseline_mean']:.0f} "
                   f"over the previous {s['baseline_blocks']} weeks (z {s['z']:.1f}); week-over-week {_fmt_pct(s['growth_pct'])}.")
            items.append({"id": f"disease:{region}:{dis}", "kind": "disease", "level": s["level"], "disease": dis,
                          "label": s["label"], "district": region, "district_name": SG.DISTRICT_NAMES.get(region, region),
                          "title": f"{s['label']} {s['level']} in {SG.DISTRICT_NAMES.get(region, region).split(' (')[0]}",
                          "why": why, "last7": s["last7"], "z": s["z"], "growth_pct": s["growth_pct"], "trend": s["trend"],
                          "as_of": dv["as_of"], "spark": [b["cases"] for b in s["blocks"]], **imp})
    # Rule-based weather watches (context, not fitted on this shop's data)
    try:
        wv = wv or SG.weather_view(weeks=4)
        obs = [w for w in wv["observed"]["weeks"][-2:]
               if (date.today() - date.fromisoformat(w["week"])).days - 6 <= OBS_RECENT_DAYS]   # stale weeks never fire
        if obs and (any(w["heavy_days"] > 0 for w in obs) or any((w.get("percentile") or 0) >= 0.9 for w in obs)):
            imp = disease_impact("dengue", "watch")
            items.append({"id": "weather:post-rain", "kind": "weather", "level": "watch", "disease": "dengue",
                          "label": "Post-rain", "district": "EKM", "district_name": "Kochi",
                          "title": "Heavy or unusually wet fortnight in Kochi",
                          "why": ("Observed rain in the last two weeks was in the wettest 10% for the time of year or included a heavy-rain day "
                                  f"(>= {SG.HEAVY_RAIN_MM} mm). Leptospirosis typically follows flooding by 1-2 weeks and dengue by 2-6 weeks."),
                          "rule": True, **imp})
        n16 = wv["forecast"].get("next16")
        if n16 and (n16["heavy_days"] >= 2 or (n16.get("percentile") or 0) >= 0.9):
            imp = disease_impact("lepto", "watch")
            items.append({"id": "weather:heavy-forecast", "kind": "weather", "level": "watch", "disease": "lepto",
                          "label": "Heavy rain forecast", "district": "EKM", "district_name": "Kochi",
                          "title": "Heavy rain in the 16-day forecast",
                          "why": (f"{n16['total_mm']:.0f} mm forecast over {n16['days']} days ({_fmt_pct(n16.get('anomaly_pct'))} vs normal) with "
                                  f"{n16['heavy_days']} heavy-rain day(s). Watch leptospirosis after any flooding."),
                          "rule": True, **imp})
        hot = [d for d in wv["forecast"].get("days", []) if (d.get("tmax") or 0) >= 36]
        if len(hot) >= 3:
            imp = disease_impact("add", "watch")
            imp["preset"] = {**(imp["preset"] or {}), "type": "heatwave", "label": OUTBREAKS["heatwave"]["label"],
                             "href": simulator_href("heatwave", "watch")}
            items.append({"id": "weather:heat", "kind": "weather", "level": "watch", "disease": "add", "label": "Heat",
                          "district": "EKM", "district_name": "Kochi", "title": "Hot spell forecast",
                          "why": f"{len(hot)} forecast days at or above 36 °C: dehydration and GI illness rise in heat.",
                          "rule": True, **imp})
    except Exception:
        pass
    items.sort(key=lambda x: (-LEVEL_RANK.get(x["level"], 0), x["kind"] != "disease", -(x.get("z") or 0)))
    return {"as_of": dv.get("as_of"), "items": items,
            "rule_note": "Weather watches are public-health rules of thumb, not effects fitted on this shop's sales.",
            "levels": {"watch": "worth keeping an eye on", "elevated": "clearly above recent weeks", "high": "far above recent weeks"}}


def _who(user: dict) -> int | None:
    return user.get("id")


# ── Cross-feature contract ───────────────────────────────────────────────────────────────────

_BRIEF_MEMO: dict = {"at": 0.0, "value": None}
_BRIEF_TTL_S = 300


def brief_summary() -> dict:
    """Cached-only summary for the daily brief, memoised for 5 minutes. Never raises."""
    import time as _t
    if _BRIEF_MEMO["value"] is not None and _t.monotonic() - _BRIEF_MEMO["at"] < _BRIEF_TTL_S:
        return _BRIEF_MEMO["value"]
    value = _brief_summary_uncached()
    if value.get("available", True):
        _BRIEF_MEMO.update(at=_t.monotonic(), value=value)
    return value


def _brief_summary_uncached() -> dict:
    """Cached-only summary for the daily brief. Never raises; {"available": False} on any problem."""
    try:
        fc, fetched = SG.forecast_daily()
        lic = SG.license_info()
        n16 = SG.next16_summary(fc) if lic["open_meteo_enabled"] else None
        dv = SG.disease_view()
        outbreaks = []
        for region in ("EKM", "KERALA"):
            for dis, s in (dv.get("series", {}).get(region) or {}).items():
                if LEVEL_RANK.get(s["level"], -1) >= 1 and (region == "EKM" or LEVEL_RANK[s["level"]] >= 2):
                    link = DISEASE_LINKS.get(dis, {})
                    cats = disease_impact(dis, s["level"], n=3)["categories"] if (link.get("preset") or link.get("rules")) else []
                    outbreaks.append({"disease": dis, "label": s["label"], "district": region, "level": s["level"],
                                      "last7": s["last7"], "z": s["z"], "trend": s["trend"], "categories": cats})
        outbreaks.sort(key=lambda o: (-LEVEL_RANK[o["level"]], -(o["z"] or 0)))
        parts = []
        if n16:
            parts.append(f"Rain next {n16['days']} days: {n16['total_mm']:.0f} mm, {n16['outlook'] or 'no climatology'}"
                         + (f" ({_fmt_pct(n16['anomaly_pct'])})" if n16.get("anomaly_pct") is not None else "") + ".")
        ekm = [o for o in outbreaks if o["district"] == "EKM"]
        if ekm:
            parts.append("; ".join(f"{o['label']} {o['level']} in Ernakulam" for o in ekm[:2]) + ".")
        elif dv.get("as_of"):
            parts.append("No disease watch in Ernakulam.")
        weather_stale = SG._stale("om_forecast", fetched) if n16 else True
        for o in outbreaks:
            o["summary"] = f"{o['label']} {o['level']} in {SG.DISTRICT_NAMES.get(o['district'], o['district']).split(' (')[0]}"
        w_text = (parts[0] + (" (forecast is stale)" if weather_stale else "")) if n16 else None
        return clean({
            "available": True,
            "headline": " ".join(parts) or "No early-warning data cached yet.",
            "weather": {"next16_rain_mm": n16["total_mm"] if n16 else None, "anomaly_pct": n16["anomaly_pct"] if n16 else None,
                        "outlook": n16["outlook"] if n16 else None, "stale": bool(weather_stale),
                        "source": "Open-Meteo" if n16 else None, "licence": lic["mode"], "summary": w_text},
            "source": "NASA POWER / Open-Meteo weather, DHS Kerala IDSP reports (Kochi / Ernakulam)",
            "simulated": False,
            "outbreaks": outbreaks[:5],
            "disease_as_of": dv.get("as_of"), "disease_stale": dv.get("stale"),
            "updated_at": max(filter(None, [fetched, dv.get("fetched_at")]), default=None),
        })
    except Exception:
        return {"available": False}


# ── Routes ───────────────────────────────────────────────────────────────────────────────────

@router.get("/status")
def status(user: dict = Depends(current_user)):
    log = SG.fetch_log()
    lic = SG.license_info()
    wv_obs = SG.observed_daily()[0]
    last_obs = wv_obs["precip_mm"].dropna().index.max().isoformat() if len(wv_obs) and wv_obs["precip_mm"].notna().any() else None
    fc, fc_fetched = SG.forecast_daily()
    rep = db.query("SELECT status, COUNT(*) n, MAX(date) latest FROM signals_disease_reports GROUP BY status")
    rep_by = {r["status"]: r for r in rep}
    latest_dis = SG.latest_report_date()
    seas = SG._read_json("openmeteo_seasonal.json") or {}
    clim_ok = {"nasa_power": SG.get_clim("nasa_power") is not None, "era5": SG.get_clim("era5") is not None}
    clim_file = SG._read_json("nasa_power_climatology.json") or {} if clim_ok["nasa_power"] else {}
    clim_fetched = log.get("nasa_clim", {}).get("last_success") or (clim_file.get("fetched_at") if isinstance(clim_file, dict) else None)

    def src(id_, name, provider, licence, url, last_success, stale, detail, enabled=True, log_key=None):
        lg = log.get(log_key or id_, {})
        return {"id": id_, "name": name, "provider": provider, "licence": licence, "url": url, "enabled": enabled,
                "last_success": last_success, "last_attempt": lg.get("last_attempt"), "status": lg.get("status") or "never",
                "message": lg.get("message"), "stale": bool(stale) if enabled else False, "detail": detail}

    om_lic = ("Free API: non-commercial only (CC BY 4.0)" if lic["mode"] == "noncommercial"
              else "Commercial customer API" if lic["mode"] == "commercial-plan" else "Switched off")
    sources = [
        src("nasa_obs", "Observed rainfall", "NASA POWER", "Free, no key; commercial use allowed", SG.NASA_URL,
            log.get("nasa_obs", {}).get("last_success"), SG._stale("nasa_obs", log.get("nasa_obs", {}).get("last_success")),
            f"Daily data to {last_obs} (2-3 day latency)" if last_obs else "No observed data cached yet"),
        src("om_forecast", "16-day forecast", "Open-Meteo", om_lic, SG.OPEN_METEO_URL, fc_fetched,
            SG._stale("om_forecast", fc_fetched),
            (f"{len(fc)} days from {fc.index.min().isoformat()}" if len(fc) else "No forecast cached yet") if lic["open_meteo_enabled"] else lic["notice"],
            enabled=lic["open_meteo_enabled"]),
        src("om_seasonal", "Seasonal outlook", "Open-Meteo (ECMWF SEAS5 ensemble)", om_lic, SG.OPEN_METEO_URL, seas.get("fetched_at"),
            SG._stale("om_seasonal", seas.get("fetched_at")),
            "51-member monthly rainfall to 6 months ahead" if seas else "No outlook cached yet", enabled=lic["open_meteo_enabled"]),
        src("climatology", "Climatology 1991-2020", "NASA POWER + Open-Meteo ERA5", "Fetched once and cached", SG.NASA_URL,
            clim_fetched, not clim_ok["nasa_power"],
            "NASA POWER" + (" and ERA5" if clim_ok["era5"] else "") + " ready" if clim_ok["nasa_power"] else "Using built-in monthly fallback values",
            log_key="nasa_clim"),
        src("dhs_idsp", "Disease reports", "DHS Kerala IDSP daily PDF", "Public government reports", SG.DHS_URL,
            log.get("dhs_idsp", {}).get("last_success"), SG._disease_stale(latest_dis, log.get("dhs_idsp", {})),
            (f"{rep_by.get('ok', {}).get('n', 0)} days validated, latest {latest_dis.isoformat()}; "
             f"{sum(r['n'] for k, r in rep_by.items() if k != 'ok')} need manual entry or are pending") if latest_dis else "No reports parsed yet"),
    ]
    can_refresh = user["role"] in ("owner", "buyer")
    return clean({
        "today": date.today().isoformat(), "place": SG.PLACE, "lat": SG.LAT, "lon": SG.LON,
        "sources": sources, "license": lic, "refresh": SG.state(), "autofetch": SG.autofetch_enabled(),
        "can_refresh": can_refresh, "can_edit_settings": user["role"] == "owner",
        "can_upload": user["role"] in ("owner", "buyer"), "can_enter": True,
        "simulated_branches_note": "Signals describe Kochi / Ernakulam (the main shop). Branch stores are simulated from the main shop's data.",
    })


@router.get("/weather")
def weather(weeks: int = Query(26, ge=4, le=60)):
    return clean(SG.weather_view(weeks))


def _can_delete_manual(user: dict, entered_by: int | None) -> bool:
    """Same rule as DELETE /disease/manual/{id}: owners/buyers any entry, others only their own."""
    if user["role"] in ("owner", "buyer"):
        return True
    return entered_by is not None and entered_by == user.get("id")


@router.get("/disease")
def disease(weeks: int = Query(12, ge=4, le=13), user: dict = Depends(current_user)):
    view = SG.disease_view(weeks)
    entries = view.get("manual_entries") or []
    if entries:
        ids = [int(e["id"]) for e in entries if e.get("id") is not None]
        who: dict[int, dict] = {}
        if ids:
            marks = ",".join("?" * len(ids))
            for r in db.query(f"SELECT d.id, d.entered_by, u.username, u.full_name FROM signals_disease_daily d "
                              f"LEFT JOIN users u ON u.id = d.entered_by WHERE d.id IN ({marks})", ids):
                who[r["id"]] = r
        out = []
        for e in entries:
            w = who.get(int(e["id"])) if e.get("id") is not None else None
            w = w or {}
            out.append({**e, "entered_by": w.get("entered_by"),
                        "entered_by_name": w.get("full_name") or w.get("username"),
                        "can_delete": _can_delete_manual(user, w.get("entered_by"))})
        view = {**view, "manual_entries": out}
    return clean(view)


@router.get("/evidence")
def evidence():
    res = SG.evidence()
    if res.get("available"):
        res = {**res, "tests": [{k: v for k, v in t.items()} for t in res["tests"]]}
    return clean(res)


@router.get("/watch")
def watch():
    return clean(build_watch())


@router.get("/impact/{disease}")
def impact(disease: str, level: Literal["watch", "elevated", "high"] = "watch"):
    if disease not in SG.DISEASE_CODES:
        raise HTTPException(404, "Unknown disease")
    return clean({"disease": disease, **disease_impact(disease, level)})


class RefreshBody(BaseModel):
    parts: list[Literal["weather", "disease"]] = Field(default_factory=lambda: ["weather", "disease"], min_length=1, max_length=2)
    force: bool = False


@router.post("/refresh", status_code=202)
def refresh(body: Optional[RefreshBody] = None, user: dict = Depends(require_role("owner", "buyer"))):
    body = body or RefreshBody()
    started = SG.trigger_refresh(tuple(dict.fromkeys(body.parts)), body.force, trigger=f"user:{user.get('username')}")
    return clean({"started": started, "message": "Refresh started in the background." if started else "A refresh is already running.",
                  "state": SG.state()})


class ManualEntry(BaseModel):
    date: str = Field(..., min_length=10, max_length=10, pattern=r"^\d{4}-\d{2}-\d{2}$")
    period: Literal["day", "week"] = "day"
    district: Literal["EKM", "KERALA"]
    disease: Literal["fever", "dengue", "lepto", "hepatitis_a", "chikungunya", "add", "influenza", "ili", "other"]
    suspected: Optional[StrictInt] = Field(None, ge=0, le=1_000_000)   # strict: true/false are not counts
    confirmed: Optional[StrictInt] = Field(None, ge=0, le=1_000_000)   # strict: true/false are not counts
    deaths: Optional[StrictInt] = Field(None, ge=0, le=1_000_000)   # strict: true/false are not counts
    source: str = Field("manual entry", max_length=120)
    source_url: str = Field("", max_length=300)
    notes: str = Field("", max_length=500)


@router.post("/disease/manual", status_code=201)
def manual(body: ManualEntry, user: dict = Depends(current_user)):
    try:
        rec = SG.validate_manual(body.model_dump())
    except SG.ManualError as e:
        raise HTTPException(400, str(e)) from None
    if user["role"] not in ("owner", "buyer"):
        prev = db.query_one("SELECT entered_by FROM signals_disease_daily WHERE date=? AND period=? AND district=? AND disease=? "
                            "AND source='manual'", rec[:4])
        if prev and (prev["entered_by"] is None or prev["entered_by"] != user.get("id")):
            raise HTTPException(403, "Another user already entered this day; ask an owner or buyer to change it")
    try:
        n = SG.save_manual([body.model_dump()], _who(user))
    except SG.ManualError as e:
        raise HTTPException(400, str(e)) from None
    return clean({"saved": n, "disease": SG.disease_view()["series"].get(body.district, {}).get(body.disease, {}).get("level")})


@router.delete("/disease/manual/{entry_id}")
def delete_manual(entry_id: int = Path(..., ge=1, le=SQLITE_MAX_INT), user: dict = Depends(current_user)):
    row = db.query_one("SELECT id, entered_by FROM signals_disease_daily WHERE id=? AND source='manual'", (entry_id,))
    if not row:
        raise HTTPException(404, "Manual entry not found")
    if not _can_delete_manual(user, row["entered_by"]):
        raise HTTPException(403, "You can delete only the entries you made")
    SG.delete_manual(entry_id)
    return {"ok": True}


@router.post("/disease/upload")
async def upload(request: Request, user: dict = Depends(require_role("owner", "buyer"))):
    """CSV body (text/csv, UTF-8, at most 1 MB). All rows are validated first; any error rejects the whole file."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File too large (max 1 MB)")
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length") from None
    buf = bytearray()
    async for chunk in request.stream():          # never buffer more than the limit
        buf += chunk
        if len(buf) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "File too large (max 1 MB)")
    raw = bytes(buf)
    if not raw.strip():
        raise HTTPException(400, "Empty file")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "The file must be UTF-8 text (save as CSV UTF-8)") from None
    if "\x00" in text:
        raise HTTPException(400, "The file is not a text CSV")
    recs, errs = await run_in_threadpool(SG.parse_csv, text)
    if errs:
        return JSONResponse(status_code=400, content={"detail": {"message": f"{len(errs)} problem(s); nothing was saved.", "errors": errs[:21]}})
    if not recs:
        raise HTTPException(400, "No data rows found (example rows are ignored)")
    try:
        n = await run_in_threadpool(SG.save_manual, recs, _who(user))
    except SG.ManualError as e:
        raise HTTPException(400, str(e)) from None
    return {"saved": n}


@router.get("/disease/template.csv")
def template():
    return Response(SG.template_csv(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="disease_manual_template.csv"'})


class SettingsBody(BaseModel):
    license_mode: Literal["noncommercial", "commercial-plan", "off"]


@router.put("/settings")
def settings(body: SettingsBody, _: dict = Depends(require_perm("settings.edit"))):
    mode, locked = SG.license_mode()
    if locked:
        raise HTTPException(409, "The licence mode is set by env MEDFORECAST_WEATHER_LICENSE and cannot be changed here")
    SG.set_license_mode(body.license_mode)
    return clean({"license": SG.license_info()})


# Background refresh: weather and DHS reports are refreshed when due (daily); off with MEDFORECAST_SIGNALS_AUTOFETCH=0.
SG.start_scheduler()
