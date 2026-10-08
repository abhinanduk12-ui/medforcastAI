# MedForecast AI: seasonal medicine demand forecasting

Forecasts weekly demand for every medicine in a Kerala retail pharmacy. It measures how each
season (Winter, Summer, Monsoon, Post-Monsoon) and festival (Onam, Vishu, Christmas) changes demand,
and turns the forecast into an order-up-to stock plan.

```
data/raw/pharma_dataset.xlsx   32,000 sales lines · 424 medicines · Aug 2025 – Aug 2026
ml/                            ML + DL pipeline (python -m ml.train)
ml/artifacts/                  trained outputs: forecasts, seasonal indices, metrics
backend/app.py                 FastAPI service (port 8000)
frontend/                      Next.js 16 + Tailwind 4 + Recharts web app (port 3000)
```

## Quick start (Windows)

```powershell
pip install -r requirements.txt
python -m ml.train                 # ~1 min on an NVIDIA GPU, 6-12 min on CPU; writes ml/artifacts/
cd frontend; npm install; cd ..
.\start.ps1                        # starts API (8000) and web app (3000)
```

Open http://localhost:3000.

## What's in the app

Sign in at http://localhost:3000 (start everything with `.\start.ps1`; use `.\start.ps1 -NoAuth` to skip sign-in during development).

| User | Password | Access |
|---|---|---|
| owner | Owner@2026 | everything, all branches, user admin |
| buyer | Buyer@2026 | purchasing, receiving and transfers, all branches |
| pharmacist.kochi | Pharma@2026 | sales and stock, Kochi only |
| pharmacist.tsr | Pharma@2026 | sales and stock, Thrissur only |

Change these passwords (Admin → Users) before real use.

- **Insights:** overview, morning brief (dashboard / email / WhatsApp, scheduled), alerts (FDR-controlled anomalies, season transitions, expiry and stock-out), seasonal impact, medicines (forecast, SHAP "why this forecast", stock and substitutes).
- **Operations:**
  - point of sale (barcode, GST, FEFO, returns, offline queue)
  - stock & expiry ledger
  - generic substitutes with safety tiers
  - branches & expiry-aware transfers
  - suppliers, purchase orders & learned lead times
  - slow stock & return-to-vendor optimiser
  - DPDP-consented refill reminders
  - compliance (Schedule H1/X/NDPS registers, DPCO/NPPA ceilings, margins)
- **Plan:** stock planner (on-hand, learned lead times, refill floor), budget-constrained purchase optimiser, 12-month year planner, scenario lab.
- **Intelligence:**
  - Copilot: grounded tool use; Claude when `ANTHROPIC_API_KEY` is set, a local engine otherwise.
  - Early warning: NASA POWER / Open-Meteo rainfall, DHS Kerala disease reports.
  - Model lab.
  - Data & models: upload, retrain on GPU, champion/challenger registry.
- Installable PWA with an offline fallback, Ctrl+K command palette, and role-based access enforced server-side.

The Thrissur and Kozhikode branches are simulated from the Kochi sales history (demand x scale) until real branch data is loaded.

## How it works

1. **Weekly panel.** Per-medicine daily sales are very sparse (the median medicine sells about 0.1 times a day),
   so the system forecasts weekly units: 424 medicines × 56 full weeks.
2. **Seasonal indices** (`ml/seasonality.py`). A seasonal index is season-average demand divided by a typical week,
   shown as an uplift % (+30 % means 30 % more demand).
   - Category indices are shrunk toward "no effect" according to the number of weeks and transactions behind them.
     A 90 % bootstrap CI marks which effects are statistically significant.
   - Medicine indices use normal-normal empirical Bayes. A medicine's deviation from its category is
     kept in proportion to τ² / (τ² + se²). Here se² comes from the medicine's week-to-week volatility,
     and τ² is estimated per season by method of moments. Noisy, lumpy items fall back to the category effect.
   - Festival effects compare festival weeks with other weeks of the same season. Only effects with z ≥ 3 are shown (a Bonferroni-style correction for about 90 tests).
3. **Features** (`ml/features.py`). Direct multi-horizon design: one row per (medicine, origin week, horizon 1–12).
   Features include lags, moving averages, an EMA, volatility, intermittency, item/category/store momentum,
   the season-adjusted run-rate, the target-season index, week-of-year, festivals, price, Rx share, category and form.
   All seasonal features are computed **point-in-time**, using data up to the origin week only.
4. **Models**
   - *XGBoost, Poisson objective*: one global model for all medicines and horizons.
   - *Deep SeasonalGRU* (PyTorch): a 2-layer GRU over 16 weeks of history, plus medicine, category and form
     embeddings and known-future season and festival inputs. Poisson NLL loss.
   - *Seasonal baseline*: season-adjusted run-rate × target-season index.
   - *Ensemble*: convex weights from a grid search, shrunk 50 % toward equal weights.
5. **Uncertainty.** Conformal-style 90 % intervals from variance-normalised out-of-sample residuals,
   calibrated per horizon group.
6. **Stock planner.** Order-up-to level = forecast over (lead time + review period) + z·σ.
   - Very slow movers (under 0.5 units a week) switch to an "on demand" policy based on an exact Poisson quantile.
   - Every medicine is tagged with an ABC class (by revenue) and a Syntetos-Boylan demand class.

## Evaluation (rolling origin, no leakage)

| Fold | Train until | Forecast | Used for |
|---|---|---|---|
| A | 9 Mar 2026 | Mar – May 2026 | ensemble weights, DL epochs, boosting rounds, interval calibration |
| B | 1 Jun 2026 | **Jun – Aug 2026 (monsoon)** | reported holdout metrics; nothing is tuned on it |
| Final | 24 Aug 2026 | next 12 weeks | production forecast |

Holdout results (WAPE, lower is better):

| | Item-week | Seasonal categories, category-week | 90 % interval coverage |
|---|---|---|---|
| 8-week moving average | 68.3 % | 30.6 % | – |
| **MedForecast ensemble** | **66.8 %** | **19.9 %** (35 % less error) | **90 %** |

Item-week error has a hard noise floor. An oracle that knew each medicine's true mean demand for the
holdout still scores 59.9 %, because single-medicine weekly sales are mostly Poisson noise. The seasonal
models earn their keep at the level a buyer plans at: category-week, where the monsoon surge is predictable.

## GPU training

Training uses an NVIDIA GPU automatically when one is available (`ml/device.py`):

| | CPU | GPU (RTX 4050 Laptop) |
|---|---|---|
| Full pipeline (`python -m ml.train`) | ~12 min | **~66 s** |
| Deep SeasonalGRU, one fold | 121 s | 8 s |
| XGBoost, one fold | 3.7 s | 2.3 s |

Holdout accuracy is unchanged (ensemble WAPE 0.668 on both). GPU runs are reproducible run to run, but not bit-identical to CPU runs.
- Requirements: an NVIDIA driver, the CUDA build of PyTorch (`pip install torch --index-url https://download.pytorch.org/whl/cu130`), and XGBoost ≥ 2 (its Windows wheel includes CUDA).
- Choosing the device: `MEDFORECAST_DEVICE=auto` (default) picks the GPU only after a real CUDA probe succeeds and otherwise falls back to the CPU. Set `cpu` to force the CPU, or `cuda` to fail loudly when no GPU is usable.

## Data caveat

The workbook's own *Read Me* sheet says the sales are **synthetic**. They are generated with Kerala-specific seasonal
rules for practice and demos. The pipeline does not assume this: retrain on real POS exports with the same columns
(`transaction_id, sale_date, sale_time, medicine_id, medicine_name, generic_name, category, quantity_sold, unit_price,
total_amount, …` plus the *Medicine Master* sheet). Seasonal indices get much sharper with 2+ years of history.

## Environment note

On this machine, Windows Smart App Control blocks some compiled scikit-learn and LightGBM modules, so the pipeline
uses XGBoost + PyTorch + NumPy and has no scikit-learn dependency.
