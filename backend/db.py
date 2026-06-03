"""Supabase service-role client singleton and per-table upsert helpers.

The scraper uses the service_role key, which bypasses RLS. All warehouse
writes funnel through `upsert` / `upsert_many` here so on-conflict handling
and error logging live in one place.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

logger = logging.getLogger(__name__)

_client: Client | None = None


def get_client() -> Client:
    """Return the Supabase service-role singleton (lazy init)."""
    global _client
    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_KEY"],
        )
    return _client


def upsert(table: str, row: dict[str, Any], on_conflict: str) -> None:
    """Upsert a single row, deduplicating on `on_conflict`."""
    get_client().table(table).upsert(row, on_conflict=on_conflict).execute()


def _dedupe(rows: list[dict[str, Any]], on_conflict: str) -> list[dict[str, Any]]:
    """Collapse rows that share the same on_conflict key, keeping the last.

    Postgres rejects an upsert batch containing two rows with identical
    conflict-key values ("ON CONFLICT DO UPDATE command cannot affect row a
    second time"). Extractors can legitimately produce such duplicates (e.g.
    EDGAR form prefix-matching returns an amendment under both "SC 13D" and
    "SC 13D/A"), so we dedupe here rather than in every caller.
    """
    keys = [k.strip() for k in on_conflict.split(",")]
    seen: dict[tuple, dict[str, Any]] = {}
    for r in rows:
        seen[tuple(r.get(k) for k in keys)] = r  # last write wins
    return list(seen.values())


def upsert_many(
    table: str, rows: list[dict[str, Any]], on_conflict: str, chunk: int = 500
) -> int:
    """Upsert rows in chunks, deduplicating on the conflict key. Returns count."""
    if not rows:
        return 0
    rows = _dedupe(rows, on_conflict)
    client = get_client()
    for i in range(0, len(rows), chunk):
        client.table(table).upsert(
            rows[i : i + chunk], on_conflict=on_conflict
        ).execute()
    return len(rows)


def upsert_company(row: dict[str, Any]) -> None:
    """Upsert watchlist company metadata, keyed on cik."""
    upsert("companies", row, on_conflict="cik")


def get_seen_accessions(table: str, accession_numbers: list[str]) -> set[str]:
    """Return the subset of accession numbers already present in `table`."""
    if not accession_numbers:
        return set()
    try:
        result = (
            get_client()
            .table(table)
            .select("accession_number")
            .in_("accession_number", accession_numbers)
            .execute()
        )
        return {r["accession_number"] for r in (result.data or [])}
    except Exception:
        logger.exception("get_seen_accessions failed for %s", table)
        return set()


# ─── Cleanup ──────────────────────────────────────────────────────────────────

def clear_old_filing_sections(days: int = 30) -> int:
    """Null out narrative section text on filings older than `days`.

    The metadata row (form, date, url) is retained; only the bulky extracted
    sections roll off, per the README retention split.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_client()
            .table("filings")
            .update({
                "section_business": None,
                "section_risk_factors": None,
                "section_mda": None,
            })
            .lt("filed_at", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("clear_old_filing_sections failed")
        return 0


def delete_old_filings(days: int = 90) -> int:
    """Delete feed rows in `filings` older than `days` (the 3-month feed window).

    Keeps the live feed and database lean. Only the `filings` feed table is
    pruned; the structured warehouse tables (fundamentals, holdings, events)
    are retained.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_client()
            .table("filings")
            .delete()
            .lt("filed_at", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("delete_old_filings failed")
        return 0
