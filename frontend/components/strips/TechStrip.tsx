// TechStrip — trader technicals readout (the price-action layer): RSI, distance
// from the 50/200-day moving averages, and volume vs its 30-day average. All values
// are pre-computed by deriveTechnicals(); this just renders them as a strip alongside
// the fundamentals so a trader sees momentum at a glance. (52-week position is shown
// once, precisely, by PriceStrip's "Off 52-wk High".)
import { InfoTip } from "../InfoTip";
import type { Technicals } from "../../lib/domain/technicals";

export function TechStrip({ t }: { t: Technicals }) {
  const pct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  const signClass = (v: number | null) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  const rsiClass = t.rsi14 == null ? "" : t.rsi14 >= 70 ? "neg" : t.rsi14 <= 30 ? "pos" : "";
  return (
    <div className="kpi-strip dense">
      <div className="kpi">
        <div className="k-label">RSI-14<InfoTip term="RSI" /></div>
        <div className={`k-value ${rsiClass}`}>{t.rsi14 == null ? "—" : t.rsi14.toFixed(0)}</div>
        <div className="k-delta"><span className="muted">{t.rsi14 == null ? "" : t.rsi14 >= 70 ? "overbought" : t.rsi14 <= 30 ? "oversold" : "neutral"}</span></div>
      </div>
      <div className="kpi">
        <div className="k-label">vs 50d MA<InfoTip term="vs 50-day MA" /></div>
        <div className={`k-value ${signClass(t.pctFrom50)}`}>{pct(t.pctFrom50)}</div>
      </div>
      <div className="kpi">
        <div className="k-label">vs 200d MA<InfoTip term="vs 200-day MA" /></div>
        <div className={`k-value ${signClass(t.pctFrom200)}`}>{pct(t.pctFrom200)}</div>
        {t.cross && (
          <div className="k-delta">
            <span className={t.cross === "golden" ? "pos" : "neg"}>
              {t.cross === "golden" ? "▲ golden cross" : "▼ death cross"}
            </span>
          </div>
        )}
      </div>
      <div className="kpi">
        <div className="k-label">Volume<InfoTip term="Volume Spike" /></div>
        <div className={`k-value ${t.volSpike != null && t.volSpike >= 2 ? "neg" : ""}`}>{t.volSpike == null ? "—" : `${t.volSpike.toFixed(1)}×`}</div>
        <div className="k-delta"><span className="muted">vs 30d avg</span></div>
      </div>
      <div className="kpi">
        <div className="k-label">Volatility<InfoTip term="Volatility" /></div>
        <div className="k-value">{t.histVol == null ? "—" : `${t.histVol.toFixed(0)}%`}</div>
        <div className="k-delta"><span className="muted">annualized</span></div>
      </div>
      <div className="kpi">
        <div className="k-label">ATR<InfoTip term="ATR" /></div>
        <div className="k-value">{t.atrPct == null ? "—" : `${t.atrPct.toFixed(1)}%`}</div>
        <div className="k-delta"><span className="muted">typical daily range</span></div>
      </div>
    </div>
  );
}
