// KpiTile — a single headline metric with QoQ / YoY deltas, used in the
// fundamentals KPI strips.
import { InfoTip } from "../InfoTip";
import { fmtUSD, fmtNum, fmtPct, fmtDelta } from "../../lib/utils/format";

export function KpiTile({
  label, value, fmt, qoq, yoy,
}: {
  label: string; value: number | null;
  fmt: "usd" | "pct" | "num";
  qoq: number | null; yoy: number | null;
}) {
  const formatted =
    fmt === "usd" ? fmtUSD(value) :
    fmt === "pct" ? fmtPct(value) :
    fmtNum(value);
  return (
    <div className="kpi">
      <div className="k-label">{label}<InfoTip term={label} /></div>
      <div className="k-value">{formatted}</div>
      <div className="k-delta">
        {qoq != null && <span className={qoq >= 0 ? "pos" : "neg"}>{fmtDelta(qoq)} QoQ</span>}
        {yoy != null && <span className={yoy >= 0 ? "pos" : "neg"}>{fmtDelta(yoy)} YoY</span>}
      </div>
    </div>
  );
}
