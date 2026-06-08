"use client";
// Watchlist-wide scanners surfaced on the Overview page:
//   • ScannerSection — every actionable fundamentals/filings signal across the
//     watchlist, ranked most-actionable first (buildWatchlistSignals), filterable
//     by direction. Reuses the exact SignalCard from the company cockpit.
//   • MomentumScanner — pure price-action setups (52-wk breakouts/lows, MA
//     crosses, RSI extremes, volume spikes) derived from the technicals snapshot
//     OverviewPage already fetched, ranked by how many setups are firing.
import { useMemo, useState } from "react";

import { CompanyMark } from "../components/badges/CompanyMark";
import { SignalCard } from "../components/SignalCard";
import { useWatchlistPulse } from "../lib/hooks/useWatchlistPulse";
import { buildWatchlistSignals, type Direction } from "../lib/domain/pulse";
import { elapsed, fmtDate } from "../lib/utils/format";
import type { Technicals } from "../lib/domain/technicals";
import type { Company } from "../lib/types";

export function ScannerSection({
  companies, onCompany, isNew,
}: { companies: Company[]; onCompany: (cik: string) => void; isNew?: (iso: string | null | undefined) => boolean }) {
  const { entries, loading } = useWatchlistPulse(companies);
  const [dir, setDir] = useState<Direction | "all">("all");

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

  return (
    <div className="section">
      <div className="section-title">Live Signals · {rows.length} compan{rows.length === 1 ? "y" : "ies"} active</div>
      <div className="toggle-row">
        <button className={`chip${dir === "all" ? " active" : ""}`} onClick={() => setDir("all")}>All</button>
        <button className={`chip${dir === "bull" ? " active" : ""}`} onClick={() => setDir(dir === "bull" ? "all" : "bull")}>▲ Bullish {counts.bull}</button>
        <button className={`chip${dir === "bear" ? " active" : ""}`} onClick={() => setDir(dir === "bear" ? "all" : "bear")}>▼ Bearish {counts.bear}</button>
        <button className={`chip${dir === "flag" ? " active" : ""}`} onClick={() => setDir(dir === "flag" ? "all" : "flag")}>◆ Flags {counts.flag}</button>
      </div>
      {loading ? (
        <div className="skeleton-block">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 84, borderRadius: 6, opacity: 0.8 - i * 0.18 }} />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-note">No active signals across your watchlist yet. Signals appear as filings are ingested.</div>
      ) : (
        <div className="scan-list">
          {shown.map((r) => (
            <div
              key={r.cik} className={`scan-row dir-${r.dominant}`} role="button" tabIndex={0}
              onClick={() => onCompany(r.cik)}
              onKeyDown={(e) => { if (e.key === "Enter") onCompany(r.cik); }}
            >
              <div className="scan-head">
                <CompanyMark ticker={r.ticker} size={26} />
                <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{r.ticker}</strong>
                <span className="dimmed" style={{ fontSize: 12 }}>{r.name}</span>
                <span className="scan-meta">
                  {isNew?.(r.latest) && <span className="new-dot" title="New activity since your last visit">NEW</span>}
                  {r.insider.clusterBuy && <span className="dir-bull" style={{ fontSize: 11 }}>⚑ cluster buy</span>}
                  {elapsed(r.latest) && <span className="muted" style={{ fontSize: 11 }} title={fmtDate(r.latest)}>{elapsed(r.latest)}</span>}
                </span>
              </div>
              <div className="signal-stack">
                {r.signals.map((s) => <SignalCard key={s.label} s={s} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type MomSetup = { label: string; dir: Direction; tip: string };

function momentumSetups(t: Technicals): MomSetup[] {
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

export function MomentumScanner({
  companies, tech, onCompany,
}: { companies: Company[]; tech: Record<string, Technicals>; onCompany: (cik: string) => void }) {
  const rows = useMemo(
    () => companies
      .map((c) => ({ c, setups: tech[c.cik] ? momentumSetups(tech[c.cik]) : [] }))
      .filter((r) => r.setups.length > 0)
      .sort((a, b) => b.setups.length - a.setups.length),
    [companies, tech],
  );
  if (rows.length === 0) return null;

  return (
    <div className="section">
      <div className="section-title">Momentum · {rows.length} setup{rows.length === 1 ? "" : "s"} firing</div>
      <div className="scan-list">
        {rows.map(({ c, setups }) => (
          <div
            key={c.cik} className="scan-row" role="button" tabIndex={0}
            onClick={() => onCompany(c.cik)}
            onKeyDown={(e) => { if (e.key === "Enter") onCompany(c.cik); }}
          >
            <div className="scan-head">
              <CompanyMark ticker={c.ticker ?? "?"} size={26} />
              <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{c.ticker}</strong>
              <span className="dimmed" style={{ fontSize: 12 }}>{c.name}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {setups.map((s) => (
                <span
                  key={s.label} className={`dir-${s.dir}`} title={s.tip}
                  style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", border: "1px solid var(--border-1)", borderRadius: 999, whiteSpace: "nowrap" }}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
