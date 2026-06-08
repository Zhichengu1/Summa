// DirMark — the small directional glyph (▲ bull / ▼ bear / ◆ flag / ● neutral)
// shared by the tape, signal cards, and calendar rows.
import type { Direction } from "../../lib/domain/pulse";

export function DirMark({ dir }: { dir: Direction }) {
  const mark = dir === "bull" ? "▲" : dir === "bear" ? "▼" : dir === "flag" ? "◆" : "●";
  return <span className={`dir-mark dir-${dir}`}>{mark}</span>;
}
