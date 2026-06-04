"use client";
// Tracks "what's new since your last visit". On mount it reads the previous
// visit timestamp (used to flag new items for the whole session) and immediately
// stamps *now* for the next visit — so badges reflect changes since you were last
// here and stay stable while you browse, rather than clearing the moment you load.

import { useCallback, useEffect, useState } from "react";

const KEY = "summa.lastSeen.v1";

export function useLastSeen() {
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      setLastSeen(raw ? Number(raw) : null);     // null on first-ever visit → nothing flagged new
      localStorage.setItem(KEY, String(Date.now()));
    } catch { /* ignore unavailable storage */ }
    setHydrated(true);
  }, []);

  /** True if `iso` is newer than the previous visit (false on first visit / no date). */
  const isNew = useCallback((iso: string | null | undefined): boolean => {
    if (!iso || lastSeen == null) return false;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t > lastSeen;
  }, [lastSeen]);

  return { lastSeen, hydrated, isNew };
}
