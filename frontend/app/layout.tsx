import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Summa — SEC Filing Intelligence",
  description: "Automated signal detection for SEC EDGAR filings",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
