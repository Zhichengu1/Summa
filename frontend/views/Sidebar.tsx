"use client";
// Sidebar — brand, grouped primary nav, and the personal watchlist list (with a
// 30-day filing count / pending indicator per company and an inline remove button).
//
// Navigation is declared once in NAV_GROUPS so the sidebar, the hash router and
// the mobile drawer all agree on which views exist. Every item is a real <button>
// (keyboard focusable, aria-current on the active one) with a one-line
// description as its tooltip, so a first-time user can tell what each view is
// for before clicking it.
import { useMemo } from "react";

import { CompanyMark } from "../components/badges/CompanyMark";
import { fmtPct } from "../lib/utils/format";
import type { Company, Filing, MainView, CompanySummary } from "../lib/types";

export type NavItem = {
  view: Exclude<MainView, "company">;
  label: string;
  icon: string;
  /** One-line "what is this page" — shown as the tooltip and on the Data Guide. */
  desc: string;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Your watchlist",
    items: [
      { view: "overview", label: "Overview",  icon: "◈", desc: "Live signals, momentum setups and a price table for every company you follow" },
      { view: "calendar", label: "Calendar",  icon: "◷", desc: "Recent and dated catalysts across your watchlist, grouped by day" },
      { view: "feed",     label: "Filings",   icon: "≡", desc: "Real-time SEC filings feed for your companies (10-K, 10-Q, 8-K, DEF 14A)" },
      { view: "news",     label: "News",      icon: "▤", desc: "Market-moving headlines: curated federal/market feeds plus per-company news" },
      { view: "search",   label: "Add companies", icon: "⌕", desc: "Search every US public company and add it to your watchlist" },
    ],
  },
  {
    label: "Market intelligence",
    items: [
      { view: "trends",   label: "Trends",       icon: "◭", desc: "What tracked companies are collectively investing in, from 10-K/10-Q language and capital" },
      { view: "managers", label: "Institutions", icon: "⬡", desc: "What the big 13F managers hold and what they bought or sold last quarter" },
      { view: "options",  label: "Options Radar", icon: "⧉", desc: "Calls-vs-puts bias, volatility pricing and a suggested structure per company" },
      { view: "ipos",     label: "IPOs",         icon: "◆", desc: "The live IPO pipeline: registrations, pricings and withdrawals market-wide" },
      { view: "congress", label: "Congress",     icon: "⚖", desc: "STOCK-Act trades by members of Congress, with consensus buys and sells" },
      { view: "reddit",   label: "Reddit Buzz",  icon: "◍", desc: "Most-discussed tickers on the investing subreddits, refreshed daily" },
      { view: "cot",      label: "COT Futures",  icon: "◮", desc: "Weekly CFTC positioning: speculators vs hedgers across major futures" },
    ],
  },
  {
    label: "Help",
    items: [
      { view: "guide", label: "Data Guide", icon: "◇", desc: "What every dataset means and how much it tends to move a stock" },
    ],
  },
];

export function Sidebar({
  companies, filings, activeCik, view, ingestedCiks, prices,
  onCompany, onNavigate, onRemove, newFilings = 0, newNews = 0,
  open = false, onClose,
}: {
  companies: Company[]; filings: Filing[];
  activeCik: string | null; view: MainView;
  ingestedCiks: Set<string>;
  prices: Map<string, CompanySummary>;
  onCompany: (cik: string) => void;
  onNavigate: (view: Exclude<MainView, "company">) => void;
  onRemove: (cik: string) => void;
  newFilings?: number;
  newNews?: number;
  /** Mobile drawer state — ignored on wide viewports where the sidebar is always shown. */
  open?: boolean;
  onClose?: () => void;
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

  const badgeFor = (v: MainView): number => (v === "feed" ? newFilings : v === "news" ? newNews : 0);

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} aria-hidden />}
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Primary navigation">
        <div className="sidebar-brand-row">
          <button className="sidebar-brand" onClick={() => onNavigate("overview")} title="Back to the overview">
            Summa<span className="dot">.</span>
          </button>
          {onClose && (
            <button className="sidebar-close" onClick={onClose} aria-label="Close menu">×</button>
          )}
        </div>

        <nav className="sidebar-nav">
          {NAV_GROUPS.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((it) => {
                const active = view === it.view;
                const badge = badgeFor(it.view);
                return (
                  <button
                    key={it.view}
                    className={`nav-item${active ? " active" : ""}`}
                    onClick={() => onNavigate(it.view)}
                    title={it.desc}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="nav-icon" aria-hidden>{it.icon}</span>
                    <span className="nav-label">{it.label}</span>
                    {badge > 0 && (
                      <span className="nav-badge" title={`${badge} new since your last visit`}>
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-list-head">
          <span className="label-caps">Watchlist · {companies.length}</span>
          <button className="sidebar-add-btn" title="Search & add companies" onClick={() => onNavigate("search")}>+ Add</button>
        </div>
        <div className="sidebar-list" role="list">
          {companies.map((c) => {
            const cnt = recent30.get(c.cik) ?? 0;
            const pending = !ingestedCiks.has(c.cik);
            const px = prices.get(c.cik);
            const chg = px?.chg_1d ?? null;
            const isActive = activeCik === c.cik;
            return (
              <div
                key={c.cik}
                role="listitem"
                className={`company-row${isActive ? " active" : ""}`}
                onClick={() => onCompany(c.cik)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCompany(c.cik); } }}
                tabIndex={0}
                title={`${c.ticker ?? ""} · ${c.name ?? ""}${cnt ? ` · ${cnt} filings in 30d` : ""}`}
                aria-current={isActive ? "true" : undefined}
              >
                <CompanyMark ticker={c.ticker ?? "?"} size={22} />
                <span className="tkr">{c.ticker}</span>
                <span className="nm">{c.name}</span>
                {px?.last_close != null && (
                  <span className="px" title={px.as_of ? `Last close · as of ${px.as_of}` : "Last close"}>
                    <span className="px-last">{px.last_close.toFixed(2)}</span>
                    {chg != null && (
                      <span className={`px-chg ${chg >= 0 ? "pos" : "neg"}`}>
                        {chg >= 0 ? "+" : ""}{fmtPct(chg)}
                      </span>
                    )}
                  </span>
                )}
                {pending
                  ? <span className="pending-dot" title="Queued — data appears after the next pipeline run (≈10 min)">⏳</span>
                  : cnt > 0 ? <span className="cnt" title={`${cnt} filings in the last 30 days`}>{cnt}</span> : null}
                <button
                  className="row-remove" title="Remove from watchlist" aria-label={`Remove ${c.ticker ?? c.name} from watchlist`}
                  onClick={(e) => { e.stopPropagation(); onRemove(c.cik); }}
                >×</button>
              </div>
            );
          })}
          {companies.length === 0 && (
            <div className="sidebar-empty">
              Your watchlist is empty.{" "}
              <button className="link-like" onClick={() => onNavigate("search")}>Add companies</button> to start tracking their filings.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
