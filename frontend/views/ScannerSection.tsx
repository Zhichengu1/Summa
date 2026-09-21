"use client";
// Watchlist-wide scanners rendered as compact dashboard panels on the Overview:
//   • SignalsPanel  — every actionable fundamentals/filings signal across the
//     watchlist (buildWatchlistSignals), one row per company with the signals as
//     colored pills, filterable by direction. Same signal logic as the company
//     cockpit; only the rendering is denser.
//   • MomentumPanel — pure price-action setups (52-wk breakouts/lows, MA crosses,
//     RSI extremes, volume spikes) from the technicals snapshot OverviewPage
//     already fetched, ranked by how many setups are firing.
import { useMemo, useState } from "react";

import { CompanyMark } from "../components/badges/CompanyMark";
import { Panel } from "../components/Panel";
import { buildWatchlistSignals, type Direction, type Signal, type WatchEntry } from "../lib/domain/pulse";
import { elapsed, fmtDate } from "../lib/utils/format";
import type { Technicals } from "../lib/domain/technicals";
import type { Company } from "../lib/types";

const DIR_MARK: Record<Direction, string> = { bull: "▲", bear: "▼", flag: "◆", neutral: "●" };

function SignalPill({ s }: { s: Signal }) {
  return (
    <span className={`pill dir-${s.dir}`} title={`${s.label} — ${s.detail}${s.date ? ` (${fmtDate(s.date)})` : ""}`}>
      <span className="pill-mark" aria-hidden>{DIR_MARK[s.dir]}</span>
      <span className="pill-label">{s.label}</span>
      <span className="pill-status">{s.status}</span>
    </span>
  );
}

/** One compact company row: mark + ticker + name on top, pills below. */
function CompanyRow({
  ticker, name, meta, onOpen, children,
}: { ticker: string; name: string; meta?: React.ReactNode; onOpen: () => void; children: React.ReactNode }) {
  return (
    <div
      className="srow" role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
    >
      <CompanyMark ticker={ticker} size={26} />
      <div className="srow-main">
        <div className="srow-top">
          <span className="srow-tkr">{ticker}</span>
          <span className="srow-name">{name}</span>
          {meta && <span className="srow-meta">{meta}</span>}
        </div>
        <div className="srow-pills">{children}</div>
      </div>
    </div>
  );
}

function RowsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="srow-skel">
      {Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" style={{ height: 52, opacity: 0.8 - i * 0.15 }} />)}
    </div>
  );
}

export function SignalsPanel({
  entries, loading, onCompany, isNew, limit,
}: {
  entries: WatchEntry[]; loading: boolean;
  onCompany: (cik: string) => void;
  isNew?: (iso: string | null | undefined) => boolean;
  /** Show only the top N rows with a "Show all" toggle (dashboard panels). */
  limit?: number;
}) {
  const [dir, setDir] = useState<Direction | "all">("all");
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => buildWatchlistSignals(entries).filter((r) => r.signals.length > 0), [entries]);
  const shown = useMemo(() => {
    if (dir === "all") return rows;
    return rows
      .map((r) => ({ ...r, signals: r.signals.filter((s) => s.dir === dir) }))
      .filter((r) => r.signals.length > 0);
  }, [rows, dir]);
  const counts = useMemo(() => {
    let bull = 0, bear = 0, flag = 0;
    for (const r of rows) for (const s of r.signals) {
      if (s.dir === "bull") bull++; else if (s.dir === "bear") bear++; else if (s.dir === "flag") flag++;
    }
    return { bull, bear, flag };
  }, [rows]);

  const toggle = (d: Direction) => setDir(dir === d ? "all" : d);
  const capped = limit != null && !expanded && shown.length > limit;
  const visible = capped ? shown.slice(0, limit) : shown;

  return (
    <Panel
      title="Signals" count={rows.length}
      sub="Most actionable first"
      flush
      actions={
        <div className="seg" role="group" aria-label="Filter signals by direction">
          <button className={`seg-btn${dir === "all" ? " active" : ""}`} onClick={() => setDir("all")}>All</button>
          <button className={`seg-btn dir-bull${dir === "bull" ? " active" : ""}`} onClick={() => toggle("bull")} title="Bullish signals">▲ {counts.bull}</button>
          <button className={`seg-btn dir-bear${dir === "bear" ? " active" : ""}`} onClick={() => toggle("bear")} title="Bearish signals">▼ {counts.bear}</button>
          <button className={`seg-btn dir-flag${dir === "flag" ? " active" : ""}`} onClick={() => toggle("flag")} title="Flags — needs a look">◆ {counts.flag}</button>
        </div>
      }
    >
      {loading ? (
        <RowsSkeleton />
      ) : shown.length === 0 ? (
        <div className="panel-empty">No active signals across your watchlist yet. Signals appear as filings are ingested.</div>
      ) : (
        <div className="srow-list">
          {visible.map((r) => (
            <CompanyRow
              key={r.cik} ticker={r.ticker} name={r.name} onOpen={() => onCompany(r.cik)}
              meta={
                <>
                  {isNew?.(r.latest) && <span className="new-dot" title="New activity since your last visit">NEW</span>}
                  {r.insider.clusterBuy && <span className="dir-bull" title="Several insiders bought recently">cluster buy</span>}
                  {elapsed(r.latest) && <span className="srow-age" title={fmtDate(r.latest)}>{elapsed(r.latest)}</span>}
                </>
              }
            >
              {r.signals.map((s) => <SignalPill key={s.label} s={s} />)}
            </CompanyRow>
          ))}
          {limit != null && shown.length > limit && (
            <button className="panel-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show fewer" : `Show all ${shown.length}`}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

type MomSetup = { label: string; dir: Direction; tip: string };

export function momentumSetups(t: Technicals): MomSetup[] {
  const out: MomSetup[] = [];
  if (t.new52wHigh) out.push({ label: "52-wk breakout", dir: "bull", tip: "Closed at a fresh 52-week high — momentum at the top of its range." });
  if (t.new52wLow) out.push({ label: "52-wk low", dir: "bear", tip: "Closed at a fresh 52-week low." });
  if (t.cross === "golden") out.push({ label: "Golden cross", dir: "bull", tip: "50-day MA just crossed above the 200-day." });
  if (t.cross === "death") out.push({ label: "Death cross", dir: "bear", tip: "50-day MA just crossed below the 200-day." });
  if (t.rsi14 != null && t.rsi14 >= 70) out.push({ label: `RSI ${t.rsi14.toFixed(0)} · overbought`, dir: "bear", tip: "14-day RSI ≥ 70 — possibly overextended." });
  if (t.rsi14 != null && t.rsi14 <= 30) out.push({ label: `RSI ${t.rsi14.toFixed(0)} · oversold`, dir: "bull", tip: "14-day RSI ≤ 30 — possibly oversold." });
  if (t.volSpike != null && t.volSpike >= 2) out.push({ label: `Vol ${t.volSpike.toFixed(1)}× avg`, dir: "flag", tip: "Latest volume ≥ 2× the 30-day average." });
  return out;
}

export function MomentumPanel({
  companies, tech, onCompany, limit,
}: { companies: Company[]; tech: Record<string, Technicals>; onCompany: (cik: string) => void; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(
    () => companies
      .map((c) => ({ c, setups: tech[c.cik] ? momentumSetups(tech[c.cik]) : [] }))
      .filter((r) => r.setups.length > 0)
      .sort((a, b) => b.setups.length - a.setups.length),
    [companies, tech],
  );

  return (
    <Panel title="Momentum" count={rows.length} sub="End-of-day price setups" flush>
      {rows.length === 0 ? (
        <div className="panel-empty">No breakouts, crosses, RSI extremes or volume spikes firing right now.</div>
      ) : (
        <div className="srow-list">
          {(limit != null && !expanded ? rows.slice(0, limit) : rows).map(({ c, setups }) => (
            <CompanyRow key={c.cik} ticker={c.ticker ?? "?"} name={c.name ?? c.cik} onOpen={() => onCompany(c.cik)}>
              {setups.map((s) => (
                <span key={s.label} className={`pill dir-${s.dir}`} title={s.tip}>
                  <span className="pill-mark" aria-hidden>{DIR_MARK[s.dir]}</span>
                  <span className="pill-status">{s.label}</span>
                </span>
              ))}
            </CompanyRow>
          ))}
          {limit != null && rows.length > limit && (
            <button className="panel-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
