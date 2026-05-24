export default function NotFound() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "var(--bg-0)", fontFamily: "ui-monospace, monospace",
      gap: 16, padding: "40px 24px", textAlign: "center",
    }}>
      <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--fg-4)", textTransform: "uppercase", fontWeight: 600 }}>
        404
      </div>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)", margin: 0 }}>
        Page not found
      </h2>
      <p style={{ fontSize: 14, color: "var(--fg-3)", margin: 0 }}>
        This route does not exist.
      </p>
      <a
        href="/"
        style={{
          marginTop: 8, padding: "10px 28px", borderRadius: 8,
          background: "var(--bg-2)", border: "1px solid var(--border-1)",
          color: "var(--accent)", fontSize: 14, fontFamily: "inherit",
          textDecoration: "none", letterSpacing: "0.04em", fontWeight: 600,
        }}
      >
        Go home
      </a>
    </div>
  );
}
