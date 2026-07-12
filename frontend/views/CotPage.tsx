"use client";
// COT Futures — CFTC Commitments of Traders positioning over `cot_reports`
// (weekly legacy futures-only report, refreshed by summa-cot.yml after the
// Friday ~3:30pm ET release; data is as of the prior Tuesday). The headline
// read is the COT INDEX: where today's large-speculator net position sits in
// its trailing 1y/3y range. ≥90 = specs crowded long (the trend is mature —
// reversal risk), ≤10 = crowded short (squeeze setup); a net-position flip or
// a big weekly shift shows fresh money moving NOW. Commercials (hedgers) are
// the mirror side and historically the "smart money" at extremes. Clicking a
// row opens a detail panel with the full spec-vs-commercial history and the
// interpretation. Positioning is a condition, not a timing trigger — pair it
// with a catalyst before acting.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { Sparkline } from "../components/charts/Sparkline";
import { NetPositionChart } from "../components/charts/charts.lazy";
import { fetchCotReports } from "../lib/data/data";
import { buildCotMarkets, buildCotTakeaways, COT_GROUPS, type CotMarket, type CotSignalKind } from "../lib/domain/cot";
import { fmtDate, fmtNum } from "../lib/utils/format";
import type { CotReport } from "../lib/types";

const INDEX_WINDOWS = [{ weeks: 52, label: "1y index" }, { weeks: 156, label: "3y index" }] as const;

// Signed compact contract count, e.g. '+194.2K' / '−8,340'.
function fmtContracts(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  const body = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(2)}M`
    : a >= 10_000 ? `${(a / 1_000).toFixed(1)}K` : a.toLocaleString("en-US");
  return `${v >= 0 ? "+" : "−"}${body}`;
}

const SIGNAL_META: Record<CotSignalKind, { label: string; bg: string; fg: string }> = {
  // Flips/surges are directional (pos/neg); crowded extremes are a RISK state,
  // not a direction — amber, matching the chart palette's attention hue.
  "flip-long":     { label: "FLIP → LONG",   bg: "rgba(34,197,94,0.16)",   fg: "var(--pos)" },
  "flip-short":    { label: "FLIP → SHORT",  bg: "rgba(239,68,68,0.15)",   fg: "var(--neg)" },
  "crowded-long":  { label: "CROWDED LONG",  bg: "rgba(217,119,6,0.18)",   fg: "#d97706" },
  "crowded-short": { label: "CROWDED SHORT", bg: "rgba(217,119,6,0.18)",   fg: "#d97706" },
  "surge-long":    { label: "BUYING SURGE",  bg: "rgba(34,197,94,0.16)",   fg: "var(--pos)" },
  "surge-short":   { label: "SELLING SURGE", bg: "rgba(239,68,68,0.15)",   fg: "var(--neg)" },
  neutral:         { label: "MID-RANGE",     bg: "rgba(148,163,184,0.12)", fg: "var(--fg-3)" },
};

function SignalBadge({ signal }: { signal: CotSignalKind }) {
  const m = SIGNAL_META[signal];
  return (
    <span style={{
      background: m.bg, color: m.fg, padding: "2px 8px", borderRadius: 4,
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>
      {m.label}
    </span>
  );
}

// 0–100 positioning meter: neutral track, marker at the percentile; the marker
// turns amber in the crowded bands (≥90 / ≤10). The number carries the value —
// color is never the only cue (the Signal column names the state).
function IndexMeter({ value }: { value: number }) {
  const extreme = value >= 90 || value <= 10;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ position: "relative", width: 72, height: 6, borderRadius: 3, background: "var(--border-1)", flex: "none" }}>
        <span style={{
          position: "absolute", top: -2, width: 10, height: 10, borderRadius: 5,
          left: `calc(${Math.min(100, Math.max(0, value))}% - 5px)`,
          background: extreme ? "#d97706" : "var(--accent)",
          border: "2px solid var(--bg-1)",
        }} />
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 26, textAlign: "right", color: extreme ? "#d97706" : "var(--fg-1)" }}>
        {value.toFixed(0)}
      </span>
    </span>
  );
}

function NetCell({ value, pctOi }: { value: number; pctOi: number | null }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: value >= 0 ? "var(--pos)" : "var(--neg)" }}>
        {fmtContracts(value)}
      </span>
      {pctOi != null && (
        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{pctOi > 0 ? "+" : ""}{pctOi.toFixed(1)}% OI</span>
      )}
    </span>
  );
}

const CHART_WINDOWS = [{ weeks: 26, label: "26w" }, { weeks: 52, label: "1y" }, { weeks: 156, label: "3y" }] as const;

function DetailPanel({ m, onClose }: { m: CotMarket; onClose: () => void }) {
  // Default to the recent half-year — the tradeable trend — with the longer
  // context one click away.
  const [chartWeeks, setChartWeeks] = useState<number>(26);
  const chartData = useMemo(() => {
    const start = Math.max(0, m.dates.length - chartWeeks);
    return m.dates.slice(start).map((d, i) => ({
      x: d.slice(2, 10), spec: m.series[start + i], comm: m.commSeries[start + i],
    }));
  }, [m, chartWeeks]);
  const stats: [string, string][] = [
    ["Open interest", fmtNum(m.openInterest, 0)],
    ["Spec long / short", `${fmtNum(m.specLong, 0)} / ${fmtNum(m.specShort, 0)}`],
    ["Comm long / short", `${fmtNum(m.commLong, 0)} / ${fmtNum(m.commShort, 0)}`],
    ["Commercial net", fmtContracts(m.commNet)],
    ["Traders", m.tradersTotal != null ? fmtNum(m.tradersTotal, 0) : "—"],
    ["COT index", m.specIndex.toFixed(0)],
  ];
  return (
    <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{m.name}</span>
        <SignalBadge signal={m.signal} />
        <span className="muted" style={{ fontSize: 12 }}>as of {fmtDate(m.latestDate, { utc: true })}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {CHART_WINDOWS.map((w) => (
            <button key={w.weeks} className={`chip${chartWeeks === w.weeks ? " active" : ""}`}
              onClick={() => setChartWeeks(w.weeks)}>{w.label}</button>
          ))}
          <button className="chip active" onClick={onClose}>✕ close</button>
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 12, maxWidth: 720 }}>{m.read}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
        {stats.map(([label, value]) => (
          <div key={label}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>
      <NetPositionChart
        data={chartData}
        lines={[{ key: "spec", name: "Large speculators (net)" }, { key: "comm", name: "Commercials (net)" }]}
        title={`${m.name} — net positions, contracts (last ${chartWeeks === 26 ? "26 weeks" : chartWeeks === 52 ? "year" : "3 years"})`}
        info="Non-commercials (funds) vs commercials (hedgers), weekly. The two are near mirror images; extremes in the spread mark crowded trades."
        height={240}
      />
    </div>
  );
}

export function CotPage() {
  const [rows, setRows] = useState<CotReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<string | null>(null);
  const [indexWeeks, setIndexWeeks] = useState<number>(156);
  const [detailCode, setDetailCode] = useState<string | null>(null);

  useEffect(() => {
    fetchCotReports().then((r) => { setRows(r); setLoading(false); });
  }, []);

  const markets = useMemo(() => buildCotMarkets(rows, indexWeeks), [rows, indexWeeks]);
  const shown = useMemo(
    () => (group ? markets.filter((m) => m.group === group) : markets),
    [markets, group],
  );
  // Key reads follow the group filter, so narrowing to e.g. FX focuses the story.
  const takeaways = useMemo(() => buildCotTakeaways(shown), [shown]);
  const detail = detailCode ? markets.find((m) => m.code === detailCode) ?? null : null;

  const reportDate = useMemo(
    () => markets.reduce((d, m) => (m.latestDate > d ? m.latestDate : d), ""),
    [markets],
  );
  const crowdedLong = markets.filter((m) => m.signal === "crowded-long").length;
  const crowdedShort = markets.filter((m) => m.signal === "crowded-short").length;
  const flips = markets.filter((m) => m.signal.startsWith("flip")).length;

  const cols: Column<CotMarket>[] = [
    { key: "name", header: "Market", width: "170px", value: (m) => m.name,
      render: (m) => (
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }} title={`CFTC contract ${m.code} · ${fmtNum(m.openInterest, 0)} contracts open interest`}>
          {m.name}
        </span>
      ) },
    { key: "group", header: "Group", width: "82px", value: (m) => m.group,
      render: (m) => <span className="muted" style={{ fontSize: 11, textTransform: "capitalize" }}>{m.group}</span> },
    { key: "net", header: "Spec net", width: "168px", align: "right", value: (m) => m.specNet,
      render: (m) => <NetCell value={m.specNet} pctOi={m.specNetPctOi} /> },
    { key: "wow", header: "1-wk flow", width: "150px", align: "right", value: (m) => m.specWowPctOi ?? 0,
      render: (m) => <NetCell value={m.specWow} pctOi={m.specWowPctOi} /> },
    { key: "idx", header: "COT index", width: "126px", align: "right", value: (m) => m.specIndex,
      render: (m) => <IndexMeter value={m.specIndex} /> },
    { key: "streak", header: "Streak", width: "78px", align: "right", value: (m) => m.streak,
      render: (m) => Math.abs(m.streak) < 2 ? <span className="muted">—</span> : (
        <span title={`Speculators have ${m.streak > 0 ? "added to" : "cut"} this position for ${Math.abs(m.streak)} consecutive weeks`}
          style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: m.streak > 0 ? "var(--pos)" : "var(--neg)" }}>
          {m.streak > 0 ? "▲" : "▼"}{Math.abs(m.streak)}w
        </span>
      ) },
    { key: "signal", header: "Signal", width: "130px", value: (m) => m.signal,
      render: (m) => <span title={m.read}><SignalBadge signal={m.signal} /></span> },
    { key: "trend", header: "Trend 26w", width: "92px", value: () => null,
      render: (m) => <Sparkline values={m.series.slice(-26)} /> },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">COT Futures</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  const emptyNote = rows.length === 0
    ? "No COT data yet — apply the updated schema.sql in Supabase, then run the summa-cot workflow (its first run backfills ~3 years)."
    : "No markets in this group.";

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">COT Futures Positioning</h1>
        <div className="page-sub">
          CFTC Commitments of Traders · large speculators (funds) vs commercials (hedgers) across {markets.length} major
          futures markets · COT index = where today&apos;s spec net sits in its trailing {indexWeeks === 52 ? "1-year" : "3-year"} range
          (≥90 crowded long · ≤10 crowded short) · published Fridays ~3:30pm ET with Tuesday&apos;s data · click a market for its full history
        </div>
      </div>

      <div className="toggle-row">
        <button className={`chip${group === null ? " active" : ""}`} onClick={() => setGroup(null)}>All</button>
        {COT_GROUPS.map((g) => (
          <button key={g.key} className={`chip${group === g.key ? " active" : ""}`} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border-1)", margin: "0 4px" }} />
        {INDEX_WINDOWS.map((w) => (
          <button key={w.weeks} className={`chip${indexWeeks === w.weeks ? " active" : ""}`}
            title={`Compute the COT index over the trailing ${w.weeks} weeks`}
            onClick={() => setIndexWeeks(w.weeks)}>
            {w.label}
          </button>
        ))}
      </div>

      <div className="kpi-strip dense" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="k-label">Report week</div>
          <div className="k-value" style={{ fontSize: 16 }}>{reportDate ? fmtDate(reportDate, { utc: true }) : "—"}</div>
          <div className="k-delta"><span>positions as of Tuesday</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "#d97706" }}>Crowded long</div>
          <div className="k-value" style={{ color: "#d97706" }}>{crowdedLong}</div>
          <div className="k-delta"><span>specs stretched — reversal risk</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "#d97706" }}>Crowded short</div>
          <div className="k-value" style={{ color: "#d97706" }}>{crowdedShort}</div>
          <div className="k-delta"><span>bear crowd stretched — squeeze setup</span></div>
        </div>
        <div className="kpi">
          <div className="k-label">Flips this week</div>
          <div className="k-value">{flips}</div>
          <div className="k-delta"><span>spec net crossed zero</span></div>
        </div>
      </div>

      {takeaways.length > 0 && (
        <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>📌 This week&apos;s key reads</div>
          <div style={{ display: "grid", gap: 6 }}>
            {takeaways.map((t) => (
              <div key={t.code} style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
                <span onClick={() => setDetailCode(t.code)}
                  style={{ color: "var(--accent)", fontWeight: 700, cursor: "pointer", marginRight: 6 }}
                  title="Open this market's detail">
                  {t.name}
                </span>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail && <DetailPanel m={detail} onClose={() => setDetailCode(null)} />}

      <DataTable
        columns={cols} rows={shown} rowKey={(m) => m.code}
        empty={emptyNote} maxHeight="calc(100vh - 330px)"
        onRowClick={(m) => setDetailCode((c) => (c === m.code ? null : m.code))}
      />

      <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: "12px 16px", marginTop: 16, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700, color: "var(--fg-1)", marginBottom: 4 }}>How to act on this</div>
        <b>Crowded extremes are contrarian conditions, not sell/buy buttons</b> — a market can stay crowded for
        months while trending. The strong pattern: a crowded reading <i>plus</i> a catalyst (a Fed decision, earnings,
        a supply shock) unwinds violently in the crowd&apos;s face. <b>Flips</b> mark regime changes worth trading with,
        not against. <b>Surges</b> show where fresh money is moving this week — momentum confirmation. Commercials
        leaning hard against the specs strengthens the contrarian read. Data lags 3 days (Tuesday → Friday), so treat
        it as positioning context for the week ahead, not a real-time trigger.
      </div>
    </div>
  );
}
