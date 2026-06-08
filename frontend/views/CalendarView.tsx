"use client";
// Catalyst Calendar — a watchlist-wide event timeline grouped by calendar day,
// filterable by event kind. Reuses the shared watchlist pulse + the buildWatchlistTape
// merge so it stays in lock-step with the Live Signals scanner.
import { useMemo, useState } from "react";

import { InfoTip } from "../components/InfoTip";
import { DirMark } from "../components/badges/DirMark";
import { useWatchlistPulse } from "../lib/hooks/useWatchlistPulse";
import { buildWatchlistTape, type TapeItem } from "../lib/domain/pulse";
import { fmtDate } from "../lib/utils/format";
import type { Company } from "../lib/types";

export function CalendarView({
  companies, onCompany,
}: { companies: Company[]; onCompany: (cik: string) => void }) {
  const { entries, loading } = useWatchlistPulse(companies);
  const [kind, setKind] = useState<string>("all");

  const tape = useMemo(() => buildWatchlistTape(entries), [entries]);
  const kinds = useMemo(() => Array.from(new Set(tape.map((t) => t.kind))), [tape]);
  const shown = useMemo(() => (kind === "all" ? tape : tape.filter((t) => t.kind === kind)), [tape, kind]);

  // Group by calendar day; `tape` is already date-desc so groups stay newest-first.
  const groups = useMemo(() => {
    const m = new Map<string, TapeItem[]>();
    for (const t of shown) {
      const day = t.date.slice(0, 10);
      const arr = m.get(day) ?? [];
      arr.push(t);
      m.set(day, arr);
    }
    return Array.from(m.entries());
  }, [shown]);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Catalyst Calendar</h1>
        <div className="page-sub">{tape.length} events across {companies.length} compan{companies.length === 1 ? "y" : "ies"} · recent &amp; dated disclosures</div>
      </div>
      <div className="toggle-row">
        <button className={`chip${kind === "all" ? " active" : ""}`} onClick={() => setKind("all")}>All</button>
        {kinds.map((k) => (
          <button key={k} className={`chip${kind === k ? " active" : ""}`} onClick={() => setKind(kind === k ? "all" : k)}>{k}</button>
        ))}
      </div>
      {loading ? (
        <div className="skeleton-block">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 30, borderRadius: 4, opacity: 0.85 - i * 0.12 }} />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="empty-note">No catalyst events recorded across your watchlist yet.</div>
      ) : (
        <div className="cal-groups">
          {groups.map(([day, items]) => (
            <div key={day} className="cal-group">
              <div className="cal-date">{fmtDate(day)}</div>
              <div className="cal-items">
                {items.map((t, i) => (
                  <div
                    key={`${t.cik}-${i}`} className={`tape-row dir-${t.dir}`} role="button" tabIndex={0}
                    style={{ cursor: "pointer" }}
                    onClick={() => t.cik && onCompany(t.cik)}
                    onKeyDown={(e) => { if (e.key === "Enter" && t.cik) onCompany(t.cik); }}
                  >
                    <span className="tape-kind" style={{ minWidth: 70 }}>{t.kind}</span>
                    <strong style={{ color: "var(--accent)", minWidth: 52, letterSpacing: "0.04em" }}>{t.ticker}</strong>
                    <span className="tape-head">
                      <span className="tape-head-text" title={t.headline}>{t.headline}</span>
                      {t.note && <InfoTip def={t.note} />}
                    </span>
                    <DirMark dir={t.dir} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
