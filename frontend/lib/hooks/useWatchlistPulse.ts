// Watchlist-wide pulse hook (shared by the Live Signals scanner + the Catalyst
// Calendar). Fetches the six event-driven slices across the whole watchlist in
// one pass and partitions them per company into the CompanyData bundle that
// pulse.ts consumes. Deliberately omits heavy fundamentals/13F/prices: the
// scanner and calendar are catalyst surfaces ("what just happened / what's
// actionable"), and buildSignals degrades gracefully when those slices are absent.

import { useEffect, useMemo, useState } from "react";

import {
  fetchRecentInsider, fetchRecentEarnings, fetchRecentEvents,
  fetchRecentBeneficial, fetchRecentOfferings, fetchRecentLateFilings,
} from "../data/data";
import type { CompanyData, WatchEntry } from "../domain/pulse";
import type { Company } from "../types";

/** Fetch + partition the watchlist's recent catalyst slices into per-company bundles. */
export function useWatchlistPulse(companies: Company[]): { entries: WatchEntry[]; loading: boolean } {
  const [bundles, setBundles] = useState<Record<string, CompanyData>>({});
  const [loading, setLoading] = useState(true);
  const ciks = useMemo(() => companies.map((c) => c.cik), [companies]);
  const cikKey = ciks.join(",");

  useEffect(() => {
    if (!ciks.length) { setBundles({}); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchRecentInsider(ciks), fetchRecentEarnings(ciks), fetchRecentEvents(ciks),
      fetchRecentBeneficial(ciks), fetchRecentOfferings(ciks), fetchRecentLateFilings(ciks),
    ]).then(([ins, ea, ev, ben, off, late]) => {
      if (cancelled) return;
      const by: Record<string, CompanyData> = {};
      const slot = (cik: string) =>
        (by[cik] ??= { insider: [], earnings: [], events: [], beneficial: [], offers: [], lateF: [] });
      for (const r of ins)  slot(r.cik).insider!.push(r);
      for (const r of ea)   slot(r.cik).earnings!.push(r);
      for (const r of ev)   slot(r.cik).events!.push(r);
      for (const r of ben)  slot(r.cik).beneficial!.push(r);
      for (const r of off)  slot(r.cik).offers!.push(r);
      for (const r of late) slot(r.cik).lateF!.push(r);
      setBundles(by);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [cikKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo<WatchEntry[]>(
    () => companies.map((c) => ({
      cik: c.cik, ticker: c.ticker ?? "?", name: c.name ?? c.cik, data: bundles[c.cik] ?? {},
    })),
    [companies, bundles],
  );
  return { entries, loading };
}
