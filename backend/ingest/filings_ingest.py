"""Narrative filings feed ingest — populates the `filings` table.

Captures recent 10-K / 10-Q / 8-K / DEF 14A metadata for the live feed. To keep
the feed (and the database) lean, only filings from the last FEED_RETENTION_DAYS
(3 months) are ingested; cleanup.py deletes feed rows once they age past that
window. The structured warehouse tables (fundamentals, holdings, events) are
unaffected and retained per their own policy.
"""

import logging
from datetime import date, timedelta
from typing import Any

import db
from edgar_cache import get_company

logger = logging.getLogger(__name__)

FEED_FORMS = ["10-K", "10-Q", "8-K", "DEF 14A"]

# Feed retention: only the trailing 3 months of filings are kept.
FEED_RETENTION_DAYS = 90
# Fetch a generous slice per form, then date-filter — a busy issuer can file
# many 8-Ks in a quarter, so head() alone (by count) isn't enough.
_FETCH_PER_FORM = 40


def _iso(filing: Any) -> str | None:
    d = getattr(filing, "filing_date", None)
    return f"{d}T16:00:00+00:00" if d else None


def _filing_date(filing: Any) -> date | None:
    d = getattr(filing, "filing_date", None)
    if d is None:
        return None
    if isinstance(d, date):
        return d
    try:
        return date.fromisoformat(str(d))
    except ValueError:
        return None


def ingest_filings_feed(
    cik: str, ticker: str, name: str, *, retention_days: int = FEED_RETENTION_DAYS
) -> int:
    """Upsert the last `retention_days` of feed filings for one company."""
    cutoff = date.today() - timedelta(days=retention_days)
    company = get_company(cik)
    rows: list[dict[str, Any]] = []
    for form in FEED_FORMS:
        try:
            filings = company.get_filings(form=form).head(_FETCH_PER_FORM)
        except Exception:
            logger.exception("  get_filings(%s) failed for %s", form, ticker)
            continue
        for f in filings:
            fd = _filing_date(f)
            if fd is None or fd < cutoff:
                continue  # outside the 3-month feed window
            rows.append({
                "accession_number": f.accession_no,
                "cik": cik,
                "ticker": ticker,
                "company_name": name,
                "form_type": form,
                "filed_at": _iso(f),
                "period_of_report": str(getattr(f, "period_of_report", "") or "") or None,
                "filing_url": getattr(f, "filing_url", None) or getattr(f, "url", None),
            })

    written = db.upsert_many("filings", rows, on_conflict="accession_number")
    logger.info("  %s filings feed: %d rows (last %dd)", ticker, written, retention_days)
    return written
