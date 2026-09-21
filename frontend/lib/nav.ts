// Primary navigation, declared once. The nav board, the hash router, the mobile
// menu and the Data Guide all read this, so a view can't exist in the nav without
// a route (or vice versa). Hash === view key.
import type { IconName } from "../components/Icon";
import type { MainView } from "./types";

export type NavItem = {
  view: Exclude<MainView, "company">;
  label: string;
  icon: IconName;
  /** One-line "what is this page" — shown as the tooltip / menu description. */
  desc: string;
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Your watchlist",
    items: [
      { view: "overview", label: "Dashboard", icon: "dashboard", desc: "What moved, what was filed, and what the filings imply across your watchlist" },
      { view: "calendar", label: "Calendar",  icon: "calendar", desc: "Recent and dated catalysts across your watchlist, grouped by day" },
      { view: "feed",     label: "Filings",   icon: "filings", desc: "Real-time SEC filings feed for your companies (10-K, 10-Q, 8-K, DEF 14A)" },
      { view: "news",     label: "News",      icon: "news", desc: "Market-moving headlines: curated federal/market feeds plus per-company news" },
      { view: "search",   label: "Add companies", icon: "search", desc: "Search every US public company and add it to your watchlist" },
    ],
  },
  {
    label: "Market intelligence",
    items: [
      { view: "trends",   label: "Trends",       icon: "trends", desc: "What tracked companies are collectively investing in, from 10-K/10-Q language and capital" },
      { view: "managers", label: "Institutions", icon: "institutions", desc: "What the big 13F managers hold and what they bought or sold last quarter" },
      { view: "options",  label: "Options Radar", icon: "options", desc: "Calls-vs-puts bias, volatility pricing and a suggested structure per company" },
      { view: "ipos",     label: "IPOs",         icon: "ipos", desc: "The live IPO pipeline: registrations, pricings and withdrawals market-wide" },
      { view: "congress", label: "Congress",     icon: "congress", desc: "Congress tracker: the stocks the most members are buying, consensus buys and sells, and every disclosed trade" },
      { view: "reddit",   label: "Reddit Buzz",  icon: "reddit", desc: "Most-discussed tickers on the investing subreddits, refreshed daily" },
      { view: "cot",      label: "COT Futures",  icon: "cot", desc: "Weekly CFTC positioning: speculators vs hedgers across major futures" },
    ],
  },
  {
    label: "Help",
    items: [
      { view: "guide", label: "Data Guide", icon: "guide", desc: "What every dataset means and how much it tends to move a stock" },
    ],
  },
];

/** The primary tabs shown inline on the nav board (the first group, minus "Add companies"). */
export const PRIMARY_NAV: NavItem[] = NAV_GROUPS[0].items.filter((it) => it.view !== "search");
/** The "Markets" menu on the nav board. */
export const MARKETS_NAV: NavItem[] = NAV_GROUPS[1].items;
