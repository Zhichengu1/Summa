"use client";
// News tab — the company's complete recent headline feed (up to ~100, the full
// window Google News RSS returns), from the shared CompanyAux bundle. Same card
// styling as the global News view; searchable within the company.
import { useMemo, useState } from "react";

import { safeHref } from "../../lib/utils/url";
import { fmtDate, elapsed } from "../../lib/utils/format";
import type { CompanyAux } from "./companyAux";

const CAT_EMOJI: Record<string, string> = {
  Fed: "🏦", Macro: "🏛️", "M&A": "💼", Investment: "💡", FDA: "💊", Legal: "⚖️",
  Earnings: "📊", Distress: "🚨", Capital: "💰", Exec: "👔", Analyst: "⭐",
  Product: "🚀", Move: "📉", News: "📰",
};
const IMPORTANT_MIN = 4;  // "important" = Minor+ catalyst tier (below is generic/latest)

export function NewsTab({ aux, ticker }: { aux: CompanyAux; ticker: string }) {
  const { news, loading } = aux;
  const [q, setQ] = useState("");
  const [importantOnly, setImportantOnly] = useState(true);

  const displayed = useMemo(() => {
    let r = news;
    if (importantOnly) r = r.filter((n) => (n.importance ?? 0) >= IMPORTANT_MIN);
    if (q.trim()) {
      const t = q.toLowerCase();
      r = r.filter((n) =>
        (n.title ?? "").toLowerCase().includes(t) ||
        (n.source ?? "").toLowerCase().includes(t),
      );
    }
    return r;
  }, [news, q, importantOnly]);

  if (loading) return (
    <div className="skeleton-block">
      <div className="skeleton" style={{ height: 36, borderRadius: 4 }} />
      {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton" style={{ height: 46, borderRadius: 4, opacity: 0.8 - i * 0.1 }} />)}
    </div>
  );
  if (!news.length) return <div className="empty-note">No news found for {ticker}.</div>;

  return (
    <div>
      <div className="toggle-row">
        <button
          className={`chip${importantOnly ? " active" : ""}`}
          title="Show only trader-important headlines (earnings, M&A, analyst, FDA, legal…)"
          onClick={() => setImportantOnly((v) => !v)}
        >★ Important only</button>
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 220 }}
          placeholder={`Search ${ticker} news…`} value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="dimmed" style={{ fontSize: 11 }}>{displayed.length} of {news.length} headlines</span>
      </div>

      <div className="news-feed" style={{ maxWidth: "100%" }}>
        {displayed.map((n) => {
          const href = safeHref(n.link);
          const title = n.title ?? "(untitled)";
          return (
            <article key={`${n.cik}:${n.guid}`} className="news-card">
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
                  {n.source && <><span className="news-src">{n.source}</span><span className="news-sep">·</span></>}
                  <span className="news-time" title={fmtDate(n.published_at)}>
                    {elapsed(n.published_at) || fmtDate(n.published_at)}
                  </span>
                  {href && <a className="news-open" href={href} target="_blank" rel="noopener noreferrer" title="Open article">↗</a>}
                </div>
              </div>
            </article>
          );
        })}
        {displayed.length === 0 && <div className="empty-note">No headlines match “{q}”.</div>}
      </div>
    </div>
  );
}
