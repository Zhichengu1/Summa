// Tiny in-memory read cache for the data layer. Supabase egress (5 GB/month on the
// free tier) is the real production budget: without this, every navigation back to
// the dashboard re-downloaded the same market-wide rows. `cached()` returns the
// in-flight or recent promise for a key, so concurrent callers share one request
// and repeat visits inside the TTL cost nothing. Per tab, cleared on reload.

type Entry = { at: number; promise: Promise<unknown> };
const store = new Map<string, Entry>();

export function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.promise as Promise<T>;
  const promise = loader().catch((e) => { store.delete(key); throw e; });   // never cache a failure
  store.set(key, { at: now, promise });
  return promise;
}

/** Drop one key (e.g. after a write that invalidates it) or everything. */
export function invalidate(key?: string): void {
  if (key == null) store.clear(); else store.delete(key);
}
