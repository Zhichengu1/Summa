"""Per-process cache for edgartools ``Company`` objects.

Constructing ``Company(cik)`` fetches that company's SEC *submissions* JSON from
EDGAR. Within a single ingest run several datasets for the same company each used
to build their own ``Company(cik)``, refetching the identical submissions index
N times per visit. This module shares one ``Company`` per CIK across every
ingestor for the life of the process.

Bounded by ``INGEST_MAX_PER_RUN`` companies per run, so the cache stays tiny; and
each GitHub Actions run is a fresh process, so the cache is naturally per-run.
Submissions don't change within a ~6-minute run, so the shared object is safe —
``Company.get_filings(...)`` reads the already-loaded index without refetching.
"""
import logging
from functools import lru_cache

from edgar import Company

logger = logging.getLogger(__name__)


@lru_cache(maxsize=64)
def _cached(cik: str) -> Company:
    """Construct a Company once per CIK (memoized for the life of the process)."""
    return Company(cik)


def get_company(cik: str | int) -> Company:
    """Return a shared edgartools Company for this CIK, built once per run.

    Drop-in replacement for ``Company(cik)`` in the ingestors/extractors so a
    company visited for several datasets fetches its submissions index only once.
    """
    return _cached(str(cik))
