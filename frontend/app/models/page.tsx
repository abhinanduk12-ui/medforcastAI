"use client";

import { ArrowRight, Info } from "lucide-react";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { BarList, C, MultiLine } from "@/components/charts";
import { Card, CardHeader, ErrorState, Legend, PageHeader, PageSkeleton, StatTile } from "@/components/ui";
import { GlobalDrivers } from "@/components/explain/GlobalDrivers";

type Sum = { wape: number; mae: number; rmse: number; bias: number; accuracy: number; skill_vs_ma8: number; label: string };
type Eval = {
  overall: Record<string, Sum>; by_horizon: Record<string, number>[];
  by_category: { category: string; units: number; wape_item: number; wape_category: number }[];
  aggregate: Record<string, Record<string, number>>; coverage_90: number; noise_floor_wape: number; direction_accuracy: number;
  seasonal_categories: { categories: string[]; share_of_units: number; item_week: Record<string, number>; category_week: Record<string, number> };
};
type Models = {
  protocol: { fold_a: { train_until: string; test: string[] }; fold_b: { train_until: string; test: string[] }; final: { train_until: string }; horizon_weeks: number; rows_per_fold: number };
  labels: Record<string, string>; weights: Record<string, number>; production_weights: Record<string, number>;
  dl_epochs: number; gbm_rounds: number; dl_history: { epoch: number; train_poisson_nll: number; val_wape?: number }[];
  holdout: Eval; validation: Eval; training_seconds: number;
  importance: { feature: string; importance: number }[];
  holdout_series: Record<string, number | string>[];
};

const KEYS = ["ensemble", "gbm", "deep", "snaive", "ma8"] as const;
const COLORS: Record<string, string> = { actual: C.ink, ensemble: C.s2, gbm: C.s1, deep: C.s7, snaive: C.s3, ma8: "#a3a29b" };

const FEATURE_NAMES: Record<string, string> = {
  hist_mean: "Long-run average demand", category_code: "Therapeutic category", ma_12: "12-week moving average", ma_8: "8-week moving average",
  ma_4: "4-week moving average", rx_share: "Prescription share", woy_cos: "Week of year (cos)", woy_sin: "Week of year (sin)",
  deseason_level: "Season-adjusted run-rate", target_med_season_idx: "Target-season index (medicine)", target_cat_season_idx: "Target-season index (category)",
  nz_8: "Sales frequency (8 wk)", log_price: "Unit price", seasonal_naive: "Seasonal baseline", season_shift: "Season shift ratio",
  ema: "Exponential average", std_8: "Volatility (8 wk)", lag_1: "Last week", lag_2: "2 weeks ago", lag_3: "3 weeks ago", lag_4: "4 weeks ago",
  momentum: "Item momentum", cat_momentum: "Category momentum", store_momentum: "Store momentum", recent_season_idx: "Recent season index",
  weeks_since_sale: "Weeks since last sale", h: "Forecast horizon", form_code: "Dosage form", season_code: "Target season", month: "Target month",
  fest_onam: "Onam festival", fest_vishu: "Vishu festival", fest_xmas: "Christmas / New Year",
};

const PIPE = [
  { t: "32k bills", d: "Clean & validate" },
  { t: "Weekly panel", d: "424 medicines × 56 weeks" },
  { t: "Seasonal indices", d: "Empirical-Bayes, point-in-time" },
  { t: "Features", d: "Lags, momentum, calendar, festivals" },
  { t: "3 models", d: "XGBoost · GRU · seasonal baseline" },
  { t: "Ensemble", d: "Shrunk convex weights" },
  { t: "Conformal range", d: "Calibrated 90% interval" },
];

export default function ModelsPage() {
  const { data, error } = useApi<Models>("/api/models");
  if (error) return <ErrorState error={error} />;
  if (!data) return <PageSkeleton />;
  const h = data.holdout;
  const ens = h.overall.ensemble, ma = h.overall.ma8;
  const sc = h.seasonal_categories;
  const seasonalGain = 1 - sc.category_week.ensemble / sc.category_week.ma8;

  return (
    <>
      <PageHeader eyebrow="Model lab" title="How the forecasts are made and how well they work">
        Every number here is measured on an untouched holdout: the models were trained on data up to {fmt.weekYear(data.protocol.fold_b.train_until)} and
        then asked to forecast the 2026 monsoon ({fmt.week(data.protocol.fold_b.test[0])} – {fmt.weekYear(data.protocol.fold_b.test[1])}) without seeing it.
      </PageHeader>

      {/* Pipeline */}
      <Card className="p-6" delay={20}>
        <p className="eyebrow mb-4">Pipeline</p>
        <div className="flex flex-wrap items-stretch gap-2">
          {PIPE.map((p, i) => (
            <div key={p.t} className="flex items-center gap-2">
              <div className={`rounded-xl border px-3.5 py-2.5 ${i === 4 ? "border-brand-soft bg-brand-wash" : "border-hairline bg-surface-2"}`}>
                <p className="text-[13px] font-semibold">{p.t}</p>
                <p className="text-[11px] text-ink-3">{p.d}</p>
              </div>
              {i < PIPE.length - 1 && <ArrowRight className="h-4 w-4 shrink-0 text-muted" />}
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatTile label="Seasonal categories · error cut" value={fmt.pct(seasonalGain)} hint={`vs moving average, ${sc.categories.length} categories`} />
        <StatTile label="Category-week accuracy" value={fmt.pct(1 - h.aggregate.category_week.ensemble)} hint="what a buyer plans with" />
        <StatTile label="90% range coverage" value={fmt.pct(h.coverage_90)} hint="target 90% · well calibrated" />
        <StatTile label="Rise / fall called correctly" value={fmt.pct(h.direction_accuracy)} hint="active medicines, holdout" />
      </div>

      {/* Leaderboard */}
      <Card className="mt-6 overflow-hidden" delay={60}>
        <CardHeader title="Leaderboard" sub="Holdout error (WAPE: weighted absolute % error, lower is better)" />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13px]">
            <thead>
              <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wider text-ink-3">
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-3 py-3 text-right font-medium">Item-week WAPE</th>
                <th className="px-3 py-3 text-right font-medium">Category-week</th>
                <th className="px-3 py-3 text-right font-medium">Seasonal categories</th>
                <th className="px-3 py-3 text-right font-medium">Store-week</th>
                <th className="px-3 py-3 text-right font-medium">MAE</th>
                <th className="px-3 py-3 text-right font-medium">Bias</th>
                <th className="px-6 py-3 text-right font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => {
                const o = h.overall[k];
                const best = (vals: Record<string, number>) => Math.min(...KEYS.map((x) => vals[x])) === vals[k];
                const cell = (v: number, isBest: boolean) => <span className={isBest ? "rounded-md bg-brand-wash px-1.5 py-0.5 font-semibold text-brand-ink" : ""}>{fmt.pct(v, 1)}</span>;
                return (
                  <tr key={k} className={`border-t border-hairline ${k === "ensemble" ? "bg-[#fffaf6]" : ""}`}>
                    <td className="px-6 py-3"><span className="inline-flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[k] }} />{data.labels[k]}</span></td>
                    <td className="px-3 py-3 text-right tnum">{cell(o.wape, best(Object.fromEntries(KEYS.map((x) => [x, h.overall[x].wape]))))}</td>
                    <td className="px-3 py-3 text-right tnum">{cell(h.aggregate.category_week[k], best(h.aggregate.category_week))}</td>
                    <td className="px-3 py-3 text-right tnum">{cell(sc.category_week[k], best(sc.category_week))}</td>
                    <td className="px-3 py-3 text-right tnum">{cell(h.aggregate.store_week[k], best(h.aggregate.store_week))}</td>
                    <td className="px-3 py-3 text-right tnum text-ink-2">{o.mae.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right tnum text-ink-2">{fmt.signedPct(o.bias, 1)}</td>
                    <td className="px-6 py-3 text-right tnum text-ink-2">{k === "ensemble" ? "—" : k === "ma8" ? "baseline" : fmt.pct(data.production_weights[k])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 border-t border-hairline bg-surface-2 px-6 py-4 text-[12px] leading-relaxed text-ink-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
          <p>
            <b className="font-semibold text-ink">Why item-week error looks high:</b> a typical medicine sells only a few units a week, so most week-to-week variation is random.
            Even an oracle that knew each medicine’s true average demand for the holdout would score <b className="font-semibold text-ink">{fmt.pct(h.noise_floor_wape, 1)}</b> WAPE (the noise floor).
            The ensemble scores {fmt.pct(ens.wape, 1)} against the moving average’s {fmt.pct(ma.wape, 1)}.
            The seasonal value shows at category level, where the ensemble cuts monsoon-category error by {fmt.pct(seasonalGain)}.
          </p>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card delay={90}>
          <CardHeader title="Holdout: store-wide weekly units" sub="Each model’s forecast made from the end of May, against what actually sold"
            right={<Legend items={[{ label: "Actual", color: COLORS.actual }, ...KEYS.map((k) => ({ label: data.labels[k], color: COLORS[k], kind: k === "ma8" ? "dash" as const : undefined }))]} />} />
          <div className="px-4 pb-4 pt-4">
            <MultiLine data={data.holdout_series} x="week" xFormatter={(w: string) => fmt.week(w)} height={300}
              series={[{ key: "actual", label: "Actual", color: COLORS.actual, width: 2.5 }, ...KEYS.map((k) => ({ key: k, label: data.labels[k], color: COLORS[k], dash: k === "ma8" }))]} />
          </div>
        </Card>
        <Card delay={110}>
          <CardHeader title="Error by forecast horizon" sub="Item-week WAPE, 1 to 12 weeks ahead"
            right={<Legend items={KEYS.map((k) => ({ label: data.labels[k], color: COLORS[k], kind: k === "ma8" ? "dash" as const : undefined }))} />} />
          <div className="px-4 pb-4 pt-4">
            <MultiLine data={h.by_horizon} x="h" xFormatter={(v: number) => `${v} wk`} height={300} yFormatter={(v) => fmt.pct(v)} valueFormatter={(v) => fmt.pct(v, 1)}
              series={KEYS.map((k) => ({ key: k, label: data.labels[k], color: COLORS[k], dash: k === "ma8" }))} />
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card delay={130}>
          <CardHeader title="What drives the forecast" sub="Permutation importance in the gradient-boosting model (MAE increase when a feature is shuffled)" />
          <div className="px-6 pb-6 pt-4">
            <BarList items={data.importance.filter((f) => f.importance > 0).slice(0, 12).map((f) => ({ label: FEATURE_NAMES[f.feature] ?? f.feature, value: f.importance }))}
              color={C.s1} format={(n) => n.toFixed(3)} />
          </div>
        </Card>
        <Card delay={150}>
          <CardHeader title="Deep model training" sub={`SeasonalGRU validation error per epoch (fold A); ${data.dl_epochs} epochs used in production`} />
          <div className="px-4 pb-2 pt-4">
            <MultiLine data={data.dl_history} x="epoch" xFormatter={(v: number) => `Epoch ${v}`} height={200} yFormatter={(v) => fmt.pct(v, 1)} valueFormatter={(v) => fmt.pct(v, 1)}
              series={[{ key: "val_wape", label: "Validation WAPE", color: C.s7 }]} />
          </div>
          <div className="grid grid-cols-2 gap-3 px-6 pb-6 text-[12px] leading-relaxed text-ink-2">
            <div className="rounded-xl bg-surface-2 p-3"><b className="font-semibold text-ink">SeasonalGRU</b><br />2-layer GRU over 16 weeks of history, with medicine, category and form embeddings plus known-future season and festival inputs. Trained with Poisson loss.</div>
            <div className="rounded-xl bg-surface-2 p-3"><b className="font-semibold text-ink">XGBoost (Poisson)</b><br />{data.gbm_rounds} boosting rounds chosen by early stopping. One global model covers all 12 horizons directly (no recursive error build-up).</div>
          </div>
        </Card>
      </div>

      <GlobalDrivers />

      <Card className="mt-6 p-6" delay={170}>
        <p className="eyebrow mb-3">Evaluation protocol</p>
        <div className="grid gap-4 text-[13px] leading-relaxed text-ink-2 md:grid-cols-3">
          <p><b className="font-semibold text-ink">Fold A (tuning).</b> Train through {fmt.weekYear(data.protocol.fold_a.train_until)}, then forecast {fmt.week(data.protocol.fold_a.test[0])} – {fmt.weekYear(data.protocol.fold_a.test[1])}. This fold sets the ensemble weights, deep-model epochs, boosting rounds and interval calibration.</p>
          <p><b className="font-semibold text-ink">Fold B (holdout).</b> Train through {fmt.weekYear(data.protocol.fold_b.train_until)}, then forecast the monsoon. Nothing is tuned on this fold. Seasonal indices are computed point-in-time, so no feature sees the future.</p>
          <p><b className="font-semibold text-ink">Production.</b> Retrain on everything through {fmt.weekYear(data.protocol.final.train_until)} and forecast {data.protocol.horizon_weeks} weeks ahead. Full pipeline runtime: {Math.round(data.training_seconds)}s on CPU.</p>
        </div>
      </Card>
    </>
  );
}
