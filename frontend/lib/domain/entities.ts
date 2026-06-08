// Registry of notable institutional managers and activist investors.
//
// SEC filings show raw names — "Vanguard Group Inc", "ELLIOTT INVESTMENT
// MANAGEMENT L.P." — with no indication of who they are or why their presence on a
// shareholder register matters. This adds that context. Matching is substring-based
// (case-insensitive) so filing-name variants ("BLACKROCK INC.", "BlackRock, Inc.")
// all resolve to the same entry.

export type EntityKind = "index" | "active" | "bank" | "activist" | "value";

export type Entity = { kind: EntityKind; note: string };

// Each entry: lowercase substrings that identify the filer → its context.
const REGISTRY: { match: string[]; entity: Entity }[] = [
  // ── The "Big Three" index managers — top holders of nearly every US large-cap ──
  { match: ["blackrock"], entity: { kind: "index", note: "The world's largest asset manager (~$10T). Its index funds and iShares ETFs make it a top-three holder of almost every large US company, so its stake reflects passive indexing, not a stock-specific view." } },
  { match: ["vanguard"], entity: { kind: "index", note: "The largest mutual-fund manager and a top-two passive holder of most US large-caps. Client-owned and index-driven, so its position size tracks the company's index weight rather than conviction." } },
  { match: ["state street"], entity: { kind: "index", note: "Manager of the SPDR ETF family (including SPY) and the third of the 'Big Three' index holders. Its stake is overwhelmingly passive." } },
  { match: ["geode"], entity: { kind: "index", note: "Sub-advisor that runs Fidelity's index funds; appears as a large passive holder despite the unfamiliar name." } },

  // ── Large active managers ────────────────────────────────────────────────────
  { match: ["berkshire hathaway", "warren buffett"], entity: { kind: "value", note: "Warren Buffett's conglomerate. Its concentrated, long-held equity stakes are watched as a high-conviction value signal — Berkshire buying or selling moves sentiment." } },
  { match: ["fidelity", "fmr llc", "fmr "], entity: { kind: "active", note: "One of the largest active asset managers and 401(k) providers. An active position change reflects a real portfolio-manager decision, unlike index holders." } },
  { match: ["t. rowe", "t rowe", "price (t.rowe)"], entity: { kind: "active", note: "A large active manager known for growth and retirement funds; position changes are discretionary calls." } },
  { match: ["capital research", "capital world", "capital group"], entity: { kind: "active", note: "Capital Group (American Funds) — among the largest active managers in the world; long-term, research-driven positions." } },
  { match: ["wellington"], entity: { kind: "active", note: "A major active institutional manager and sub-advisor; discretionary, fundamentals-driven holdings." } },
  { match: ["morgan stanley"], entity: { kind: "bank", note: "Holdings span its asset-management arm and brokerage/market-making inventory, so the position mixes conviction with client and trading activity." } },
  { match: ["jpmorgan", "j.p. morgan", "jp morgan"], entity: { kind: "bank", note: "Combines JPMorgan Asset Management funds with bank trading inventory; read the position with that mix in mind." } },
  { match: ["goldman sachs"], entity: { kind: "bank", note: "Mixes Goldman Sachs Asset Management funds with market-making inventory rather than pure conviction." } },
  { match: ["bank of america", "merrill"], entity: { kind: "bank", note: "Holdings blend asset management with brokerage and trading inventory." } },
  { match: ["invesco"], entity: { kind: "active", note: "A large asset manager (including the QQQ ETF franchise); positions are a mix of active and index funds." } },
  { match: ["northern trust"], entity: { kind: "index", note: "A custody bank and large index/passive manager; stakes are mostly index-tracking." } },

  // ── Activist investors — a 13D from these names is a potential catalyst ────────
  { match: ["elliott"], entity: { kind: "activist", note: "Paul Singer's Elliott Management — an aggressive, deeply-resourced activist that pushes for board change, breakups, cost cuts, or an outright sale. Its arrival often precedes a fight." } },
  { match: ["icahn"], entity: { kind: "activist", note: "Carl Icahn's vehicle — a pioneering activist/corporate raider that agitates for buybacks, spin-offs, and board seats." } },
  { match: ["pershing square", "ackman"], entity: { kind: "activist", note: "Bill Ackman's concentrated activist fund, known for large, public, high-conviction campaigns." } },
  { match: ["starboard"], entity: { kind: "activist", note: "Starboard Value — an activist specializing in operational turnarounds and board overhauls at underperforming companies." } },
  { match: ["valueact"], entity: { kind: "activist", note: "A 'constructive' activist that usually takes a board seat and works with management at large caps rather than waging public war." } },
  { match: ["third point", "daniel loeb", "dan loeb"], entity: { kind: "activist", note: "Dan Loeb's Third Point — an activist hedge fund famous for pointed public letters demanding change." } },
  { match: ["trian", "nelson peltz"], entity: { kind: "activist", note: "Nelson Peltz's Trian — an operational activist that targets large consumer and industrial companies for margin improvement and board seats." } },
  { match: ["engine no. 1", "engine no 1"], entity: { kind: "activist", note: "A small activist famous for winning Exxon board seats in 2021 on a returns-and-climate platform — proof that a tiny stake can force change." } },
];

const KIND_LABEL: Record<string, string> = {
  index: "Index manager",
  active: "Active manager",
  bank: "Bank / broker-dealer",
  activist: "Activist investor",
  value: "Value investor",
};

// ─── Backend-backed cache (Phase A) ─────────────────────────────────────────
// The `entities` warehouse table is the source of truth; REGISTRY above is the
// embedded fallback. `loadEntities` is called once per session from the app's
// initial load. Each row is a single (match_key → context) pair.
import type { EntityRow } from "../types";

let dbEntities: { match: string; entity: Entity }[] | null = null;

/** Populate the cache from the warehouse rows (called once at startup). */
export function loadEntities(rows: EntityRow[]): void {
  if (!rows.length) { dbEntities = null; return; }
  dbEntities = rows
    .filter((r) => r.match_key && r.note)
    .map((r) => ({ match: r.match_key.toLowerCase(), entity: { kind: (r.kind ?? "active") as EntityKind, note: r.note ?? "" } }));
}

/** Resolve filing-name → context, or null if the name isn't a known entity. */
export function entityContext(name: string | null | undefined): (Entity & { label: string }) | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const source = dbEntities ?? REGISTRY;
  for (const row of source) {
    if (Array.isArray((row as { match: string[] }).match)
      ? (row as { match: string[] }).match.some((m) => n.includes(m))
      : n.includes((row as { match: string }).match)) {
      const e = row.entity;
      return { ...e, label: KIND_LABEL[e.kind] ?? "Investor" };
    }
  }
  return null;
}
