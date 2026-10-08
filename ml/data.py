"""Load, validate and reshape raw transactions into a dense weekly medicine panel."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config as C


def load_raw() -> tuple[pd.DataFrame, pd.DataFrame]:
    sales = pd.read_excel(C.RAW_XLSX, sheet_name="Sales Data")
    master = pd.read_excel(C.RAW_XLSX, sheet_name="Medicine Master")

    sales["sale_date"] = pd.to_datetime(sales["sale_date"])
    sales["hour"] = pd.to_datetime(sales["sale_time"], format="%H:%M:%S").dt.hour
    sales = sales.drop_duplicates("transaction_id")
    sales = sales[(sales["quantity_sold"] > 0) & (sales["unit_price"] > 0)]

    # Per-medicine static attributes, enriched from transactions.
    rx = sales.groupby("medicine_id")["prescription_type"].apply(lambda s: (s == "Rx").mean())
    price = sales.groupby("medicine_id")["unit_price"].median()
    master = master.set_index("medicine_id")
    master["rx_share"] = rx.reindex(master.index).fillna(0.5)
    master["median_price"] = price.reindex(master.index).fillna(master["reference_unit_price"])
    master = master.reset_index()
    return sales, master


def weekly_panel(sales: pd.DataFrame, master: pd.DataFrame) -> tuple[pd.DataFrame, pd.DatetimeIndex]:
    """Dense (medicine x week) panel of units sold, zeros filled. Only full 7-day weeks kept."""
    s = sales.copy()
    s["week"] = (s["sale_date"].dt.normalize() - pd.to_timedelta(s["sale_date"].dt.weekday, unit="D")).astype("datetime64[ns]")
    first_full = s["sale_date"].min().normalize()
    first_full = first_full + pd.Timedelta(days=(7 - first_full.weekday()) % 7)
    last_full = s["sale_date"].max().normalize()
    last_full = last_full - pd.Timedelta(days=(last_full.weekday() + 1) % 7)  # last Sunday
    weeks = pd.date_range(first_full, last_full - pd.Timedelta(days=6), freq="7D").astype("datetime64[ns]")

    agg = (s[s["week"].isin(weeks)]
           .groupby(["medicine_id", "week"])
           .agg(units=("quantity_sold", "sum"), revenue=("total_amount", "sum"), tx=("transaction_id", "size")))
    idx = pd.MultiIndex.from_product([master["medicine_id"], weeks], names=["medicine_id", "week"])
    panel = agg.reindex(idx, fill_value=0).reset_index()
    panel = panel.merge(master[["medicine_id", "medicine_name", "category", "form"]], on="medicine_id")
    panel["t"] = panel["week"].map({w: i for i, w in enumerate(weeks)})
    panel["season"] = panel["week"].map(lambda w: C.season_of(w + pd.Timedelta(days=3)))
    return panel, weeks


def calendar_frame(weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """Known-in-advance calendar covariates for any list of week starts."""
    rows = []
    for w in weeks:
        mid = w + pd.Timedelta(days=3)
        fest = C.festival_days(w)
        woy = mid.isocalendar().week
        rows.append({
            "week": w,
            "month": mid.month,
            "season": C.season_of(mid),
            "woy_sin": np.sin(2 * np.pi * woy / 52.18),
            "woy_cos": np.cos(2 * np.pi * woy / 52.18),
            "fest_onam": fest["Onam"] / 7,
            "fest_vishu": fest["Vishu"] / 7,
            "fest_xmas": fest["Christmas/New Year"] / 7,
            "fest_any": min(1.0, sum(fest.values()) / 7),
        })
    return pd.DataFrame(rows)
