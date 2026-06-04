// Insider-transaction quality analysis.
//
// Not all Form 4 trades carry the same signal. A real open-market BUY (code P)
// is the discretionary, cash-out-of-pocket vote that traders weight; an open-
// market SELL (code S) is its bearish counterpart. Everything else — option
// exercises (M), grants (A), gifts (G), tax-withholding sales (F), conversions
// (C) — is compensation/mechanical noise that the crude "acquired vs disposed"
// net lumps in and distorts. This module isolates the open-market signal and
// flags cluster buying (several distinct insiders buying in the same window),
// the most studied bullish insider pattern.
//
// Note: 10b5-1 (pre-planned) status would further refine this, but the backend
// does not yet populate `is_10b5_1` (always false), so we lean on the reliably
// captured transaction codes instead.
import type { InsiderTransaction } from "./types";

export type InsiderRead = {
  netOpenMarket: number;   // Σ open-market buys − Σ open-market sells ($), in window
  buyValue: number;        // Σ open-market buy value ($)
  sellValue: number;       // Σ open-market sell value ($)
  distinctBuyers: number;  // unique insiders with an open-market buy
  distinctSellers: number; // unique insiders with an open-market sell
  clusterBuy: boolean;     // ≥3 distinct open-market buyers — a strong bullish tell
  routineValue: number;    // Σ |value| of non-open-market (grants/options/tax) trades
  anyOpenMarket: boolean;  // any P or S in the window at all
};

const CLUSTER_THRESHOLD = 3;

// Form 4 transaction codes → a short label and a plain-English meaning. Lets the
// UI tell a trader *what kind* of trade happened, not just buy/sell: a CEO buying
// on the open market (P) is a very different signal from shares withheld for tax
// (F) or an option exercise (M).
export const TX_CODE_INFO: Record<string, { label: string; meaning: string }> = {
  P: { label: "Open-market buy",  meaning: "Open-market purchase — the insider bought shares with their own cash. The most informative insider trade." },
  S: { label: "Open-market sell", meaning: "Open-market sale — the insider sold shares into the market." },
  A: { label: "Grant",            meaning: "Stock grant or award from the company as compensation — not a discretionary purchase." },
  M: { label: "Option exercise",  meaning: "Exercise or conversion of options/derivatives into shares — a compensation mechanic, not an open-market buy." },
  F: { label: "Tax withholding",  meaning: "Shares automatically withheld to pay taxes on vesting or an exercise — not a discretionary sale." },
  G: { label: "Gift",             meaning: "Shares given or received as a gift — no market transaction." },
  C: { label: "Conversion",       meaning: "Conversion of a derivative security into shares." },
  X: { label: "Exercise",         meaning: "Exercise of an in-the-money or at-the-money derivative." },
  D: { label: "Disposed to issuer", meaning: "Shares disposed back to the company (e.g. forfeiture, repurchase)." },
  W: { label: "Will / inheritance", meaning: "Acquisition or disposition by will or the laws of descent." },
  J: { label: "Other",            meaning: "Other acquisition or disposition (see the filing footnotes)." },
  I: { label: "Discretionary",    meaning: "A discretionary transaction under an employee benefit plan." },
  Z: { label: "Voting trust",     meaning: "Deposit into or withdrawal from a voting trust." },
};

/** Short human label for a Form 4 transaction code (falls back to the raw code). */
export function txCodeLabel(code: string | null | undefined): string {
  const c = (code ?? "").toUpperCase();
  return TX_CODE_INFO[c]?.label ?? (c || "—");
}

/** Plain-English description of one insider trade: who, their role, and what kind. */
export function describeInsiderTx(t: {
  filer_title?: string | null; transaction_code?: string | null;
  acquired_disposed?: string | null; is_10b5_1?: boolean;
}): string {
  const c = (t.transaction_code ?? "").toUpperCase();
  const role = (t.filer_title ?? "").trim();
  const kind = TX_CODE_INFO[c]?.meaning
    ?? (t.acquired_disposed === "A" ? "Acquisition of shares." : t.acquired_disposed === "D" ? "Disposition of shares." : "Reported transaction.");
  const plan = t.is_10b5_1 ? " Executed under a pre-arranged 10b5-1 plan, so it is less informative than a discretionary trade." : "";
  return `${role ? role + ". " : ""}${kind}${plan}`;
}

/** Analyze a company's insider trades over a trailing window (default 90 days). */
export function analyzeInsider(
  txns: InsiderTransaction[],
  windowDays = 90,
): InsiderRead {
  const cutoff = Date.now() - windowDays * 86_400_000;
  let buyValue = 0, sellValue = 0, routineValue = 0;
  const buyers = new Set<string>();
  const sellers = new Set<string>();

  for (const t of txns) {
    const when = t.transaction_date ?? t.filed_at;
    if (!when || t.value == null) continue;
    if (new Date(when).getTime() < cutoff) continue;
    const code = (t.transaction_code ?? "").toUpperCase();
    const v = Math.abs(t.value);
    const who = t.filer_name ?? "?";
    if (code === "P") {
      buyValue += v;
      buyers.add(who);
    } else if (code === "S") {
      sellValue += v;
      sellers.add(who);
    } else {
      routineValue += v;
    }
  }

  return {
    netOpenMarket: buyValue - sellValue,
    buyValue,
    sellValue,
    distinctBuyers: buyers.size,
    distinctSellers: sellers.size,
    clusterBuy: buyers.size >= CLUSTER_THRESHOLD,
    routineValue,
    anyOpenMarket: buyValue > 0 || sellValue > 0,
  };
}
