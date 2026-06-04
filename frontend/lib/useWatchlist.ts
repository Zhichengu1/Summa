"use client";
// Personal watchlist persisted in the browser (localStorage). This is the user's
// own list — instant, private, no backend write. Adding a company that isn't yet
// ingested separately queues it for the backend (see queueWatchlist in data.ts).

import { useCallback, useEffect, useRef, useState } from "react";

export type WatchItem = { cik: string; ticker: string; name: string };

const KEY = "summa.watchlist.v1";

export function useWatchlist() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const hadKey = useRef(false);

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { hadKey.current = true; setItems(JSON.parse(raw)); }
    } catch { /* ignore corrupt/unavailable storage */ }
    setHydrated(true);
  }, []);

  const update = useCallback((fn: (prev: WatchItem[]) => WatchItem[]) => {
    setItems((prev) => {
      const next = fn(prev);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const add = useCallback((c: WatchItem) => {
    update((prev) => (prev.some((i) => i.cik === c.cik) ? prev : [...prev, c]));
  }, [update]);

  const remove = useCallback((cik: string) => {
    update((prev) => prev.filter((i) => i.cik !== cik));
  }, [update]);

  // Seed from the ingested companies on the very first visit (no stored key yet),
  // so the list isn't empty out of the box. A returning user's curation wins.
  const seedIfEmpty = useCallback((seed: WatchItem[]) => {
    if (hadKey.current) return;
    hadKey.current = true;
    update((prev) => (prev.length ? prev : seed));
  }, [update]);

  return { items, hydrated, add, remove, seedIfEmpty };
}
