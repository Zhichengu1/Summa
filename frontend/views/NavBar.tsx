"use client";
// NavBar — the navigation board across the top of the app: brand · primary tabs
// (Dashboard / Calendar / Filings / News) · a "Markets" menu for the intelligence
// views · Guide · universal ticker search · US-session status + ET clock · the
// watchlist-dock toggle. On narrow viewports the tabs and menu collapse into one
// "Menu" dropdown.
//
// Hover, not click: menus open on hover intent (click still toggles for touch and
// keyboard), and the Filings / News tabs show a live preview of the latest items
// on hover so a glance answers "anything new?" without leaving the page.
//
// Search: the bundled SEC index loads lazily on first focus; selecting a hit routes
// through the same add-or-open path as the Search page. Press "/" or Ctrl/⌘+K
// anywhere to focus it.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { FormBadge } from "../components/badges/FormBadge";
import { Icon } from "../components/Icon";
import { loadSecIndex, searchSec, type SecCompany } from "../lib/domain/secIndex";
import { MARKETS_NAV, NAV_GROUPS, PRIMARY_NAV, type NavItem } from "../lib/nav";
import { safeHref } from "../lib/utils/url";
import { elapsed, fmtDate } from "../lib/utils/format";
import type { CompanyTab, Filing, MainView, NewsItem } from "../lib/types";

type NavView = Exclude<MainView, "company">;

/** New York wall-clock parts for the given instant (handles DST via Intl). */
function etParts(now: Date): { day: number; minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days.indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minutes = hour * 60 + Number(get("minute"));
  return { day, minutes, label: `${get("weekday")} ${get("hour")}:${get("minute")} ET` };
}

/** Regular NYSE/Nasdaq session: Mon–Fri 9:30–16:00 ET (holidays not modeled). */
function isMarketOpen(p: { day: number; minutes: number }): boolean {
  return p.day >= 1 && p.day <= 5 && p.minutes >= 9 * 60 + 30 && p.minutes < 16 * 60;
}

/** True when the keyboard event originated inside a text-entry element. */
function inTextField(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Open-on-hover intent with a grace period on leave; click toggles for touch/keyboard. */
function useHoverOpen(openDelay = 90, closeDelay = 220) {
  const [open, setOpen] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (t.current) { clearTimeout(t.current); t.current = null; } };
  const enter = useCallback(() => { clear(); t.current = setTimeout(() => setOpen(true), openDelay); }, [openDelay]);
  const leave = useCallback(() => { clear(); t.current = setTimeout(() => setOpen(false), closeDelay); }, [closeDelay]);
  const toggle = useCallback(() => { clear(); setOpen((v) => !v); }, []);
  const close = useCallback(() => { clear(); setOpen(false); }, []);
  useEffect(() => () => clear(), []);
  return { open, enter, leave, toggle, close };
}

/** A nav tab with a hover popover (menu or preview). */
function HoverPop({
  button, children, wide = false, className = "",
}: { button: (h: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode; wide?: boolean; className?: string }) {
  const h = useHoverOpen();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!h.open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) h.close(); }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") h.close(); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [h.open, h]);
  return (
    <div className={`navmenu${className ? ` ${className}` : ""}`} ref={ref} onMouseEnter={h.enter} onMouseLeave={h.leave}>
      {button({ open: h.open, toggle: h.toggle })}
      {h.open && (
        <div className={`navmenu-pop${wide ? " wide" : ""}`} role="menu" onClick={h.close}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A dropdown menu of nav items (used for "Markets" and the narrow-viewport "Menu"). */
function NavMenu({
  label, groups, view, badgeFor, onNavigate, onPreload, wide = false,
}: {
  label: string;
  groups: { label?: string; items: NavItem[] }[];
  view: MainView;
  badgeFor: (v: NavView) => number;
  onNavigate: (v: NavView) => void;
  onPreload?: (v: NavView) => void;
  /** Two-column layout for the Markets menu. */
  wide?: boolean;
}) {
  const active = groups.some((g) => g.items.some((it) => it.view === view));
  const total = groups.reduce((n, g) => n + g.items.reduce((m, it) => m + badgeFor(it.view), 0), 0);

  return (
    <HoverPop
      wide={wide}
      button={({ open, toggle }) => (
        <button
          className={`nav-tab${active ? " active" : ""}${open ? " open" : ""}`}
          onClick={toggle}
          aria-haspopup="menu" aria-expanded={open}
        >
          {label} <span className="nav-caret" aria-hidden><Icon name="chevron-down" size={12} strokeWidth={2} /></span>
          {total > 0 && <span className="nav-badge">{total > 99 ? "99+" : total}</span>}
        </button>
      )}
    >
      {groups.map((g, gi) => (
        <div className="navmenu-group" key={g.label ?? gi}>
          {g.label && <div className="navmenu-label">{g.label}</div>}
          {g.items.map((it) => {
            const badge = badgeFor(it.view);
            return (
              <button
                key={it.view} role="menuitem"
                className={`navmenu-item${view === it.view ? " active" : ""}`}
                onClick={() => onNavigate(it.view)}
                onMouseEnter={() => onPreload?.(it.view)}
                aria-current={view === it.view ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden><Icon name={it.icon} /></span>
                <span className="navmenu-text">
                  <span className="navmenu-name">{it.label}{badge > 0 && <span className="nav-badge">{badge}</span>}</span>
                  <span className="navmenu-desc">{it.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </HoverPop>
  );
}

/** Hover preview for the Filings tab: the latest filings across the watchlist. */
function FilingsPreview({ filings, isNew, onCompany, onNavigate }: {
  filings: Filing[]; isNew?: (iso: string | null | undefined) => boolean;
  onCompany: (cik: string, tab?: CompanyTab) => void; onNavigate: (v: NavView) => void;
}) {
  const latest = filings.slice(0, 8);
  return (
    <div className="navprev">
      <div className="navprev-head"><span className="live-dot" /> Latest filings</div>
      {latest.length === 0 && <div className="navprev-empty">No filings yet.</div>}
      {latest.map((f) => (
        <button key={f.accession_number} className="navprev-row" onClick={() => onCompany(f.cik, "filings")} title={`${f.company_name ?? ""} · ${fmtDate(f.filed_at)}`}>
          <FormBadge form={f.form_type} />
          <span className="navprev-tkr">{f.ticker}</span>
          <span className="navprev-name">{f.company_name}</span>
          <span className="navprev-age">{isNew?.(f.filed_at) && <span className="new-dot">NEW</span>}{elapsed(f.filed_at) || fmtDate(f.filed_at)}</span>
        </button>
      ))}
      <button className="navprev-more" onClick={() => onNavigate("feed")}>Open the filings feed <Icon name="arrow-right" size={12} /></button>
    </div>
  );
}

/** Hover preview for the News tab: the latest headlines across the watchlist. */
function NewsPreview({ news, isNew, onCompany, onNavigate }: {
  news: NewsItem[]; isNew?: (iso: string | null | undefined) => boolean;
  onCompany: (cik: string, tab?: CompanyTab) => void; onNavigate: (v: NavView) => void;
}) {
  const latest = news.slice(0, 7);
  return (
    <div className="navprev">
      <div className="navprev-head"><span className="live-dot" /> Latest headlines</div>
      {latest.length === 0 && <div className="navprev-empty">No headlines yet.</div>}
      {latest.map((n) => {
        const href = safeHref(n.link);
        return (
          <div key={`${n.cik}:${n.guid}`} className="navprev-row navprev-news">
            <button className="navprev-tkr as-btn" onClick={() => onCompany(n.cik, "news")} title="Open the company's news">{n.ticker ?? "—"}</button>
            {href
              ? <a className="navprev-title" href={href} target="_blank" rel="noopener noreferrer">{n.title}</a>
              : <span className="navprev-title">{n.title}</span>}
            <span className="navprev-age">{isNew?.(n.published_at) && <span className="new-dot">NEW</span>}{elapsed(n.published_at) || fmtDate(n.published_at)}</span>
          </div>
        );
      })}
      <button className="navprev-more" onClick={() => onNavigate("news")}>Open the news feed <Icon name="arrow-right" size={12} /></button>
    </div>
  );
}

export function NavBar({
  view, watched, onSelect, onNavigate, onPreload, onCompany, filings = [], news = [], isNew,
  newFilings = 0, newNews = 0, watchCount = 0, dockOpen, onToggleDock,
}: {
  view: MainView;
  watched: Set<string>;
  onSelect: (c: SecCompany) => void;   // add-or-open (Page.handleAdd)
  onNavigate: (v: NavView) => void;
  onPreload?: (v: NavView) => void;
  onCompany: (cik: string, tab?: CompanyTab) => void;
  /** Live feeds for the hover previews on the Filings / News tabs. */
  filings?: Filing[]; news?: NewsItem[];
  isNew?: (iso: string | null | undefined) => boolean;
  newFilings?: number; newNews?: number;
  watchCount?: number;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<SecCompany[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clock ticks every 30s — cheap, and minute-resolution is all we display.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Close the dropdown on any outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Global shortcut: "/" or Ctrl/⌘+K focuses the search from anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !inTextField(e);
      if (cmdK || slash) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The bundled SEC index (~707 KB) loads on first focus; loadSecIndex caches.
  const ensureIndex = () => { if (index.length === 0) loadSecIndex().then(setIndex); };

  const hits = useMemo(
    () => (q.trim() && index.length ? searchSec(index, q, 8) : []),
    [index, q],
  );

  const pick = (c: SecCompany) => {
    onSelect(c);
    setQ(""); setOpen(false); setHi(0);
    inputRef.current?.blur();
  };

  const et = etParts(now);
  const mktOpen = isMarketOpen(et);
  const showList = open && q.trim() !== "";
  const badgeFor = (v: NavView): number => (v === "feed" ? newFilings : v === "news" ? newNews : 0);
  const guide = NAV_GROUPS[2].items[0];

  return (
    <header className="navbar">
      <button className="navbar-brand" onClick={() => onNavigate("overview")} title="Dashboard">
        <span className="brand-mark" aria-hidden>S</span>
        <span className="brand-word">Summa<span className="dot">.</span></span>
      </button>

      {/* Wide viewports: inline tabs + Markets menu + Guide */}
      <nav className="nav-tabs" aria-label="Primary">
        {PRIMARY_NAV.map((it) => {
          const active = view === it.view;
          const badge = badgeFor(it.view);
          const tab = (open: boolean) => (
            <button
              className={`nav-tab${active ? " active" : ""}${open ? " open" : ""}`}
              onClick={() => onNavigate(it.view)}
              onMouseEnter={() => onPreload?.(it.view)}
              onFocus={() => onPreload?.(it.view)}
              title={it.desc}
              aria-current={active ? "page" : undefined}
            >
              {it.label}
              {badge > 0 && <span className="nav-badge" title={`${badge} new since your last visit`}>{badge > 99 ? "99+" : badge}</span>}
            </button>
          );
          if (it.view === "feed" && view !== "feed") {
            return (
              <HoverPop key={it.view} button={({ open }) => tab(open)}>
                <FilingsPreview filings={filings} isNew={isNew} onCompany={onCompany} onNavigate={onNavigate} />
              </HoverPop>
            );
          }
          if (it.view === "news" && view !== "news") {
            return (
              <HoverPop key={it.view} button={({ open }) => tab(open)}>
                <NewsPreview news={news} isNew={isNew} onCompany={onCompany} onNavigate={onNavigate} />
              </HoverPop>
            );
          }
          return <span key={it.view} className="navmenu">{tab(false)}</span>;
        })}
        <NavMenu label="Markets" groups={[{ items: MARKETS_NAV }]} view={view} badgeFor={badgeFor} onNavigate={onNavigate} onPreload={onPreload} wide />
        <button
          className={`nav-tab${view === guide.view ? " active" : ""}`}
          onClick={() => onNavigate(guide.view)} onMouseEnter={() => onPreload?.(guide.view)} title={guide.desc}
          aria-current={view === guide.view ? "page" : undefined}
        >
          {guide.label}
        </button>
      </nav>

      {/* Narrow viewports: everything in one menu */}
      <div className="nav-compact">
        <NavMenu label="Menu" groups={NAV_GROUPS} view={view} badgeFor={badgeFor} onNavigate={onNavigate} onPreload={onPreload} />
      </div>

      <div className="topbar-search" ref={boxRef}>
        <span className="topbar-search-icon" aria-hidden><Icon name="search" size={14} /></span>
        <input
          ref={inputRef}
          className="topbar-input"
          placeholder="Search any ticker or company…"
          aria-label="Search any ticker or company"
          role="combobox"
          aria-expanded={showList}
          aria-controls="topbar-results"
          aria-autocomplete="list"
          value={q}
          onFocus={() => { ensureIndex(); setOpen(true); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
            else if (e.key === "Enter" && hits[hi]) pick(hits[hi]);
            else if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur(); }
          }}
        />
        {!q && <kbd className="topbar-kbd" aria-hidden title="Press / to search">/</kbd>}
        {showList && (
          <div className="topbar-results" id="topbar-results" role="listbox">
            {hits.map((c, i) => (
              <div
                key={c.cik}
                role="option"
                aria-selected={i === hi}
                className={`topbar-hit${i === hi ? " hi" : ""}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(c)}
              >
                <span className="tkr">{c.ticker}</span>
                <span className="nm">{c.name}</span>
                <span className={`st${watched.has(c.cik) ? " watched" : ""}`}>
                  {watched.has(c.cik) ? "Watching · open" : "Add to watchlist"}
                </span>
              </div>
            ))}
            {hits.length === 0 && (
              <div className="topbar-empty">{index.length === 0 ? "Loading company index…" : "No matches — try a ticker symbol or part of the company name."}</div>
            )}
          </div>
        )}
      </div>

      <div className="topbar-right">
        <span className="mkt-status" title="Regular US session, Mon–Fri 9:30–16:00 ET (holidays not modeled)">
          <span className={`mkt-dot${mktOpen ? " open" : ""}`} />
          <span className={`mkt-label ${mktOpen ? "open" : "closed"}`}>{mktOpen ? "Market open" : "Market closed"}</span>
        </span>
        <span className="mkt-clock">{et.label}</span>
        <button
          className={`dock-toggle${dockOpen ? " active" : ""}`}
          onClick={onToggleDock}
          aria-pressed={dockOpen}
          title={dockOpen ? "Hide the watchlist panel" : "Show the watchlist panel"}
        >
          <Icon name="panel-right" size={14} /><span className="dock-toggle-label">Watchlist</span>{watchCount > 0 && <span className="dock-toggle-count">{watchCount}</span>}
        </button>
      </div>
    </header>
  );
}
