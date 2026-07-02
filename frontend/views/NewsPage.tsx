"use client";
// News — two live feeds behind one view:
//   • "Top Intelligence" (default): the curated, market-wide market_news feed
//     (SEC/Fed/FDA/PR Newswire), already importance-filtered to market-movers.
//   • "Watchlist": per-company Google News headlines (the `news` prop), grouped by day.
// Both stream in live via Supabase Realtime. company_news is owned by the root Page
// (for the nav badge); market_news is fetched + subscribed here.
import { useEffect, useMemo, useState } from "react";

import { CompanyMark } from "../components/badges/CompanyMark";
import { fetchMarketNews, subscribeMarketNews } from "../lib/data/data";
import { safeHref } from "../lib/utils/url";
import { fmtDate, elapsed } from "../lib/utils/format";
import type { NewsItem, MarketNews } from "../lib/types";

type Scope = "top" | "watchlist";

// Category → emoji chip (mirrors backend news_score.py CATEGORY_EMOJI).
const CAT_EMOJI: Record<string, string> = {
  Fed: "🏦", Macro: "🏛️", "M&A": "💼", Investment: "💡", FDA: "💊", Legal: "⚖️",
  Earnings: "📊", Distress: "🚨", Capital: "💰", Exec: "👔", Analyst: "⭐",
  Product: "🚀", Move: "📉", News: "📰",
};
// "Important" = a real catalyst (Minor tier and up); below this is generic/latest news.
const IMPORTANT_MIN = 4;

// Recency windows — the feed is about knowing BEFORE the move, so it defaults to
// the freshest window; older stored headlines stay one chip away.
const AGE_CHOICES: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 },
  { label: "3d", days: 3 },
  { label: "7d", days: 7 },
  { label: "All", days: null },
];
const DEFAULT_MAX_AGE_DAYS = 3;

function dayLabel(iso: string | null): string {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

export function NewsPage({ news, onCompany }: { news: NewsItem[]; onCompany: (cik: string) => void }) {
  const [scope, setScope] = useState<Scope>("top");
  const [market, setMarket] = useState<MarketNews[]>([]);
  const [q, setQ] = useState("");
  const [tickerFilter, setTickerFilter] = useState<string | null>(null);
  const [importantOnly, setImportantOnly] = useState(true);
  const [maxAgeDays, setMaxAgeDays] = useState<number | null>(DEFAULT_MAX_AGE_DAYS);

  // Curated market feed: fetch once + keep live.
  useEffect(() => { fetchMarketNews(200).then(setMarket); }, []);
  useEffect(() => subscribeMarketNews((incoming) => {
    setMarket((prev) => {
      if (prev.some((p) => p.guid === incoming.guid)) return prev;
      return [incoming, ...prev]
        .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
        .slice(0, 200);
    });
  }), []);

  const tickers = useMemo(() => {
    const s = new Set<string>();
    for (const n of news) if (n.ticker) s.add(n.ticker);
    return Array.from(s).sort();
  }, [news]);

  // Items missing a pubDate can't prove they're fresh, so a recency window hides them.
  const withinAge = (iso: string | null, cutoff: string | null) =>
    cutoff === null || (iso !== null && iso >= cutoff);

  const marketShown = useMemo(() => {
    const cutoff = maxAgeDays === null
      ? null : new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    let r = market.filter((n) => withinAge(n.published_at, cutoff));
    if (q.trim()) {
      const t = q.toLowerCase();
      r = r.filter((n) =>
        (n.title ?? "").toLowerCase().includes(t) ||
        (n.source ?? "").toLowerCase().includes(t) ||
        (n.category ?? "").toLowerCase().includes(t),
      );
    }
    return r;
  }, [market, q, maxAgeDays]);

  const companyShown = useMemo(() => {
    const cutoff = maxAgeDays === null
      ? null : new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    let r = news.filter((n) => withinAge(n.published_at, cutoff));
    if (importantOnly) r = r.filter((n) => (n.importance ?? 0) >= IMPORTANT_MIN);
    if (tickerFilter) r = r.filter((n) => n.ticker === tickerFilter);
    if (q.trim()) {
      const t = q.toLowerCase();
      r = r.filter((n) =>
        (n.title ?? "").toLowerCase().includes(t) ||
        (n.company_name ?? "").toLowerCase().includes(t) ||
        (n.ticker ?? "").toLowerCase().includes(t) ||
        (n.source ?? "").toLowerCase().includes(t),
      );
    }
    return r;
  }, [news, q, tickerFilter, importantOnly, maxAgeDays]);

  const companySections = useMemo(() => {
    const out: { label: string; items: NewsItem[] }[] = [];
    for (const n of companyShown) {
      const label = dayLabel(n.published_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [companyShown]);

  const count = scope === "top" ? marketShown.length : companyShown.length;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          News
          <span className="live-dot" title="Live — updates in real time" />
        </h1>
        <div className="page-sub">
          {scope === "top"
            ? `${count} market-moving alerts · SEC · Fed · FDA · PR Newswire · live`
            : `${count} ${importantOnly ? "important " : ""}watchlist headlines · Google News · live`}
        </div>
      </div>

      <div className="toggle-row">
        <button className={`chip${scope === "top" ? " active" : ""}`} onClick={() => setScope("top")}>
          🔥 Top Intelligence
        </button>
        <button className={`chip${scope === "watchlist" ? " active" : ""}`} onClick={() => setScope("watchlist")}>
          ★ Watchlist
        </button>
        <span className="chip-sep">|</span>
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 220 }}
          placeholder="Search…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="chip-sep">|</span>
        {AGE_CHOICES.map((c) => (
          <button
            key={c.label}
            className={`chip${maxAgeDays === c.days ? " active" : ""}`}
            title={c.days === null ? "Show every stored headline" : `Only headlines from the last ${c.label}`}
            onClick={() => setMaxAgeDays(c.days)}
          >{c.label}</button>
        ))}
        {scope === "watchlist" && (
          <>
            <button
              className={`chip${importantOnly ? " active" : ""}`}
              title="Show only trader-important headlines (earnings, M&A, analyst, FDA, legal…)"
              onClick={() => setImportantOnly((v) => !v)}
            >★ Important only</button>
            <span className="chip-sep">|</span>
            <button className={`chip${tickerFilter === null ? " active" : ""}`} onClick={() => setTickerFilter(null)}>All</button>
            {tickers.map((t) => (
              <button
                key={t}
                className={`chip${tickerFilter === t ? " active" : ""}`}
                onClick={() => setTickerFilter(tickerFilter === t ? null : t)}
              >{t}</button>
            ))}
          </>
        )}
      </div>

      {scope === "top" ? (
        marketShown.length === 0 ? (
          <div className="news-empty">
            {market.length === 0
              ? "No market intelligence yet — curated alerts appear after the next pipeline run."
              : "No alerts in this window — widen the recency filter or clear the search."}
          </div>
        ) : (
          <div className="news-feed">
            {marketShown.map((n) => {
              const href = safeHref(n.link);
              const title = n.title ?? "(untitled)";
              const emoji = CAT_EMOJI[n.category ?? "News"] ?? "📰";
              return (
                <article key={n.guid} className="news-card">
                  <div className="news-body">
                    <div className="news-tags">
                      <span className="news-cat">{emoji} {n.category ?? "News"}</span>
                      {n.source && <span className="news-srcbadge">{n.source}</span>}
                    </div>
                    {href ? (
                      <a className="news-title" href={href} target="_blank" rel="noopener noreferrer">{title}</a>
                    ) : (
                      <span className="news-title">{title}</span>
                    )}
                    {n.summary && <p className="news-summary">{n.summary}</p>}
                    <div className="news-meta">
                      <span className="news-time" title={fmtDate(n.published_at)}>
                        {elapsed(n.published_at) || fmtDate(n.published_at)}
                      </span>
                      {href && <a className="news-open" href={href} target="_blank" rel="noopener noreferrer" title="Open article">↗</a>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : companyShown.length === 0 ? (
        <div className="news-empty">
          {news.length === 0
            ? "No news yet — headlines appear after the next pipeline run."
            : "No headlines match your filter."}
        </div>
      ) : (
        <div className="news-feed">
          {companySections.map((sec) => (
            <section key={sec.label} className="news-section">
              <div className="news-day">{sec.label}</div>
              {sec.items.map((n) => {
                const href = safeHref(n.link);
                const title = n.title ?? "(untitled)";
                return (
                  <article key={`${n.cik}:${n.guid}`} className="news-card">
                    <button className="news-mark" title={n.company_name ?? n.ticker ?? ""} onClick={() => onCompany(n.cik)}>
                      <CompanyMark ticker={n.ticker ?? "?"} size={30} />
                    </button>
                    <div className="news-body">
                      {n.category && n.category !== "News" && (n.importance ?? 0) > 0 && (
                        <div className="news-tags">
                          <span className="news-cat">{CAT_EMOJI[n.category] ?? "📰"} {n.category}</span>
                        </div>
                      )}
                      {href ? (
                        <a className="news-title" href={href} target="_blank" rel="noopener noreferrer">{title}</a>
                      ) : (
                        <span className="news-title">{title}</span>
                      )}
                      {n.summary && <p className="news-summary">{n.summary}</p>}
                      <div className="news-meta">
                        <button className="news-tkr" onClick={() => onCompany(n.cik)}>{n.ticker ?? n.company_name ?? "—"}</button>
                        {n.source && <><span className="news-sep">·</span><span className="news-src">{n.source}</span></>}
                        <span className="news-sep">·</span>
                        <span className="news-time" title={fmtDate(n.published_at)}>
                          {elapsed(n.published_at) || fmtDate(n.published_at)}
                        </span>
                        {href && <a className="news-open" href={href} target="_blank" rel="noopener noreferrer" title="Open article">↗</a>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
