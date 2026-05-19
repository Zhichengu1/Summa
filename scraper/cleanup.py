"""
cleanup.py — Purge rows older than 30 days from filings and filing_events.

Run monthly via GitHub Actions (summa-cleanup.yml). Safe to run manually too.
company_meta is intentionally left untouched — it stores rolling baselines, not
time-series data, so deleting it would break signal comparisons for existing companies.
"""

import logging
from datetime import datetime, timedelta, timezone

from db import get_client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

RETENTION_DAYS = 30


def main() -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).isoformat()
    db = get_client()

    result = db.table("filings").delete().lt("filed_at", cutoff).execute()
    deleted_filings = len(result.data) if result.data else 0
    log.info("Deleted %d filings older than %d days", deleted_filings, RETENTION_DAYS)

    result = db.table("filing_events").delete().lt("filed_at", cutoff).execute()
    deleted_events = len(result.data) if result.data else 0
    log.info("Deleted %d filing_events older than %d days", deleted_events, RETENTION_DAYS)

    log.info("Cleanup complete — %d total rows removed", deleted_filings + deleted_events)


if __name__ == "__main__":
    main()
