// SignalCard — renders one derived forward-looking Signal (label, status,
// detail, age, direction). Shared by the company cockpit and the watchlist-wide
// Live Signals scanner so both read identically.
import { InfoTip } from "./InfoTip";
import { DirMark } from "./badges/DirMark";
import { elapsed, fmtDate } from "../lib/utils/format";
import type { Signal } from "../lib/domain/pulse";

// Map each derived signal to the glossary term that explains the concept behind it.
const SIGNAL_TERM: Record<string, string> = {
  "Guidance": "Guidance",
  "Revenue Momentum": "YoY",
  "Net Margin": "Net Margin",
  "Insider Flow · 90d": "Insider",
  "Institutional Flow": "Institutional Holdings",
  "Activist Watch": "Activist",
  "Dilution Risk": "Dilution",
  "Filing Integrity": "NT 10-K",
  "Insider Cluster Buy": "Cluster buying",
  "Price vs 52-wk High": "% off 52-wk high",
  "Golden Cross": "Golden Cross",
  "Death Cross": "Death Cross",
  "52-wk Breakout": "52-wk Breakout",
  "RSI": "RSI",
  "Volume Spike": "Volume Spike",
};

export function SignalCard({ s }: { s: Signal }) {
  const term = SIGNAL_TERM[s.label];
  const age = elapsed(s.date);
  return (
    <div className={`signal dir-${s.dir}`}>
      <div className="sig-top">
        <span className="sig-label">{s.label}{term && <InfoTip term={term} />}</span>
        {age && <span className="sig-age" title={fmtDate(s.date)}>{age}</span>}
        <DirMark dir={s.dir} />
      </div>
      <div className="sig-status">{s.status}</div>
      <div className="sig-detail">{s.detail}</div>
    </div>
  );
}
