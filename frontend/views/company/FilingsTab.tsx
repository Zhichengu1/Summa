"use client";
// Filings tab — the company's full filings list (form, period, filed date, link),
// driven off the shared CompanyAux bundle.
import { DataTable, type Column } from "../../components/DataTable";
import { FormBadge } from "../../components/badges/FormBadge";
import { safeHref } from "../../lib/utils/url";
import { fmtDate } from "../../lib/utils/format";
import type { Filing } from "../../lib/types";
import type { CompanyAux } from "./companyAux";

export function FilingsTab({ aux }: { aux: CompanyAux }) {
  const { filings, loading } = aux;

  const cols: Column<Filing>[] = [
    { key: "form", header: "Form", width: "80px", value: (f) => f.form_type, render: (f) => <FormBadge form={f.form_type} /> },
    { key: "period", header: "Period", value: (f) => f.period_of_report ?? "", render: (f) => <span className="muted">{fmtDate(f.period_of_report)}</span> },
    { key: "filed", header: "Filed", value: (f) => f.filed_at ?? "", render: (f) => <span className="muted">{fmtDate(f.filed_at)}</span> },
    {
      key: "link", header: "", width: "30px", value: () => "",
      render: (f) => {
        const href = safeHref(f.filing_url);
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-4)" }}>↗</a> : null;
      },
    },
  ];

  if (loading) return (
    <div className="skeleton-block">
      <div className="skeleton" style={{ height: 36, borderRadius: 4 }} />
      {[0,1,2,3,4,5,6].map((i) => <div key={i} className="skeleton" style={{ height: 32, borderRadius: 4, opacity: 0.8 - i * 0.08 }} />)}
    </div>
  );
  if (!filings.length) return <div className="empty-note">No filings found.</div>;

  return (
    <DataTable
      columns={cols} rows={filings} rowKey={(f) => f.accession_number}
      initialSort={{ key: "filed", dir: "desc" }}
      maxHeight="calc(100vh - 280px)" empty="No filings."
    />
  );
}
