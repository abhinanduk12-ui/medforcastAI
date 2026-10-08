"""Central configuration: paths, Kerala season calendar, festival windows, model settings."""
from __future__ import annotations

import os
import re
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_XLSX = ROOT / "data" / "raw" / "pharma_dataset.xlsx"
PROCESSED = ROOT / "data" / "processed"
DEFAULT_ARTIFACTS = ROOT / "ml" / "artifacts"
DEFAULT_REGISTRY = ROOT / "ml" / "models_registry"
_VERSION_RE = re.compile(r"^v[0-9]{1,6}$")


def registry_dir() -> Path:
    """Model registry root (env MEDFORECAST_REGISTRY overrides; read on every call)."""
    return Path(os.environ.get("MEDFORECAST_REGISTRY") or DEFAULT_REGISTRY)


def active_version(registry: Path | None = None) -> str | None:
    """Name of the registry's active (champion) version, or None if there is no usable pointer."""
    reg = Path(registry) if registry else registry_dir()
    try:
        name = (reg / "ACTIVE").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not _VERSION_RE.match(name) or not (reg / name / "forecast.csv").exists():
        return None
    return name


def artifacts_dir() -> Path:
    """Artifact directory the app serves: env MEDFORECAST_ARTIFACTS, else the registry's active
    version (ml/models_registry/<v>/), else ml/artifacts. Resolved on every call."""
    env = os.environ.get("MEDFORECAST_ARTIFACTS")
    if env:
        return Path(env)
    reg = registry_dir()
    v = active_version(reg)
    return reg / v if v else DEFAULT_ARTIFACTS


# Raw workbook (env MEDFORECAST_RAW lets a retraining job point load_raw() at a built training set).
RAW_XLSX = Path(os.environ.get("MEDFORECAST_RAW") or DEFAULT_RAW_XLSX)
ARTIFACTS = artifacts_dir()

SEED = 42

# Forecast design ---------------------------------------------------------------
# Per-medicine daily demand is very sparse (median ~0.1 sales/day), so the system
# forecasts weekly units. Weeks start on Monday; partial edge weeks are dropped.
HORIZON = 12                 # weeks ahead (~one season)
MIN_HISTORY = 6              # weeks of history required before an origin is used
SEQ_LEN = 16                 # lookback window for the deep model

# Kerala climate seasons (IMD convention, adapted to Kerala's two monsoons).
SEASONS = {
    "Winter": [12, 1, 2],
    "Summer": [3, 4, 5],
    "Monsoon": [6, 7, 8, 9],        # South-west monsoon (Edavappathi)
    "Post-Monsoon": [10, 11],       # North-east monsoon (Thulavarsham)
}
SEASON_ORDER = list(SEASONS)
MONTH_TO_SEASON = {m: s for s, ms in SEASONS.items() for m in ms}

SEASON_META = {
    "Winter": {"months": "Dec – Feb", "drivers": "Cool dry spell, festive OTC spike at Christmas/New Year, respiratory flare-ups"},
    "Summer": {"months": "Mar – May", "drivers": "Heat, dehydration and water-borne GI illness; vitamin & ORS demand; Vishu festival"},
    "Monsoon": {"months": "Jun – Sep", "drivers": "Humidity, infections, fevers, vector-borne disease (dengue/malaria), fungal skin issues; Onam festival"},
    "Post-Monsoon": {"months": "Oct – Nov", "drivers": "North-east monsoon tail, lingering respiratory & allergy cases"},
}

# Festival windows (inclusive). Onam = Thiruvonam ±5 days; Vishu = Apr 14/15 ±3 days.
FESTIVALS = {
    "Onam": [("2025-08-31", "2025-09-10"), ("2026-08-21", "2026-08-31"), ("2027-09-07", "2027-09-17")],
    "Vishu": [("2025-04-11", "2025-04-18"), ("2026-04-11", "2026-04-18"), ("2027-04-11", "2027-04-18")],
    "Christmas/New Year": [("2024-12-20", "2025-01-02"), ("2025-12-20", "2026-01-02"), ("2026-12-20", "2027-01-02")],
}


def season_of(ts) -> str:
    return MONTH_TO_SEASON[pd.Timestamp(ts).month]


def festival_days(week_start: pd.Timestamp) -> dict[str, int]:
    """Number of days of each festival falling inside the 7-day week."""
    days = pd.date_range(week_start, periods=7, freq="D")
    out = {}
    for name, windows in FESTIVALS.items():
        n = 0
        for a, b in windows:
            n += int(((days >= pd.Timestamp(a)) & (days <= pd.Timestamp(b))).sum())
        out[name] = n
    return out
