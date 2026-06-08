"use client";
// Search / Browse all companies — the universal company finder. Searches the
// bundled SEC index (~all US public companies) client-side and lets the user add
// any of them to the watchlist (which queues backend ingestion). The search runs
// ~350ms after typing pauses so partial words don't flash partial matches.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { CompanyMark } from "../components/badges/CompanyMark";
import { searchSec, type SecCompany } from "../lib/domain/secIndex";

export function SearchPage({
  secIndex, watched, ingestedCiks, onAdd, onCompany,
}: {
  secIndex: SecCompany[];
  watched: Set<string>;
  ingestedCiks: Set<string>;
  onAdd: (c: SecCompany) => void;
  onCompany: (cik: string) => void;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");   // settled query — only updates once typing pauses

  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(id);
  }, [q]);

  const typing = q.trim() !== query;   // entered text hasn't settled into a search yet

  const results = useMemo(
    () => (query ? searchSec(secIndex, query, 250) : []),
    [query, secIndex],
  );

  const cols: Column<SecCompany>[] = [
    {
      key: "ticker", header: "Ticker", width: "130px", value: (c) => c.ticker,
      render: (c) => (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CompanyMark ticker={c.ticker || "?"} size={22} />
          <strong style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>{c.ticker}</strong>
        </div>
      ),
    },
    { key: "name", header: "Company", value: (c) => c.name },
    {
      key: "status", header: "Status", width: "140px",
      value: (c) => (ingestedCiks.has(c.cik) ? "2" : watched.has(c.cik) ? "1" : "0"),
      render: (c) => ingestedCiks.has(c.cik)
        ? <span className="cat-chip sector">In warehouse</span>
        : watched.has(c.cik)
          ? <span className="cat-chip">Watchlisted</span>
          : <span className="dimmed">—</span>,
    },
    {
      key: "action", header: "", width: "92px", align: "right", value: () => "",
      render: (c) => watched.has(c.cik)
        ? <span style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }} title="Open">Open ↗</span>
        : <button className="chip" onClick={(e) => { e.stopPropagation(); onAdd(c); }}>+ Add</button>,
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Search Companies</h1>
        <div className="page-sub">
          {secIndex.length.toLocaleString()} US public companies · search any ticker or name and add it to your watchlist to ingest its filings.
        </div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter" style={{ borderRadius: 5, width: 340 }}
          placeholder="Search ticker or company name…" value={q}
          onChange={(e) => setQ(e.target.value)} autoFocus
        />
      </div>
      {query && !typing && (
        <div className="section">
          <div className="section-title">Results for “{query}” · {results.length.toLocaleString()}{results.length === 250 ? "+" : ""}</div>
          <DataTable
            columns={cols} rows={results} rowKey={(c) => c.cik}
            onRowClick={(c) => (watched.has(c.cik) || ingestedCiks.has(c.cik) ? onCompany(c.cik) : onAdd(c))}
            filterable={false}
            empty={secIndex.length ? "No company matches your search." : "Company index not loaded yet."}
          />
        </div>
      )}
      {q.trim() && typing && (
        <div className="empty-note" style={{ marginTop: 4 }}>Searching…</div>
      )}
      {!q.trim() && (
        <div className="empty-note" style={{ marginTop: 4 }}>
          Start typing a ticker or company name to search {secIndex.length.toLocaleString()} companies, then pause to see matches.
        </div>
      )}
    </div>
  );
}
