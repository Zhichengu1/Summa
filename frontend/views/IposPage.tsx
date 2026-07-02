"use client";
// IPOs — the active IPO pipeline, market-wide (companies not yet on any watchlist).
// Reads the `ipos` table (one row per IPO-lifecycle filing: S-1/F-1 registration,
// S-1/A amendment, 424B pricing, RW withdrawal) and groups the rows by issuer into
// one card per IPO. The default view FOCUSES on the notable deals: ranked by capital
// raised (gross proceeds — the standard "hot IPO" signal), with SPACs/blank-check
// shells and micro/penny offerings hidden unless the user opts to show everything.
import { useEffect, useMemo, useState } from "react";

import { DataTable, type Column } from "../components/DataTable";
import { fetchIpos } from "../lib/data/data";
import { safeHref } from "../lib/utils/url";
import { fmtUSD, fmtNum, fmtDate, elapsed } from "../lib/utils/format";
import type { Ipo } from "../lib/types";

type IpoStatus = "filed" | "updated" | "priced" | "withdrawn";

// One grouped card per issuer (cik), folded down from its lifecycle filings.
type IpoCard = {
  cik: string;
  company: string;
  ticker: string | null;
  status: IpoStatus;
  isSpac: boolean;
  price: number | null;
  shares: number | null;
  proceeds: number | null;
  registeredAt: string | null;   // earliest filing (first registration)
  latestAt: string | null;       // most recent filing
  latestForm: string | null;
  filingUrl: string | null;
  key: string;
};

// Deals raising less than this (when a size is known) are treated as micro/shell
// noise and hidden in the focused view. Penny-priced and SPAC deals are hidden too.
const MIN_NOTABLE = 10_000_000;
// "Hot" thresholds on capital raised.
const MEGA = 500_000_000;
const LARGE = 100_000_000;

// Pipeline ordering: a later stage supersedes an earlier one; withdrawal is terminal.
const RANK: Record<IpoStatus, number> = { filed: 0, updated: 1, priced: 2, withdrawn: 3 };

const STATUS_STYLE: Record<IpoStatus, { label: string; bg: string; fg: string }> = {
  filed:     { label: "Filed",     bg: "var(--bg-2)",            fg: "var(--fg-3)" },
  updated:   { label: "Updated",   bg: "rgba(59,130,246,0.15)",  fg: "#60a5fa" },
  priced:    { label: "Priced",    bg: "rgba(34,197,94,0.16)",   fg: "#22c55e" },
  withdrawn: { label: "Withdrawn", bg: "rgba(239,68,68,0.15)",   fg: "#ef4444" },
};

function StatusBadge({ status }: { status: IpoStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{
      background: s.bg, color: s.fg, padding: "2px 8px", borderRadius: 4,
      fontSize: 11, fontWeight: 700, letterSpacing: 0.3, whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

function fold(rows: Ipo[]): IpoCard[] {
  const groups = new Map<string, Ipo[]>();
  for (const r of rows) {
    const g = groups.get(r.cik);
    if (g) g.push(r); else groups.set(r.cik, [r]);
  }
  const cards: IpoCard[] = [];
  for (const [cik, g] of groups) {
    const byDate = [...g].sort((a, b) => (a.filed_at ?? "").localeCompare(b.filed_at ?? ""));
    const earliest = byDate[0];
    const latest = byDate[byDate.length - 1];
    const priced = g.find((r) => r.price != null || r.proceeds != null);
    const status = g.reduce<IpoStatus>(
      (acc, r) => (r.status && RANK[r.status as IpoStatus] > RANK[acc] ? (r.status as IpoStatus) : acc),
      "filed",
    );
    cards.push({
      cik,
      company: g.find((r) => r.company_name)?.company_name ?? cik,
      ticker: priced?.ticker ?? g.find((r) => r.ticker)?.ticker ?? null,
      status,
      isSpac: g.some((r) => r.is_spac),
      price: priced?.price ?? null,
      shares: priced?.shares ?? null,
      proceeds: priced?.proceeds ?? null,
      registeredAt: earliest?.filed_at ?? null,
      latestAt: latest?.filed_at ?? null,
      latestForm: latest?.form ?? null,
      filingUrl: latest?.filing_url ?? null,
      key: latest?.accession_number ?? cik,
    });
  }
  return cards;
}

// A deal is "noise" (hidden in the focused view) if it's a SPAC/blank-check, a
// penny offering, or a known-tiny raise. Priced deals whose size didn't parse
// (e.g. SpaceX) are NOT noise — they stay visible.
function isNoise(c: IpoCard): boolean {
  if (c.isSpac) return true;
  if (c.price != null && c.price < 1) return true;
  if (c.proceeds != null && c.proceeds < MIN_NOTABLE) return true;
  return false;
}

// Hottest-first ordering. Priced deals lead (largest known raise first, then
// recent priced deals whose size is unknown), then upcoming registrations by
// recency, then withdrawals.
function hotnessCompare(a: IpoCard, b: IpoCard): number {
  const ga = a.status === "priced" ? 0 : a.status === "withdrawn" ? 2 : 1;
  const gb = b.status === "priced" ? 0 : b.status === "withdrawn" ? 2 : 1;
  if (ga !== gb) return ga - gb;
  if (ga === 0) {                                   // both priced: by raise, known first
    if (a.proceeds != null && b.proceeds != null) return b.proceeds - a.proceeds;
    if (a.proceeds != null) return -1;
    if (b.proceeds != null) return 1;
  }
  return (b.latestAt ?? "").localeCompare(a.latestAt ?? "");   // tiebreak: most recent
}

function tier(proceeds: number | null): "mega" | "large" | null {
  if (proceeds == null) return null;
  if (proceeds >= MEGA) return "mega";
  if (proceeds >= LARGE) return "large";
  return null;
}

const STATUS_TABS: { key: IpoStatus | "all" | "upcoming"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "priced", label: "Priced" },
  { key: "upcoming", label: "Upcoming" },
  { key: "withdrawn", label: "Withdrawn" },
];

const RAISE_TABS: { label: string; min: number }[] = [
  { label: "Any size", min: 0 },
  { label: "$50M+", min: 50_000_000 },
  { label: "$100M+", min: 100_000_000 },
  { label: "$500M+", min: 500_000_000 },
];

export function IposPage() {
  const [rows, setRows] = useState<Ipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<IpoStatus | "all" | "upcoming">("all");
  const [minRaise, setMinRaise] = useState(0);
  const [focus, setFocus] = useState(true);   // hide SPACs + shells by default

  useEffect(() => {
    fetchIpos().then((r) => { setRows(r); setLoading(false); });
  }, []);

  const cards = useMemo(() => fold(rows), [rows]);

  const displayed = useMemo(() => {
    let r = cards;
    if (tab === "upcoming") r = r.filter((c) => c.status === "filed" || c.status === "updated");
    else if (tab !== "all") r = r.filter((c) => c.status === tab);
    if (focus) r = r.filter((c) => !isNoise(c));
    if (minRaise > 0) r = r.filter((c) => c.proceeds != null && c.proceeds >= minRaise);
    if (q.trim()) {
      const n = q.toLowerCase();
      r = r.filter((c) =>
        c.company.toLowerCase().includes(n) || (c.ticker ?? "").toLowerCase().includes(n));
    }
    return [...r].sort(hotnessCompare);
  }, [cards, tab, focus, minRaise, q]);

  const cols: Column<IpoCard>[] = [
    { key: "company", header: "Company", value: (c) => c.company,
      render: (c) => {
        const t = tier(c.proceeds);
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontWeight: 600 }}>{c.company}</span>
            {t && (
              <span style={{
                fontSize: 9, fontWeight: 800, letterSpacing: 0.5, padding: "1px 5px", borderRadius: 3,
                color: t === "mega" ? "#f59e0b" : "#22c55e",
                background: t === "mega" ? "rgba(245,158,11,0.14)" : "rgba(34,197,94,0.12)",
              }}>{t === "mega" ? "MEGA" : "HOT"}</span>
            )}
            {c.isSpac && <span className="dimmed" style={{ fontSize: 10, border: "1px solid var(--border-1)", borderRadius: 3, padding: "0 4px" }}>SPAC</span>}
          </span>
        );
      } },
    { key: "ticker", header: "Ticker", width: "78px", value: (c) => c.ticker ?? "",
      render: (c) => <span style={{ color: "var(--accent)", fontWeight: 700 }}>{c.ticker ?? "—"}</span> },
    { key: "status", header: "Status", width: "96px", value: (c) => c.status,
      render: (c) => <StatusBadge status={c.status} /> },
    { key: "proceeds", header: "Raised", width: "100px", align: "right", value: (c) => c.proceeds ?? -1,
      render: (c) => {
        const t = tier(c.proceeds);
        return <span style={{ fontWeight: 700, color: t === "mega" ? "#f59e0b" : t === "large" ? "#22c55e" : "var(--fg-2)" }}>
          {c.proceeds != null ? fmtUSD(c.proceeds) : "—"}
        </span>;
      } },
    { key: "price", header: "Price", width: "84px", align: "right", value: (c) => c.price ?? -1,
      render: (c) => <span>{c.price != null ? `$${fmtNum(c.price, 2)}` : "—"}</span> },
    { key: "shares", header: "Shares", width: "104px", align: "right", value: (c) => c.shares ?? -1,
      render: (c) => <span className="muted">{c.shares != null ? fmtNum(c.shares, 0) : "—"}</span> },
    { key: "latest", header: "Last update", width: "138px", value: (c) => c.latestAt ?? "",
      render: (c) => (
        <span className="muted" title={`${c.latestForm ?? ""} · ${fmtDate(c.latestAt)}`}>
          {c.latestForm ? `${c.latestForm} · ` : ""}{elapsed(c.latestAt) || fmtDate(c.latestAt)}
        </span>
      ) },
    { key: "link", header: "", width: "30px", value: () => "",
      render: (c) => {
        const href = safeHref(c.filingUrl);
        // stopPropagation so the anchor doesn't also trigger the row-click handler
        // below (which opens the same URL) and pop a second tab.
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "var(--fg-4)" }}>↗</a> : null;
      } },
  ];

  if (loading) {
    return (
      <div className="page-head">
        <h1 className="page-title">IPOs</h1>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  const hidden = cards.length - displayed.length;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">IPOs</h1>
        <div className="page-sub">
          {displayed.length} notable IPO{displayed.length === 1 ? "" : "s"} ranked by capital raised
          {focus && hidden > 0 ? ` · ${hidden} SPAC/micro filtered` : ""} · live from SEC EDGAR
        </div>
      </div>
      <div className="toggle-row">
        <input
          className="dt-filter"
          style={{ borderRadius: 5, width: 200 }}
          placeholder="Search company or ticker…" value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {STATUS_TABS.map((t) => (
          <button key={t.key} className={`chip${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        {RAISE_TABS.map((t) => (
          <button key={t.min} className={`chip${minRaise === t.min ? " active" : ""}`} onClick={() => setMinRaise(t.min)}>
            {t.label}
          </button>
        ))}
        <button className={`chip${focus ? " active" : ""}`} title="Hide SPACs, penny, and sub-$10M micro-offerings"
          onClick={() => setFocus((v) => !v)}>
          {focus ? "Notable only ✓" : "Show all"}
        </button>
      </div>
      <DataTable
        columns={cols} rows={displayed} rowKey={(c) => c.key}
        filterable={false}
        empty="No IPOs match."
        maxHeight="calc(100vh - 240px)"
        onRowClick={(c) => {
          const href = safeHref(c.filingUrl);
          if (href) window.open(href, "_blank", "noopener,noreferrer");
        }}
      />
    </div>
  );
}
