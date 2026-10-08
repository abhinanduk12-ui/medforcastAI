"""External early-warning signals: weather (NASA POWER, Open-Meteo) and DHS Kerala IDSP disease reports.

Everything here is best effort and cache-first:

* Fetchers use urllib with a 10 s timeout, 3 attempts and exponential backoff. Raw responses are cached
  as JSON in data/external/ (override with env MEDFORECAST_SIGNALS_CACHE) and parsed rows are written to
  SQLite tables owned by this component (signals_*). Read functions never touch the network.
* Weather licence mode (env MEDFORECAST_WEATHER_LICENSE, else the `signals.weather_license` setting):
    noncommercial    (default) free Open-Meteo endpoints: non-commercial use only, CC-BY 4.0 attribution
    commercial-plan  Open-Meteo customer endpoints with env MEDFORECAST_OPENMETEO_APIKEY
    off              no Open-Meteo at all (no forecast / seasonal outlook)
  Observed history always comes from NASA POWER (no key, free for commercial use), and its anomalies are
  computed against NASA POWER's own 1991-2020 climatology. Open-Meteo forecasts are compared with the
  Open-Meteo ERA5 1991-2020 climatology, so each anomaly uses one source end to end.
* Disease counts are parsed from the DHS Kerala IDSP daily PDF (page "DISTRICT WISE DAILY REPORTING
  FORMAT"). A day is stored only when every check passes: 14 districts in the expected order plus a TOT
  row, 29 whole-number cells per row, the report date matches, and the districts sum to TOT in every
  column used. Anything else is recorded as "needs manual entry" with the PDF link. Numbers are never guessed.
"""
from __future__ import annotations

import csv
from contextlib import contextmanager
import io
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from backend import db
from ml import config as C

# ── Constants ────────────────────────────────────────────────────────────────────────────────
LAT, LON = 9.9312, 76.2673            # Kochi (Ernakulam district), where the main shop is
PLACE = "Kochi, Ernakulam"
HIST_START = date(2025, 6, 1)         # observed weather kept from here (sales history starts 2025-08-04, lags need ~5 weeks)
CLIM_START, CLIM_END = date(1991, 1, 1), date(2020, 12, 31)
HEAVY_RAIN_MM = 64.5                  # IMD "heavy rain" threshold for one day
TIMEOUT_S = 10
RETRIES = 3
BACKOFF_S = 1.0
MAX_BYTES = 8_000_000
UA = "MedForecast-AI/2.0 (pharmacy demand early-warning; contact: shop owner)"

LICENSE_MODES = ("noncommercial", "commercial-plan", "off")
DEFAULT_LICENSE = "noncommercial"
OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)"
OPEN_METEO_URL = "https://open-meteo.com/"
OPEN_METEO_TERMS = "https://open-meteo.com/en/terms"
NASA_ATTRIBUTION = "NASA Langley Research Center (LaRC) POWER Project, funded through the NASA Earth Science/Applied Science Program"
NASA_URL = "https://power.larc.nasa.gov/"
DHS_URL = "https://dhs.kerala.gov.in/"

# Long-term monthly mean rainfall (mm), Kochi point, 1991-2020. Measured from the same APIs on 2026-10-01 and
# used only when nothing has been fetched yet (offline first run), always labelled as a fallback.
FALLBACK_MONTHLY_CLIM = {
    "nasa_power": {1: 17, 2: 27, 3: 44, 4: 111, 5: 250, 6: 521, 7: 438, 8: 342, 9: 271, 10: 361, 11: 172, 12: 47},
    "era5": {1: 9, 2: 13, 3: 40, 4: 120, 5: 294, 6: 521, 7: 469, 8: 357, 9: 272, 10: 287, 11: 164, 12: 50},
}

# Freshness (hours) after which a source is flagged stale
STALE_HOURS = {"nasa_obs": 72, "om_forecast": 36, "om_seasonal": 24 * 8, "dhs_idsp": 72}
# Re-fetch intervals for the scheduler (hours); weather and disease default to daily
DUE_HOURS = {"nasa_obs": 20, "om_forecast": 12, "om_seasonal": 24 * 3, "nasa_clim": 24 * 365, "era5_clim": 24 * 365}

# ── Disease definitions ──────────────────────────────────────────────────────────────────────
DISTRICTS = ["TVM", "KLM", "PTA", "IDK", "KTM", "ALP", "EKM", "TSR", "PKD", "MPM", "KKD", "WYD", "KNR", "KSD"]
DISTRICT_NAMES = {"EKM": "Ernakulam", "KERALA": "Kerala (state total)"}
REGIONS = ("EKM", "KERALA")
DISEASE_CODES = ("fever", "dengue", "lepto", "hepatitis_a", "chikungunya", "add", "influenza", "ili", "other")
N_COLS = 29
# Column positions (0-based, after the district code) in the IDSP district table, verified against the
# state analysis page and the free-text case listings for several 2025-2026 reports.
IDSP_COLS: dict[str, dict[str, int]] = {
    "fever": {"suspected": 0},                     # fever OP (column 1 is IP admissions, kept in notes)
    "chikungunya": {"suspected": 2, "confirmed": 3, "deaths": 4},
    "dengue": {"suspected": 5, "confirmed": 6, "deaths": 7},
    "lepto": {"suspected": 8, "confirmed": 9, "deaths": 10},
    "add": {"suspected": 11},                      # acute diarrhoeal disease cases
    "hepatitis_a": {"confirmed": 13},
    "influenza": {"confirmed": 28},                # lab-confirmed influenza
}
FEVER_IP_COL = 1
CHECK_COLS = sorted({c for d in IDSP_COLS.values() for c in d.values()} | {FEVER_IP_COL})
BACKFILL_DAYS = 98                    # 14 weeks: one current block + 12 baseline blocks + slack
MAX_PDF_PER_RUN = 120

# ── Small utils ──────────────────────────────────────────────────────────────────────────────

def today() -> date:
    return date.today()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _age_hours(s: str | None) -> float | None:
    dt = _parse_iso(s)
    return None if dt is None else (_utcnow() - dt).total_seconds() / 3600


def cache_dir() -> Path:
    p = Path(os.environ.get("MEDFORECAST_SIGNALS_CACHE") or (C.ROOT / "data" / "external"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _write_json(name: str, obj: Any) -> None:
    p = cache_dir() / name
    tmp = p.with_suffix(p.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, p)


def _read_json(name: str) -> Any | None:
    p = cache_dir() / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f <= -900:      # NASA POWER uses -999 for missing
        return None
    return f


# ── Schema ───────────────────────────────────────────────────────────────────────────────────
db.register_schema("signals", [
    """
    CREATE TABLE IF NOT EXISTS signals_weather_daily (
        date TEXT NOT NULL, source TEXT NOT NULL, is_forecast INTEGER NOT NULL DEFAULT 0,
        precip_mm REAL, tmax REAL, tmin REAL, rh REAL, precip_prob REAL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (date, source, is_forecast));
    CREATE TABLE IF NOT EXISTS signals_disease_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL, period TEXT NOT NULL CHECK (period IN ('day','week')),
        district TEXT NOT NULL, disease TEXT NOT NULL,
        suspected INTEGER CHECK (suspected IS NULL OR suspected >= 0),
        confirmed INTEGER CHECK (confirmed IS NULL OR confirmed >= 0),
        deaths INTEGER CHECK (deaths IS NULL OR deaths >= 0),
        source TEXT NOT NULL, source_url TEXT, validated INTEGER NOT NULL DEFAULT 0, notes TEXT,
        entered_by INTEGER, created_at TEXT NOT NULL,
        UNIQUE (date, period, district, disease, source));
    CREATE INDEX IF NOT EXISTS signals_disease_daily_dd ON signals_disease_daily (district, disease, date);
    CREATE TABLE IF NOT EXISTS signals_disease_reports (
        date TEXT PRIMARY KEY, status TEXT NOT NULL, url TEXT, message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt TEXT);
    CREATE TABLE IF NOT EXISTS signals_fetch_log (
        source TEXT PRIMARY KEY, last_attempt TEXT, last_success TEXT, status TEXT, message TEXT, rows INTEGER);
    """,
])


class _DbMoved(Exception):
    """MEDFORECAST_DB changed while a background refresh was running (e.g. a test's temp DB was closed)."""


_pinned = threading.local()          # .path = database file a background refresh is bound to (None = unbound)


def _same_file(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _check_db() -> None:
    """Abort a background refresh early if the database it started on is no longer the one in effect."""
    want = getattr(_pinned, "path", None)
    if want is not None and not _same_file(str(db.db_path()), want):
        raise _DbMoved(f"database changed during refresh (started on {want})")


@contextmanager
def _wtx():
    """Write transaction for refresh code. Inside the transaction it verifies that the connection really is the
    pinned database file, so a refresh started on one DB can never write into another (no check-then-write gap)."""
    _check_db()                      # cheap env check first: do not even open a connection to another DB
    with db.tx() as con:
        want = getattr(_pinned, "path", None)
        if want is not None:
            files = [r[2] for r in con.execute("PRAGMA database_list").fetchall() if r[1] == "main"]
            if not files or not _same_file(files[0], want):
                raise _DbMoved(f"database changed during refresh (started on {want})")
        yield con


def _log(source: str, ok: bool, message: str = "", rows: int | None = None) -> None:
    with _wtx():
        _log_row(source, ok, message, rows)


def _log_row(source: str, ok: bool, message: str = "", rows: int | None = None) -> None:
    now = db.now_iso()
    if ok:
        db.execute("""INSERT INTO signals_fetch_log(source, last_attempt, last_success, status, message, rows)
                      VALUES (?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET last_attempt=excluded.last_attempt,
                      last_success=excluded.last_success, status=excluded.status, message=excluded.message, rows=excluded.rows""",
                   (source, now, now, "ok", message[:500], rows))
    else:
        db.execute("""INSERT INTO signals_fetch_log(source, last_attempt, status, message)
                      VALUES (?,?,?,?) ON CONFLICT(source) DO UPDATE SET last_attempt=excluded.last_attempt,
                      status=excluded.status, message=excluded.message""",
                   (source, now, "error", message[:500]))


def fetch_log() -> dict[str, dict]:
    return {r["source"]: r for r in db.query("SELECT * FROM signals_fetch_log")}


# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────
class FetchError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def http_get(url: str, timeout: float = TIMEOUT_S, retries: int = RETRIES, backoff: float = BACKOFF_S) -> bytes:
    """GET with a timeout, retries with exponential backoff, and a size cap. 4xx (except 429) is not retried."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise FetchError("response too large")
            return body
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise FetchError(f"HTTP {e.code}", e.code) from None
            last = e
        except FetchError:
            raise
        except Exception as e:  # URLError, timeouts, connection resets
            last = e
        if attempt < retries - 1:
            time.sleep(backoff * (2 ** attempt))
    raise FetchError(f"{type(last).__name__}: {last}" if last else "request failed")


def http_json(url: str, **kw) -> dict:
    b = http_get(url, **kw)
    try:
        return json.loads(b)
    except ValueError:
        raise FetchError("invalid JSON") from None


# ── Licence mode ─────────────────────────────────────────────────────────────────────────────

def license_mode() -> tuple[str, bool]:
    """(mode, locked_by_env)."""
    env = (os.environ.get("MEDFORECAST_WEATHER_LICENSE") or "").strip().lower()
    if env in LICENSE_MODES:
        return env, True
    try:
        v = db.get_setting("signals.weather_license", DEFAULT_LICENSE)
    except Exception:
        v = DEFAULT_LICENSE
    return (v if v in LICENSE_MODES else DEFAULT_LICENSE), False


def set_license_mode(mode: str) -> None:
    if mode not in LICENSE_MODES:
        raise ValueError(f"mode must be one of {LICENSE_MODES}")
    db.set_setting("signals.weather_license", mode)


def license_info() -> dict:
    mode, locked = license_mode()
    key_set = bool(os.environ.get("MEDFORECAST_OPENMETEO_APIKEY"))
    notices = {
        "noncommercial": ("Forecasts use Open-Meteo's free API, which is licensed for non-commercial use only "
                          "(CC BY 4.0, attribution required). A retail pharmacy is a commercial user: buy an "
                          "Open-Meteo API plan or self-host before relying on it in day-to-day business, or switch to 'off'."),
        "commercial-plan": ("Forecasts use Open-Meteo's commercial customer API" +
                            (" with the configured API key." if key_set else
                             ", but MEDFORECAST_OPENMETEO_APIKEY is not set, so forecasts cannot be fetched.")),
        "off": "Open-Meteo is switched off: no 16-day forecast or seasonal outlook. Observed rainfall still comes from NASA POWER.",
    }
    return {"mode": mode, "locked": locked, "modes": list(LICENSE_MODES), "notice": notices[mode],
            "open_meteo_enabled": mode == "noncommercial" or (mode == "commercial-plan" and key_set),
            "api_key_set": key_set,
            "attribution": {"open_meteo": {"text": OPEN_METEO_ATTRIBUTION, "url": OPEN_METEO_URL, "terms": OPEN_METEO_TERMS},
                            "nasa_power": {"text": NASA_ATTRIBUTION, "url": NASA_URL},
                            "dhs_kerala": {"text": "Directorate of Health Services, Kerala: IDSP daily communicable disease reports", "url": DHS_URL}}}


def _om_host(kind: str) -> tuple[str, str]:
    """(base url, extra query) for an Open-Meteo API kind: forecast | archive | seasonal."""
    mode, _ = license_mode()
    if mode == "off":
        raise FetchError("Open-Meteo is switched off (licence mode 'off')")
    hosts = {"forecast": "api.open-meteo.com/v1/forecast", "archive": "archive-api.open-meteo.com/v1/archive",
             "seasonal": "seasonal-api.open-meteo.com/v1/seasonal"}
    if mode == "commercial-plan":
        key = os.environ.get("MEDFORECAST_OPENMETEO_APIKEY")
        if not key:
            raise FetchError("licence mode 'commercial-plan' needs env MEDFORECAST_OPENMETEO_APIKEY")
        return "https://customer-" + hosts[kind], "&apikey=" + urllib.parse.quote(key)
    return "https://" + hosts[kind], ""


# ── Weather fetchers ─────────────────────────────────────────────────────────────────────────

def _nasa_url(start: date, end: date, params: str = "PRECTOTCORR,T2M_MAX,T2M_MIN,RH2M") -> str:
    return ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=" + params +
            f"&community=AG&longitude={LON}&latitude={LAT}&start={start:%Y%m%d}&end={end:%Y%m%d}&format=JSON")


def fetch_nasa_observed() -> int:
    """Daily observed rain/temperature/humidity since HIST_START. Returns rows stored."""
    end = today()
    d = http_json(_nasa_url(HIST_START, end))
    p = (d.get("properties") or {}).get("parameter") or {}
    pr = p.get("PRECTOTCORR")
    if not isinstance(pr, dict) or not pr:
        raise FetchError("NASA POWER response has no PRECTOTCORR series")
    _write_json("nasa_power_observed.json", {"fetched_at": db.now_iso(), "lat": LAT, "lon": LON, "parameter": p})
    return _store_nasa(p, db.now_iso())


def _store_nasa(p: dict, fetched_at: str) -> int:
    pr, tx, tn, rh = (p.get(k) or {} for k in ("PRECTOTCORR", "T2M_MAX", "T2M_MIN", "RH2M"))
    rows = []
    for k, v in pr.items():
        try:
            dt = datetime.strptime(k, "%Y%m%d").date()
        except ValueError:
            continue
        rows.append((dt.isoformat(), "nasa_power", 0, _num(v), _num(tx.get(k)), _num(tn.get(k)), _num(rh.get(k)), None, fetched_at))
    with _wtx():
        db.executemany("""INSERT INTO signals_weather_daily(date, source, is_forecast, precip_mm, tmax, tmin, rh, precip_prob, fetched_at)
                          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(date, source, is_forecast) DO UPDATE SET
                          precip_mm=excluded.precip_mm, tmax=excluded.tmax, tmin=excluded.tmin, rh=excluded.rh,
                          fetched_at=excluded.fetched_at""", rows)
    return sum(1 for r in rows if r[3] is not None)


def fetch_nasa_climatology() -> int:
    d = http_json(_nasa_url(CLIM_START, CLIM_END, "PRECTOTCORR"), timeout=TIMEOUT_S)
    pr = ((d.get("properties") or {}).get("parameter") or {}).get("PRECTOTCORR")
    if not isinstance(pr, dict) or len(pr) < 3650:
        raise FetchError("NASA POWER climatology response is incomplete")
    vals = [_num(pr.get(f"{(CLIM_START + timedelta(i)):%Y%m%d}")) for i in range((CLIM_END - CLIM_START).days + 1)]
    _write_json("nasa_power_climatology.json", {"source": "nasa_power", "start": CLIM_START.isoformat(), "values": vals,
                                                "fetched_at": db.now_iso()})
    _clim_cache.clear()
    return sum(v is not None for v in vals)


def fetch_era5_climatology() -> int:
    base, extra = _om_host("archive")
    url = (f"{base}?latitude={LAT}&longitude={LON}&start_date={CLIM_START}&end_date={CLIM_END}"
           f"&daily=precipitation_sum&timezone=Asia%2FKolkata{extra}")
    d = http_json(url)
    t, p = (d.get("daily") or {}).get("time"), (d.get("daily") or {}).get("precipitation_sum")
    if not t or not p or len(t) != len(p) or t[0] != CLIM_START.isoformat():
        raise FetchError("ERA5 climatology response is incomplete")
    _write_json("era5_climatology.json", {"source": "era5", "start": t[0], "values": [_num(v) for v in p],
                                          "fetched_at": db.now_iso()})
    _clim_cache.clear()
    return len(t)


def fetch_om_forecast() -> int:
    base, extra = _om_host("forecast")
    url = (f"{base}?latitude={LAT}&longitude={LON}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,"
           f"relative_humidity_2m_mean,precipitation_probability_max&timezone=Asia%2FKolkata&forecast_days=16{extra}")
    d = http_json(url)
    dl = d.get("daily") or {}
    t = dl.get("time") or []
    if not t:
        raise FetchError("Open-Meteo forecast response has no days")
    now = db.now_iso()
    _write_json("openmeteo_forecast.json", {"fetched_at": now, "daily": dl})
    _store_forecast(dl, now)
    return len(t)


def _store_forecast(dl: dict, fetched_at: str) -> None:
    t = dl.get("time") or []
    col = lambda k: dl.get(k) or [None] * len(t)
    rows = [(day, "open_meteo", 1, _num(p), _num(a), _num(b), _num(h), _num(pp), fetched_at)
            for day, p, a, b, h, pp in zip(t, col("precipitation_sum"), col("temperature_2m_max"), col("temperature_2m_min"),
                                            col("relative_humidity_2m_mean"), col("precipitation_probability_max"))]
    with _wtx():
        db.execute("DELETE FROM signals_weather_daily WHERE source='open_meteo' AND is_forecast=1")
        db.executemany("""INSERT INTO signals_weather_daily(date, source, is_forecast, precip_mm, tmax, tmin, rh, precip_prob, fetched_at)
                          VALUES (?,?,?,?,?,?,?,?,?)""", rows)


def fetch_om_seasonal() -> int:
    base, extra = _om_host("seasonal")
    url = (f"{base}?latitude={LAT}&longitude={LON}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min"
           f"&forecast_days=183{extra}")
    d = http_json(url)
    dl = d.get("daily") or {}
    if not dl.get("time") or not any(k.startswith("precipitation_sum") for k in dl):
        raise FetchError("Open-Meteo seasonal response has no precipitation members")
    keep = {k: v for k, v in dl.items() if k == "time" or k.startswith("precipitation_sum")}
    _write_json("openmeteo_seasonal.json", {"fetched_at": db.now_iso(), "daily": keep})
    return len(dl["time"])


# ── Climatology ──────────────────────────────────────────────────────────────────────────────
_clim_cache: dict[str, "Clim | None"] = {}


class Clim:
    """1991-2020 daily rainfall at the point, for window statistics on any calendar span."""

    def __init__(self, source: str, start: date, values: list):
        self.source = source
        self.start = start
        self.v = np.array([np.nan if x is None else float(x) for x in values], dtype=float)
        self.cs = np.concatenate([[0.0], np.nancumsum(self.v)])
        self.nan_cs = np.concatenate([[0], np.cumsum(np.isnan(self.v))])
        end = start + timedelta(len(values) - 1)
        self.years = list(range(start.year if start.month == 1 and start.day == 1 else start.year + 1, end.year + 1))
        self._w: dict = {}

    def totals(self, d0: date, ndays: int, jitter: int = 7) -> np.ndarray:
        """ndays totals starting within +-jitter days of d0's calendar date in every climatology year
        (windows that run off the record or contain a missing day are dropped). Vectorised."""
        base = []
        for y in self.years:
            try:
                b = date(y, d0.month, d0.day)
            except ValueError:
                b = date(y, 2, 28)
            base.append((b - self.start).days)
        i = (np.asarray(base)[:, None] + np.arange(-jitter, jitter + 1)[None, :]).ravel()
        j = i + ndays
        ok = (i >= 0) & (j <= len(self.v))
        i, j = i[ok], j[ok]
        ok = (self.nan_cs[j] - self.nan_cs[i]) == 0
        return (self.cs[j] - self.cs[i])[ok]

    def window(self, d0: date, ndays: int, jitter: int = 7) -> dict | None:
        key = (d0.month, d0.day, ndays, jitter)
        if key in self._w:
            return self._w[key]
        a = self.totals(d0, ndays, jitter)
        if len(a) < 10:
            self._w[key] = None
            return None
        lg = np.log1p(a)
        p10, p50, p90 = np.percentile(a, [10, 50, 90])
        r = {"mean": float(a.mean()), "sd": float(a.std(ddof=1)), "p10": float(p10), "p50": float(p50), "p90": float(p90),
             "lmean": float(lg.mean()), "lsd": float(max(lg.std(ddof=1), 1e-6)), "n": int(len(a)), "_sorted": np.sort(a)}
        self._w[key] = r
        return r

    def month(self, m: int) -> float | None:
        tot = []
        for y in self.years:
            a = date(y, m, 1)
            b = date(y + (m == 12), m % 12 + 1, 1)
            i, j = (a - self.start).days, (b - self.start).days
            if i >= 0 and j <= len(self.v) and self.nan_cs[j] - self.nan_cs[i] == 0:
                tot.append(self.cs[j] - self.cs[i])
        return float(np.mean(tot)) if tot else None


def get_clim(source: str) -> Clim | None:
    """source = 'nasa_power' | 'era5' (cached JSON only; None if never fetched)."""
    if source in _clim_cache:
        return _clim_cache[source]
    name = {"nasa_power": "nasa_power_climatology.json", "era5": "era5_climatology.json"}[source]
    j = _read_json(name)
    c = None
    if j and j.get("values") and j.get("start"):
        try:
            c = Clim(source, date.fromisoformat(j["start"]), j["values"])
        except (ValueError, TypeError):
            c = None
    _clim_cache[source] = c
    return c


def anomaly(total: float, st: dict | None) -> dict:
    if st is None or total is None:
        return {"anomaly_pct": None, "anomaly_z": None, "percentile": None}
    s = st["_sorted"]
    pct = float((np.searchsorted(s, total, side="left") + np.searchsorted(s, total, side="right")) / 2 / len(s))
    return {"anomaly_pct": (total / st["mean"] - 1) if st["mean"] > 0.5 else None,
            "anomaly_z": (math.log1p(total) - st["lmean"]) / st["lsd"], "percentile": pct}


def tercile(percentile: float | None) -> str | None:
    if percentile is None:
        return None
    return "wetter than usual" if percentile >= 2 / 3 else "drier than usual" if percentile <= 1 / 3 else "near normal"


def _stats_public(st: dict | None) -> dict:
    if not st:
        return {"clim_mean": None, "clim_p10": None, "clim_p90": None}
    return {"clim_mean": st["mean"], "clim_p10": st["p10"], "clim_p90": st["p90"]}


# ── Weather reads (cache only) ───────────────────────────────────────────────────────────────

def observed_daily() -> tuple[pd.DataFrame, bool]:
    """(daily frame indexed by date [precip_mm, tmax, tmin, rh], from_json_fallback)."""
    rows = db.query("SELECT date, precip_mm, tmax, tmin, rh FROM signals_weather_daily WHERE source='nasa_power' AND is_forecast=0 ORDER BY date")
    fallback = False
    if not rows:
        j = _read_json("nasa_power_observed.json")
        if j and j.get("parameter"):
            p = j["parameter"]
            rows = [{"date": datetime.strptime(k, "%Y%m%d").date().isoformat(), "precip_mm": _num(v),
                     "tmax": _num((p.get("T2M_MAX") or {}).get(k)), "tmin": _num((p.get("T2M_MIN") or {}).get(k)),
                     "rh": _num((p.get("RH2M") or {}).get(k))} for k, v in (p.get("PRECTOTCORR") or {}).items()]
            fallback = True
    df = pd.DataFrame(rows, columns=["date", "precip_mm", "tmax", "tmin", "rh"])
    if len(df):
        df["date"] = pd.to_datetime(df["date"]).dt.date
        df = df.set_index("date").sort_index()
        df = df.astype(float)
    return df, fallback


def forecast_daily() -> tuple[pd.DataFrame, str | None]:
    rows = db.query("""SELECT date, precip_mm, tmax, tmin, rh, precip_prob, fetched_at FROM signals_weather_daily
                       WHERE source='open_meteo' AND is_forecast=1 ORDER BY date""")
    fetched = rows[0]["fetched_at"] if rows else None
    if not rows:
        j = _read_json("openmeteo_forecast.json")
        if j and j.get("daily", {}).get("time"):
            dl = j["daily"]
            t = dl["time"]
            g = lambda k: dl.get(k) or [None] * len(t)
            rows = [{"date": a, "precip_mm": _num(b), "tmax": _num(c), "tmin": _num(e), "rh": _num(f), "precip_prob": _num(h)}
                    for a, b, c, e, f, h in zip(t, g("precipitation_sum"), g("temperature_2m_max"), g("temperature_2m_min"),
                                                g("relative_humidity_2m_mean"), g("precipitation_probability_max"))]
            fetched = j.get("fetched_at")
    df = pd.DataFrame(rows, columns=["date", "precip_mm", "tmax", "tmin", "rh", "precip_prob"])
    if len(df):
        df["date"] = pd.to_datetime(df["date"]).dt.date
        df = df.set_index("date").sort_index().astype(float)
    return df, fetched


def _monday(d: date) -> date:
    return d - timedelta(d.weekday())


def weekly_observed(daily: pd.DataFrame, clim: Clim | None) -> list[dict]:
    """Monday-aligned weekly features for every complete week (all 7 days observed)."""
    if daily.empty:
        return []
    pr = daily["precip_mm"]
    first = _monday(daily.index.min())
    if first < daily.index.min():
        first += timedelta(7)
    out = []
    wk = first
    last = daily.index.max()
    while wk + timedelta(6) <= last:
        days = [wk + timedelta(i) for i in range(7)]
        vals = pr.reindex(days)
        if vals.notna().all():
            tot = float(vals.sum())
            st = clim.window(wk, 7) if clim else None
            prev = [wk - timedelta(i) for i in range(1, 8)]
            pv = pr.reindex(prev)
            r = {"week": wk.isoformat(), "rain_mm": tot, "heavy_days": int((vals >= HEAVY_RAIN_MM).sum()),
                 "max_day_mm": float(vals.max()),
                 "roll14_mm": float(tot + pv.sum()) if pv.notna().all() else None,
                 "tmax": _mean(daily["tmax"].reindex(days)), "tmin": _mean(daily["tmin"].reindex(days)),
                 "rh": _mean(daily["rh"].reindex(days)), **_stats_public(st), **anomaly(tot, st)}
            out.append(r)
        wk += timedelta(7)
    # lags of the anomaly (z on the log scale) for 1-4 weeks, by calendar week (None when a week is missing)
    by = {r["week"]: r for r in out}
    for r in out:
        w = date.fromisoformat(r["week"])
        for L in range(1, 5):
            p = by.get((w - timedelta(7 * L)).isoformat())
            r[f"anom_z_lag{L}"] = p["anomaly_z"] if p else None
    return out


def _mean(s: pd.Series) -> float | None:
    s = s.dropna()
    return float(s.mean()) if len(s) else None


def seasonal_outlook() -> dict:
    j = _read_json("openmeteo_seasonal.json")
    era = get_clim("era5")
    if not j or not (j.get("daily") or {}).get("time"):
        return {"available": False, "months": [], "fetched_at": None}
    dl = j["daily"]
    t = [date.fromisoformat(x[:10]) for x in dl["time"]]
    members = [k for k in dl if k.startswith("precipitation_sum")]
    M = np.array([[np.nan if v is None else float(v) for v in dl[k]] for k in members], dtype=float)
    months = []
    for ym in sorted({(d.year, d.month) for d in t}):
        idx = [i for i, d in enumerate(t) if (d.year, d.month) == ym]
        first, ndays = t[idx[0]], len(idx)
        mdays = (date(ym[0] + (ym[1] == 12), ym[1] % 12 + 1, 1) - date(ym[0], ym[1], 1)).days
        sub = M[:, idx]
        ok = ~np.isnan(sub).any(axis=1)
        if ok.sum() < 10 or ndays < 7:
            continue
        tot = sub[ok].sum(axis=1)
        st = era.window(first, ndays, jitter=0) if era else None
        clim_mean = st["mean"] if st else (FALLBACK_MONTHLY_CLIM["era5"][ym[1]] * ndays / mdays)
        med = float(np.median(tot))
        months.append({
            "month": f"{ym[0]}-{ym[1]:02d}", "days": ndays, "partial": ndays < mdays, "members": int(ok.sum()),
            "median": med, "p10": float(np.percentile(tot, 10)), "p90": float(np.percentile(tot, 90)),
            "min": float(tot.min()), "max": float(tot.max()),
            "clim_mean": clim_mean, "clim_p10": st["p10"] if st else None, "clim_p90": st["p90"] if st else None,
            "clim_fallback": st is None,
            "anomaly_pct": med / clim_mean - 1 if clim_mean and clim_mean > 0.5 else None,
            "prob_above_normal": float((tot > (st["p50"] if st else clim_mean)).mean()),
        })
    return {"available": bool(months), "months": months, "fetched_at": j.get("fetched_at"),
            "caveat": ("Raw ensemble output from the ECMWF-based seasonal model, not bias-corrected for Kochi. Read the "
                       "spread and the share of members above normal rather than the exact millimetres.")}


def next16_summary(fc: pd.DataFrame) -> dict | None:
    if fc.empty:
        return None
    fc = fc[fc.index >= today()]
    vals = fc["precip_mm"].dropna()
    if vals.empty:
        return None
    tot = float(vals.sum())
    era = get_clim("era5")
    st = era.window(vals.index.min(), len(vals), jitter=7) if era else None
    an = anomaly(tot, st)
    return {"start": vals.index.min().isoformat(), "end": vals.index.max().isoformat(), "days": int(len(vals)),
            "total_mm": tot, "heavy_days": int((vals >= HEAVY_RAIN_MM).sum()), "max_day_mm": float(vals.max()),
            "wet_days": int((vals >= 2.5).sum()),
            "max_prob": _num(fc["precip_prob"].max()) if "precip_prob" in fc else None,
            **_stats_public(st), **an, "outlook": tercile(an["percentile"]),
            "clim_source": "Open-Meteo ERA5 1991-2020" if st else None}


def weather_view(weeks: int = 26) -> dict:
    """Everything the weather panel needs, from cache only."""
    log = fetch_log()
    lic = license_info()
    daily, fb = observed_daily()
    nclim = get_clim("nasa_power")
    wk = weekly_observed(daily, nclim)
    last_obs = daily["precip_mm"].dropna().index.max().isoformat() if len(daily) and daily["precip_mm"].notna().any() else None
    fc, fc_fetched = forecast_daily()
    fc_future = fc[fc.index >= today()] if len(fc) else fc
    era = get_clim("era5")

    # Chart weeks: recent observed weeks, then Monday-weeks covered by the forecast (observed days + forecast days)
    chart = [{"week": r["week"], "observed": r["rain_mm"], "forecast": None, "days_observed": 7, "days_forecast": 0,
              "clim_mean": r["clim_mean"], "clim_p10": r["clim_p10"], "clim_p90": r["clim_p90"], "kind": "observed"}
             for r in wk[-weeks:]]
    if len(fc_future) and lic["open_meteo_enabled"]:          # licence 'off': no Open-Meteo values anywhere in the view
        start_wk = _monday(fc_future.index.min())
        last_chart = date.fromisoformat(chart[-1]["week"]) if chart else None
        w = start_wk
        while w <= fc_future.index.max():
            days = [w + timedelta(i) for i in range(7)]
            fpart = fc_future["precip_mm"].reindex(days).dropna()
            opart = daily["precip_mm"].reindex(days).dropna() if len(daily) else pd.Series(dtype=float)
            opart = opart[[d not in fpart.index for d in opart.index]] if len(opart) else opart
            if last_chart is None or w > last_chart:
                st = era.window(w, 7) if era else None
                chart.append({"week": w.isoformat(), "observed": float(opart.sum()) if len(opart) else None,
                              "forecast": float(fpart.sum()) if len(fpart) else None,
                              "days_observed": int(len(opart)), "days_forecast": int(len(fpart)),
                              **_stats_public(st), "kind": "forecast"})
            w += timedelta(7)

    # Current (incomplete) week so far
    this_week = None
    if len(daily):
        mon = _monday(today())
        so_far = daily["precip_mm"].reindex([mon + timedelta(i) for i in range((today() - mon).days + 1)]).dropna()
        this_week = {"week": mon.isoformat(), "observed_mm": float(so_far.sum()), "days": int(len(so_far))}

    obs_log = log.get("nasa_obs", {})
    fc_log = log.get("om_forecast", {})
    lag_days = (today() - date.fromisoformat(last_obs)).days if last_obs else None
    return {
        "place": PLACE, "lat": LAT, "lon": LON, "today": today().isoformat(), "license": lic,
        "observed": {"source": "NASA POWER (MERRA-2 / IMERG blend, PRECTOTCORR)", "weeks": wk[-weeks:], "last_date": last_obs,
                     "lag_days": lag_days, "fetched_at": obs_log.get("last_success"), "from_cache_file": fb,
                     "stale": _stale("nasa_obs", obs_log.get("last_success")) or not wk,
                     "climatology": "NASA POWER 1991-2020" if nclim else None, "this_week": this_week,
                     "heavy_rain_mm": HEAVY_RAIN_MM},
        "forecast": {"available": bool(len(fc_future)) and lic["open_meteo_enabled"],
                     "source": "Open-Meteo forecast API (best-match models)",
                     "fetched_at": fc_fetched, "stale": bool(lic["open_meteo_enabled"]) and _stale("om_forecast", fc_fetched),
                     "days": [{"date": d.isoformat(), **{k: _num(v) for k, v in r.items()}} for d, r in fc_future.iterrows()]
                     if lic["open_meteo_enabled"] else [],
                     "next16": next16_summary(fc) if lic["open_meteo_enabled"] else None,
                     "reason": None if lic["open_meteo_enabled"] else lic["notice"],
                     "error": fc_log.get("message") if fc_log.get("status") == "error" else None},
        "seasonal": seasonal_outlook() if lic["open_meteo_enabled"] else {"available": False, "months": [], "reason": lic["notice"]},
        "chart": chart,
        "climatology_monthly": [{"month": m, "nasa_power": (nclim.month(m) if nclim else None),
                                 "era5": (era.month(m) if era else None),
                                 "fallback_nasa": FALLBACK_MONTHLY_CLIM["nasa_power"][m],
                                 "fallback_era5": FALLBACK_MONTHLY_CLIM["era5"][m]} for m in range(1, 13)],
        "climatology_available": {"nasa_power": nclim is not None, "era5": era is not None},
    }


def _stale(source: str, last_success: str | None) -> bool:
    age = _age_hours(last_success)
    return age is None or age > STALE_HOURS[source]


# ── DHS Kerala IDSP disease reports ──────────────────────────────────────────────────────────

def idsp_urls(d: date) -> list[str]:
    """Candidate URLs: the report month's upload folder, then the next month's (month-end reports)."""
    nxt = (d.replace(day=28) + timedelta(days=5)).replace(day=1)
    folders = [d.replace(day=1), nxt]
    if d.day <= 2:   # very early-month reports occasionally land in the previous month's folder
        folders.append((d.replace(day=1) - timedelta(days=1)).replace(day=1))
    name = f"IDSP-Daily-Report-{d.day:02d}.{d.month:02d}.{d.year}.pdf"
    return [f"https://dhs.kerala.gov.in/wp-content/uploads/{f.year}/{f.month:02d}/{name}" for f in folders]


class ParseError(Exception):
    pass


_ROW = re.compile(r"^\s*(?:\d{1,2}\s+)?(" + "|".join(DISTRICTS + ["TOT"]) + r")\s+((?:(?:\d+|-)\s+){" + str(N_COLS - 1) + r"}(?:\d+|-))\s*$")


def parse_idsp_text(text: str, expect: date | None = None) -> dict:
    """Parse the district table text. Returns {"rows": {district: [29 ints]}, "tot": [...], "report_date", "warnings"}.
    Raises ParseError on any structural or arithmetic inconsistency."""
    if "DISTRICT WISE DAILY REPORTING FORMAT" not in text:
        raise ParseError("district table page not found")
    for tok in ("DENGUE", "LEPTO", "Fever"):
        if tok not in text:
            raise ParseError(f"table header '{tok}' not found")
    m = re.search(r"Kerala\s+(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b", text)
    rep = None
    if m:
        dd, mm, yy = (int(x) for x in m.groups())
        yy = yy + 2000 if yy < 100 else yy
        try:
            rep = date(yy, mm, dd)
        except ValueError:
            raise ParseError("report date in the table header is invalid") from None
    if expect is not None:
        if rep is None:
            raise ParseError("report date not found in the table header")
        if rep != expect:
            raise ParseError(f"table is dated {rep.isoformat()}, expected {expect.isoformat()}")
    order, rows, tot = [], {}, None
    for line in text.splitlines():
        mm_ = _ROW.match(line)
        if not mm_:
            continue
        code, rest = mm_.group(1), mm_.group(2).split()
        vals = [0 if v == "-" else int(v) for v in rest]
        if len(vals) != N_COLS:
            raise ParseError(f"{code}: expected {N_COLS} cells, found {len(vals)}")
        if code == "TOT":
            if tot is not None:
                raise ParseError("two TOT rows")
            tot = vals
        else:
            if code in rows:
                raise ParseError(f"district {code} appears twice (mislabelled row)")
            rows[code] = vals
            order.append(code)
    if order != DISTRICTS:
        missing = [d for d in DISTRICTS if d not in rows]
        raise ParseError(f"district rows incomplete or out of order (missing: {', '.join(missing) or 'none'})")
    if tot is None:
        raise ParseError("state TOT row not found")
    bad = [c for c in CHECK_COLS if sum(rows[d][c] for d in DISTRICTS) != tot[c]]
    if bad:
        raise ParseError(f"districts do not sum to TOT in column(s) {', '.join(str(c + 1) for c in bad)}")
    other_bad = [c for c in range(N_COLS) if c not in CHECK_COLS and sum(rows[d][c] for d in DISTRICTS) != tot[c]]
    if any(v > 1_000_000 for v in tot):
        raise ParseError("implausibly large value")
    warn = [f"{len(other_bad)} unused column(s) do not sum to TOT"] if other_bad else []
    return {"rows": rows, "tot": tot, "report_date": rep.isoformat() if rep else None, "warnings": warn}


def parse_idsp_pdf(pdf: bytes, expect: date | None = None) -> dict:
    try:
        import pypdf  # pure python; verified to import under Smart App Control
    except ImportError as e:  # pragma: no cover
        raise ParseError("pypdf is not installed (pip install pypdf)") from e
    try:
        reader = pypdf.PdfReader(io.BytesIO(pdf))
        texts = [p.extract_text() or "" for p in reader.pages[:6]]
    except Exception as e:
        raise ParseError(f"PDF could not be read: {type(e).__name__}") from None
    page = next((t for t in texts if "DISTRICT WISE DAILY REPORTING FORMAT" in t), None)
    if page is None and not any(t.strip() for t in texts):
        raise ParseError("the PDF has no text layer (scanned image), so it cannot be read automatically")
    if page is None:
        raise ParseError("district table page not found")
    return parse_idsp_text(page, expect)


def _records_from_parse(d: date, parsed: dict, url: str) -> list[tuple]:
    now = db.now_iso()
    out = []
    for region, vals in (("EKM", parsed["rows"]["EKM"]), ("KERALA", parsed["tot"])):
        for disease, cols in IDSP_COLS.items():
            note = f"Fever IP admissions: {vals[FEVER_IP_COL]}" if disease == "fever" else None
            if parsed.get("warnings"):
                note = "; ".join(filter(None, [note] + parsed["warnings"]))
            out.append((d.isoformat(), "day", region, disease, vals[cols["suspected"]] if "suspected" in cols else None,
                        vals[cols["confirmed"]] if "confirmed" in cols else None,
                        vals[cols["deaths"]] if "deaths" in cols else None, "dhs_idsp", url, 1, note, None, now))
    return out


def _store_disease_rows(rows: list[tuple]) -> None:
    db.executemany("""INSERT INTO signals_disease_daily(date, period, district, disease, suspected, confirmed, deaths, source,
                      source_url, validated, notes, entered_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(date, period, district, disease, source) DO UPDATE SET suspected=excluded.suspected,
                      confirmed=excluded.confirmed, deaths=excluded.deaths, source_url=excluded.source_url,
                      validated=excluded.validated, notes=excluded.notes, entered_by=excluded.entered_by,
                      created_at=excluded.created_at""", rows)


def _set_report(d: date, status: str, url: str | None, message: str) -> None:
    with _wtx():
        _set_report_row(d, status, url, message)


def _set_report_row(d: date, status: str, url: str | None, message: str) -> None:
    db.execute("""INSERT INTO signals_disease_reports(date, status, url, message, attempts, last_attempt) VALUES (?,?,?,?,1,?)
                  ON CONFLICT(date) DO UPDATE SET status=excluded.status, url=COALESCE(excluded.url, url),
                  message=excluded.message, attempts=attempts+1, last_attempt=excluded.last_attempt""",
               (d.isoformat(), status, url, message[:500], db.now_iso()))


def fetch_idsp_day(d: date) -> str:
    """Fetch + parse + store one report. Returns the status: ok | missing | invalid | error."""
    last_err, pdf, url = None, None, None
    for u in idsp_urls(d):
        try:
            pdf = http_get(u, retries=2)
            url = u
            break
        except FetchError as e:
            if e.status == 404:
                continue
            last_err = str(e)
            break
    if pdf is None:
        if last_err:
            _set_report(d, "error", idsp_urls(d)[0], f"download failed: {last_err}")
            return "error"
        _set_report(d, "missing", idsp_urls(d)[0], "report not published at the expected address")
        return "missing"
    if not pdf.startswith(b"%PDF"):
        _set_report(d, "invalid", url, "the address did not return a PDF")
        return "invalid"
    try:
        parsed = parse_idsp_pdf(pdf, expect=d)
    except ParseError as e:
        _set_report(d, "invalid", url, f"needs manual entry: {e}")
        return "invalid"
    with _wtx():
        _store_disease_rows(_records_from_parse(d, parsed, url))
        _set_report(d, "ok", url, "; ".join(parsed["warnings"]) or "validated: districts sum to state total")
    _cache_idsp(d, parsed, url)
    return "ok"


def _cache_idsp(d: date, parsed: dict, url: str) -> None:
    j = _read_json("idsp_parsed.json") or {}
    j[d.isoformat()] = {"url": url, "EKM": parsed["rows"]["EKM"], "TOT": parsed["tot"], "warnings": parsed["warnings"]}
    keep = sorted(j)[-400:]
    _write_json("idsp_parsed.json", {k: j[k] for k in keep})


def import_idsp_cache() -> int:
    """Re-load parsed reports from the JSON cache into an empty/new database (no network)."""
    j = _read_json("idsp_parsed.json") or {}
    have = {r["date"] for r in db.query("SELECT date FROM signals_disease_reports WHERE status='ok'")}
    n = 0
    for ds, v in j.items():
        if ds in have or not isinstance(v, dict):
            continue
        try:
            d = date.fromisoformat(ds)
            ekm, tot = v["EKM"], v["TOT"]
            if len(ekm) != N_COLS or len(tot) != N_COLS:
                continue
            parsed = {"rows": {"EKM": [int(x) for x in ekm]}, "tot": [int(x) for x in tot], "warnings": v.get("warnings") or []}
        except (KeyError, ValueError, TypeError):
            continue
        with _wtx():
            _store_disease_rows(_records_from_parse(d, parsed, v.get("url")))
            _set_report(d, "ok", v.get("url"), "loaded from local cache (validated when first fetched)")
        n += 1
    return n


def refresh_disease(force: bool = False, max_requests: int = MAX_PDF_PER_RUN, progress=None) -> dict:
    """Fetch recent reports newest first, back to BACKFILL_DAYS. Retries missing/errored days politely."""
    _check_db()
    import_idsp_cache()
    reports = {r["date"]: r for r in db.query("SELECT * FROM signals_disease_reports")}
    manual_days = {r["date"] for r in db.query("SELECT DISTINCT date FROM signals_disease_daily WHERE source='manual' AND period='day'")}
    counts = {"ok": 0, "missing": 0, "invalid": 0, "error": 0, "skipped": 0}
    n = 0
    t = today()
    for back in range(1, BACKFILL_DAYS + 1):
        d = t - timedelta(days=back)
        r = reports.get(d.isoformat())
        if r and r["status"] == "ok":
            continue
        if r and not force:
            age = _age_hours(r["last_attempt"]) or 0
            recent = back <= 7
            # recently missing days are retried every 6 h for a week; older gaps at most 3 times, a day apart
            if r["status"] == "invalid" and (r["attempts"] >= 2 or age < 24):
                counts["skipped"] += 1
                continue
            if r["status"] in ("missing", "error") and (age < 6 or (not recent and (r["attempts"] >= 3 or age < 24))):
                counts["skipped"] += 1
                continue
        if d.isoformat() in manual_days and not force:
            continue
        if n >= max_requests:
            break
        _check_db()
        st = fetch_idsp_day(d)
        counts[st] += 1
        n += 1
        if progress:
            progress(f"DHS report {d.isoformat()}: {st}")
        time.sleep(0.3)
    ok = counts["ok"] + len([1 for r in reports.values() if r["status"] == "ok"])
    msg = ", ".join(f"{k} {v}" for k, v in counts.items() if v)
    _check_db()
    if counts["error"] and not counts["ok"]:
        _log("dhs_idsp", False, f"DHS Kerala site unreachable ({msg})")
    else:
        _log("dhs_idsp", True, msg or "up to date", ok)
    return counts


# ── Manual disease data ──────────────────────────────────────────────────────────────────────
TEMPLATE_HEADER = ["date", "period", "district", "disease", "suspected", "confirmed", "deaths", "source", "source_url", "notes"]


def template_csv() -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(TEMPLATE_HEADER)
    ex = (today() - timedelta(days=1)).isoformat()
    w.writerow([ex, "day", "EKM", "dengue", 23, 6, 0, "DHS Kerala IDSP daily report", "https://dhs.kerala.gov.in/", "example row: delete before upload"])
    w.writerow([_monday(today() - timedelta(days=7)).isoformat(), "week", "KERALA", "lepto", 60, 75, 2, "DHS weekly bulletin", "", "example row: week rows use the first day of the 7-day period as date"])
    return buf.getvalue()


class ManualError(ValueError):
    pass


def _int_or_none(v, field: str) -> int | None:
    if v is None or (isinstance(v, str) and v.strip() in ("", "-")):
        return None
    if isinstance(v, bool):
        raise ManualError(f"{field} must be a whole number")
    try:
        f = float(str(v).strip())
    except ValueError:
        raise ManualError(f"{field} must be a whole number") from None
    if not math.isfinite(f) or f != int(f) or f < 0 or f > 1_000_000:
        raise ManualError(f"{field} must be a whole number between 0 and 1,000,000")
    return int(f)


def validate_manual(rec: dict) -> tuple:
    try:
        d = date.fromisoformat(str(rec.get("date", "")).strip()[:10])
    except ValueError:
        raise ManualError("date must be YYYY-MM-DD") from None
    if d > today():
        raise ManualError("date cannot be in the future")
    if d < date(2015, 1, 1):
        raise ManualError("date is too old (before 2015)")
    period = str(rec.get("period") or "day").strip().lower()
    if period not in ("day", "week"):
        raise ManualError("period must be 'day' or 'week'")
    district = str(rec.get("district") or "").strip().upper()
    if district not in REGIONS:
        raise ManualError("district must be EKM or KERALA")
    disease = str(rec.get("disease") or "").strip().lower()
    if disease not in DISEASE_CODES:
        raise ManualError(f"disease must be one of: {', '.join(DISEASE_CODES)}")
    sus, con, dea = (_int_or_none(rec.get(k), k) for k in ("suspected", "confirmed", "deaths"))
    if sus is None and con is None:
        raise ManualError("give at least a suspected or a confirmed count")
    src = str(rec.get("source") or "manual entry").strip()[:120]
    url = str(rec.get("source_url") or "").strip()[:300]
    if url and not re.match(r"^https?://", url):
        raise ManualError("source_url must start with http:// or https://")
    notes = str(rec.get("notes") or "").strip()[:500]
    note = f"{src}" + (f" | {notes}" if notes else "")
    return (d.isoformat(), period, district, disease, sus, con, dea, "manual", url or None, 0, note)


def save_manual(records: list[dict], user_id: int | None) -> int:
    rows = [validate_manual(r) + (user_id, db.now_iso()) for r in records]
    with db.tx():
        _store_disease_rows(rows)
    return len(rows)


def parse_csv(text: str, max_rows: int = 2000) -> tuple[list[dict], list[str]]:
    """Returns (valid records, errors). Any error rejects the whole upload in the router."""
    text = text.lstrip("﻿")
    rdr = csv.DictReader(io.StringIO(text))
    hdr = [h.strip().lower() for h in (rdr.fieldnames or [])]
    missing = [h for h in ("date", "district", "disease") if h not in hdr]
    if missing:
        return [], [f"missing column(s): {', '.join(missing)}. Download the template for the expected header."]
    rdr.fieldnames = hdr
    recs, errs = [], []
    for i, row in enumerate(rdr, start=2):
        if i - 1 > max_rows:
            errs.append(f"more than {max_rows} rows")
            break
        if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
            continue
        if "example row" in (row.get("notes") or "").lower():
            continue
        try:
            validate_manual(row)
            recs.append(row)
        except ManualError as e:
            errs.append(f"line {i}: {e}")
            if len(errs) >= 20:
                errs.append("stopped after 20 errors")
                break
    return recs, errs


def delete_manual(entry_id: int) -> bool:
    cur = db.execute("DELETE FROM signals_disease_daily WHERE id=? AND source='manual'", (entry_id,))
    return cur.rowcount > 0


# ── Disease features ─────────────────────────────────────────────────────────────────────────
DISEASE_META: dict[str, dict] = {
    "dengue": {"label": "Dengue", "metric": "cases", "min_cases": {"EKM": 5, "KERALA": 30},
               "about": "Suspected + confirmed dengue reported to IDSP."},
    "fever": {"label": "Fever (outpatient)", "metric": "suspected", "min_cases": {"EKM": 100, "KERALA": 1000},
              "about": "All fever outpatient visits reported to IDSP (undifferentiated)."},
    "lepto": {"label": "Leptospirosis", "metric": "cases", "min_cases": {"EKM": 3, "KERALA": 15},
              "about": "Suspected + confirmed leptospirosis."},
    "add": {"label": "Acute diarrhoeal disease", "metric": "suspected", "min_cases": {"EKM": 30, "KERALA": 300},
            "about": "Acute diarrhoeal disease cases."},
    "hepatitis_a": {"label": "Hepatitis A", "metric": "confirmed", "min_cases": {"EKM": 3, "KERALA": 15},
                    "about": "Confirmed hepatitis A."},
    "influenza": {"label": "Influenza (lab-confirmed)", "metric": "confirmed", "min_cases": {"EKM": 3, "KERALA": 15},
                  "about": "Laboratory-confirmed influenza; testing volume drives these numbers."},
    "chikungunya": {"label": "Chikungunya", "metric": "cases", "min_cases": {"EKM": 3, "KERALA": 10},
                    "about": "Suspected + confirmed chikungunya."},
    "ili": {"label": "Influenza-like illness", "metric": "cases", "min_cases": {"EKM": 10, "KERALA": 50},
            "about": "Manual entries only (not in the IDSP daily table)."},
    "other": {"label": "Other", "metric": "cases", "min_cases": {"EKM": 5, "KERALA": 30}, "about": "Manual entries only."},
}
PANEL_DISEASES = ["dengue", "fever", "lepto", "add", "hepatitis_a", "influenza", "chikungunya"]
BLOCK_DAYS = 7
BASELINE_BLOCKS = 12
MIN_BASELINE = 6


def _metric_value(r: dict, metric: str) -> float | None:
    s, c = r.get("suspected"), r.get("confirmed")
    if metric == "suspected":
        return s
    if metric == "confirmed":
        return c
    if s is None and c is None:
        return None
    return (s or 0) + (c or 0)


def disease_frame() -> pd.DataFrame:
    rows = db.query("SELECT id, date, period, district, disease, suspected, confirmed, deaths, source, source_url, validated, notes "
                    "FROM signals_disease_daily")
    return pd.DataFrame(rows, columns=["id", "date", "period", "district", "disease", "suspected", "confirmed", "deaths",
                                       "source", "source_url", "validated", "notes"])


def latest_report_date(df: pd.DataFrame | None = None) -> date | None:
    df = disease_frame() if df is None else df
    d = df[df["period"] == "day"]["date"]
    return date.fromisoformat(d.max()) if len(d) else None


def daily_series(df: pd.DataFrame, region: str, disease: str) -> dict[date, dict]:
    """date -> {cases, suspected, confirmed, deaths, source, estimated}. Manual day rows override automatic ones;
    weekly manual rows are spread evenly over their 7 days only where no daily row exists (flagged estimated)."""
    meta = DISEASE_META[disease]
    sub = df[(df["district"] == region) & (df["disease"] == disease)]
    out: dict[date, dict] = {}
    day = sub[sub["period"] == "day"].sort_values("source", key=lambda s: s.eq("manual"))  # manual last -> wins
    for r in day.to_dict("records"):
        r = {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()}
        out[date.fromisoformat(r["date"])] = {"cases": _metric_value(r, meta["metric"]), "suspected": r["suspected"],
                                              "confirmed": r["confirmed"], "deaths": r["deaths"], "source": r["source"],
                                              "estimated": False}
    for r in sub[sub["period"] == "week"].to_dict("records"):
        r = {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()}
        v = _metric_value(r, meta["metric"])
        d0 = date.fromisoformat(r["date"])
        for i in range(7):
            d = d0 + timedelta(i)
            if d not in out:
                out[d] = {"cases": None if v is None else v / 7, "suspected": None, "confirmed": None, "deaths": None,
                          "source": "manual-week", "estimated": True}
    return out


def blocks(series: dict[date, dict], end: date, n: int = BASELINE_BLOCKS + 1) -> list[dict]:
    """Rolling 7-day blocks ending at `end`, newest first. A block needs >= 5 reported days; with 5-6 days the
    total is scaled to 7 days and flagged."""
    out = []
    for k in range(n):
        b_end = end - timedelta(days=BLOCK_DAYS * k)
        days = [b_end - timedelta(i) for i in range(BLOCK_DAYS)]
        vals = [series[d]["cases"] for d in days if d in series and series[d]["cases"] is not None]
        deaths = [series[d]["deaths"] for d in days if d in series and series[d].get("deaths") is not None]
        est = any(series[d]["estimated"] for d in days if d in series)
        if len(vals) >= 5:
            tot = sum(vals) * BLOCK_DAYS / len(vals)
        else:
            tot = None
        out.append({"start": days[-1].isoformat(), "end": b_end.isoformat(), "cases": tot, "days": len(vals),
                    "scaled": len(vals) < BLOCK_DAYS and tot is not None, "estimated": est,
                    "deaths": sum(deaths) if deaths else None})
    return out


def score(bl: list[dict], disease: str, region: str) -> dict:
    cur = bl[0]["cases"] if bl else None
    prev = bl[1]["cases"] if len(bl) > 1 else None
    base = [b["cases"] for b in bl[1:] if b["cases"] is not None]
    mean = float(np.mean(base)) if len(base) >= MIN_BASELINE else None
    sd = float(np.std(base, ddof=1)) if len(base) >= MIN_BASELINE else None
    z = None
    if cur is not None and mean is not None:
        z = (cur - mean) / max(sd or 0.0, math.sqrt(max(mean, 1.0)), 1.0)   # Poisson floor: small counts are noisy
    growth = math.log((cur + 1) / (prev + 1)) if cur is not None and prev is not None else None
    trend = None if growth is None else "rising" if growth > math.log(1.15) else "falling" if growth < -math.log(1.15) else "stable"
    min_c = DISEASE_META[disease]["min_cases"].get(region, 5)
    level = "insufficient"
    if cur is not None and mean is not None:
        enough = cur >= min_c
        if enough and z is not None and z >= 3:
            level = "high"
        elif enough and z is not None and (z >= 2 or (z >= 1 and growth is not None and growth >= math.log(1.5))):
            level = "elevated"
        elif enough and ((z is not None and z >= 1.5) or (growth is not None and growth >= math.log(1.3) and z is not None and z >= 0.5)):
            level = "watch"
        else:
            level = "normal"
    return {"last7": cur, "prev7": prev, "baseline_mean": mean, "baseline_sd": sd, "baseline_blocks": len(base),
            "z": z, "growth": growth, "growth_pct": (math.exp(growth) - 1) if growth is not None else None,
            "trend": trend, "level": level, "min_cases": min_c}


def disease_view(weeks: int = 12) -> dict:
    df = disease_frame()
    end = latest_report_date(df)
    reports = db.query("SELECT * FROM signals_disease_reports ORDER BY date DESC")
    log = fetch_log().get("dhs_idsp", {})
    t = today()
    needs = []
    for r in reports:
        d = date.fromisoformat(r["date"])
        has_manual = bool(len(df[(df["date"] == r["date"]) & (df["source"] == "manual")]))
        if r["status"] != "ok" and not has_manual and (t - d).days <= BACKFILL_DAYS:
            needs.append({"date": r["date"], "status": r["status"], "url": r["url"], "message": r["message"],
                          "pending": r["status"] == "missing" and (t - d).days <= 2,
                          "attempts": r["attempts"], "last_attempt": r["last_attempt"]})
    series = {}
    if end is not None:
        for region in REGIONS:
            series[region] = {}
            for dis in DISEASE_META:
                ds = daily_series(df, region, dis)
                if not ds:
                    continue
                bl = blocks(ds, end, max(weeks, BASELINE_BLOCKS + 1))
                sc = score(bl, dis, region)
                last = sorted(ds)[-1]
                series[region][dis] = {"disease": dis, "label": DISEASE_META[dis]["label"], "metric": DISEASE_META[dis]["metric"],
                                       "about": DISEASE_META[dis]["about"], **sc,
                                       "blocks": list(reversed(bl[:weeks])),
                                       "daily": [{"date": d.isoformat(), **{k: v for k, v in ds[d].items()}}
                                                 for d in sorted(ds) if d > end - timedelta(days=28)],
                                       "last_date": last.isoformat(),
                                       "sources": sorted({v["source"] for v in ds.values()})}
    ok = [r for r in reports if r["status"] == "ok"]
    manual = df[df["source"] == "manual"].sort_values("date", ascending=False).head(50)
    return {
        "as_of": end.isoformat() if end else None, "today": t.isoformat(), "regions": list(REGIONS),
        "region_names": DISTRICT_NAMES, "panel_diseases": PANEL_DISEASES, "series": series,
        "reports": {"ok": len(ok), "total": len(reports), "latest_ok": ok[0]["date"] if ok else None,
                    "needs_manual": [n for n in needs if not n["pending"]], "pending": [n for n in needs if n["pending"]]},
        "fetched_at": log.get("last_success"), "stale": _disease_stale(end, log), "error": log.get("message") if log.get("status") == "error" else None,
        "manual_entries": [{k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()} for r in manual.to_dict("records")],
        "method": {"block_days": BLOCK_DAYS, "baseline_blocks": BASELINE_BLOCKS, "min_baseline": MIN_BASELINE,
                   "z": "z = (last 7 days - mean of the previous 12 seven-day blocks) / max(sd, sqrt(mean), 1)",
                   "growth": "week-over-week growth = log((last 7 + 1) / (previous 7 + 1))",
                   "levels": {"high": "z >= 3", "elevated": "z >= 2, or z >= 1 with >= 50% weekly growth",
                              "watch": "z >= 1.5, or >= 30% weekly growth with z >= 0.5", "normal": "below these",
                              "insufficient": "fewer than 6 baseline weeks"},
                   "min_cases": "levels above normal also need a minimum weekly count, so tiny numbers do not trigger"},
    }


def _disease_stale(end: date | None, log: dict) -> bool:
    if end is None:
        return True
    return (today() - end).days > 3


# ── Rainfall vs demand evidence ──────────────────────────────────────────────────────────────
EVIDENCE_MIN_WEEKLY = 15     # category units/week needed for a stable log ratio
EVIDENCE_LAGS = (0, 1, 2, 3, 4)
BOOT_B = 1000
BLOCK_LEN = 4
FDR_Q = 0.10
_evidence_cache: dict = {}


def _ols_slope(x: np.ndarray, y: np.ndarray) -> float:
    xc = x - x.mean()
    den = (xc ** 2).sum()
    return float((xc * (y - y.mean())).sum() / den) if den > 0 else 0.0


def _block_boot(x: np.ndarray, y: np.ndarray, rng: np.random.Generator, B: int = BOOT_B, L: int = BLOCK_LEN) -> np.ndarray:
    n = len(x)
    nb = math.ceil(n / L)
    starts = rng.integers(0, n - L + 1, size=(B, nb))
    idx = (starts[:, :, None] + np.arange(L)[None, None, :]).reshape(B, -1)[:, :n]
    X, Y = x[idx], y[idx]
    Xc = X - X.mean(1, keepdims=True)
    Yc = Y - Y.mean(1, keepdims=True)
    den = (Xc ** 2).sum(1)
    return np.where(den > 0, (Xc * Yc).sum(1) / np.where(den > 0, den, 1), 0.0)


def _oos_gain(x: np.ndarray, y: np.ndarray, min_train: int = 26) -> float | None:
    """Rolling-origin out-of-sample: MAE of (intercept + slope * rain) vs intercept-only. >0 = rain helps."""
    if len(x) <= min_train + 4:
        return None
    e_r, e_b = [], []
    for t in range(min_train, len(x)):
        xt, yt = x[:t], y[:t]
        b = _ols_slope(xt, yt)
        a = yt.mean() - b * xt.mean()
        e_r.append(abs(y[t] - (a + b * x[t])))
        e_b.append(abs(y[t] - yt.mean()))
    mb = float(np.mean(e_b))
    return (1 - float(np.mean(e_r)) / mb) if mb > 0 else None


_evidence_lock = threading.Lock()
EVIDENCE_CACHE_FILE = "evidence_cache.json"
EVIDENCE_VERSION = 2


def evidence() -> dict:
    """Does lagged rainfall anomaly explain weekly demand beyond the model's seasonal index? Honest test.

    The result is memoised in memory and in data/external/evidence_cache.json (keyed by the rainfall weeks and
    the model build), so a restarted server does not recompute it on the request path. One computation at a time."""
    from backend.core import S
    daily, _ = observed_daily()
    clim = get_clim("nasa_power")
    wk = weekly_observed(daily, clim) if clim is not None else []
    import hashlib
    digest = hashlib.sha256(json.dumps([(w["week"], None if w.get("anomaly_z") is None else round(w["anomaly_z"], 6)) for w in wk])
                            .encode()).hexdigest()[:16]     # any revision of observed rain invalidates the result
    key = (EVIDENCE_VERSION, len(wk), wk[-1]["week"] if wk else None, digest, str(S.meta.get("generated_at")))
    if key in _evidence_cache:
        return _evidence_cache[key]
    if not wk:
        res = {"available": False, "reason": ("No observed rainfall with climatology yet. The analysis runs once NASA POWER "
                                              "history and its 1991-2020 climatology have been fetched (Refresh).")}
        return res
    with _evidence_lock:
        if key in _evidence_cache:          # computed by another thread while we waited
            return _evidence_cache[key]
        disk = _read_json(EVIDENCE_CACHE_FILE)
        if isinstance(disk, dict) and disk.get("key") == list(key) and isinstance(disk.get("result"), dict):
            _evidence_cache.clear()
            _evidence_cache[key] = disk["result"]
            return disk["result"]
        res = _compute_evidence(wk, S)
        _evidence_cache.clear()
        _evidence_cache[key] = res
        try:
            _write_json(EVIDENCE_CACHE_FILE, {"key": list(key), "computed_at": db.now_iso(), "result": res})
        except (OSError, TypeError, ValueError):
            pass
        return res


def _compute_evidence(wk: list[dict], S) -> dict:
    rain = pd.DataFrame(wk).set_index("week")
    m = S.meds
    h = S.hist.merge(m[["category", "base_level", "idx_Winter", "idx_Summer", "idx_Monsoon", "idx_Post-Monsoon"]],
                     left_on="medicine_id", right_index=True)
    smap = {w: C.season_of(w) for w in h["week"].unique()}
    h["season"] = h["week"].map(smap)
    h["expected"] = h["base_level"] * np.select([h["season"] == s for s in C.SEASON_ORDER],
                                                 [h[f"idx_{s}"] for s in C.SEASON_ORDER], 1.0)
    g = h.groupby(["category", "week"])[["units", "expected"]].sum().reset_index()
    tot = h.groupby("week")[["units", "expected"]].sum().reset_index().assign(category="All medicines")
    g = pd.concat([tot, g], ignore_index=True)
    vol = g.groupby("category")["units"].mean()
    cats = [c for c in vol.index if vol[c] >= EVIDENCE_MIN_WEEKLY]
    cats = ["All medicines"] + sorted([c for c in cats if c != "All medicines"], key=lambda c: -vol[c])
    rng = np.random.default_rng(42)
    tests = []
    for cat in cats:
        sub = g[g["category"] == cat].set_index("week").sort_index()
        y_all = np.log((sub["units"] + 0.5) / (sub["expected"] + 0.5))
        for L in EVIDENCE_LAGS:
            col = "anomaly_z" if L == 0 else f"anom_z_lag{L}"
            x_all = rain[col].reindex(sub.index)
            ok = x_all.notna() & y_all.notna()
            x, y = x_all[ok].to_numpy(dtype=float), y_all[ok].to_numpy(dtype=float)
            if len(x) < 30:
                continue
            b = _ols_slope(x, y)
            bs = _block_boot(x, y, rng)
            lo, hi = np.percentile(bs, [2.5, 97.5])
            p = float(min(1.0, 2 * min((bs <= 0).mean(), (bs >= 0).mean())))
            p = max(p, 1 / BOOT_B)
            r = float(np.corrcoef(x, y)[0, 1]) if x.std() > 0 and y.std() > 0 else 0.0
            tests.append({"category": cat, "lag_weeks": L, "n_weeks": int(len(x)), "slope": b, "ci_lo": float(lo), "ci_hi": float(hi),
                          "p": p, "r2": r * r, "effect_per_sd_pct": math.exp(b) - 1,
                          "effect_ci_pct": [math.exp(lo) - 1, math.exp(hi) - 1], "oos_gain": _oos_gain(x, y),
                          "mean_units": float(vol[cat])})
    # Benjamini-Hochberg across every (category, lag) test
    if tests:
        ps = np.array([t["p"] for t in tests])
        order = np.argsort(ps)
        mtests = len(ps)
        q = np.empty(mtests)
        prev = 1.0
        for rank in range(mtests, 0, -1):
            i = order[rank - 1]
            prev = min(prev, ps[i] * mtests / rank)
            q[i] = prev
        for t, qq in zip(tests, q):
            t["q"] = float(qq)
            t["supported"] = bool(qq <= FDR_Q and (t["ci_lo"] > 0 or t["ci_hi"] < 0) and (t["oos_gain"] or 0) > 0)
    best = {}
    for t in tests:
        c = t["category"]
        if c not in best or t["p"] < best[c]["p"]:
            best[c] = t
    supported = [t for t in tests if t["supported"]]
    rows = [best[c] for c in cats if c in best]
    n_sig_raw = sum(1 for t in tests if t["p"] < 0.05)
    expected_false = 0.05 * len(tests)
    if supported:
        verdict = "partial"
        headline = (f"Rainfall adds a small, statistically supported signal for {len(supported)} category-lag pair(s) "
                    f"after correcting for {len(tests)} tests. The forecast is not changed automatically: the effects are "
                    "listed for review and can be explored in Scenario Lab.")
    else:
        verdict = "none"
        headline = ("Weather does not add predictive power beyond the seasonal index on this shop's data. "
                    "It is shown as context and drives rule-based watches only; no forecast adjustment is applied.")
    weeks_used = sorted(set(S.hist["week"]) & set(rain.index))
    res = {
        "available": True, "verdict": verdict, "headline": headline,
        "n_tests": len(tests), "n_raw_p05": n_sig_raw, "expected_false_positives": expected_false,
        "fdr_q": FDR_Q, "lags": list(EVIDENCE_LAGS),
        "period": {"start": weeks_used[0] if weeks_used else None, "end": weeks_used[-1] if weeks_used else None, "weeks": len(weeks_used)},
        "rows": rows, "supported": supported, "tests": tests,
        "adjustments_applied": False,
        "adjustments": [{"category": t["category"], "lag_weeks": t["lag_weeks"], "effect_per_sd_pct": t["effect_per_sd_pct"],
                         "effect_ci_pct": t["effect_ci_pct"]} for t in supported],
        "method": [
            "Outcome: log((actual units + 0.5) / (seasonal expectation + 0.5)) per category and week, where the seasonal expectation is "
            "each medicine's base level x its season index (the same index the forecast model uses).",
            "Predictor: weekly rainfall anomaly at Kochi (NASA POWER), as a z-score of log rain against 1991-2020 weeks around the same date, "
            "lagged 0-4 weeks.",
            f"Slope 95% CI from a moving-block bootstrap (blocks of {BLOCK_LEN} weeks, {BOOT_B} resamples), p-values adjusted with "
            f"Benjamini-Hochberg across all tests (q <= {FDR_Q}).",
            "Out-of-sample check: rolling-origin forecasts of the ratio with and without rain from week 26 on; 'gain' is the reduction in mean absolute error.",
            "A relationship counts as supported only when it survives the FDR correction, its CI excludes zero and it improves out-of-sample error.",
        ],
        "caveats": [
            "The sales history is synthetic (generated with month-based seasonality, per the dataset's Read Me), so little real weather signal is expected.",
            f"About one year of weekly data ({len(weeks_used)} weeks) per category: small effects cannot be detected reliably.",
            "Season indices were estimated on the same history, so the residuals are in-sample and slightly too smooth.",
        ],
    }
    return res


# ── Refresh orchestration ────────────────────────────────────────────────────────────────────
_state_lock = threading.Lock()
_run_lock = threading.Lock()
STATE: dict[str, Any] = {"running": False, "started_at": None, "finished_at": None, "trigger": None, "results": {},
                         "progress": None, "error": None}


def _due(source: str, log: dict, force: bool) -> bool:
    if force:
        return True
    r = log.get(source) or {}
    ok_age = _age_hours(r.get("last_success"))
    try_age = _age_hours(r.get("last_attempt"))
    if try_age is not None and try_age < 1 and (ok_age is None or ok_age > DUE_HOURS[source]):
        return False                    # failed less than an hour ago: back off
    return ok_age is None or ok_age > DUE_HOURS[source]


def refresh_all(parts: Iterable[str] = ("weather", "disease"), force: bool = False, trigger: str = "manual",
                db_file: str | None = None) -> dict:
    """Blocking refresh (call from a background thread). Each source fails independently.
    db_file pins the database: the run stops as soon as MEDFORECAST_DB points elsewhere."""
    if not _run_lock.acquire(blocking=False):
        return {"skipped": "a refresh is already running"}
    _pinned.path = db_file or str(db.db_path())
    parts = set(parts)
    results: dict[str, Any] = {}
    with _state_lock:
        STATE.update(running=True, started_at=db.now_iso(), finished_at=None, trigger=trigger, results={}, error=None)

    def progress(msg):
        _check_db()
        with _state_lock:
            STATE["progress"] = msg

    def put(name, value):
        results[name] = value
        with _state_lock:
            STATE["results"] = {**STATE.get("results", {}), name: value}
    try:
        _check_db()
        lic = license_info()
        log = fetch_log()
        jobs = []
        if "weather" in parts:
            jobs += [("nasa_clim", fetch_nasa_climatology, not (cache_dir() / "nasa_power_climatology.json").exists()),
                     ("nasa_obs", fetch_nasa_observed, None)]
            if lic["open_meteo_enabled"]:
                jobs += [("era5_clim", fetch_era5_climatology, not (cache_dir() / "era5_climatology.json").exists()),
                         ("om_forecast", fetch_om_forecast, None), ("om_seasonal", fetch_om_seasonal, None)]
        for name, fn, missing in jobs:
            due = (missing or force) if missing is not None else _due(name, log, force)
            if not due:
                put(name, "fresh")
                continue
            progress(f"Fetching {name}")
            try:
                n = fn()
                _check_db()
                _log(name, True, f"{n} rows", n)
                put(name, "ok")
            except _DbMoved:
                raise
            except Exception as e:  # never let one source break the others
                _check_db()
                _log(name, False, f"{type(e).__name__}: {e}" if not isinstance(e, FetchError) else str(e))
                put(name, f"error: {e}")
        if "disease" in parts:
            progress("Fetching DHS Kerala reports")
            try:
                put("dhs_idsp", refresh_disease(force=force, progress=progress))
            except _DbMoved:
                raise
            except Exception as e:
                _check_db()
                _log("dhs_idsp", False, f"{type(e).__name__}: {e}")
                put("dhs_idsp", f"error: {e}")
        _evidence_cache.clear()
        if "weather" in parts:
            progress("Updating the rainfall evidence analysis")
            try:
                evidence()          # recompute off the request path when new rainfall weeks arrived
            except Exception:
                pass
    except Exception as e:
        with _state_lock:
            STATE["error"] = f"{type(e).__name__}: {e}"
    finally:
        _pinned.path = None
        with _state_lock:
            STATE.update(running=False, finished_at=db.now_iso(), progress=None)
        _run_lock.release()
    return results


def trigger_refresh(parts: Iterable[str] = ("weather", "disease"), force: bool = False, trigger: str = "manual") -> bool:
    """Start refresh_all in a daemon thread. False if one is already running."""
    if _run_lock.locked():
        return False
    threading.Thread(target=refresh_all, args=(tuple(parts), force, trigger, str(db.db_path())),
                     name="signals-refresh", daemon=True).start()
    return True


def state() -> dict:
    with _state_lock:
        s = dict(STATE)
        s["results"] = json.loads(json.dumps(s.get("results") or {}, default=str))   # snapshot, never a live dict
        return s


_scheduler_started = False


def autofetch_enabled() -> bool:
    return os.environ.get("MEDFORECAST_SIGNALS_AUTOFETCH", "1").strip() != "0"


def start_scheduler(initial_delay: float = 15.0, interval_h: float | None = None) -> bool:
    """Daemon loop: refresh what is due (weather daily, DHS reports daily). Disabled by MEDFORECAST_SIGNALS_AUTOFETCH=0."""
    global _scheduler_started
    if _scheduler_started or not autofetch_enabled():
        return False
    _scheduler_started = True
    every = interval_h or float(os.environ.get("MEDFORECAST_SIGNALS_CHECK_HOURS", "3") or 3)

    def loop():
        time.sleep(initial_delay)
        while True:
            if autofetch_enabled():
                try:
                    refresh_all(trigger="scheduler")
                except Exception:
                    pass
            time.sleep(max(0.25, every) * 3600)
    threading.Thread(target=loop, name="signals-scheduler", daemon=True).start()
    return True
