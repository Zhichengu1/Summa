"use client";
// Filing Feed — the global real-time filings tape (recent-200 window), searchable
// by company/ticker and filterable by form type. New filings stream in via the
// Realtime subscription wired in the root Page.
import { useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { FormBadge } from "../components/badges/FormBadge";
import { safeHref } from "../lib/utils/url";
import { fmtDate, elapsed } from "../lib/utils/format";
import type { Filing } from "../lib/types";

export function FeedPage({ filings, onCompany }: { filings: Filing[]; onCompany: (cik: string) => void }) {
  const [q, setQ] = useState("");
  const [formFilter, setFormFilter] = useState<string | null>(null);

  const formTypes = useMemo(() => {
    const s = new Set<string>();
    for (const f of filings) s.add(f.form_type);
    return Array.from(s).sort();
  }, [filings]);

  const displayed = useMemo(() => {
    let r = filings;
    if (formFilter) r = r.filter((f) => f.form_type === formFilter);
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((f) =>
        (f.company_name ?? "").toLowerCase().includes(n) ||
        (f.ticker ?? "").toLowerCase().includes(n),
      );
    }
    return r;
  }, [filings, q, formFilter]);

  const cols: Column<Filing>[] = [
    {
      key: "ticker", header: "Ticker", width: "70px",
      value: (f) => f.ticker ?? "",
      render: (f) => (
        <button
          style={{
            background: "none", border: "none", padding: 0, cursor: "pointer",
            color: "var(--accent)", fontWeight: 700,
            fontFamily: "inherit", fontSize: "inherit",
          }}
          onClick={(e) => { e.stopPropagation(); onCompany(f.cik); }}
        >
          {f.ticker}
        </button>
      ),
    },
    { key: "company", header: "Company", value: (f) => f.company_name ?? "" },
    {
      key: "form", header: "Form", width: "80px",
      value: (f) => f.form_type,
      render: (f) => <FormBadge form={f.form_type} />,
    },
    {
      key: "filed", header: "Filed",
      value: (f) => f.filed_at ?? "",
      render: (f) => {
        const ago = elapsed(f.filed_at);
        return (
          <span className="muted" title={fmtDate(f.filed_at)}>
            {ago || fmtDate(f.filed_at)}
          </span>
        );
      },
    },
    {
      key: "period", header: "Period",
      value: (f) => f.period_of_report ?? "",
      render: (f) => <span className="dimmed">{fmtDate(f.period_of_report)}</span>,
    },
    {
      key: "link", header: "", width: "30px",
      value: () => "",
      render: (f) => {
        const href = safeHref(f.filing_url);
        return href
          ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-4)" }}>↗</a>
          : null;
      },
    },
  ];

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Filing Feed
          <span className="live-dot" title="Live — new filings appear in real time" />
        </h1>
        <div className="page-sub">{filings.length} filings loaded · updates in real time</div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 220 }}
          placeholder="Search…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className={`chip${formFilter === null ? " active" : ""}`} onClick={() => setFormFilter(null)}>
          All
        </button>
        {formTypes.map((ft) => (
          <button
            key={ft}
            className={`chip${formFilter === ft ? " active" : ""}`}
            onClick={() => setFormFilter(formFilter === ft ? null : ft)}
          >
            {ft}
          </button>
        ))}
      </div>
      <DataTable
        columns={cols} rows={displayed} rowKey={(f) => f.accession_number}
        filterable={false}
        initialSort={{ key: "filed", dir: "desc" }}
        empty="No filings match." maxHeight="calc(100vh - 240px)"
      />
    </div>
  );
}
