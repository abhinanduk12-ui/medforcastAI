"""Deterministic demo data: stores, users and opening stock batches.

    python -m backend.seed            # seed only if the database has no stores yet
    python -m backend.seed --reset    # wipe ALL rows (every table except schema_migrations/settings) and re-seed

What it creates (numpy seed 42; expiry dates are relative to the day you run it):
* Stores  KOCHI "Kochi – Main" (Ernakulam, demand_scale 1.0, the real shop the sales data comes from),
          TSR "Thrissur branch" (0.70) and KZD "Kozhikode branch" (0.55). Branches are SIMULATED by
          scaling the main shop's forecast; the data has only one real shop.
* Users   owner / Owner@2026 (owner, all stores), pharmacist.kochi / Pharma@2026 (KOCHI),
          pharmacist.tsr / Pharma@2026 (TSR), buyer / Buyer@2026 (buyer, all stores).
* Opening stock for every store x medicine:
    target = order-up-to level from plan_rows(lead 1, review 2, service 95 %) x demand_scale
    actual = round(target x f), f = lognormal(-0.05, 0.55) clipped to [0.2, 2.2] (some short, some overstocked)
    ~6 % of store-medicine pairs get no stock at all (stockouts)
  split into 1-3 batches. Remaining shelf life is drawn from the empirical distribution of
  (expiry_date - sale_date) in the sales file for that medicine, less a 0-60 day shelf age, except
  ~1 % already expired, ~4 % expiring within 30 days and ~8 % within 31-90 days (demo cases).
  unit_cost = median selling price x 0.8 (assumed 20 % margin; the data has no purchase prices).
  Every batch gets a matching 'receive' movement (ref OPENING) so the ledger reconciles.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone

import numpy as np

from backend import db
from backend.auth import hash_password

SEED = 42
STORES = [  # id, name, city, demand_scale, is_main
    ("KOCHI", "Kochi – Main", "Ernakulam", 1.0, 1),
    ("TSR", "Thrissur branch", "Thrissur", 0.70, 0),
    ("KZD", "Kozhikode branch", "Kozhikode", 0.55, 0),
]
DEMO_USERS = [  # username, password, role, store_id, full_name
    ("owner", "Owner@2026", "owner", None, "Joseph Mathew"),
    ("pharmacist.kochi", "Pharma@2026", "pharmacist", "KOCHI", "Anjali Menon"),
    ("pharmacist.tsr", "Pharma@2026", "pharmacist", "TSR", "Rahul Varma"),
    ("buyer", "Buyer@2026", "buyer", None, "Fathima Rasheed"),
]
P_ZERO = 0.06                      # store-medicine pairs with no stock
P_EXPIRED, P_30, P_90 = 0.01, 0.04, 0.08
COST_FACTOR = 0.8


def _wipe() -> None:
    con = db.connect()
    tables = [r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table' "
                                          "AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'settings')")]
    con.execute("PRAGMA foreign_keys = OFF")
    try:
        with db.tx():
            for t in tables:
                db.execute(f'DELETE FROM "{t}"')
    finally:
        con.execute("PRAGMA foreign_keys = ON")


def seed(reset: bool = False, verbose: bool = True) -> dict:
    """Seed the current database (db.db_path()). Returns a summary dict. No-op if stores exist and not reset."""
    from backend.core import S, get_sales, plan_rows

    db.init_db()
    if reset:
        _wipe()
    elif db.scalar("SELECT COUNT(*) FROM stores", default=0):
        if verbose:
            print(f"{db.db_path()} already has data - use --reset to rebuild it.")
        return summary()

    rng = np.random.default_rng(SEED)
    today = date.today()
    now = db.now_iso()

    sales = get_sales()
    life = (sales["expiry_date"] - sales["sale_date"]).dt.days
    life_by_med = {m: v.to_numpy() for m, v in life.groupby(sales["medicine_id"])}
    life_all = life.to_numpy()
    supplier = sales.groupby("medicine_id")["supplier_id"].agg(lambda x: x.mode().iloc[0]).to_dict()

    plan = plan_rows(1, 2, 0.95, S.meds)
    meds = sorted(S.meds.index)
    used_batch_nos: dict[str, set] = {m: set() for m in meds}

    def batch_no(mid: str) -> str:
        while True:
            b = f"BTH{int(rng.integers(1000, 10000))}"
            if b not in used_batch_nos[mid]:
                used_batch_nos[mid].add(b)
                return b

    def days_left(mid: str) -> int:
        u = rng.random()
        if u < P_EXPIRED:
            return -int(rng.integers(0, 46))
        if u < P_EXPIRED + P_30:
            return int(rng.integers(1, 31))
        if u < P_EXPIRED + P_30 + P_90:
            return int(rng.integers(31, 91))
        pool = life_by_med.get(mid)
        pool = pool if pool is not None and len(pool) >= 5 else life_all
        return max(91, int(rng.choice(pool)) - int(rng.integers(0, 61)))

    batch_rows, n_zero = [], 0
    with db.tx():
        for sid, name, city, scale, is_main in STORES:
            db.execute("INSERT INTO stores(id, name, city, demand_scale, is_main, created_at) VALUES (?,?,?,?,?,?)",
                       (sid, name, city, scale, is_main, now))
        for username, pw, role, store, full in DEMO_USERS:
            db.execute("INSERT INTO users(username, full_name, role, store_id, password_hash, active, created_at) "
                       "VALUES (?,?,?,?,?,1,?)", (username, full, role, store, hash_password(pw), now))

        for sid, _, _, scale, is_main in STORES:
            for mid in meds:
                target = float(plan.at[mid, "order_up_to"]) * scale
                f = float(np.clip(np.exp(rng.normal(-0.05, 0.55)), 0.2, 2.2))
                zero = rng.random() < P_ZERO
                if zero or target <= 0:
                    n_zero += 1
                    continue
                qty = max(1, int(round(target * f)))
                n = 1 if qty < 4 else int(rng.choice([1, 2, 3], p=[0.35, 0.40, 0.25]))
                n = min(n, qty)
                w = rng.dirichlet(np.ones(n) * 2.0)
                parts = np.maximum(1, np.floor(w * qty).astype(int))
                parts[-1] += qty - parts.sum()
                if parts[-1] < 1:  # rounding pushed the last part to 0: rebalance from the largest
                    j = int(np.argmax(parts[:-1]))
                    need = 1 - parts[-1]
                    parts[j] -= need
                    parts[-1] = 1
                cost = round(float(S.meds.at[mid, "median_price"]) * COST_FACTOR, 2)
                for q in parts:
                    dl = days_left(mid)
                    rec = today - timedelta(days=int(rng.integers(3, 121)))
                    batch_rows.append((sid, mid, batch_no(mid), (today + timedelta(days=dl)).isoformat(), int(q), cost,
                                       supplier.get(mid),
                                       datetime.combine(rec, time(9, 0), tzinfo=timezone.utc).isoformat(timespec="seconds"),
                                       bool(is_main)))
        for (sid, mid, bno, exp, q, cost, sup, rec, is_main) in batch_rows:
            bid = db.execute("INSERT INTO batches(store_id, medicine_id, batch_no, expiry_date, qty_received, qty_on_hand, "
                             "unit_cost, supplier_id, received_at, source) VALUES (?,?,?,?,?,?,?,?,?,'opening')",
                             (sid, mid, bno, exp, q, q, cost, sup, rec)).lastrowid
            db.execute("INSERT INTO movements(store_id, medicine_id, batch_id, kind, qty, unit_cost, ref, note, user_id, created_at) "
                       "VALUES (?,?,?,'receive',?,?,'OPENING',?,NULL,?)",
                       (sid, mid, bid, q, cost, "Opening stock" + ("" if is_main else " (simulated branch)"), rec))
        db.set_setting("seed", {"seeded_at": now, "seed": SEED, "as_of": today.isoformat(), "zero_pairs": n_zero,
                                "cost_factor": COST_FACTOR})
    out = summary()
    if verbose:
        _print(out)
    return out


def summary() -> dict:
    today = date.today().isoformat()
    in30 = (date.today() + timedelta(days=30)).isoformat()
    in90 = (date.today() + timedelta(days=90)).isoformat()
    stores = db.query(
        "SELECT s.id, s.name, s.demand_scale, s.is_main, "
        " (SELECT COUNT(*) FROM batches b WHERE b.store_id = s.id AND b.qty_on_hand > 0) AS batches, "
        " (SELECT COALESCE(SUM(qty_on_hand), 0) FROM batches b WHERE b.store_id = s.id) AS units, "
        " (SELECT COALESCE(SUM(qty_on_hand * unit_cost), 0) FROM batches b WHERE b.store_id = s.id) AS value, "
        " (SELECT COUNT(DISTINCT medicine_id) FROM batches b WHERE b.store_id = s.id AND b.qty_on_hand > 0) AS medicines "
        "FROM stores s ORDER BY s.is_main DESC, s.demand_scale DESC")
    nb = db.scalar("SELECT COUNT(*) FROM batches WHERE qty_on_hand > 0", default=0)
    return {
        "db": str(db.db_path()),
        "stores": stores,
        "users": db.query("SELECT username, role, store_id FROM users ORDER BY id"),
        "batches": nb,
        "expired": db.scalar("SELECT COUNT(*) FROM batches WHERE qty_on_hand > 0 AND expiry_date <= ?", (today,), default=0),
        "within_30d": db.scalar("SELECT COUNT(*) FROM batches WHERE qty_on_hand > 0 AND expiry_date > ? AND expiry_date <= ?",
                                (today, in30), default=0),
        "within_31_90d": db.scalar("SELECT COUNT(*) FROM batches WHERE qty_on_hand > 0 AND expiry_date > ? AND expiry_date <= ?",
                                   (in30, in90), default=0),
        "movements": db.scalar("SELECT COUNT(*) FROM movements", default=0),
    }


def _print(s: dict) -> None:
    import sys
    try:
        sys.stdout.reconfigure(errors="replace")  # store names contain an en dash; never crash a cp1252 console
    except (AttributeError, ValueError):
        pass
    print(f"Seeded {s['db']}")
    for st in s["stores"]:
        tag = "main" if st["is_main"] else "simulated"
        print(f"  {st['id']:<6} {st['name']:<18} x{st['demand_scale']:.2f} ({tag})  {st['medicines']:>3} medicines in stock, "
              f"{st['batches']:>4} batches, {st['units']:>6} units, cost value Rs {st['value']:,.0f}")
    nb = max(s["batches"], 1)
    print(f"  batches with stock: {s['batches']}  | expired {s['expired']} ({s['expired'] / nb:.1%}), "
          f"<=30d {s['within_30d']} ({s['within_30d'] / nb:.1%}), 31-90d {s['within_31_90d']} ({s['within_31_90d'] / nb:.1%})")
    print(f"  movements: {s['movements']}")
    print("  users: " + ", ".join(f"{u['username']} ({u['role']}{'/' + u['store_id'] if u['store_id'] else ''})" for u in s["users"]))
    print("  demo passwords: owner/Owner@2026, pharmacist.kochi|pharmacist.tsr/Pharma@2026, buyer/Buyer@2026")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Seed MedForecast demo stores, users and stock")
    ap.add_argument("--reset", action="store_true", help="wipe all rows first (keeps schema & settings)")
    a = ap.parse_args()
    seed(reset=a.reset)
