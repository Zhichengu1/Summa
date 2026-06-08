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


def upsert_profile(row: dict[str, Any]) -> None:
    """Upsert a company industry profile, keyed on cik."""
    upsert("company_profiles", row, on_conflict="cik")


def upsert_summary(row: dict[str, Any]) -> None:
    """Upsert a company's precomputed watchlist-summary row, keyed on cik."""
    upsert("company_summary", row, on_conflict="cik")


def upsert_themes(rows: list[dict[str, Any]], cik: str) -> int:
    """Replace a company's themes: delete existing rows for the cik, then insert.

    Themes are a small, fully-recomputed set per company, so a delete+insert is
    simpler and safer than diffing (handles renamed/removed themes cleanly).
    """
    client = get_client()
    try:
        client.table("company_themes").delete().eq("cik", cik).execute()
    except Exception:
        logger.exception("clearing company_themes failed for %s", cik)
    return upsert_many("company_themes", rows, on_conflict="cik,name")


def upsert_entities(rows: list[dict[str, Any]]) -> int:
    """Upsert the global entity-context registry, keyed on match_key."""
    return upsert_many("entities", rows, on_conflict="match_key")


# PostgREST returns at most ~1000 rows per request (the instance's default row
# cap). Any whole-table read therefore has to page, or it silently truncates as
# the watchlist grows — which would leave companies beyond the cap unscheduled.
_PAGE = 1000


def _select_all(table: str, columns: str) -> list[dict[str, Any]]:
    """Fetch every row of `table` (selected `columns`) by paging through ranges.

    Scales the scheduler's whole-table reads to any watchlist size: without this,
    a single `.select().execute()` caps at ~1000 rows and the pipeline would stop
    seeing (and so stop ingesting) companies past that boundary.
    """
    client = get_client()
    out: list[dict[str, Any]] = []
    start = 0
    while True:
        batch = (
            client.table(table).select(columns)
            .range(start, start + _PAGE - 1).execute().data or []
        )
        out.extend(batch)
        if len(batch) < _PAGE:
            return out
        start += _PAGE


def fetch_watchlist() -> list[dict[str, Any]]:
    """Return the dynamic watchlist / ingest queue rows (cik, ticker, name, status)."""
    try:
        return _select_all("watchlist", "cik, ticker, name, status")
    except Exception:
        logger.exception("fetch_watchlist failed")
        return []


def mark_watchlist_ingested(cik: str) -> None:
    """Flip a queued watchlist row to 'ingested' after a successful pull."""
    try:
        get_client().table("watchlist").update({"status": "ingested"}).eq("cik", cik).execute()
    except Exception:
        logger.exception("mark_watchlist_ingested failed for %s", cik)


def fetch_ingest_state() -> dict[str, dict[str, Any]]:
    """Return {cik: {"last": ISO|None, "datasets": {dataset: ISO}}} for all companies.

    Drives both scheduler levels: `last` for the company-level batch selection, and
    `datasets` for the per-dataset cadence inside process(). A missing cik means
    'never ingested' → highest priority and every dataset due.
    """
    try:
        out: dict[str, dict[str, Any]] = {}
        for r in _select_all("companies", "cik, last_ingested_at, dataset_state"):
            ds = r.get("dataset_state")
            out[r["cik"]] = {"last": r.get("last_ingested_at"), "datasets": ds if isinstance(ds, dict) else {}}
        return out
    except Exception:
        logger.exception("fetch_ingest_state failed")
        return {}


def update_company_state(cik: str, dataset_state: dict[str, str]) -> None:
    """Persist per-dataset timestamps and stamp last_ingested_at = now (one write)."""
    try:
        ts = datetime.now(timezone.utc).isoformat()
        get_client().table("companies").update(
            {"dataset_state": dataset_state, "last_ingested_at": ts}
        ).eq("cik", cik).execute()
    except Exception:
        logger.exception("update_company_state failed for %s", cik)


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


def prune_old_prices(days: int = 760) -> int:
    """Delete `daily_prices` bars older than `days` to bound storage growth.

    `daily_prices` is the only structured table that grows unbounded with time:
    price_ingest re-pulls a rolling ~2-year window each run and upserts, but never
    deletes, so bars older than that window accumulate forever and are never
    refreshed. We keep ~2 years + a margin (the most the frontend/summary read is
    ~400 sessions ≈ 1.6y) and prune the stale tail. Pruned rows are outside the
    ingest window, so nothing the app uses is lost. Monthly cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client()
            .table("daily_prices")
            .delete()
            .lt("date", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_prices failed")
        return 0
