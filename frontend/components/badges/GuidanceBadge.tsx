// GuidanceBadge — colors an earnings guidance action (raised / lowered /
// withdrawn / reaffirmed) green / red / amber.
export function GuidanceBadge({ action }: { action: string }) {
  const c = action === "raised" ? "var(--pos)" : action === "lowered" ? "var(--neg)" : action === "withdrawn" ? "var(--warn)" : "var(--fg-2)";
  return <span style={{ color: c, fontWeight: 600 }}>{action}</span>;
}
