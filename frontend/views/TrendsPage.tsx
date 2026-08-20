"use client";
// Trends — Phase 2. The cross-company read: what tracked companies are
// collectively investing in, ranked by momentum, over `theme_trends`
// (trend_aggregator.py, recomputed weekly from the theme_mentions distilled out
// of each new 10-K/10-Q).
//
// Every number here is deterministic code over the warehouse — a curated
// keyword taxonomy plus arithmetic. No model wrote any of it, including the
// per-theme sentence, which is a template filled with this row's own figures.
//
// The view is built around one distinction and refuses to blur it:
//   BREADTH — how many companies cite a theme. Cheap to say, so it is narrative.
//   CAPITAL — attributed R&D + capex behind it. Expensive, so it is commitment.
// A theme climbing on breadth alone is a story; climbing on both is a buildout.
// The table shows the two side by side rather than folding them into a single
// number, and the momentum score is presented as a ranking, not a verdict.
//
// Coverage honesty: the watchlist is not the market. Every share is quoted
// against the number of companies that actually reported that quarter, and a
// quarter with too few reporters is badged "thin" instead of quietly rendered.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { Sparkline } from "../components/charts/Sparkline";
import { HorizontalBarChart, MultiLineChart } from "../components/charts/charts.lazy";
import { fetchThemeTrends } from "../lib/data/data";
import {
  availablePeriods, buildTrends, capitalBySector, coverageFor, latestPeriod,
  nextTrend, quarterLabel, TREND_CATEGORIES, type TrendRow,
} from "../lib/domain/trends";
import { fmtUSD } from "../lib/utils/format";
import type { ThemeStage, ThemeTrend } from "../lib/types";

const STAGE_META: Record<ThemeStage, { label: string; bg: string; fg: string; hint: string }> = {
  // Emerging/accelerating are directional good news (green), cooling is a
  // retreat (red), mainstream is a neutral state — already everywhere, so
  // there's no edge left in the fact itself.
  emerging:     { label: "EMERGING",     bg: "rgba(59,130,246,0.16)",  fg: "var(--accent)",
                  hint: "Few companies, but adoption or spend is rising fast — earliest and least crowded." },
  accelerating: { label: "ACCELERATING", bg: "rgba(34,197,94,0.16)",   fg: "var(--pos)",
                  hint: "Already meaningful adoption and still growing — the buildout phase." },
  mainstream:   { label: "MAINSTREAM",   bg: "rgba(148,163,184,0.12)", fg: "var(--fg-3)",
                  hint: "Most tracked companies cite it and growth has flattened — priced in." },
  cooling:      { label: "COOLING",      bg: "rgba(239,68,68,0.15)",   fg: "var(--neg)",
                  hint: "Fewer companies citing it, or the money is pulling back." },
};

function StageBadge({ stage }: { stage: ThemeStage }) {
  const m = STAGE_META[stage];
  return (
    <span title={m.hint} style={{
      background: m.bg, color: m.fg, padding: "2px 8px", borderRadius: 4,
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>
      {m.label}
    </span>
  );
}

// 0–100 momentum meter. The number always carries the value; the bar is a
// secondary cue, never the only one.
function MomentumMeter({ value }: { value: number }) {
  const strong = value >= 60;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ position: "relative", width: 64, height: 6, borderRadius: 3, background: "var(--border-1)", flex: "none" }}>
        <span style={{
          position: "absolute", inset: 0, width: `${Math.min(100, Math.max(0, value))}%`,
          borderRadius: 3, background: strong ? "var(--accent)" : "var(--fg-4)",
        }} />
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 24, textAlign: "right", fontWeight: 600 }}>
        {value.toFixed(0)}
      </span>
    </span>
  );
}

// Breadth cell: N of M companies, with the quarter-over-quarter change. The
// denominator is always visible — it is the whole coverage caveat in one place.
function BreadthCell({ t }: { t: TrendRow }) {
  const d = t.breadthDelta;
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{t.companyCount}</span>
      <span className="muted" style={{ fontSize: 11 }}> / {t.coverage}</span>
      {d !== 0 && (
        <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: d > 0 ? "var(--pos)" : "var(--neg)" }}>
          {d > 0 ? "▲" : "▼"}{Math.abs(d)}
        </span>
      )}
    </span>
  );
}

function CapitalCell({ t }: { t: TrendRow }) {
  if (!t.capitalFlow) return <span className="muted">—</span>;
  return (
    <span style={{ whiteSpace: "nowrap" }} title="R&D + capex for the quarter, attributed across a company's themes in proportion to how much of its forward-looking language each one accounts for. An attribution — companies never break spend out by theme.">
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{fmtUSD(t.capitalFlow)}</span>
      {t.capitalGrowth != null && Math.abs(t.capitalGrowth) >= 1 && (
        <span style={{ marginLeft: 6, fontSize: 11, color: t.capitalGrowth > 0 ? "var(--pos)" : "var(--neg)" }}>
          {t.capitalGrowth > 0 ? "+" : ""}{t.capitalGrowth.toFixed(0)}%
        </span>
      )}
    </span>
  );
}

function DetailPanel({ t, onClose, onCompany }: {
  t: TrendRow; onClose: () => void; onCompany: (cik: string) => void;
}) {
  // Breadth and capital are plotted on one indexed axis (each series scaled to
  // its own peak) so the SHAPES can be compared — the point is whether dollars
  // are following the talk, not the raw magnitudes, which share no unit.
  const chartData = useMemo(() => {
    const maxB = Math.max(...t.breadthSeries, 1);
    const maxC = Math.max(...t.capitalSeries, 1);
    return t.periods.map((p, i) => ({
      x: quarterLabel(p).replace(" ", " "),
      breadth: Math.round((t.breadthSeries[i] / maxB) * 100),
      capital: Math.round((t.capitalSeries[i] / maxC) * 100),
    }));
  }, [t]);

  const sectors = useMemo(
    () => Object.entries(t.sectorFlow)
      .map(([sector, capital]) => ({ sector, capital }))
      .sort((a, b) => b.capital - a.capital),
    [t.sectorFlow],
  );

  return (
    <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{t.label}</span>
        <StageBadge stage={t.stage} />
        <span className="muted" style={{ fontSize: 12 }}>{t.categoryLabel} · {t.quarter}</span>
        <button className="chip active" style={{ marginLeft: "auto" }} onClick={onClose}>✕ close</button>
      </div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 12, maxWidth: 760, lineHeight: 1.55 }}>{t.summary}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
        {([
          ["Companies citing", `${t.companyCount} of ${t.coverage}`],
          ["Adoption", `${Math.round(t.adoption * 100)}%`],
          ["Attributed capital", t.capitalFlow ? fmtUSD(t.capitalFlow) : "—"],
          ["Momentum", t.momentum.toFixed(0)],
          ["Leading sector", t.sector ?? "—"],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      {t.drivers.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
            Companies driving it
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {t.drivers.map((d) => (
              <button key={d.cik} className="chip" onClick={() => onCompany(d.cik)}
                title={`${d.mentions} mentions · ${fmtUSD(d.capital)} attributed`}>
                {d.ticker || d.cik} <span className="muted">{fmtUSD(d.capital)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {chartData.length > 1 && (
        <MultiLineChart
          data={chartData}
          lines={[{ key: "breadth", name: "Companies citing" }, { key: "capital", name: "Attributed capital" }]}
          title={`${t.label} — talk vs money, indexed to each series' own peak`}
          info="Both series are scaled to 100 at their own maximum so their SHAPES can be compared; they share no unit. Capital tracking breadth means the spending is following the language — capital flat while breadth climbs is talk running ahead of investment."
        />
      )}

      {sectors.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <HorizontalBarChart
            data={sectors.map((s) => ({ x: s.sector, sector: s.sector, capital: s.capital }))}
            barKey="capital" labelKey="sector"
            title={`${t.label} — attributed capital by sector`}
            info="Which sectors are putting money behind this theme, this quarter."
          />
        </div>
      )}
    </div>
  );
}

export function TrendsPage({ onCompany }: { onCompany: (cik: string) => void }) {
  const [rows, setRows] = useState<ThemeTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string | null>(null);
  const [stage, setStage] = useState<ThemeStage | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);

  useEffect(() => {
    fetchThemeTrends().then((r) => { setRows(r); setLoading(false); });
  }, []);

  const periods = useMemo(() => availablePeriods(rows), [rows]);
  const activePeriod = period ?? latestPeriod(rows);
  const trends = useMemo(() => buildTrends(rows, activePeriod), [rows, activePeriod]);

  const shown = useMemo(() => trends.filter(
    (t) => (!category || t.category === category) && (!stage || t.stage === stage),
  ), [trends, category, stage]);

  const pick = useMemo(() => nextTrend(trends), [trends]);
  const sectorFlow = useMemo(() => capitalBySector(shown), [shown]);
  const coverage = coverageFor(trends);
  const detail = detailKey ? trends.find((t) => t.key === detailKey) ?? null : null;

  const emerging = trends.filter((t) => t.stage === "emerging").length;
  const accelerating = trends.filter((t) => t.stage === "accelerating").length;
  const totalCapital = trends.reduce((sum, t) => sum + t.capitalFlow, 0);

  const cols: Column<TrendRow>[] = [
    { key: "label", header: "Theme", width: "200px", value: (t) => t.label,
      render: (t) => (
        <span style={{ whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 600 }}>{t.label}</span>
          {t.isNew && <span className="muted" style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", fontWeight: 700 }}>NEW</span>}
        </span>
      ) },
    { key: "category", header: "Category", width: "150px", value: (t) => t.categoryLabel,
      render: (t) => <span className="muted" style={{ fontSize: 11 }}>{t.categoryLabel}</span> },
    { key: "breadth", header: "Companies", width: "118px", align: "right", value: (t) => t.companyCount,
      render: (t) => <BreadthCell t={t} /> },
    { key: "capital", header: "Attributed capital", width: "150px", align: "right", value: (t) => t.capitalFlow,
      render: (t) => <CapitalCell t={t} /> },
    { key: "momentum", header: "Momentum", width: "118px", align: "right", value: (t) => t.momentum,
      render: (t) => <MomentumMeter value={t.momentum} /> },
    { key: "stage", header: "Stage", width: "126px", value: (t) => t.stage,
      render: (t) => <StageBadge stage={t.stage} /> },
    { key: "sector", header: "Led by", width: "130px", value: (t) => t.sector ?? "",
      render: (t) => t.sector ? <span style={{ fontSize: 12 }}>{t.sector}</span> : <span className="muted">—</span> },
    { key: "trend", header: "Breadth trend", width: "96px", value: () => null,
      render: (t) => t.breadthSeries.length > 1 ? <Sparkline values={t.breadthSeries} /> : <span className="muted">—</span> },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Trends</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  const emptyNote = rows.length === 0
    ? "No trend data yet — apply the updated schema.sql in Supabase, then let the pipeline run: each company's next visit distils themes from its latest 10-K/10-Q, and the weekly aggregation publishes the leaderboard once a few companies have reported."
    : "No themes match these filters.";

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Trend Intelligence</h1>
        <div className="page-sub">
          What {coverage || "the"} tracked compan{coverage === 1 ? "y is" : "ies are"} collectively investing in ·
          themes distilled from 10-K / 10-Q Business and MD&amp;A language, scored on
          BREADTH (how many companies cite it) against CAPITAL (R&amp;D + capex attributed to it) ·
          {activePeriod ? ` ${quarterLabel(activePeriod)}` : ""} · click a theme for its history
        </div>
      </div>

      <div className="toggle-row">
        <button className={`chip${category === null ? " active" : ""}`} onClick={() => setCategory(null)}>All</button>
        {TREND_CATEGORIES.map((c) => (
          <button key={c.key} className={`chip${category === c.key ? " active" : ""}`} onClick={() => setCategory(c.key)}>
            {c.label}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border-1)", margin: "0 4px" }} />
        {(Object.keys(STAGE_META) as ThemeStage[]).map((s) => (
          <button key={s} className={`chip${stage === s ? " active" : ""}`} title={STAGE_META[s].hint}
            onClick={() => setStage(stage === s ? null : s)}>
            {STAGE_META[s].label.toLowerCase()}
          </button>
        ))}
        {periods.length > 1 && (
          <>
            <span style={{ width: 1, alignSelf: "stretch", background: "var(--border-1)", margin: "0 4px" }} />
            {periods.slice(-4).map((p) => (
              <button key={p} className={`chip${activePeriod === p ? " active" : ""}`}
                title={`Rank themes as of ${quarterLabel(p)}`} onClick={() => { setPeriod(p); setDetailKey(null); }}>
                {quarterLabel(p)}
              </button>
            ))}
          </>
        )}
      </div>

      <div className="kpi-strip dense" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="k-label">Quarter</div>
          <div className="k-value" style={{ fontSize: 16 }}>{activePeriod ? quarterLabel(activePeriod) : "—"}</div>
          <div className="k-delta"><span>{coverage} compan{coverage === 1 ? "y" : "ies"} reporting</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "var(--accent)" }}>Emerging</div>
          <div className="k-value" style={{ color: "var(--accent)" }}>{emerging}</div>
          <div className="k-delta"><span>early, still uncrowded</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "var(--pos)" }}>Accelerating</div>
          <div className="k-value" style={{ color: "var(--pos)" }}>{accelerating}</div>
          <div className="k-delta"><span>adoption and spend both rising</span></div>
        </div>
        <div className="kpi">
          <div className="k-label">Attributed capital</div>
          <div className="k-value" style={{ fontSize: 18 }}>{totalCapital ? fmtUSD(totalCapital) : "—"}</div>
          <div className="k-delta"><span>R&amp;D + capex behind all themes</span></div>
        </div>
      </div>

      {pick && (
        <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>🌱 Next trend</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}>
            <span onClick={() => setDetailKey(pick.key)}
              style={{ color: "var(--accent)", fontWeight: 700, cursor: "pointer", marginRight: 6 }}
              title="Open this theme's detail">
              {pick.label}
            </span>
            {pick.summary}
            <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>
              Highest-momentum theme that is still early <i>and</i> has real spending behind it — the capital
              filter is what separates a trend from a talking point.
            </div>
          </div>
        </div>
      )}

      {detail && <DetailPanel t={detail} onClose={() => setDetailKey(null)} onCompany={onCompany} />}

      <DataTable
        columns={cols} rows={shown} rowKey={(t) => t.key}
        empty={emptyNote} maxHeight="calc(100vh - 400px)"
        onRowClick={(t) => setDetailKey((k) => (k === t.key ? null : t.key))}
      />

      {sectorFlow.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <HorizontalBarChart
            data={sectorFlow.map((s) => ({ x: s.sector, sector: s.sector, capital: s.capital }))}
            barKey="capital" labelKey="sector"
            title={`Capital allocation by sector — ${activePeriod ? quarterLabel(activePeriod) : ""}`}
            info="Attributed R&D + capex summed across the themes shown. Follows the filters above, so narrowing to one category shows who is funding it."
          />
        </div>
      )}

      <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: "12px 16px", marginTop: 16, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700, color: "var(--fg-1)", marginBottom: 4 }}>How to read this</div>
        <b>Breadth is talk; capital is commitment.</b> Language is free, so a theme every company suddenly
        mentions may be nothing more than the quarter&apos;s vocabulary. The pairing is the signal: breadth
        climbing <i>with</i> capital behind it is a real buildout, breadth climbing <i>without</i> it is a
        narrative to fade. <b>Emerging</b> beats <b>mainstream</b> for edge — by the time a theme is
        mainstream it is in the price. <b>Cooling</b> is the useful early warning: companies quietly stop
        talking about a bet before they write it off.
        <div style={{ marginTop: 8 }}>
          <b>Two honest limits.</b> The universe is your watchlist, not the market — every share above is
          quoted against the {coverage || "n"} compan{coverage === 1 ? "y" : "ies"} that actually reported this
          quarter, and a thin quarter says so. And the dollar figures are <i>attributed</i>: companies never
          break R&amp;D or capex out by theme, so spend is allocated in proportion to how much of a filing&apos;s
          forward-looking language each theme accounts for. Treat capital as a direction and a rough scale,
          never as a disclosed number.
        </div>
      </div>
    </div>
  );
}
