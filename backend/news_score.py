"""Shared trader-importance scorer for news headlines.

One source of truth used by BOTH the market-wide feed (market_news_ingest.py) and
the per-company Google feed (news_ingest.py), so "important for a trader" means the
same thing everywhere. A headline is dropped outright on a noise pattern (routine
PR, fund-holding chatter, class-action spam), else scored by summing the weights of
every category bucket it matches (+ an optional source base weight). The first
(most-specific) bucket names the item's category.

Pure/stdlib; no I/O, no dependencies — safe to import anywhere.
"""

import re

# Corporate-name suffixes stripped when deriving a company's distinctive key word.
_NAME_SUFFIXES: frozenset[str] = frozenset({
    "corp", "corporation", "inc", "incorporated", "ltd", "limited", "co", "company",
    "plc", "group", "holdings", "holding", "the", "technologies", "technology",
    "sa", "ag", "nv", "lp", "llc", "class", "ord", "shs", "partners",
})

# Routine / non-market-moving chatter — dropped regardless of source (score 0).
DROP_PATTERNS: tuple[str, ...] = (
    # Earnings-date / event announcements (not the event itself)
    "to report", "to present", "to participate", "to host", "to webcast",
    "conference call", "webcast", "investor day", "to attend", "will present",
    # Fund / institutional-holding chatter (13F/13D churn — the biggest noise source)
    "schedule 13", "13f", "13d", "discloses stake", "discloses its stake",
    "buys shares of", "sells shares of", "shares of", "shares in", "shares purchased by",
    "shares sold by", "shares bought by", "acquires shares", "purchases shares", "sells shares",
    "boosts stake", "trims stake", "cuts stake", "reduces stake", "increases stake",
    "raises stake", "lowers stake", "grows position", "boosts holdings", "trims holdings",
    "reduces holdings", "increases holdings", "lowers holdings", "raises holdings",
    "position decreased", "position increased", "has $", "makes new investment in",
    "takes position in", "reduces position", "increases position",
    # Routine dividends
    "declares quarterly dividend", "declares monthly dividend",
    # Plaintiff / class-action law-firm spam
    "reminds investors", "class action", "deadline reminder", "lead plaintiff",
    "encourages investors", "investor alert", "law firm", "law offices", "opportunity to lead",
    "securities fraud investigation", "shareholder investigation", "on behalf of shareholders",
    "notifies investors", "investor rights", "shareholder alert", "should contact",
    # Aggregator / forecast filler
    "price target — prediction", "forecast — price target", "stocks moving in",
    "stocks to watch", "issues negative estimate", "issues positive estimate",
)

# (category, emoji, weight, keywords). Highest-specificity first; scores from ALL
# matched buckets sum, but the first match names the category.
SCORED: list[tuple[str, str, int, tuple[str, ...]]] = [
    # ── Federal Reserve / monetary policy (highest — moves the whole market) ──
    ("Fed",       "🏦", 5, ("fomc", "federal funds", "interest rate", "rate cut", "rate hike",
                            "monetary policy", "basis point", "rate decision", "rate pause",
                            "jerome powell", "powell", "fed chair", "dot plot", "quantitative",
                            "stress test", "bank capital", "supervisory", "beige book")),
    # ── Macro / government economic data + trade & fiscal policy ──
    ("Macro",     "🏛️", 4, ("jobs report", "nonfarm payroll", "unemployment rate", "jobless claims",
                            "cpi", "inflation", "ppi", "gdp", "personal income", "pce",
                            "consumer spending", "retail sales", "durable goods", "trade deficit",
                            "tariff", "trade deal", "trade war", "sanction", "export control",
                            "government shutdown", "debt ceiling", "treasury yield", "executive order",
                            "antitrust probe", "national emergency")),
    ("M&A",       "💼", 4, ("acquisition", "acquires ", "to acquire", "merger", "merges",
                            "buyout", "takeover", "agrees to buy", "definitive agreement",
                            "divest", "spin-off", "to purchase")),
    # ── Company investment: where it's deploying capital (capex/R&D/build-out/stakes) ──
    ("Investment", "💡", 3, ("capex", "capital expenditure", "r&d", "research and development",
                            "invests", "to invest", "invest $", "invest in", "billion investment",
                            "builds", "new plant", "new factory", "breaks ground", "expansion",
                            "expands into", "expanding", "takes stake", "acquires stake", "buys stake",
                            "funding round", "bets on", "new campus", "data center", "gigafactory",
                            "to spend", "ramps up", "commits $")),
    # Pharma/med only — kept narrow so it stops firing on generic "approval".
    ("FDA",       "💊", 4, ("fda ", "drug", "vaccine", "clinical trial", "phase 3", "phase iii",
                            "recall", "warning letter", "complete response", "biologic",
                            "breakthrough therapy", "fast track", "therapy")),
    ("Legal",     "⚖️", 4, ("charges", "fraud", "enforcement action", "settlement", "halts trading",
                            "suspends trading", "antitrust", "sues", "penalty", "sanction",
                            "indict", "pleads guilty", "subpoena", "sec probe")),
    ("Earnings",  "📊", 3, ("cuts guidance", "raises guidance", "profit warning", "guidance",
                            "restatement", "preliminary results", "beats", "misses", "quarterly results",
                            "record revenue", "record profit", "earnings")),
    # Severe going-concern events only (NOT ordinary price moves — those are "Move").
    ("Distress",  "🚨", 5, ("bankruptcy", "chapter 11", "default", "delisting", "going concern",
                            "layoffs", "restructuring", "insolvency")),
    # Capital structure / shareholder returns.
    ("Capital",   "💰", 3, ("buyback", "repurchase", "special dividend", "suspends dividend",
                            "stock split", "secondary offering", "capital raise", "dilution",
                            "private placement", "at-the-market", "raises dividend")),
    ("Exec",      "👔", 3, ("ceo steps down", "ceo resigns", "cfo resigns", "ceo departs",
                            "names ceo", "appoints ceo", "sudden departure", "ousted")),
    ("Analyst",   "⭐", 2, ("upgrade", "downgrade", "price target", "initiates coverage",
                            "outperform", "overweight", "underweight", "rated buy", "rated sell")),
    ("Product",   "🚀", 2, ("launches", "unveils", "partnership", "joint venture", "contract win",
                            "wins contract", "secures deal", "new product", "approval", "approved",
                            "clearance", "authorizes")),
    # Notable price/volatility moves — market-relevant, lower priority than the above.
    ("Move",      "📉", 2, ("plunge", "plummet", "soar", "tumble", "crashes", "sinks", "surges",
                            "spikes", "52-week low", "52-week high", "record high", "sell-off",
                            "selloff", "slumps")),
]

CATEGORY_EMOJI: dict[str, str] = {label: emoji for label, emoji, _w, _k in SCORED}
CATEGORY_EMOJI["News"] = "📰"

# ─── Source credibility (higher = more market-moving / trustworthy) ─────────────
# Matched as substrings against the RSS <source>. SEC/Fed/FDA + the wire services
# (Reuters/Bloomberg/WSJ/Dow Jones/AP/FT) are the top tier; reputable outlets are
# mid; data-scraper/aggregator sites default to 0 so their filler ranks low.
SOURCE_TIERS: list[tuple[int, tuple[str, ...]]] = [
    (3, ("sec.gov", "securities and exchange", "federal reserve", "fda", "reuters",
         "bloomberg", "wall street journal", "dow jones", "associated press",
         "financial times", "the wall street journal")),
    (2, ("cnbc", "barron", "marketwatch", "the economist", "nikkei", "forbes",
         "business insider", "axios", "fortune", "yahoo finance", "ap news")),
    (1, ("seeking alpha", "benzinga", "motley fool", "investing.com", "zacks",
         "thestreet", "investorplace", "247 wall", "simply wall", "cnn", "reuters.com")),
]

# Headlines whose numbers/guidance move the fundamentals thesis (extra weight).
FUNDAMENTAL_KW: tuple[str, ...] = (
    "guidance", "revenue", "earnings", " eps", "profit", "margin", "forecast",
    "outlook", "sales", "free cash flow", "net income", "same-store", "comparable sales",
    "bookings", "backlog", "subscribers", " arr", "operating income", "cash flow",
)

# Strong single-move language ⇒ likely a real short-term price catalyst.
STRONG_MOVE: tuple[str, ...] = (
    "plunge", "plummet", "soar", "surge", "crash", "tumble", "skyrocket", "spikes",
    "doubles", "craters", "rockets", "halted",
)

# Peripheral "list" headlines that only mention the company in passing (down-weight).
LIST_NOISE: tuple[str, ...] = (
    "stocks moving", "stocks to watch", "stocks to buy", "best stocks", "top stocks",
    "stocks in focus", "market movers", "biggest movers", "trending stocks",
    "stocks that", "watchlist", "stocks close", "stocks jump", "% this week",
)

# impact score → catalyst tier (label, emoji) for display + webhook gating.
def catalyst_tier(impact: int) -> tuple[str, str]:
    """Map a composite impact score to a catalyst strength tier."""
    if impact >= 8:
        return "High-impact", "🔴"
    if impact >= 6:
        return "Notable", "🟠"
    if impact >= 4:
        return "Minor", "🟡"
    return "Informational", "⚪"


def _name_key(name: str | None) -> str:
    """Distinctive lowercased key word from a company name (e.g. 'Alcoa Corp' → 'alcoa')."""
    if not name:
        return ""
    words = re.sub(r"[^a-z0-9 ]", " ", name.lower()).split()
    for w in words:
        if w not in _NAME_SUFFIXES and len(w) >= 3:
            return w
    return words[0] if words else ""


def _directness(title: str, ticker: str | None, name: str | None) -> int:
    """How directly the headline is about THIS company.

    +1 = the company's name (or an unambiguous ticker form like '(AA)', '$AA',
    'NYSE: AA') is in the title. -3 = company context was given but neither matched
    (likely a different issuer Google surfaced on a loose/short ticker match). 0 =
    no company context (macro/market feed).
    """
    if not ticker and not name:
        return 0
    tl = title.lower()
    key = _name_key(name)
    if key and key in tl:
        return 1
    if ticker:
        tk = ticker.strip()
        forms = (f"({tk})", f"${tk}", f"{tk}:", f": {tk}", f":{tk}")
        if any(f.lower() in tl for f in forms):
            return 1
        if len(tk) >= 4 and re.search(rf"\b{re.escape(tk)}\b", title):
            return 1
    return -3  # peripheral — not clearly about this company


def source_weight(source: str | None) -> int:
    """Credibility weight (0–3) for an RSS source name."""
    if not source:
        return 0
    s = source.lower()
    for weight, subs in SOURCE_TIERS:
        if any(x in s for x in subs):
            return weight
    return 0


def _event(hay: str) -> tuple[int, str, str]:
    """Event-type score + category + emoji (sums all matched buckets; first names it)."""
    total, cat, emoji = 0, "News", "📰"
    for label, em, weight, keywords in SCORED:
        if any(k in hay for k in keywords):
            total += weight
            if cat == "News":
                cat, emoji = label, em
    return total, cat, emoji


def assess(
    title: str, summary: str | None = None, source: str | None = None,
    ticker: str | None = None, name: str | None = None, base: int = 0,
) -> dict:
    """Composite trader-catalyst assessment of a headline.

    Combines: event type, source credibility, fundamentals impact, move magnitude,
    directness to the company, and an optional `base` seed (e.g. a curated feed's
    weight). Returns a dict with `impact` (0–10 composite), `category`/`emoji`,
    `source_tier`, `fundamentals`, and the `catalyst` tier. A drop-pattern (routine
    PR, fund-holding chatter, law-firm spam) forces impact 0.
    """
    hay = f"{title} {summary or ''}".lower()
    if any(p in hay for p in DROP_PATTERNS):
        return {"impact": 0, "category": "News", "emoji": "📰", "source_tier": 0,
                "fundamentals": False, "catalyst": "Informational", "catalyst_emoji": "⚪"}

    ev, cat, emoji = _event(hay)
    src = source_weight(source)
    fundamentals = any(k in hay for k in FUNDAMENTAL_KW)
    move = any(k in hay for k in STRONG_MOVE)

    tl = title.lower()
    if any(k in tl for k in LIST_NOISE):
        direct = -3                       # peripheral "N stocks moving" mention
    else:
        direct = _directness(title, ticker, name)

    impact = base + ev + src + (2 if fundamentals else 0) + (1 if move else 0) + direct
    impact = max(0, min(impact, 10))
    tier, tier_emoji = catalyst_tier(impact)
    return {"impact": impact, "category": cat, "emoji": emoji, "source_tier": src,
            "fundamentals": fundamentals, "catalyst": tier, "catalyst_emoji": tier_emoji}


def score(title: str, summary: str | None = None, base: int = 0,
          source: str | None = None) -> tuple[int, str, str]:
    """Back-compat wrapper: (impact, category, emoji). `base` still adds (e.g. a
    per-feed seed); `source` feeds credibility. impact 0 ⇒ noise/routine."""
    a = assess(title, summary, source)
    imp = a["impact"]
    return (imp + base if imp > 0 else 0), a["category"], a["emoji"]
