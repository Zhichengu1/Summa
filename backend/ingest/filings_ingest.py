"""Narrative filings feed ingest — populates the `filings` table.

Captures recent 10-K / 10-Q / 8-K / DEF 14A metadata for the live feed. To keep
the feed (and the database) lean, only filings from the last FEED_RETENTION_DAYS
(3 months) are ingested; cleanup.py deletes feed rows once they age past that
window. The structured warehouse tables (fundamentals, holdings, events) are
unaffected and retained per their own policy.
"""

import logging
import os
from datetime import date, timedelta
from typing import Any

import db
from edgar_cache import get_company

try:
    from enrichment import discord_notify  # optional: real-time filing alerts
except Exception:  # pragma: no cover — notifications are optional
    discord_notify = None

logger = logging.getLogger(__name__)

FEED_FORMS = ["10-K", "10-Q", "8-K", "DEF 14A"]

# Feed retention: only the trailing 3 months of filings are kept.
FEED_RETENTION_DAYS = 90
# Fetch a generous slice per form, then date-filter — a busy issuer can file
# many 8-Ks in a quarter, so head() alone (by count) isn't enough.
_FETCH_PER_FORM = 40
# Only filings this fresh are Discord-alerted — the alert channel is "it just
# hit EDGAR", never a backfill replay of the whole 90-day feed window.
_ALERT_RECENCY_DAYS = int(os.environ.get("FILING_ALERT_RECENCY_DAYS", "2"))


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

    # Real-time filing alerts: the genuinely-NEW delta among just-filed documents.
    # Checked BEFORE the upsert (afterwards everything looks "seen"). Recency-gated
    # so a backfill never floods, and suppressed entirely on a company's first-ever
    # feed ingest (same first-seed contract as news). Fail-soft throughout.
    alerts: list[dict[str, Any]] = []
    if discord_notify is not None and rows:
        alert_cut = (date.today() - timedelta(days=_ALERT_RECENCY_DAYS)).isoformat()
        fresh = [r for r in rows if (r.get("filed_at") or "")[:10] >= alert_cut]
        if fresh:
            seen = db.get_seen_accessions("filings", [r["accession_number"] for r in fresh])
            alerts = [r for r in fresh if r["accession_number"] not in seen]
            if alerts and not db.company_has_rows("filings", cik):
                alerts = []  # first seed — store silently, alert only on later deltas

    written = db.upsert_many("filings", rows, on_conflict="accession_number")
    logger.info("  %s filings feed: %d rows (last %dd)", ticker, written, retention_days)

    if alerts:
        try:
            alerts.sort(key=lambda r: r.get("filed_at") or "", reverse=True)
            discord_notify.notify_filings(ticker, name, alerts)
        except Exception:
            logger.exception("  %s filings: Discord notify failed", ticker)
    return written
