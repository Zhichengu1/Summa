"use client";
// CompanyPeek — the hover/focus "peek" card for a watchlist row: the company's
// key numbers (last, 1D, YTD, vs 52w high, a 3-month sparkline), its latest filing
// and any flags, plus direct links into the company's tabs — so a reader can see
// what matters and jump straight to the right tab without opening the page first.
// Rendered into document.body (portal) so the sidebar's scroll clipping never cuts
// it off; positioned by the caller (viewport coordinates).
import { createPortal } from "react-dom";

import { CompanyMark } from "./badges/CompanyMark";
import { Icon } from "./Icon";
import { FormBadge } from "./badges/FormBadge";
import { Sparkline } from "./charts/Sparkline";
import { profileFor } from "../lib/domain/taxonomy";
import { fmtUSD, fmtDelta, fmtPct, fmtDate, elapsed } from "../lib/utils/format";
import type { Company, CompanySummary, CompanyTab } from "../lib/types";

const TABS: { key: CompanyTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "fundamentals", label: "Financials" },
  { key: "ownership", label: "Ownership" },
  { key: "catalysts", label: "Catalysts" },
  { key: "filings", label: "Filings" },
  { key: "news", label: "News" },
];

export function CompanyPeek({
  company, summary, filings30, pending, top, left, onOpen, onMouseEnter, onMouseLeave,
}: {
  company: Company;
  summary?: CompanySummary;
  filings30: number;
  pending: boolean;
  /** Viewport coordinates of the card's top-left corner. */
  top: number; left: number;
  onOpen: (cik: string, tab?: CompanyTab) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  if (typeof document === "undefined") return null;
  const profile = profileFor(company.ticker, company.sector, company.industry, company.cik);
  const s = summary;
  const flags: { text: string; dir: "bull" | "bear" | "flag" }[] = [];
  if (s?.cluster_buy) flags.push({ text: "Insider cluster buy", dir: "bull" });
  if (s?.new_52w_high) flags.push({ text: "52-wk high", dir: "bull" });
  if (s?.new_52w_low) flags.push({ text: "52-wk low", dir: "bear" });
  if (s?.ma_cross === "golden") flags.push({ text: "Golden cross", dir: "bull" });
  if (s?.ma_cross === "death") flags.push({ text: "Death cross", dir: "bear" });
  if (s?.rsi14 != null && s.rsi14 >= 70) flags.push({ text: `RSI ${s.rsi14.toFixed(0)} overbought`, dir: "bear" });
  if (s?.rsi14 != null && s.rsi14 <= 30) flags.push({ text: `RSI ${s.rsi14.toFixed(0)} oversold`, dir: "bull" });
  if (s?.vol_spike != null && s.vol_spike >= 2) flags.push({ text: `Volume ${s.vol_spike.toFixed(1)}× avg`, dir: "flag" });
  if (s?.net_insider_90d != null && s.net_insider_90d !== 0) {
    flags.push({ text: `Insiders net ${s.net_insider_90d > 0 ? "buying" : "selling"} ${fmtUSD(Math.abs(s.net_insider_90d))} · 90d`, dir: s.net_insider_90d > 0 ? "bull" : "bear" });
  }

  return createPortal(
    <div
      className="peek" style={{ top, left }} role="dialog" aria-label={`${company.ticker} at a glance`}
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    >
      <div className="peek-head">
        <CompanyMark ticker={company.ticker ?? "?"} size={30} />
        <div className="peek-title">
          <div className="peek-tkr">{company.ticker} <span className="peek-name">{company.name}</span></div>
          <div className="peek-tags">
            {profile && profile.sector !== "—" && <span className="cat-chip sector">{profile.sector}</span>}
            {profile && profile.industry !== "—" && <span className="cat-chip">{profile.industry}</span>}
          </div>
        </div>
      </div>

      {pending ? (
        <div className="peek-pending"><Icon name="clock" size={13} /> Queued — data appears after the next pipeline run (≈10 min).</div>
      ) : (
        <>
          <div className="peek-quote">
            <div className="peek-last">{s?.last_close != null ? fmtUSD(s.last_close) : "—"}</div>
            <div className="peek-kv">
              <span className="peek-k">1D</span>
              <span className={`peek-v ${s?.chg_1d == null ? "" : s.chg_1d >= 0 ? "pos" : "neg"}`}>{fmtDelta(s?.chg_1d)}</span>
              <span className="peek-k">YTD</span>
              <span className={`peek-v ${s?.ret_ytd == null ? "" : s.ret_ytd >= 0 ? "pos" : "neg"}`}>{fmtDelta(s?.ret_ytd)}</span>
              <span className="peek-k">vs 52w hi</span>
              <span className="peek-v muted">{fmtPct(s?.pct_off_high)}</span>
            </div>
          </div>
          {s?.spark && s.spark.length > 1 && (
            <div className="peek-spark"><Sparkline values={s.spark} width={252} height={40} /></div>
          )}
          <div className="peek-row">
            {s?.last_filing_form
              ? <><FormBadge form={s.last_filing_form} /><span className="muted">{elapsed(s.last_filing_at) || fmtDate(s.last_filing_at)}</span></>
              : <span className="dimmed">No recent filing</span>}
            <span className="peek-spacer" />
            <span className="dimmed">{filings30} filing{filings30 === 1 ? "" : "s"} · 30d</span>
          </div>
          {flags.length > 0 && (
            <div className="peek-flags">
              {flags.map((f) => <span key={f.text} className={`pill dir-${f.dir}`}><span className="pill-status">{f.text}</span></span>)}
            </div>
          )}
        </>
      )}

      <div className="peek-links">
        {TABS.map((t) => (
          <button key={t.key} className="peek-link" onClick={() => onOpen(company.cik, t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="peek-hint"><kbd className="kbd">Enter</kbd> open · <kbd className="kbd">[</kbd> <kbd className="kbd">]</kbd> prev / next</div>
    </div>,
    document.body,
  );
}
