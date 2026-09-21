// Path routing for the single-page app. Clean URLs, no hash:
//   /                      → dashboard (the "overview" view)
//   /feed, /news, /trends… → that nav view (the view key is the path segment)
//   /company/<cik>         → company page, Overview tab
//   /company/<cik>/<tab>   → company page on that tab
// The static export serves index.html for every one of these paths (Cloudflare
// Pages `_redirects`; `rewrites` in next.config for the dev server), and the root
// Page reads window.location.pathname. Old `#feed` / `#c=<cik>/<tab>` links are
// translated on load so existing bookmarks keep working.
import { NAV_GROUPS } from "./nav";
import type { CompanyTab, MainView } from "./types";

export type NavView = Exclude<MainView, "company">;
export type Route =
  | { kind: "view"; view: NavView }
  | { kind: "company"; cik: string; tab: CompanyTab };

/** Every routable top-level view, from the nav config (a view can't exist without a route). */
export const NAV_VIEWS = new Set<string>(NAV_GROUPS.flatMap((g) => g.items.map((it) => it.view)));

const COMPANY_TABS = new Set<string>(["overview", "strategy", "fundamentals", "peers", "ownership", "catalysts", "filings", "news"]);

export function viewPath(view: NavView): string {
  return view === "overview" ? "/" : `/${view}`;
}

export function companyPath(cik: string, tab: CompanyTab = "overview"): string {
  return `/company/${encodeURIComponent(cik)}${tab !== "overview" ? `/${tab}` : ""}`;
}

export function routePath(r: Route): string {
  return r.kind === "view" ? viewPath(r.view) : companyPath(r.cik, r.tab);
}

/** Parse a pathname; null when it is not a known route. */
export function parsePath(pathname: string): Route | null {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { kind: "view", view: "overview" };
  if (parts[0] === "company" && parts[1]) {
    const tab = parts[2] && COMPANY_TABS.has(parts[2]) ? (parts[2] as CompanyTab) : "overview";
    return { kind: "company", cik: parts[1], tab };
  }
  if (parts.length === 1 && NAV_VIEWS.has(parts[0])) return { kind: "view", view: parts[0] as NavView };
  return null;
}

/** Translate a legacy hash route (`#feed`, `#c=<cik>/<tab>`) to a Route, or null. */
export function parseLegacyHash(hash: string): Route | null {
  const h = hash.replace(/^#/, "");
  if (!h) return null;
  if (NAV_VIEWS.has(h)) return { kind: "view", view: h as NavView };
  const m = h.match(/^c=([^/]+)(?:\/(.*))?$/);
  if (m) {
    const tab = m[2] && COMPANY_TABS.has(m[2]) ? (m[2] as CompanyTab) : "overview";
    return { kind: "company", cik: m[1], tab };
  }
  return null;
}
