// FormBadge — the colored SEC form-type chip (10-K, 8-K, DEF 14A, …). Color is
// derived from the form via formColorVar so each form family reads consistently.
import { formColorVar } from "../../lib/utils/format";

export function FormBadge({ form }: { form: string }) {
  const c = formColorVar(form);
  return (
    <span style={{
      fontSize: 10, letterSpacing: "0.08em", padding: "2px 7px",
      border: `1px solid ${c}44`, color: c, background: `${c}14`,
      borderRadius: 4, whiteSpace: "nowrap", fontWeight: 700, display: "inline-block",
    }}>
      {form}
    </span>
  );
}
