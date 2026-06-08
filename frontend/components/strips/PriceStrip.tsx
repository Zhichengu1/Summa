// PriceStrip — compact EOD-price metric strip: last close, distance from the
// 52-week high, and trailing returns. Returns are colored; the price feed is
// end-of-day, not realtime.
import { InfoTip } from "../InfoTip";
import { fmtUSD, fmtPct, fmtDelta, fmtDate } from "../../lib/utils/format";
import type { derivePriceKpis } from "../../lib/domain/prices";

export function PriceStrip({ k }: { k: ReturnType<typeof derivePriceKpis> }) {
  const Ret = ({ label, v }: { label: string; v: number | null }) => (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className={`k-value ${v == null ? "" : v >= 0 ? "pos" : "neg"}`}>{v == null ? "—" : fmtDelta(v)}</div>
    </div>
  );
  return (
    <div className="kpi-strip dense">
      <div className="kpi">
        <div className="k-label">Last<InfoTip term="EOD price" /></div>
        <div className="k-value">{fmtUSD(k.last)}</div>
        <div className="k-delta"><span className="muted">{k.asOf ? fmtDate(k.asOf) : ""}</span></div>
      </div>
      <div className="kpi">
        <div className="k-label">Off 52-wk High<InfoTip term="% off 52-wk high" /></div>
        <div className={`k-value ${k.pctOffHigh == null ? "" : k.pctOffHigh > -3 ? "pos" : k.pctOffHigh < -25 ? "neg" : ""}`}>
          {k.pctOffHigh == null ? "—" : fmtPct(k.pctOffHigh)}
        </div>
      </div>
      <Ret label="YTD" v={k.retYTD} />
      <Ret label="3M" v={k.ret3M} />
      <Ret label="1M" v={k.ret1M} />
    </div>
  );
}
