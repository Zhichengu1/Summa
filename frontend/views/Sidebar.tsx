"use client";
// Sidebar — brand, primary nav, and the personal watchlist list (with a 30-day
// filing count / pending indicator per company and an inline remove button).
import { useMemo } from "react";

import { CompanyMark } from "../components/badges/CompanyMark";
import { fmtPct } from "../lib/utils/format";
import type { Company, Filing, MainView, CompanySummary } from "../lib/types";

export function Sidebar({
  companies, filings, activeCik, view, ingestedCiks, prices,
  onCompany, onOverview, onSearch, onFeed, onCalendar, onManagers, onIpos, onGuide, onRemove, newFilings = 0,
}: {
  companies: Company[]; filings: Filing[];
  activeCik: string | null; view: MainView;
  ingestedCiks: Set<string>;
  prices: Map<string, CompanySummary>;
  onCompany: (cik: string) => void;
  onOverview: () => void; onSearch: () => void; onFeed: () => void; onCalendar: () => void; onManagers: () => void; onIpos: () => void; onGuide: () => void;
  onRemove: (cik: string) => void;
  newFilings?: number;
}) {
  const recent30 = useMemo(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const m = new Map<string, number>();
    for (const f of filings) {
      if (f.filed_at && new Date(f.filed_at).getTime() > cutoff)
        m.set(f.cik, (m.get(f.cik) ?? 0) + 1);
    }
    return m;
  }, [filings]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand" onClick={onOverview}>
        Summa<span className="dot">.</span>
      </div>
      <nav className="sidebar-nav">
        <div className={`nav-item${view === "overview" ? " active" : ""}`} onClick={onOverview}>
          ◈ Overview
        </div>
        <div className={`nav-item${view === "search" ? " active" : ""}`} onClick={onSearch}>
          ⌕ Search Companies
        </div>
        <div className={`nav-item${view === "feed" ? " active" : ""}`} onClick={onFeed}>
          ≡ Feed
          {newFilings > 0 && <span className="nav-badge" title={`${newFilings} new since your last visit`}>{newFilings > 99 ? "99+" : newFilings}</span>}
        </div>
        <div className={`nav-item${view === "calendar" ? " active" : ""}`} onClick={onCalendar}>
          ◷ Calendar
        </div>
        <div className={`nav-item${view === "managers" ? " active" : ""}`} onClick={onManagers}>
          ⬡ Institutional Investors
        </div>
        <div className={`nav-item${view === "ipos" ? " active" : ""}`} onClick={onIpos}>
          ◆ IPOs
        </div>
        <div className={`nav-item${view === "guide" ? " active" : ""}`} onClick={onGuide}>
          ◇ Data Guide
        </div>
      </nav>
      <div className="sidebar-list-head">
        <span className="label-caps">Watchlist · {companies.length}</span>
        <button className="sidebar-add-btn" title="Search & add companies" onClick={onSearch}>+ Add</button>
      </div>
      <div className="sidebar-list">
        {companies.map((c) => {
          const cnt = recent30.get(c.cik) ?? 0;
          const pending = !ingestedCiks.has(c.cik);
          const px = prices.get(c.cik);
          const chg = px?.chg_1d ?? null;
          return (
            <div
              key={c.cik}
              className={`company-row${activeCik === c.cik ? " active" : ""}`}
              onClick={() => onCompany(c.cik)}
            >
              <CompanyMark ticker={c.ticker ?? "?"} size={22} />
              <span className="tkr">{c.ticker}</span>
              <span className="nm">{c.name}</span>
              {px?.last_close != null && (
                <span className="px" title={px.as_of ? `As of ${px.as_of}` : undefined}>
                  <span className="px-last">{px.last_close.toFixed(2)}</span>
                  {chg != null && (
                    <span className={`px-chg ${chg >= 0 ? "pos" : "neg"}`}>
                      {chg >= 0 ? "+" : ""}{fmtPct(chg)}
                    </span>
                  )}
                </span>
              )}
              {pending ? <span className="pending-dot" title="Queued — data appears after the next pipeline run">⏳</span>
                       : cnt > 0 ? <span className="cnt">{cnt}</span> : null}
              <button
                className="row-remove" title="Remove from watchlist"
                onClick={(e) => { e.stopPropagation(); onRemove(c.cik); }}
              >×</button>
            </div>
          );
        })}
        {companies.length === 0 && (
          <div className="sidebar-empty">Your watchlist is empty. <span className="link-like" onClick={onSearch}>Search companies</span> to add some.</div>
        )}
      </div>
    </aside>
  );
}
