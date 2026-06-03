import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Summa — SEC Data Warehouse",
  description: "13f.info-style explorer for every price-relevant SEC dataset",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jetbrains.variable}>
      <body>{children}</body>
    </html>
  );
}
