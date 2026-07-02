// EventClassBadge — uppercase color-coded label for a classified 8-K event class
// (M&A, dilution, restatement, exec_change, earnings, capital_return, cyber, …).
export function EventClassBadge({ cls }: { cls: string | null }) {
  const colors: Record<string, string> = {
    "M&A": "#60a5fa", dilution: "#f59e0b", restatement: "#ef4444",
    exec_change: "#a78bfa", earnings: "#2dd4bf", capital_return: "#22c55e",
    cyber: "#ef4444", other: "var(--fg-4)",
  };
  const c = colors[cls ?? "other"] ?? "var(--fg-4)";
  return (
    <span style={{ color: c, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {cls ?? "other"}
    </span>
  );
}
