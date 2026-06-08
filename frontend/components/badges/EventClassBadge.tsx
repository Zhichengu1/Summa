// EventClassBadge — uppercase color-coded label for a classified 8-K event class
// (M&A, dilution, restatement, exec_change, earnings, capital_return, cyber, …).
export function EventClassBadge({ cls }: { cls: string | null }) {
  const colors: Record<string, string> = {
    "M&A": "#7aa2f7", dilution: "#f5a623", restatement: "#f05252",
    exec_change: "#bb9af7", earnings: "#4fd4c2", capital_return: "#3fb950",
    cyber: "#f05252", other: "var(--fg-4)",
  };
  const c = colors[cls ?? "other"] ?? "var(--fg-4)";
  return (
    <span style={{ color: c, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {cls ?? "other"}
    </span>
  );
}
