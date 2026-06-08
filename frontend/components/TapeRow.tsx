// TapeRow — one row of the merged "what just happened" disclosure tape (date,
// kind, headline + optional note tooltip, direction mark).
import { InfoTip } from "./InfoTip";
import { DirMark } from "./badges/DirMark";
import { fmtDate } from "../lib/utils/format";
import type { TapeItem } from "../lib/domain/pulse";

export function TapeRow({ t }: { t: TapeItem }) {
  return (
    <div className={`tape-row dir-${t.dir}`}>
      <span className="tape-date">{fmtDate(t.date)}</span>
      <span className="tape-kind">{t.kind}</span>
      <span className="tape-head">
        <span className="tape-head-text" title={t.headline}>{t.headline}</span>
        {t.note && <InfoTip def={t.note} />}
      </span>
      <DirMark dir={t.dir} />
    </div>
  );
}
