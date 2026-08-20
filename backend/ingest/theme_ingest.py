"""Per-company theme extraction — populates `theme_mentions` (Phase 2 input).

Runs a keyword pass from the curated `theme_taxonomy` over the Business and
MD&A sections of a company's recent 10-K / 10-Q filings, and records how many
times each canonical theme appears, per calendar quarter. `trend_aggregator`
later rolls these per-company rows up into the cross-company `theme_trends`.

Why extraction happens HERE and not in the aggregator: the `filings` feed keeps
only metadata and its rows are deleted at 90 days, so the narrative text is not
available to re-read later. Themes must be distilled while the document is in
reach and then persisted as small structured rows.

Cost discipline — this is a text-download path, so it is aggressively incremental:
  • The filing INDEX comes from the shared per-run `edgar_cache.get_company`, so
    listing candidates costs no extra EDGAR request.
  • Accessions already represented in `theme_mentions` are skipped before any
    document is fetched, so the steady state is one small Supabase query and
    ZERO downloads until a new 10-K/10-Q lands.
  • A new company backfills at most `THEME_MAX_DOCS_PER_RUN` documents per visit
    and picks the rest up on later visits — the same spread-the-work rule the
    company scheduler uses.

Periods are normalized to the CALENDAR quarter end, not the filer's fiscal
period: Apple's Sept-28 quarter and Microsoft's Sept-30 quarter have to land in
the same bucket or cross-company breadth means nothing.
"""

import logging
import os
from datetime import date
from typing import Any

import db
from edgar_cache import get_company
from ingest.theme_taxonomy import match_themes

logger = logging.getLogger(__name__)

# How far back to build history. Eight quarters is enough for the aggregator's
# year-over-year breadth comparison plus a quarter of margin.
LOOKBACK_QUARTERS = int(os.environ.get("THEME_LOOKBACK_QUARTERS", "8"))
# Documents downloaded per company per visit. A first-ever visit backfills this
# many and defers the rest, so one new company never blows the run's time budget.
MAX_DOCS_PER_RUN = int(os.environ.get("THEME_MAX_DOCS_PER_RUN", "3"))
# Guard against a pathological filing: cap the text handed to the matcher.
_MAX_SECTION_CHARS = 400_000
# A theme must appear at least this many times in one filing to be recorded.
_MIN_HITS = int(os.environ.get("THEME_MIN_HITS", "2"))


def _quarter_end(d: date) -> str:
    """Calendar quarter end containing `d`, as an ISO date string."""
    q_month = ((d.month - 1) // 3) * 3 + 3
    last_day = {3: 31, 6: 30, 9: 30, 12: 31}[q_month]
    return date(d.year, q_month, last_day).isoformat()


def _as_date(value: Any) -> date | None:
    """Coerce an edgartools date-ish value to a date, or None."""
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _candidates(cik: str) -> list[dict[str, Any]]:
    """Recent 10-K/10-Q filings, newest reporting period first (index read only)."""
    company = get_company(cik)
    out: list[dict[str, Any]] = []
    for form, count in (("10-K", 2), ("10-Q", LOOKBACK_QUARTERS)):
        try:
            filings = company.get_filings(form=form).head(count)
        except Exception:
            logger.exception("  get_filings(%s) failed for %s", form, cik)
            continue
        for f in filings:
            period = _as_date(getattr(f, "period_of_report", None)) or _as_date(
                getattr(f, "filing_date", None)
            )
            if period is None:
                continue
            out.append({"filing": f, "form": form, "period": period,
                        "accession": getattr(f, "accession_no", None)})
    out = [c for c in out if c["accession"]]
    out.sort(key=lambda c: c["period"], reverse=True)
    return out[:LOOKBACK_QUARTERS]


def _sections(filing: Any, form: str) -> str:
    """Business + MD&A narrative text for one filing ('' if unparseable).

    Only the forward-looking sections are read. Risk Factors is deliberately
    excluded: it names every technology a company could conceivably be affected
    by, which would turn breadth into a measure of legal boilerplate rather than
    of investment.
    """
    try:
        obj = filing.obj()
    except Exception:
        logger.debug("  obj() failed for %s", getattr(filing, "accession_no", "?"))
        return ""
    if obj is None:
        return ""

    parts: list[str] = []
    if form == "10-K":
        for attr in ("business", "management_discussion"):
            try:
                parts.append(str(getattr(obj, attr, "") or ""))
            except Exception:
                logger.debug("  %s section unavailable", attr)
    else:  # 10-Q — MD&A is Part I, Item 2. There is no Business section.
        for key in ("Part I, Item 2", "Item 2"):
            try:
                text = obj[key]
            except Exception:
                text = None
            if text:
                parts.append(str(text))
                break
    return "\n".join(p for p in parts if p)[:_MAX_SECTION_CHARS]


# financial_facts.standard_concept values that count as forward investment.
_CAPITAL_CONCEPTS = ("RAndDExpense", "CapEx")


def _capital_map(cik: str) -> dict[str, float]:
    """{"<quarter-end>:<period_type>": R&D + capex} for one company.

    Built from the already-ingested `financial_facts` rows — no extra EDGAR
    work. Periods are bucketed to the calendar quarter end so they line up with
    the theme periods.
    """
    out: dict[str, float] = {}
    for r in db.fetch_capital_facts(cik, list(_CAPITAL_CONCEPTS)):
        end = _as_date(r.get("period_end"))
        value = r.get("value")
        if end is None or not isinstance(value, (int, float)):
            continue
        key = f"{_quarter_end(end)}:{r.get('period_type') or 'quarterly'}"
        out[key] = out.get(key, 0.0) + abs(float(value))
    return out


def _capital_for(period: str, facts: dict[str, float], form: str) -> tuple[float | None, str | None]:
    """R&D + capex behind one filing period, normalized to a QUARTERLY figure.

    Returns (amount, basis). A 10-K reports a full year, a 10-Q one quarter;
    summing them raw across a breadth series would silently quadruple every
    fourth point, so an annual figure is divided by four and labelled as such.
    Returns (None, None) when the company reports neither concept.
    """
    preferred = "annual" if form == "10-K" else "quarterly"
    for basis in (preferred, "quarterly", "annual"):
        total = facts.get(f"{period}:{basis}")
        if total:
            return (total / 4.0 if basis == "annual" else total), basis
    return None, None


def ingest_themes(cik: str, ticker: str) -> None:
    """Extract canonical themes from this company's new 10-K/10-Q filings."""
    candidates = _candidates(cik)
    if not candidates:
        logger.info("  %s themes: no 10-K/10-Q filings found", ticker)
        return

    seen = db.get_theme_accessions(cik)
    fresh = [c for c in candidates if c["accession"] not in seen]
    if not fresh:
        logger.info("  %s themes: up to date (%d filings on file)", ticker, len(candidates))
        return

    facts = _capital_map(cik)
    rows: list[dict[str, Any]] = []
    parsed = 0
    for c in fresh[:MAX_DOCS_PER_RUN]:
        text = _sections(c["filing"], c["form"])
        if not text:
            logger.info("  %s themes: %s %s unparseable — skipped",
                        ticker, c["form"], c["accession"])
            continue
        hits = match_themes(text, min_hits=_MIN_HITS)
        parsed += 1
        if not hits:
            continue
        period = _quarter_end(c["period"])
        total_hits = sum(hits.values())
        capital, basis = _capital_for(period, facts, c["form"])
        for key, count in hits.items():
            # Attribute the period's R&D + capex across themes in proportion to
            # how much of the filing's theme language each one accounts for. It
            # is an attribution, not a disclosure — dollars are never broken out
            # by theme — so the Trends view labels it "attributed" throughout.
            rows.append({
                "cik": cik,
                "ticker": ticker,
                "theme_key": key,
                "period": period,
                "mention_count": count,
                "mention_share": round(count / total_hits, 4),
                "capital_signal": round(capital * count / total_hits, 2) if capital else None,
                "capital_basis": basis,
                "form": c["form"],
                "source_accession": c["accession"],
            })

    written = db.upsert_theme_mentions(rows)
    deferred = max(0, len(fresh) - MAX_DOCS_PER_RUN)
    logger.info("  %s themes: %d mentions from %d new filing(s)%s",
                ticker, written, parsed,
                f", {deferred} deferred to a later visit" if deferred else "")
