// NameContext — a filer/manager name with an inline context tooltip when it's a
// known entity (index manager, activist, bank, …), looked up from the seeded
// entity registry. Falls back to the bare name when nothing is known.
import { InfoTip } from "./InfoTip";
import { entityContext } from "../lib/domain/entities";

export function NameContext({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="dimmed">—</span>;
  const e = entityContext(name);
  if (!e) return <span>{name}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {name}
      <InfoTip def={`${e.label}. ${e.note}`} />
    </span>
  );
}
