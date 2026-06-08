// URL safety guard. Every external href in the UI passes through this so only
// http(s) links are ever rendered (no javascript:/data: schemes). See the
// "URL props pass through a safeHref-style guard" frontend invariant.

/** Return the URL only if it is a well-formed http(s) link, else undefined. */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch { return undefined; }
}
