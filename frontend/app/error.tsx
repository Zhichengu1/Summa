"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "var(--bg-0)", fontFamily: "ui-monospace, monospace",
      gap: 20, padding: "40px 24px", textAlign: "center",
    }}>
      <div style={{ fontSize: 11, letterSpacing: "0.2em", color: "var(--alert)", textTransform: "uppercase", fontWeight: 700 }}>
        Error
      </div>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-0)", margin: 0 }}>
        Something went wrong
      </h2>
      <p style={{ fontSize: 14, color: "var(--fg-3)", margin: 0, maxWidth: 360 }}>
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 8, padding: "10px 28px", borderRadius: 8,
          background: "var(--bg-2)", border: "1px solid var(--border-1)",
          color: "var(--accent)", fontSize: 14, fontFamily: "inherit",
          cursor: "pointer", letterSpacing: "0.04em", fontWeight: 600,
        }}
      >
        Try again
      </button>
    </div>
  );
}
