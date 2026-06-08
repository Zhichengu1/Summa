// Scorecard — renders the Health Scorecard produced by buildScorecard (lib/
// scorecard.ts): an overall verdict + plain-English summary, then a grade per
// shareholder dimension.
import { InfoTip } from "./InfoTip";
import { GRADE_LABEL, type ScorecardResult } from "../lib/domain/scorecard";

export function Scorecard({ card }: { card: ScorecardResult }) {
  return (
    <div className={`scorecard grade-${card.overall}`}>
      <div className="sc-top">
        <div className="sc-overall">
          <span className="sc-overall-label">Health check</span>
          <span className={`sc-badge grade-${card.overall}`}>{GRADE_LABEL[card.overall]}</span>
        </div>
        <p className="sc-summary">{card.summary}</p>
      </div>
      <div className="sc-grid">
        {card.dims.map((dm) => (
          <div key={dm.label} className={`sc-dim grade-${dm.grade}`}>
            <div className="sc-dim-top">
              <span className="sc-dim-label">{dm.label}{dm.term && <InfoTip term={dm.term} />}</span>
              <span className={`sc-dim-grade grade-${dm.grade}`}>{GRADE_LABEL[dm.grade]}</span>
            </div>
            <div className="sc-dim-detail">{dm.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
