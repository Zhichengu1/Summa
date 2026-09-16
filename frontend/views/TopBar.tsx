"use client";
// TopBar — command bar spanning the main area: universal ticker search (SEC index,
// loaded lazily on first focus) plus a live US-market-session status and ET clock.
// Selecting a hit routes through the same add-or-open path as the Search page.
// Press "/" or Ctrl/⌘+K anywhere to focus the search; on narrow viewports a menu
// button opens the sidebar drawer.
import { useEffect, useMemo, useRef, useState } from "react";

import { loadSecIndex, searchSec, type SecCompany } from "../lib/domain/secIndex";

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

export function TopBar({
  watched, onSelect, onMenu,
}: {
  watched: Set<string>;
  onSelect: (c: SecCompany) => void;   // add-or-open (Page.handleAdd)
  onMenu?: () => void;                 // opens the sidebar drawer on narrow viewports
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

  return (
    <div className="topbar">
      {onMenu && (
        <button className="topbar-menu" onClick={onMenu} aria-label="Open menu" title="Menu">☰</button>
      )}
      <div className="topbar-search" ref={boxRef}>
        <span className="topbar-search-icon" aria-hidden>⌕</span>
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
                  {watched.has(c.cik) ? "★ watching · open" : "+ add to watchlist"}
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
      </div>
    </div>
  );
}
