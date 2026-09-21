"use client";
// WatchlistDock — the personal watchlist as a dense price monitor, docked on the
// right of the app (collapsible; an off-canvas drawer on narrow viewports).
//
// Built to minimise clicking: every row shows last · 1D · a 3-month sparkline
// inline; hovering (or focusing) a row opens a "peek" card with the company's key
// numbers, latest filing, flags and direct links into its tabs; ↑/↓ move through the
// list and Enter opens; the list can be sorted by ticker, move or activity; hovering
// a row pre-loads the company view's code so the click is instant. A breadth tape
// (▲/▼ counts, average move, what's new) heads the panel.
import { useEffect, useMemo, useRef, useState } from "react";

import { CompanyPeek } from "../components/CompanyPeek";
import { Icon } from "../components/Icon";
import { SearchField } from "../components/SearchField";
import { Sparkline } from "../components/charts/Sparkline";
import { usePeek } from "../lib/hooks/usePeek";
import { fmtDelta } from "../lib/utils/format";
import type { Company, Filing, MainView, CompanySummary, CompanyTab } from "../lib/types";

type SortKey = "ticker" | "chg" | "activity";
const SORT_KEY = "summa.sidebar.sort.v1";
const SORTS: { key: SortKey; label: string; title: string }[] = [
  { key: "ticker",   label: "A–Z", title: "Sort by ticker" },
  { key: "chg",      label: "1D",  title: "Sort by last-session move, best first" },
  { key: "activity", label: "Act", title: "Sort by filing activity in the last 30 days" },
];

export function WatchlistDock({
  companies, filings, activeCik, view, ingestedCiks, prices,
  onCompany, onNavigate, onRemove, onPreload, newFilings = 0, newNews = 0,
  open = false, onClose,
}: {
  companies: Company[]; filings: Filing[];
  activeCik: string | null; view: MainView;
  ingestedCiks: Set<string>;
  prices: Map<string, CompanySummary>;
  onCompany: (cik: string, tab?: CompanyTab) => void;
  onNavigate: (view: Exclude<MainView, "company">) => void;
  onRemove: (cik: string) => void;
  /** Warm the company view's code chunk ahead of the click (hover intent). */
  onPreload?: (target: "company") => void;
  newFilings?: number;
  newNews?: number;
  /** Panel visibility: collapsed/expanded on wide viewports, drawer on narrow ones. */
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

  // Watchlist tape: breadth + average move on the last close.
  const tape = useMemo(() => {
    let up = 0, down = 0, sum = 0, n = 0;
    for (const c of companies) {
      const v = prices.get(c.cik)?.chg_1d;
      if (v == null) continue;
      if (v >= 0) up++; else down++;
      sum += v; n++;
    }
    return { up, down, avg: n ? sum / n : null };
  }, [companies, prices]);

  // Sort (remembered) + quick filter (offered once the list is long enough).
  const [sort, setSort] = useState<SortKey>(() => {
    try { const v = localStorage.getItem(SORT_KEY); if (v === "chg" || v === "activity") return v; } catch { /* ignore */ }
    return "ticker";
  });
  const pickSort = (k: SortKey) => { setSort(k); try { localStorage.setItem(SORT_KEY, k); } catch { /* ignore */ } };
  const [q, setQ] = useState("");
  const showFilter = companies.length >= 8;
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    const list = !n || !showFilter ? companies : companies.filter((c) =>
      (c.ticker ?? "").toLowerCase().includes(n) || (c.name ?? "").toLowerCase().includes(n));
    const arr = [...list];
    if (sort === "chg") {
      arr.sort((a, b) => ((prices.get(b.cik)?.chg_1d ?? -Infinity) - (prices.get(a.cik)?.chg_1d ?? -Infinity)) || (a.ticker ?? "").localeCompare(b.ticker ?? ""));
    } else if (sort === "activity") {
      const act = (c: Company) => recent30.get(c.cik) ?? prices.get(c.cik)?.filings_30d ?? 0;
      const last = (c: Company) => prices.get(c.cik)?.last_filing_at ?? "";
      arr.sort((a, b) => (act(b) - act(a)) || last(b).localeCompare(last(a)) || (a.ticker ?? "").localeCompare(b.ticker ?? ""));
    } else {
      arr.sort((a, b) => (a.ticker ?? "").localeCompare(b.ticker ?? ""));
    }
    return arr;
  }, [companies, q, showFilter, sort, prices, recent30]);

  // Peek card: opens after a short hover (or on keyboard focus), stays while the
  // pointer is over the row or the card, and never on touch/narrow layouts.
  const listRef = useRef<HTMLDivElement>(null);
  const pk = usePeek({ side: "left" });
  // Any navigation closes the card.
  useEffect(() => { pk.close(); }, [activeCik, view]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ↑ / ↓ move between rows; Enter / Space open; Delete removes.
  const rowKey = (e: React.KeyboardEvent<HTMLDivElement>, cik: string) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCompany(cik); return; }
    if (e.key === "Delete") { e.preventDefault(); onRemove(cik); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".company-row") ?? []);
    const i = rows.indexOf(e.currentTarget);
    const next = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
    next?.focus();
  };

  const openPeek = (cik: string, tab?: CompanyTab) => { pk.close(); onCompany(cik, tab); };
  const peek = pk.peek;
  const peekCompany = peek ? companies.find((c) => c.cik === peek.cik) : null;

  return (
    <>
      {open && <div className="dock-overlay" onClick={onClose} aria-hidden />}
      <aside className={`dock${open ? " open" : ""}`} aria-label="Watchlist">
        <div className="dock-head">
          <span className="dock-title">Watchlist <span className="panel-count">{companies.length}</span></span>
          {onClose && (
            <button className="dock-close" onClick={onClose} aria-label="Hide watchlist" title="Hide watchlist"><Icon name="x" size={14} /></button>
          )}
        </div>

        {/* Watchlist tape — breadth and average move on the last close, plus what's new */}
        {companies.length > 0 && (
          <div className="side-tape" title="Your watchlist on the last close: up vs down, and the equal-weighted average move">
            <span className="pos">▲ {tape.up}</span>
            <span className="neg">▼ {tape.down}</span>
            {tape.avg != null && <span className={`side-tape-avg ${tape.avg >= 0 ? "pos" : "neg"}`}>{fmtDelta(tape.avg)} avg</span>}
            {(newFilings + newNews) > 0 && (
              <button className="side-tape-new" onClick={() => onNavigate(newNews > newFilings ? "news" : "feed")} title={`${newFilings} filings · ${newNews} headlines since your last visit`}>
                {newFilings + newNews} new
              </button>
            )}
          </div>
        )}

        <div className="sidebar-scroll">
        <div className="sidebar-list-head">
          <div className="sidebar-list-head-row">
            <span className="label-caps">Sort</span>
            <div className="sidebar-list-tools">
              {companies.length > 1 && (
                <div className="seg seg-xs" role="group" aria-label="Sort watchlist">
                  {SORTS.map((s) => (
                    <button key={s.key} className={`seg-btn${sort === s.key ? " active" : ""}`} onClick={() => pickSort(s.key)} title={s.title}>{s.label}</button>
                  ))}
                </div>
              )}
              <button className="sidebar-add-btn" title="Search & add companies" onClick={() => onNavigate("search")}><Icon name="plus" size={12} strokeWidth={2.25} /> Add</button>
            </div>
          </div>
          {showFilter && (
            <SearchField size="sm" value={q} onChange={setQ} placeholder="Filter watchlist…" ariaLabel="Filter watchlist" />
          )}
        </div>
        <div className="sidebar-list" role="list" ref={listRef}>
          {shown.map((c) => {
            const cnt = recent30.get(c.cik) ?? 0;
            const pending = !ingestedCiks.has(c.cik);
            const px = prices.get(c.cik);
            const chg = px?.chg_1d ?? null;
            const isActive = activeCik === c.cik;
            return (
              <div
                key={c.cik}
                role="listitem"
                className={`company-row${isActive ? " active" : ""}${peek?.cik === c.cik ? " peeked" : ""}`}
                onClick={() => openPeek(c.cik)}
                onKeyDown={(e) => rowKey(e, c.cik)}
                onMouseEnter={(e) => { onPreload?.("company"); pk.enter(c.cik, e.currentTarget); }}
                onMouseLeave={pk.leave}
                onFocus={(e) => { onPreload?.("company"); pk.enter(c.cik, e.currentTarget, true); }}
                onBlur={pk.leave}
                tabIndex={0}
                title={`${c.ticker ?? ""} · ${c.name ?? ""}`}
                aria-current={isActive ? "true" : undefined}
              >
                <span className="tkr">{c.ticker}</span>
                <span className="spk">
                  {px?.spark && px.spark.length > 1
                    ? <Sparkline values={px.spark.slice(-30)} width={40} height={14} />
                    : null}
                </span>
                {px?.last_close != null
                  ? <span className="px-last">{px.last_close < 1000 ? px.last_close.toFixed(2) : Math.round(px.last_close).toLocaleString()}</span>
                  : <span className="px-last dimmed">—</span>}
                {chg != null
                  ? <span className={`px-chg ${chg >= 0 ? "pos" : "neg"}`}>{fmtDelta(chg)}</span>
                  : <span className="px-chg dimmed">—</span>}
                <span className="row-tail">
                  {pending
                    ? <span className="pending-dot" title="Queued — data appears after the next pipeline run (≈10 min)"><Icon name="clock" size={12} /></span>
                    : cnt > 0 ? <span className="cnt" title={`${cnt} filings in the last 30 days`}>{cnt}</span> : null}
                  <button
                    className="row-remove" title="Remove from watchlist (Del)" aria-label={`Remove ${c.ticker ?? c.name} from watchlist`}
                    onClick={(e) => { e.stopPropagation(); onRemove(c.cik); }}
                    tabIndex={-1}
                  ><Icon name="x" size={12} strokeWidth={2} /></button>
                </span>
              </div>
            );
          })}
          {companies.length === 0 && (
            <div className="sidebar-empty">
              Your watchlist is empty.{" "}
              <button className="link-like" onClick={() => onNavigate("search")}>Add companies</button> to start tracking their filings.
            </div>
          )}
          {companies.length > 0 && shown.length === 0 && (
            <div className="sidebar-empty">No company matches “{q.trim()}”.</div>
          )}
        </div>
        </div>
      </aside>

      {peek && peekCompany && (
        <CompanyPeek
          company={peekCompany} summary={prices.get(peek.cik)}
          filings30={recent30.get(peek.cik) ?? prices.get(peek.cik)?.filings_30d ?? 0}
          pending={!ingestedCiks.has(peek.cik)}
          top={peek.top} left={peek.left}
          onOpen={openPeek} onMouseEnter={pk.hold} onMouseLeave={pk.leave}
        />
      )}
    </>
  );
}
