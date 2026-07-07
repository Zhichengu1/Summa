"use client";
// Reddit Buzz — the daily most-discussed-stocks leaderboard from the big
// investing subreddits (reddit_trends: ApeWisdom ranks + Tradestie WSB
// sentiment, one snapshot per UTC day, ~30-day window). GLOBAL market chatter,
// not watchlist-scoped — watchlist tickers get a ⭐ and click through to their
// company page. A day-chip row flips between stored snapshots, and each ticker
// gets a mentions sparkline across the fetched window so a one-day spike reads
// differently from sustained chatter.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { Sparkline } from "../components/charts/Sparkline";
import { fetchRedditTrends } from "../lib/data/data";
import { fmtNum, fmtDate } from "../lib/utils/format";
import type { Company, RedditTrend } from "../lib/types";

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span className="muted">—</span>;
  const bullish = /bull/i.test(sentiment);
  return (
    <span style={{
      background: bullish ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.15)",
      color: bullish ? "#22c55e" : "#ef4444",
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700,
      letterSpacing: 0.3, whiteSpace: "nowrap",
    }}>
      {bullish ? "Bullish" : "Bearish"}
    </span>
  );
}

// Signed delta with direction color: climbing/growing green, fading red.
function Delta({ v, suffix = "" }: { v: number | null; suffix?: string }) {
  if (v == null || v === 0) return <span className="muted">–</span>;
  const up = v > 0;
  return (
    <span style={{ color: up ? "var(--pos)" : "var(--neg)", fontWeight: 600 }}>
      {up ? "▲" : "▼"} {fmtNum(Math.abs(v), 0)}{suffix}
    </span>
  );
}

export function RedditPage({ companies, onCompany }: {
  companies: Company[];
  onCompany: (cik: string) => void;
}) {
  const [rows, setRows] = useState<RedditTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState<string | null>(null);   // null → latest
  const [watchOnly, setWatchOnly] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetchRedditTrends().then((r) => { setRows(r); setLoading(false); });
  }, []);

  // Watchlist ticker → cik, for stars + click-through to the company page.
  const watchByTicker = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies) if (c.ticker) m.set(c.ticker.toUpperCase(), c.cik);
    return m;
  }, [companies]);

  // Snapshot days present in the window, newest first (rows arrive pre-sorted).
  const days = useMemo(
    () => Array.from(new Set(rows.map((r) => r.trend_date))),
    [rows],
  );
  const activeDay = day ?? days[0] ?? null;

  // Per-ticker mentions across the fetched window, oldest→newest, for sparklines.
  const history = useMemo(() => {
    const byTicker = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (r.mentions == null) continue;
      let m = byTicker.get(r.ticker);
      if (!m) { m = new Map(); byTicker.set(r.ticker, m); }
      m.set(r.trend_date, r.mentions);
    }
    const asc = [...days].sort();
    const out = new Map<string, number[]>();
    for (const [t, m] of byTicker) {
      const series = asc.filter((d) => m.has(d)).map((d) => m.get(d)!);
      if (series.length >= 2) out.set(t, series);
    }
    return out;
  }, [rows, days]);

  const displayed = useMemo(() => {
    let r = rows.filter((x) => x.trend_date === activeDay);
    if (watchOnly) r = r.filter((x) => watchByTicker.has(x.ticker));
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((x) =>
        x.ticker.toLowerCase().includes(n) || (x.name ?? "").toLowerCase().includes(n));
    }
    return r;
  }, [rows, activeDay, watchOnly, watchByTicker, q]);

  const cols: Column<RedditTrend>[] = [
    { key: "rank", header: "#", width: "44px", align: "right", value: (r) => r.rank ?? 9_999,
      render: (r) => (
        <span style={{
          fontWeight: 700,
          color: r.rank != null && r.rank <= 3 ? "var(--accent)" : "var(--fg-3)",
        }}>{r.rank ?? "—"}</span>
      ) },
    { key: "ticker", header: "Ticker", width: "92px", value: (r) => r.ticker,
      render: (r) => (
        <span style={{ color: "var(--accent)", fontWeight: 700, whiteSpace: "nowrap" }}>
          {r.ticker}{watchByTicker.has(r.ticker) && (
            <span title="On your watchlist" style={{ marginLeft: 4 }}>⭐</span>
          )}
        </span>
      ) },
    { key: "name", header: "Company", value: (r) => r.name ?? "",
      render: (r) => <span className={r.name ? undefined : "muted"}>{r.name ?? "—"}</span> },
    { key: "mentions", header: "Mentions", width: "96px", align: "right",
      value: (r) => r.mentions ?? -1,
      render: (r) => <span style={{ fontWeight: 700 }}>{r.mentions != null ? fmtNum(r.mentions, 0) : "—"}</span> },
    { key: "mchange", header: "Δ 24h", width: "86px", align: "right",
      value: (r) => r.mentions_change ?? 0,
      render: (r) => <Delta v={r.mentions_change} /> },
    { key: "rchange", header: "Rank Δ", width: "80px", align: "right",
      value: (r) => r.rank_change ?? 0,
      render: (r) => <Delta v={r.rank_change} /> },
    { key: "upvotes", header: "Upvotes", width: "90px", align: "right",
      value: (r) => r.upvotes ?? -1,
      render: (r) => <span className="muted">{r.upvotes != null ? fmtNum(r.upvotes, 0) : "—"}</span> },
    { key: "sentiment", header: "WSB mood", width: "104px", value: (r) => r.sentiment ?? "",
      render: (r) => <SentimentBadge sentiment={r.sentiment} /> },
    { key: "spark", header: `Mentions · ${days.length}d`, width: "104px", value: () => null,
      render: (r) => {
        const s = history.get(r.ticker);
        return s ? <Sparkline values={s} /> : <span className="muted">·</span>;
      } },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">Reddit Buzz</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Reddit Buzz</h1>
        <div className="page-sub">
          Most-discussed tickers across r/wallstreetbets, r/stocks, r/investing &amp; co ·
          daily snapshot {activeDay ? `for ${fmtDate(activeDay, { utc: true })}` : ""} ·
          chatter is sentiment, not signal
        </div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 200 }}
          placeholder="Search ticker or company…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {days.slice(0, 7).map((d) => (
          <button key={d} className={`chip${activeDay === d ? " active" : ""}`} onClick={() => setDay(d)}>
            {d === days[0] ? "Latest" : fmtDate(d, { utc: true })}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        <button className={`chip${watchOnly ? " active" : ""}`} title="Only tickers on your watchlist"
          onClick={() => setWatchOnly((v) => !v)}>
          ⭐ Watchlist only
        </button>
      </div>
      <DataTable
        columns={cols} rows={displayed} rowKey={(r) => `${r.trend_date}:${r.ticker}`}
        filterable={false}
        initialSort={{ key: "rank", dir: "asc" }}
        empty={rows.length === 0
          ? "No Reddit snapshots yet — the summa-reddit workflow writes the first one on its next daily run."
          : "No tickers match."}
        maxHeight="calc(100vh - 240px)"
        onRowClick={(r) => {
          const cik = watchByTicker.get(r.ticker);
          if (cik) onCompany(cik);
        }}
      />
    </div>
  );
}
