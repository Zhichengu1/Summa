"use client";
// Options Radar — the calls-vs-puts decision surface over `options_snapshots`
// (one daily CBOE chain snapshot per watchlist company, written by
// ingest/options_ingest.py).
//
// Every row answers two separate questions, because conflating them is how a
// correct directional call still loses money:
//   DIRECTION — where premium dollars are actually going (put/call by $, not
//     contract counts) blended with the price trend → a bias score.
//   PRICING  — is that premium cheap or rich (IV rank, or IV vs realized vol
//     until the table has a year of history) → buy premium vs spread it.
// The Structure column is the two combined: bullish + cheap vol → long calls;
// bullish + rich vol (or earnings days away) → call debit spread; no edge +
// rich vol → sell premium. Warnings name the specific ways the trade can fail —
// IV crush into earnings, a move already priced into the straddle, pin risk.
//
// Data is CBOE's free delayed feed (~15 min), refreshed by the main pipeline.
// This is a summary of what the chain is pricing, not advice.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { CompanyMark } from "../components/badges/CompanyMark";
import { fetchCompanySummaries, fetchOptionsSnapshots, fetchRecentEarnings } from "../lib/data/data";
import { nextEarningsEstimate } from "../lib/domain/catalysts";
import {
  buildOptionsRadar, buildOptionsTape, buildSpread, buildTradeCandidates, cheapestViable, sideOf,
  type BiasKind, type OptionsIdea, type StructureKey, type TradeCandidate,
  type TradeVerdict, type VolRegime,
} from "../lib/domain/options";
import { fmtDate, fmtNum, fmtUSD } from "../lib/utils/format";
import type { CompanySummary } from "../lib/types";

const BIAS_META: Record<BiasKind, { label: string; bg: string; fg: string }> = {
  bullish: { label: "BULLISH", bg: "rgba(34,197,94,0.16)", fg: "var(--pos)" },
  "lean-bullish": { label: "LEAN BULL", bg: "rgba(34,197,94,0.10)", fg: "var(--pos)" },
  neutral: { label: "NO EDGE", bg: "rgba(148,163,184,0.12)", fg: "var(--fg-3)" },
  "lean-bearish": { label: "LEAN BEAR", bg: "rgba(239,68,68,0.10)", fg: "var(--neg)" },
  bearish: { label: "BEARISH", bg: "rgba(239,68,68,0.15)", fg: "var(--neg)" },
};

// Structures are colored by what they DO, not by direction: buying premium
// (blue), defining risk with a spread (violet), selling premium (amber), and
// standing aside (muted). Direction is already carried by the Bias column, so
// reusing pos/neg here would double-encode it.
const STRUCTURE_META: Record<StructureKey, { fg: string; bg: string }> = {
  "long-calls": { fg: "#3b82f6", bg: "rgba(59,130,246,0.14)" },
  "long-puts": { fg: "#3b82f6", bg: "rgba(59,130,246,0.14)" },
  "call-spread": { fg: "#8b5cf6", bg: "rgba(139,92,246,0.14)" },
  "put-spread": { fg: "#8b5cf6", bg: "rgba(139,92,246,0.14)" },
  "sell-premium": { fg: "#d97706", bg: "rgba(217,119,6,0.16)" },
  straddle: { fg: "#0d9488", bg: "rgba(13,148,136,0.16)" },
  "stand-aside": { fg: "var(--fg-3)", bg: "rgba(148,163,184,0.10)" },
};

const VOL_META: Record<VolRegime, { label: string; fg: string }> = {
  cheap: { label: "CHEAP", fg: "var(--pos)" },
  fair: { label: "FAIR", fg: "var(--fg-2)" },
  rich: { label: "RICH", fg: "#d97706" },
};

type FilterKey = "all" | "value" | "calls" | "puts" | "cheap" | "rich" | "unusual" | "earnings";
const FILTERS: { key: FilterKey; label: string; title: string }[] = [
  { key: "all", label: "All", title: "Every company with an options chain" },
  { key: "value", label: "Best deals", title: "The recommended contract breaks even inside the move the chain itself prices, on a tight market" },
  { key: "calls", label: "Call setups", title: "Bias is bullish — flow and trend point up" },
  { key: "puts", label: "Put setups", title: "Bias is bearish — flow and trend point down" },
  { key: "cheap", label: "Cheap premium", title: "IV low in its own range — buying options is efficient here" },
  { key: "rich", label: "Rich premium", title: "IV high in its own range — favour spreads or selling premium" },
  { key: "unusual", label: "Unusual flow", title: "Contracts traded today far above their open interest" },
  { key: "earnings", label: "Earnings ≤14d", title: "Estimated earnings inside two weeks — IV crush risk" },
];

function Badge({ label, bg, fg, title }: { label: string; bg: string; fg: string; title?: string }) {
  return (
    <span title={title} style={{
      background: bg, color: fg, padding: "2px 8px", borderRadius: 4,
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

// Bias meter: a centre-zero bar running put-side (left) to call-side (right).
// The number carries the value — color never stands alone (the badge names it).
function BiasMeter({ score }: { score: number }) {
  const pct = Math.min(Math.abs(score), 100) / 2;   // half-width from centre
  const pos = score >= 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
      <div style={{ position: "relative", width: 78, height: 6, borderRadius: 3, background: "rgba(148,163,184,0.16)" }}>
        <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 10, background: "var(--border-1)" }} />
        <div style={{
          position: "absolute", top: 0, height: 6, borderRadius: 3,
          left: pos ? "50%" : `${50 - pct}%`, width: `${pct}%`,
          background: pos ? "var(--pos)" : "var(--neg)",
        }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, minWidth: 30, textAlign: "right" }}>
        {score > 0 ? "+" : ""}{score}
      </span>
    </div>
  );
}

// Share of premium going to calls vs puts — the single most direct "which side
// is money on" read, and the reason it's dollars rather than contract counts.
function FlowBar({ idea }: { idea: OptionsIdea }) {
  if (idea.callShare == null) return <span className="muted">—</span>;
  const call = idea.callShare;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}
      title={`Calls ${fmtUSD(idea.callPremium)} vs puts ${fmtUSD(idea.putPremium)} of premium traded · put/call by $ = ${fmtNum(idea.pcPremium, 2)} · by contracts = ${fmtNum(idea.pcVolume, 2)} · by open interest = ${fmtNum(idea.pcOi, 2)}`}>
      <div style={{ display: "flex", width: 78, height: 6, borderRadius: 3, overflow: "hidden", background: "rgba(148,163,184,0.16)" }}>
        <div style={{ width: `${call}%`, background: "var(--pos)" }} />
        <div style={{ width: `${100 - call}%`, background: "var(--neg)" }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 34, textAlign: "right" }}>
        {call.toFixed(0)}%C
      </span>
    </div>
  );
}

function VolCell({ idea }: { idea: OptionsIdea }) {
  const meta = VOL_META[idea.volRegime];
  const detail = idea.volBasis === "iv-rank"
    ? `IV rank ${idea.ivRank?.toFixed(0)}`
    : idea.volBasis === "iv-vs-rv"
      ? `IV/RV ${fmtNum(idea.ivRvRatio, 2)}`
      : "—";
  const title = idea.volBasis === "iv-rank"
    ? `Today's IV30 (${fmtNum(idea.iv30, 1)}%) sits at the ${idea.ivRank?.toFixed(0)}th percentile of its trailing year (${idea.ivRankObs} snapshots).`
    : idea.volBasis === "iv-vs-rv"
      ? `IV30 ${fmtNum(idea.iv30, 1)}% vs 30-session realized vol ${fmtNum(idea.rv30, 1)}%. IV rank needs ~20 daily snapshots (${idea.ivRankObs ?? 0} so far), so this is the cheap/rich read until then.`
      : "Not enough data to price the premium.";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }} title={title}>
      <span style={{ color: meta.fg, fontWeight: 700, fontSize: 10.5, letterSpacing: 0.4 }}>{meta.label}</span>
      <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{detail}</span>
    </div>
  );
}

const VERDICT_META: Record<TradeVerdict, { label: string; fg: string; bg: string }> = {
  // Value, not direction — so this uses the chart palette's teal/amber rather than
  // pos/neg, which the Bias column already owns.
  "good-value": { label: "GOOD VALUE", fg: "#0d9488", bg: "rgba(13,148,136,0.16)" },
  fair: { label: "FAIR", fg: "var(--fg-2)", bg: "rgba(148,163,184,0.12)" },
  expensive: { label: "EXPENSIVE", fg: "#d97706", bg: "rgba(217,119,6,0.16)" },
};

// How the required breakeven move compares to the move the chain itself prices.
// Under 1.0 the option pays inside what the market already expects; over 1.0 you
// are betting on something the market does not — the single most useful "is this a
// good deal" number on the page, so it gets a bar rather than a bare figure.
function CoverageBar({ coverage }: { coverage: number | null }) {
  if (coverage == null) return <span className="muted">—</span>;
  const pct = Math.min(coverage, 2) / 2 * 100;
  const color = coverage <= 0.85 ? "#0d9488" : coverage <= 1.15 ? "var(--fg-2)" : "#d97706";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}
      title={`Breakeven needs ${(coverage * 100).toFixed(0)}% of the move the chain prices. Under 100% = the option pays off inside what the market already expects.`}>
      <div style={{ position: "relative", width: 60, height: 6, borderRadius: 3, background: "rgba(148,163,184,0.16)" }}>
        <div style={{ position: "absolute", left: "50%", top: -2, width: 1, height: 10, background: "var(--border-1)" }} />
        <div style={{ position: "absolute", left: 0, top: 0, height: 6, width: `${pct}%`, borderRadius: 3, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color, minWidth: 36, textAlign: "right" }}>
        {(coverage * 100).toFixed(0)}%
      </span>
    </div>
  );
}

// The concrete trade: which strike, what it costs, what has to happen to make money,
// and what it costs you to be wrong about timing. This is the section that turns
// "long calls" into a decision.
function TradeSection({ idea }: { idea: OptionsIdea }) {
  const side = sideOf(idea.structure.key);
  const candidates = useMemo(() => buildTradeCandidates(idea, side), [idea, side]);
  const spread = useMemo(() => (side ? buildSpread(idea, side) : null), [idea, side]);
  const cheapest = useMemo(() => cheapestViable(candidates), [candidates]);

  if (!idea.candidates.length) {
    return (
      <p className="empty-note" style={{ marginTop: 0 }}>
        No liquid contracts stored for this company yet — the ladder needs a two-sided quote and at least 25 open
        interest per strike. It appears after the next snapshot if the chain qualifies.
      </p>
    );
  }
  if (!side) {
    return (
      <p className="empty-note" style={{ marginTop: 0 }}>
        No directional edge here, so there is no call-or-put pick to make. {idea.structure.detail}
      </p>
    );
  }

  const best = candidates[0];
  const wantsSpread = idea.structure.key === "call-spread" || idea.structure.key === "put-spread";

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
        🎯 The trade — {idea.structure.label.toLowerCase()}
      </div>

      {/* Headline pick: the spread when premium is rich, otherwise the single contract. */}
      {wantsSpread && spread ? (
        <div style={{ background: "var(--bg-2, rgba(148,163,184,0.06))", border: "1px solid var(--border-1)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13.5 }}>
              Buy {spread.label.split(" / ")[0]} · Sell {spread.label.split(" / ")[1]}
            </span>
            <Badge {...VERDICT_META[spread.emCoverage != null && spread.emCoverage <= 0.85 ? "good-value" : spread.emCoverage != null && spread.emCoverage <= 1.15 ? "fair" : "expensive"]} />
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
            <span title="What you pay per spread, and the most you can lose">Cost {fmtUSD(spread.debit)}</span>
            <span title="The most this can make, if the stock closes at or beyond the short strike">Max gain {fmtUSD(spread.maxProfit)}</span>
            <span title="Max gain divided by what you risk">R:R {spread.riskReward.toFixed(2)}×</span>
            <span title="The stock price where this trade breaks even at expiry">BE {fmtNum(spread.breakeven, 2)} ({spread.beMovePct.toFixed(1)}% away)</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            The short leg caps the upside but pays for part of the long leg — that is the point when premium is
            expensive or earnings are close, because it also cuts what you lose to an IV drop.
          </div>
        </div>
      ) : null}

      {best && (
        <div style={{ background: "var(--bg-2, rgba(148,163,184,0.06))", border: "1px solid var(--border-1)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13.5 }}>
              {wantsSpread ? "Single-leg alternative: " : "Best value: "}{best.label}
            </span>
            <Badge {...VERDICT_META[best.verdict]} />
            <span className="muted" style={{ fontSize: 11.5 }}>{best.leg.dte}d · {Math.abs(best.leg.delta * 100).toFixed(0)}Δ</span>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
            <span title="Premium for one contract (100 shares)">Cost {fmtUSD(best.cost)}</span>
            <span title="Where the stock must be at expiry to return the premium">BE {fmtNum(best.breakeven, 2)} ({best.beMovePct.toFixed(1)}% away)</span>
            <span title="Breakeven move as a share of the move the chain prices">vs priced move {best.emCoverage != null ? `${(best.emCoverage * 100).toFixed(0)}%` : "—"}</span>
            {best.thetaPctPerDay != null && <span title="Daily time decay as a % of the premium">decay {best.thetaPctPerDay.toFixed(1)}%/d</span>}
          </div>
          {best.notes.length > 0 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
              {best.notes.join(" ")}
            </div>
          )}
        </div>
      )}

      {cheapest && best && cheapest.label !== best.label && (
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)", marginBottom: 10 }}>
          <strong>Least expensive that still works:</strong>{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{cheapest.label}</span> at {fmtUSD(cheapest.cost)} — the
          cheapest contract whose breakeven ({cheapest.beMovePct.toFixed(1)}%) still sits inside the ±{fmtNum(idea.nearMovePct, 1)}%
          the chain prices. Anything cheaper needs a bigger move than the market expects.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--fg-3)", textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Contract</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }}>Cost</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }}>Breakeven</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Breakeven move ÷ the move the chain prices. Under 100% is the good half.">vs priced</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Delta — roughly the odds of finishing in the money">Δ</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Time decay per day, as % of premium">Decay</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }} title="Bid/ask width as % of premium — what the round trip costs you">Spread</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }}>OI</th>
              <th style={{ padding: "4px 8px", fontWeight: 600 }}>Value</th>
            </tr>
          </thead>
          <tbody style={{ fontFamily: "var(--font-mono)" }}>
            {candidates.map((c) => (
              <tr key={c.label} style={{ borderTop: "1px solid var(--border-1)", textAlign: "right" }}>
                <td style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap" }}>{c.label}
                  <span className="muted"> · {c.leg.dte}d</span>
                </td>
                <td style={{ padding: "5px 8px" }}>{fmtUSD(c.cost)}</td>
                <td style={{ padding: "5px 8px" }}>{fmtNum(c.breakeven, 2)} <span className="muted">({c.beMovePct.toFixed(1)}%)</span></td>
                <td style={{ padding: "5px 8px" }}>{c.emCoverage != null ? `${(c.emCoverage * 100).toFixed(0)}%` : "—"}</td>
                <td style={{ padding: "5px 8px" }}>{Math.abs(c.leg.delta * 100).toFixed(0)}</td>
                <td style={{ padding: "5px 8px" }}>{c.thetaPctPerDay != null ? `${c.thetaPctPerDay.toFixed(1)}%` : "—"}</td>
                <td style={{ padding: "5px 8px" }}>{c.spreadPct != null ? `${c.spreadPct.toFixed(0)}%` : "—"}</td>
                <td style={{ padding: "5px 8px" }}>{fmtNum(c.leg.oi, 0)}</td>
                <td style={{ padding: "5px 8px" }}>
                  <span style={{ color: VERDICT_META[c.verdict].fg, fontWeight: 600, fontSize: 10.5 }}>
                    {VERDICT_META[c.verdict].label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
        Costs are mid-market for one contract (100 shares) on ~15-minute delayed quotes — you will not always get the
        mid, and the Spread column is what that gap costs. Breakevens are at expiry; selling earlier can profit on a
        smaller move, or lose on the same one.
      </div>
    </div>
  );
}

function DetailPanel({ idea, onClose, onOpenCompany }: {
  idea: OptionsIdea; onClose: () => void; onOpenCompany: (cik: string) => void;
}) {
  const stats: [string, string, string][] = [
    ["Implied vol (30d)", `${fmtNum(idea.iv30, 1)}%`,
      idea.ivDelta != null ? `${idea.ivDelta >= 0 ? "+" : ""}${fmtNum(idea.ivDelta, 1)} vs prior day` : "the market's forecast"],
    ["Realized vol (30d)", `${fmtNum(idea.rv30, 1)}%`, "what the stock actually did"],
    ["IV rank", idea.ivRank != null ? idea.ivRank.toFixed(0) : "building",
      idea.ivRank != null ? `percentile of trailing year (${idea.ivRankObs} obs)` : `${idea.ivRankObs ?? 0}/20 snapshots collected`],
    ["25Δ skew", idea.skew25d != null ? `${fmtNum(idea.skew25d, 1)} pts` : "—", "put IV − call IV"],
    ["Expected move", idea.nearMovePct != null ? `±${fmtNum(idea.nearMovePct, 1)}%` : "—",
      idea.nearExpiry ? `by ${fmtDate(idea.nearExpiry, { utc: true })} (${idea.nearDte}d)` : "~30-day expiry"],
    ["Front expiry", idea.expectedMovePct != null ? `±${fmtNum(idea.expectedMovePct, 1)}%` : "—",
      idea.frontDte != null ? `${idea.frontDte}d out` : ""],
    ["Max pain", idea.maxPainPct != null ? `${idea.maxPainPct >= 0 ? "+" : ""}${fmtNum(idea.maxPainPct, 1)}%` : "—", "from spot, front expiry"],
    ["Premium traded", `${fmtUSD(idea.callPremium)} / ${fmtUSD(idea.putPremium)}`, "calls / puts today"],
  ];

  return (
    <div style={{ background: "var(--bg-1)", border: "1px solid var(--border-1)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <span onClick={() => onOpenCompany(idea.cik)}
          style={{ fontWeight: 700, fontSize: 15, color: "var(--accent)", cursor: "pointer" }}
          title="Open this company's page">
          {idea.ticker}
        </span>
        <Badge {...BIAS_META[idea.bias]} />
        <Badge label={idea.structure.label.toUpperCase()} {...STRUCTURE_META[idea.structure.key]} />
        <span className="muted" style={{ fontSize: 12 }}>
          snapshot {fmtDate(idea.date, { utc: true })} · CBOE delayed
        </span>
        <button className="chip active" style={{ marginLeft: "auto" }} onClick={onClose}>✕ close</button>
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--fg-1)", marginBottom: 12 }}>
        {idea.read} <strong>{idea.structure.label}:</strong> {idea.structure.detail}
      </div>

      <TradeSection idea={idea} />

      <div className="kpi-strip dense" style={{ marginBottom: 12 }}>
        {stats.map(([label, value, sub]) => (
          <div className="kpi" key={label}>
            <div className="k-label">{label}</div>
            <div className="k-value" style={{ fontSize: 15 }}>{value}</div>
            <div className="k-delta"><span>{sub}</span></div>
          </div>
        ))}
      </div>

      {idea.warnings.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>⚠️ Before you trade this</div>
          <div style={{ display: "grid", gap: 5 }}>
            {idea.warnings.map((w) => (
              <div key={w} style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>• {w}</div>
            ))}
          </div>
        </div>
      )}

      {idea.unusual.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
            🔥 Unusual contracts — volume far above open interest
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "var(--fg-3)", textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600 }}>Contract</th>
                  <th style={{ padding: "4px 8px", fontWeight: 600 }}>Volume</th>
                  <th style={{ padding: "4px 8px", fontWeight: 600 }}>Open int.</th>
                  <th style={{ padding: "4px 8px", fontWeight: 600 }}>Vol/OI</th>
                  <th style={{ padding: "4px 8px", fontWeight: 600 }}>IV</th>
                  <th style={{ padding: "4px 8px", fontWeight: 600 }}>Premium</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: "var(--font-mono)" }}>
                {idea.unusual.map((u) => (
                  <tr key={`${u.right}${u.strike}${u.expiry}`} style={{ borderTop: "1px solid var(--border-1)", textAlign: "right" }}>
                    <td style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap" }}>
                      <span style={{ color: u.right === "C" ? "var(--pos)" : "var(--neg)", fontWeight: 700 }}>
                        {u.right === "C" ? "CALL" : "PUT"}
                      </span>{" "}
                      {fmtNum(u.strike, 2)} · {u.expiry.slice(5)} ({u.dte}d)
                      {u.otm_pct != null && (
                        <span className="muted"> · {u.otm_pct >= 0 ? "+" : ""}{u.otm_pct.toFixed(1)}% away</span>
                      )}
                    </td>
                    <td style={{ padding: "5px 8px" }}>{fmtNum(u.volume, 0)}</td>
                    <td style={{ padding: "5px 8px" }}>{fmtNum(u.oi, 0)}</td>
                    <td style={{ padding: "5px 8px", fontWeight: 600 }}>{u.vol_oi != null ? `${u.vol_oi.toFixed(1)}×` : "—"}</td>
                    <td style={{ padding: "5px 8px" }}>{u.iv != null ? `${u.iv.toFixed(0)}%` : "—"}</td>
                    <td style={{ padding: "5px 8px" }}>{fmtUSD(u.premium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
            Volume above open interest means these positions were opened today rather than traded between existing
            holders. Deep in-the-money contracts are excluded — those are usually stock replacements, not directional bets.
            Direction is still an inference: the feed does not say whether each print was bought or sold.
          </div>
        </div>
      )}
    </div>
  );
}

export function OptionsPage({ onCompany }: { onCompany?: (cik: string) => void }) {
  const [ideas, setIdeas] = useState<OptionsIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [detailCik, setDetailCik] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchOptionsSnapshots(), fetchCompanySummaries(), fetchRecentEarnings()])
      .then(([snaps, summaries, earnings]) => {
        if (!live) return;
        const summaryByCik = new Map<string, CompanySummary>(summaries.map((s) => [s.cik, s]));

        // Estimated next-earnings date per company, from the reporting cadence
        // already in the warehouse — SEC data carries no forward calendar.
        const reported = new Map<string, string[]>();
        for (const e of earnings) {
          if (!e.reported_date) continue;
          const list = reported.get(e.cik);
          if (list) list.push(e.reported_date);
          else reported.set(e.cik, [e.reported_date]);
        }
        const earningsDays = new Map<string, number>();
        for (const [cik, dates] of reported) {
          const est = nextEarningsEstimate(dates);
          if (est) earningsDays.set(cik, est.daysAway);
        }

        setIdeas(buildOptionsRadar(snaps, summaryByCik, earningsDays));
        setLoading(false);
      })
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const tape = useMemo(() => buildOptionsTape(ideas), [ideas]);

  // The best-value contract per company, so the concrete pick is visible in the
  // table rather than only after opening a row. Declared before `shown` because
  // the "Best deals" filter reads it.
  const bestByCik = useMemo(() => {
    const m = new Map<string, TradeCandidate>();
    for (const i of ideas) {
      const side = sideOf(i.structure.key);
      if (!side) continue;
      const top = buildTradeCandidates(i, side)[0];
      if (top) m.set(i.cik, top);
    }
    return m;
  }, [ideas]);

  const shown = useMemo(() => {
    switch (filter) {
      case "value": return ideas.filter((i) => bestByCik.get(i.cik)?.verdict === "good-value");
      case "calls": return ideas.filter((i) => i.bias === "bullish" || i.bias === "lean-bullish");
      case "puts": return ideas.filter((i) => i.bias === "bearish" || i.bias === "lean-bearish");
      case "cheap": return ideas.filter((i) => i.volRegime === "cheap");
      case "rich": return ideas.filter((i) => i.volRegime === "rich");
      case "unusual": return ideas.filter((i) => i.unusual.length > 0);
      case "earnings": return ideas.filter((i) => i.daysToEarnings != null && i.daysToEarnings >= 0 && i.daysToEarnings <= 14);
      default: return ideas;
    }
  }, [ideas, filter, bestByCik]);

  const detail = detailCik ? ideas.find((i) => i.cik === detailCik) ?? null : null;

  const cols: Column<OptionsIdea>[] = [
    {
      key: "ticker", header: "Company", width: "132px", value: (i) => i.ticker,
      render: (i) => (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CompanyMark ticker={i.ticker} />
          <span style={{ fontWeight: 600 }}>{i.ticker}</span>
        </span>
      ),
    },
    {
      key: "spot", header: "Spot", width: "104px", align: "right", value: (i) => i.spot ?? 0,
      render: (i) => (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {fmtNum(i.spot, 2)}
          {i.changePct != null && (
            <span style={{ color: i.changePct >= 0 ? "var(--pos)" : "var(--neg)", marginLeft: 6 }}>
              {i.changePct >= 0 ? "+" : ""}{i.changePct.toFixed(1)}%
            </span>
          )}
        </span>
      ),
    },
    {
      key: "bias", header: "Bias", width: "124px", align: "right", value: (i) => i.biasScore,
      render: (i) => <BiasMeter score={i.biasScore} />,
    },
    {
      key: "biasLabel", header: "", width: "92px", value: (i) => i.bias,
      render: (i) => <Badge {...BIAS_META[i.bias]} title={i.read} />,
    },
    {
      key: "flow", header: "Premium flow", width: "128px", align: "right",
      value: (i) => i.callShare ?? 50, render: (i) => <FlowBar idea={i} />,
    },
    {
      key: "vol", header: "Premium priced", width: "150px", align: "right",
      value: (i) => i.ivRank ?? i.ivRvRatio ?? 0, render: (i) => <VolCell idea={i} />,
    },
    {
      key: "move", header: "Exp. move", width: "96px", align: "right",
      value: (i) => i.nearMovePct ?? 0,
      render: (i) => i.nearMovePct == null ? <span className="muted">—</span> : (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          title={`The ~${i.nearDte}d ATM straddle prices a ±${fmtNum(i.nearMovePct, 1)}% move by ${i.nearExpiry}. A directional buyer needs more than that to profit.`}>
          ±{i.nearMovePct.toFixed(1)}%
        </span>
      ),
    },
    {
      key: "earnings", header: "Earnings", width: "86px", align: "right",
      value: (i) => i.daysToEarnings ?? 9999,
      render: (i) => {
        if (i.daysToEarnings == null || i.daysToEarnings < 0) return <span className="muted">—</span>;
        const soon = i.daysToEarnings <= 10;
        return (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: soon ? "#d97706" : "var(--fg-2)", fontWeight: soon ? 700 : 400 }}
            title={soon ? "Estimated from past reporting cadence. Implied vol usually collapses right after the report — long premium can lose even on a correct direction." : "Estimated from past reporting cadence."}>
            ~{i.daysToEarnings}d
          </span>
        );
      },
    },
    {
      key: "structure", header: "Structure", width: "154px", value: (i) => i.structure.label,
      render: (i) => (
        <Badge label={i.structure.label.toUpperCase()} {...STRUCTURE_META[i.structure.key]} title={i.structure.detail} />
      ),
    },
    {
      key: "trade", header: "Best contract", width: "186px",
      value: (i) => bestByCik.get(i.cik)?.label ?? "",
      render: (i) => {
        const t = bestByCik.get(i.cik);
        if (!t) return <span className="muted">—</span>;
        return (
          <span style={{ display: "flex", flexDirection: "column", gap: 1, lineHeight: 1.35 }}
            title={`${t.label} · ${fmtUSD(t.cost)} per contract · breaks even at ${fmtNum(t.breakeven, 2)} (${t.beMovePct.toFixed(1)}% away, ${t.emCoverage != null ? `${(t.emCoverage * 100).toFixed(0)}% of the priced move` : "priced move unknown"})${t.notes.length ? ` — ${t.notes[0]}` : ""}`}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 600 }}>{t.label}</span>
            <span style={{ fontSize: 10.5, color: VERDICT_META[t.verdict].fg }}>
              {fmtUSD(t.cost)} · BE {t.beMovePct.toFixed(1)}%
            </span>
          </span>
        );
      },
    },
    {
      key: "value", header: "Deal", width: "104px", align: "right",
      value: (i) => bestByCik.get(i.cik)?.emCoverage ?? 99,
      render: (i) => <CoverageBar coverage={bestByCik.get(i.cik)?.emCoverage ?? null} />,
    },
    {
      key: "flags", header: "", width: "58px", align: "right",
      value: (i) => i.unusual.length,
      render: (i) => (
        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {i.unusual.length > 0 && <span title={`${i.unusual.length} contracts traded far above their open interest today`}>🔥</span>}
          {i.warnings.length > 0 && <span title={`${i.warnings.length} caveats — open the row`}> ⚠️</span>}
        </span>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Options Radar</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  const emptyNote = ideas.length === 0
    ? "No options snapshots yet — apply the updated schema.sql in Supabase, then let the pipeline run (options are snapshotted per company on a 12-hour cadence)."
    : "No companies match this filter.";

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Options Radar</h1>
        <div className="page-sub">
          Calls vs puts across {ideas.length} companies · <strong>Bias</strong> = where premium dollars are going, blended
          with the price trend · <strong>Premium priced</strong> = whether implied vol is cheap or rich in its own range ·
          <strong> Structure</strong> combines the two, because being right on direction and wrong on pricing still loses ·
          <strong> Best contract</strong> is the specific strike, its cost and its breakeven, and <strong>Deal</strong> is
          that breakeven as a share of the move the chain itself prices — under 100% means it pays off inside what the
          market already expects · CBOE delayed chain data, snapshot {tape.asOf ? fmtDate(tape.asOf, { utc: true }) : "—"} ·
          click a row for the full contract ladder
        </div>
      </div>

      <div className="toggle-row">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip${filter === f.key ? " active" : ""}`}
            title={f.title} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="kpi-strip dense" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="k-label">VIX</div>
          <div className="k-value" style={{ color: tape.vix != null && tape.vix >= 25 ? "#d97706" : undefined }}>
            {fmtNum(tape.vix, 2)}
          </div>
          <div className="k-delta">
            <span>{tape.vix == null ? "—" : tape.vix >= 25 ? "elevated — size down" : tape.vix <= 15 ? "calm — premium is cheap" : "normal regime"}</span>
          </div>
        </div>
        <div className="kpi">
          <div className="k-label">Premium to calls</div>
          <div className="k-value">{tape.callShare != null ? `${tape.callShare.toFixed(0)}%` : "—"}</div>
          <div className="k-delta"><span>watchlist-wide, by dollars traded</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "var(--pos)" }}>Call setups</div>
          <div className="k-value" style={{ color: "var(--pos)" }}>{tape.bullish}</div>
          <div className="k-delta"><span>bullish flow + trend</span></div>
        </div>
        <div className="kpi">
          <div className="k-label" style={{ color: "var(--neg)" }}>Put setups</div>
          <div className="k-value" style={{ color: "var(--neg)" }}>{tape.bearish}</div>
          <div className="k-delta"><span>bearish flow + trend</span></div>
        </div>
        <div className="kpi">
          <div className="k-label">Cheap / rich vol</div>
          <div className="k-value" style={{ fontSize: 16 }}>{tape.cheap} / {tape.rich}</div>
          <div className="k-delta"><span>buy premium vs spread it</span></div>
        </div>
      </div>

      {detail && (
        <DetailPanel idea={detail} onClose={() => setDetailCik(null)}
          onOpenCompany={(cik) => onCompany?.(cik)} />
      )}

      <DataTable
        columns={cols} rows={shown} rowKey={(i) => i.cik}
        empty={emptyNote} maxHeight="calc(100vh - 360px)"
        filterable filterPlaceholder="Filter by ticker…"
        initialSort={{ key: "bias", dir: "desc" }}
        onRowClick={(i) => setDetailCik((c) => (c === i.cik ? null : i.cik))}
      />

      <p className="empty-note" style={{ marginTop: 12, lineHeight: 1.6 }}>
        Options data is CBOE&apos;s free delayed feed (~15 minutes) snapshotted once or twice a day — it shows where
        positioning stood, not a live tape. Earnings dates are <em>estimated</em> from past reporting cadence, since SEC
        filings carry no forward calendar. IV rank needs ~20 daily snapshots per company before it appears; until then the
        cheap/rich read comes from implied vs realized volatility. None of this is advice.
      </p>
    </div>
  );
}
