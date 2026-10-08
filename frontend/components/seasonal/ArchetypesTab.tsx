"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Minus } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "@/lib/api";
import { fmt } from "@/lib/format";
import { C } from "@/components/charts";
import { Card, ErrorState, SeasonIcon, Skeleton } from "@/components/ui";
import type { Archetype, ArchetypesResp } from "./types";
import { ClassChip, DataEndBar, Empty, Footnote, MoreButton, RAIN, Reading, TipShell, corrReading, haloAbove, sDec } from "./b-kit";

const MEMBERS_FIRST = 8;
const DEMAND = C.s1;
/* The profile chart and the rainfall strip share these so their 12 month bands line up exactly. */
const Y_W = 46;
const MARGIN_X = { left: 0, right: 10 } as const;

type Pt = { month: string; demand: number; mm: number };

const isSteady = (c: Archetype) => c.name.toLowerCase().startsWith("steady") || c.amplitude < 1.15;
const seasonOf = (name: string) => name.split(" peak")[0].trim();

function silReading(s: number | null): { level: 0 | 1 | 2 | 3; label: string; text: string } | null {
  if (s == null || !Number.isFinite(s)) return null;
  if (s >= 0.6) return { level: 3, label: "Clear", text: "Groups are well separated: most medicines sit firmly in one shape." };
  if (s >= 0.3) return { level: 2, label: "Moderate", text: "Real groups that overlap at the edges: a medicine near a boundary could sit in either neighbour." };
  return { level: 1, label: "Weak", text: "The shapes form a continuum more than distinct groups; read the groups as rough summaries." };
}

/* ───────────────── demand profile (own scale) + rainfall strip (own scale), aligned month by month ───────────────── */

function ProfileChart({ pts, domain, ticks, peakIdx, height = 170 }: { pts: Pt[]; domain: [number, number]; ticks: number[]; peakIdx: number; height?: number }) {
  const peak = pts[peakIdx];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={pts} margin={{ top: 20, ...MARGIN_X, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        {/* band scale (not the default point scale) so each month sits at the centre of its band, like the rainfall bars below */}
        <XAxis dataKey="month" scale="band" tick={false} tickLine={false} axisLine={{ stroke: C.axis }} height={2} />
        <YAxis domain={domain} ticks={ticks} tickFormatter={(v: number) => fmt.signedPct(v)} tickLine={false} axisLine={false} width={Y_W} />
        <ReferenceLine y={0} stroke={C.axis} />
        <Line dataKey="demand" type="monotone" stroke={DEMAND} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
        {peak && (
          <ReferenceDot x={peak.month} y={peak.demand} r={4} fill={DEMAND} stroke="#fff" strokeWidth={2} label={haloAbove(fmt.signedPct(peak.demand))} />
        )}
        <Tooltip
          cursor={{ stroke: C.axis, strokeWidth: 1 }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as Pt;
            return (
              <TipShell title={p.month} rows={[
                { label: "Demand vs average month", value: fmt.signedPct(p.demand), color: DEMAND },
                { label: "Kochi rainfall", value: `${fmt.int(p.mm)} mm`, color: RAIN.col, rect: true },
              ]} />
            );
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Rainfall bar; the wettest month also prints its value above the bar (selective direct label). */
function RainBar(props: unknown) {
  const p = props as { x?: number; y?: number; width?: number; index?: number; mm?: number; peak?: number };
  const bar = DataEndBar(props);
  if (p.index !== p.peak || p.x == null || p.y == null || p.width == null) return bar;
  return (
    <g>
      {bar}
      <text x={p.x + p.width / 2} y={p.y - 4} textAnchor="middle" fontSize={10} fill="#6b6a65">{fmt.int(p.mm)}</text>
    </g>
  );
}

function RainStrip({ pts, maxMm, height = 76 }: { pts: Pt[]; maxMm: number; height?: number }) {
  const peak = pts.reduce((best, p, i) => (p.mm > pts[best].mm ? i : best), 0);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={pts} margin={{ top: 14, ...MARGIN_X, bottom: 0 }} barCategoryGap="22%">
        <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: C.axis }} interval={0} tick={{ fontSize: 10 }} height={18} />
        <YAxis domain={[0, maxMm]} tick={false} tickLine={false} axisLine={false} width={Y_W} />
        <Bar dataKey="mm" fill={RAIN.col} maxBarSize={18} isAnimationActive={false}
          shape={(bp: unknown) => RainBar({ ...(bp as object), mm: (bp as { payload?: Pt }).payload?.mm, peak })} />
        <Tooltip
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as Pt;
            return <TipShell title={p.month} rows={[{ label: "Kochi rainfall (climatology)", value: `${fmt.int(p.mm)} mm`, color: RAIN.col, rect: true }]} />;
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ───────────────── one archetype ───────────────── */

function Stat({ label, value, children, title }: { label: string; value: ReactNode; children?: ReactNode; title?: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-surface-2 px-3.5 py-3" title={title}>
      <p className="text-[11px] leading-tight text-ink-3">{label}</p>
      <p className="mt-1.5 text-[18px] font-semibold leading-none tracking-tight">{value}</p>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function ClusterCard({ c, pts, domain, ticks, maxMm, clustered, quiet, delay }: {
  c: Archetype; pts: Pt[]; domain: [number, number]; ticks: number[]; maxMm: number; clustered: number; quiet: boolean; delay: number;
}) {
  const [open, setOpen] = useState(false);
  const members = open ? c.members : c.members.slice(0, MEMBERS_FIRST);
  const peakIdx = c.profile.indexOf(Math.max(...c.profile));
  const rr = corrReading(c.rain_corr);
  const listId = `arch-members-${c.id}`;
  const season = seasonOf(c.name);

  const head = (
    <div className="flex items-start gap-3">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${quiet ? "bg-sunken text-ink-3" : "bg-brand-wash text-brand"}`} aria-hidden>
        {quiet ? <Minus className="h-5 w-5" strokeWidth={1.8} /> : <SeasonIcon season={season} className="h-5 w-5" />}
      </span>
      <div className="min-w-0">
        <h3 className="text-[16px] font-semibold tracking-tight">{c.name}</h3>
        <p className="mt-0.5 text-[12px] text-ink-3">
          {fmt.int(c.size)} medicines{clustered > 0 && <> · {fmt.pct(c.size / clustered)} of those grouped</>}
        </p>
      </div>
    </div>
  );

  const stats = (
    <div className="grid grid-cols-3 gap-2">
      <Stat label="Peak ÷ trough" value={`${c.amplitude.toFixed(2)}×`} title="Busiest month's demand divided by the quietest month's" />
      <Stat label="Peak month" value={c.peak_month} title="Month with the highest average multiplier" />
      <Stat label="Rain-shape match" value={c.rain_corr != null ? `ρ ${sDec(c.rain_corr)}` : "—"}
        title="Spearman rank correlation between this group's 12 monthly multipliers and Kochi's monthly rainfall">
        {rr && <Reading level={rr.level} label={rr.label} />}
      </Stat>
    </div>
  );

  const chart = (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Demand · % vs the average month</p>
      <div className="-mx-2 mt-1" role="img" aria-label={`${c.name}: monthly demand relative to an average month, ${c.months.map((m, i) => `${m} ${fmt.signedPct(c.profile[i] - 1)}`).join(", ")}`}>
        <ProfileChart pts={pts} domain={domain} ticks={ticks} peakIdx={peakIdx} />
      </div>
      <p className="mt-2 text-[11px] text-ink-3">
        <span className="mr-1.5 inline-block h-2 w-2.5 rounded-[2px]" style={{ background: RAIN.col }} aria-hidden />
        Kochi rainfall · mm per month (1991–2020 climatology)
      </p>
      <div className="-mx-2" role="img" aria-label={`Kochi monthly rainfall: ${pts.map((p) => `${p.month} ${fmt.int(p.mm)} mm`).join(", ")}`}>
        <RainStrip pts={pts} maxMm={maxMm} />
      </div>
    </div>
  );

  const cats = (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-3">Main categories</p>
      <div className="flex flex-wrap gap-1.5">
        {c.top_categories.map((t) => (
          <span key={t.category} className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2">
            {t.category}<span className="font-medium text-ink tnum">{t.n}</span>
          </span>
        ))}
      </div>
    </div>
  );

  const list = (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-3">Best-selling members</p>
        <p className="text-[11px] text-ink-3">
          Top {members.length} of {fmt.int(c.size)}
        </p>
      </div>
      {c.members.length ? (
        <ul id={listId} className="divide-y divide-hairline">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2">
              <Link href={`/medicines/${m.id}`} className="focus-ring min-w-0 flex-1 rounded">
                <span className="block truncate text-[13px] font-medium hover:underline">{m.name}</span>
                <span className="block truncate text-[11px] text-ink-3">{m.category} · {fmt.int(m.units)} sold</span>
              </Link>
              <ClassChip cls={m.class} />
            </li>
          ))}
        </ul>
      ) : <p className="py-2 text-[12px] text-ink-3">No members listed.</p>}
      {c.members.length > MEMBERS_FIRST && (
        <div className="mt-1">
          <MoreButton open={open} onClick={() => setOpen((v) => !v)} controls={listId}
            more={`Show all ${c.members.length}`} less={`Show top ${MEMBERS_FIRST}`} />
        </div>
      )}
    </div>
  );

  if (quiet) {
    return (
      <Card className="p-6" delay={delay}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-8">
          <div className="space-y-5">{head}{stats}<p className="-mt-2 text-[11px] text-ink-3">Rain-shape match is shape similarity, not causation.</p>{chart}</div>
          <div className="space-y-5">{cats}{list}</div>
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-5 p-6" delay={delay}>
      {head}
      {stats}
      <p className="-mt-2 text-[11px] text-ink-3">Rain-shape match is shape similarity, not causation.</p>
      {chart}
      {cats}
      {list}
    </Card>
  );
}

/* ───────────────── tab ───────────────── */

export default function ArchetypesTab() {
  const { data, error, loading } = useApi<ArchetypesResp>("/api/seasonal/archetypes");

  const prep = useMemo(() => {
    if (!data || !data.clusters.length) return null;
    const rain = data.rain ?? [];
    const months = data.months?.length ? data.months : data.clusters[0].months;
    const rainMean = rain.length ? rain.reduce((a, b) => a + b, 0) / rain.length : 0;
    const maxMm = Math.max(1, ...rain);
    const pts = (c: Archetype): Pt[] => months.map((m, i) => ({ month: m, demand: (c.profile[i] ?? 1) - 1, mm: rain[i] ?? 0 }));
    // Demand gets its own tight, symmetric scale, shared by every card so amplitudes compare across groups.
    const dev = Math.max(0.1, ...data.clusters.flatMap((c) => c.profile.map((v) => Math.abs(v - 1))));
    const unit = dev <= 0.45 ? 0.1 : 0.25;
    const bound = Math.ceil((dev + 0.05) / unit - 1e-9) * unit;
    const domain: [number, number] = [-bound, bound];
    const tickStep = bound / unit >= 4 ? unit * 2 : unit;
    const ticks: number[] = [];
    for (let v = -bound; v <= bound + tickStep / 2; v += tickStep) ticks.push(Number(v.toFixed(6)));
    const seasonal = data.clusters.filter((c) => !isSteady(c));
    const steady = data.clusters.filter(isSteady);
    const rainPeak = rain.length ? rain.indexOf(Math.max(...rain)) : -1;
    return { pts, domain, ticks, maxMm, seasonal, steady, rainMean, rainPeak, months, rain };
  }, [data]);

  if (error && !data) return <ErrorState error={error} />;
  if (!data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32" />
        <div className="grid gap-6 lg:grid-cols-2"><Skeleton className="h-[760px]" /><Skeleton className="h-[760px]" /></div>
        <Skeleton className="h-[420px]" />
      </div>
    );
  }
  if (!prep) {
    return (
      <Card>
        <Empty title="Not enough sales history to group medicines yet">
          Archetypes need a dozen or more medicines with enough bills to have a shape of their own. They appear here once more sales are loaded.
        </Empty>
      </Card>
    );
  }

  const sil = silReading(data.silhouette);
  const clustered = data.clustered ?? data.clusters.reduce((a, c) => a + c.size, 0);

  return (
    <div className={loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
      <Card className="p-6" delay={20}>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">Medicines grouped by the shape of their year</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Each medicine’s seasonal curve is summarised as 12 monthly multipliers (1 = an average month), and k-means groups medicines whose
              years rise and fall together, regardless of how much they sell. The number of groups is the one with the best silhouette score.
              {clustered > 0 && <> {fmt.int(clustered)} medicines have enough sales to be grouped.</>}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Medicines grouped" value={fmt.int(clustered)} />
            <Stat label="Groups (k)" value={data.k} />
            <Stat label="Silhouette" value={data.silhouette != null ? data.silhouette.toFixed(2) : "—"}
              title="From −1 to 1: how much closer each medicine is to its own group's shape than to the next group's">
              {sil && <Reading level={sil.level} label={sil.label} />}
            </Stat>
          </div>
        </div>
        {sil && (
          <p className="mt-4 border-t border-hairline pt-4 text-[12px] leading-relaxed text-ink-3">
            <b className="font-semibold text-ink-2">Silhouette {data.silhouette?.toFixed(2)}:</b> {sil.text} Silhouette runs from −1 to 1 and measures how much closer each
            medicine is to its own group’s shape than to the nearest other group’s.
          </p>
        )}
      </Card>

      {prep.seasonal.length > 0 && (
        <div className={`mt-6 grid gap-6 ${prep.seasonal.length > 1 ? "lg:grid-cols-2" : ""} ${prep.seasonal.length > 2 ? "2xl:grid-cols-3" : ""}`}>
          {prep.seasonal.map((c, i) => (
            <ClusterCard key={c.id} c={c} pts={prep.pts(c)} domain={prep.domain} ticks={prep.ticks} maxMm={prep.maxMm} clustered={clustered} quiet={false} delay={60 + i * 30} />
          ))}
        </div>
      )}
      {prep.steady.map((c, i) => (
        <div key={c.id} className="mt-6">
          <ClusterCard c={c} pts={prep.pts(c)} domain={prep.domain} ticks={prep.ticks} maxMm={prep.maxMm} clustered={clustered} quiet delay={60 + (prep.seasonal.length + i) * 30} />
        </div>
      ))}

      <Card className="mt-6 px-6 py-5" delay={160}>
        <div className="space-y-2">
          <Footnote>
            Each demand chart shows the group’s monthly multipliers as % above or below its own average month, on one scale shared by every card so the groups compare directly.
          </Footnote>
          <Footnote>
            The grey strip under each chart is Kochi’s monthly rainfall climatology in mm (1991–2020; average {fmt.int(prep.rainMean)} mm a month
            {prep.rainPeak >= 0 && prep.months[prep.rainPeak] ? `, wettest in ${prep.months[prep.rainPeak]} at ${fmt.int(prep.rain[prep.rainPeak])} mm` : ""}).
            It has its own scale and sits on the same 12 months, so you can see whether a group’s peak arrives with the rains; it is context, not a second axis.
          </Footnote>
          <Footnote>
            Rain-shape match (ρ) is a rank correlation over 12 smooth monthly values. It shows shape similarity, not causation: any group that climbs out of a
            dry-season low into mid-year will match the monsoon to some degree, whatever actually drives its demand.
          </Footnote>
          <Footnote>
            Members are listed by units sold; class chips show each medicine’s own seasonal evidence (▲▲ strong, ▲ seasonal, ◆ via its category, ◇ weak, — steady).
          </Footnote>
        </div>
      </Card>
    </div>
  );
}
