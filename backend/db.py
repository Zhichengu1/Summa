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


def upsert_ipos(rows: list[dict[str, Any]]) -> int:
    """Upsert IPO-lifecycle filings, keyed on accession_number."""
    return upsert_many("ipos", rows, on_conflict="accession_number")


def upsert_news(rows: list[dict[str, Any]]) -> int:
    """Upsert Google News headlines, keyed on (cik, guid)."""
    return upsert_many("company_news", rows, on_conflict="cik,guid")


def upsert_market_news(rows: list[dict[str, Any]]) -> int:
    """Upsert curated market-wide news, keyed on guid."""
    return upsert_many("market_news", rows, on_conflict="guid")


def upsert_reddit_trends(rows: list[dict[str, Any]]) -> int:
    """Upsert daily Reddit trending-ticker snapshot rows, keyed on (trend_date, ticker)."""
    return upsert_many("reddit_trends", rows, on_conflict="trend_date,ticker")


def upsert_congress_trades(rows: list[dict[str, Any]]) -> int:
    """Upsert congressional stock-trade disclosure rows, keyed on the source id."""
    return upsert_many("congress_trades", rows, on_conflict="id")


def upsert_cot_reports(rows: list[dict[str, Any]]) -> int:
    """Upsert weekly CFTC COT report rows, keyed on (market_code, report_date)."""
    return upsert_many("cot_reports", rows, on_conflict="market_code,report_date")


def upsert_options_snapshots(rows: list[dict[str, Any]]) -> int:
    """Upsert daily options-chain snapshot rows, keyed on (cik, snapshot_date)."""
    return upsert_many("options_snapshots", rows, on_conflict="cik,snapshot_date")


def fetch_recent_closes(cik: str, sessions: int = 60) -> list[float]:
    """Most-recent `sessions` closes for a company, oldest → newest.

    order(desc) + limit then reverse — ascending + limit would return the OLDEST
    bars once a company exceeds the limit (see the retention note in CLAUDE.md).
    """
    try:
        rows = (
            get_client().table("daily_prices").select("close")
            .eq("cik", cik).order("date", desc=True).limit(sessions).execute().data or []
        )
    except Exception:
        logger.exception("fetch_recent_closes failed for %s", cik)
        return []
    closes = [float(r["close"]) for r in rows if r.get("close") is not None]
    closes.reverse()
    return closes


def fetch_iv_history(cik: str, days: int = 365) -> list[float]:
    """Trailing IV30 observations for a company — the basis for its IV rank."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        rows = (
            get_client().table("options_snapshots").select("iv30")
            .eq("cik", cik).gte("snapshot_date", cutoff).execute().data or []
        )
    except Exception:
        logger.exception("fetch_iv_history failed for %s", cik)
        return []
    return [float(r["iv30"]) for r in rows if r.get("iv30") is not None]


def get_latest_cot_date() -> str | None:
    """Most recent stored COT report date (ISO), or None if the table is empty.

    Drives the incremental fetch: the ingest only asks the CFTC API for report
    weeks after this date (None → first-seed history backfill). Fails soft to
    None, which just makes the next run re-fetch the backfill window — upserts
    keep that idempotent.
    """
    try:
        result = (
            get_client().table("cot_reports").select("report_date")
            .order("report_date", desc=True).limit(1).execute()
        )
        return result.data[0]["report_date"] if result.data else None
    except Exception:
        logger.exception("get_latest_cot_date failed")
        return None


def fetch_cot_history(weeks: int = 156) -> list[dict[str, Any]]:
    """Trailing `weeks` of `cot_reports` rows (the digest's COT-index window).

    Paged (the window is ~28 markets × weeks ≈ a few thousand skinny rows, past
    PostgREST's 1000-row page). Fails soft to [].
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(weeks=weeks)).date().isoformat()
    page, out = 1000, []
    try:
        client = get_client()
        for start in range(0, 100_000, page):
            result = (
                client.table("cot_reports")
                .select("market_code, market_name, market_group, report_date, "
                        "open_interest, noncomm_net")
                .gte("report_date", cutoff)
                .order("report_date").order("market_code")
                .range(start, start + page - 1).execute()
            )
            out.extend(result.data or [])
            if len(result.data or []) < page:
                break
        return out
    except Exception:
        logger.exception("fetch_cot_history failed")
        return []


def fetch_reddit_trends_day(trend_date: str) -> list[dict[str, Any]]:
    """Return the (ticker, rank) rows already stored for one snapshot day.

    Lets the intraday Reddit-trends runs tell the first run of the day (post the
    full digest) from refreshes (only alert genuinely-new surges). Fails soft to [].
    """
    try:
        result = (
            get_client().table("reddit_trends").select("ticker, rank")
            .eq("trend_date", trend_date).execute()
        )
        return result.data or []
    except Exception:
        logger.exception("fetch_reddit_trends_day failed")
        return []


def fetch_reddit_industry_map(tickers: list[str]) -> dict[str, tuple[str | None, str | None]]:
    """Most-recent stored (sector, industry) per ticker from reddit_trends.

    The Reddit-trends industry labeller's cache layer: a ticker labelled on any
    prior snapshot day never re-hits SEC. Fails soft to {}.
    """
    if not tickers:
        return {}
    try:
        result = (
            get_client().table("reddit_trends")
            .select("ticker, sector, industry, trend_date")
            .in_("ticker", tickers).not_.is_("industry", "null")
            .order("trend_date", desc=True).limit(1000).execute()
        )
        out: dict[str, tuple[str | None, str | None]] = {}
        for r in result.data or []:
            t = r["ticker"]
            if t not in out:
                out[t] = (r.get("sector"), r.get("industry"))
        return out
    except Exception:
        logger.exception("fetch_reddit_industry_map failed")
        return {}


def fetch_profiles_by_ticker(tickers: list[str]) -> dict[str, tuple[str | None, str | None]]:
    """(sector, industry) per ticker from the curated company_profiles (watchlist names).

    Joins companies (ticker → cik) to company_profiles client-side — two small
    queries. The richest label source (seeded industries beat raw SIC). Fails
    soft to {}.
    """
    if not tickers:
        return {}
    try:
        client = get_client()
        cos = (client.table("companies").select("cik, ticker")
               .in_("ticker", tickers).execute().data or [])
        cik_to_ticker = {c["cik"]: c["ticker"] for c in cos if c.get("ticker")}
        if not cik_to_ticker:
            return {}
        profs = (client.table("company_profiles").select("cik, sector, industry")
                 .in_("cik", list(cik_to_ticker)).execute().data or [])
        return {
            cik_to_ticker[p["cik"]].upper(): (p.get("sector"), p.get("industry"))
            for p in profs if p.get("cik") in cik_to_ticker and p.get("industry")
        }
    except Exception:
        logger.exception("fetch_profiles_by_ticker failed")
        return {}


def get_seen_market_guids(guids: list[str]) -> set[str]:
    """Return the subset of `guids` already stored in market_news (chunked)."""
    if not guids:
        return set()
    seen: set[str] = set()
    client = get_client()
    for i in range(0, len(guids), 150):
        batch = guids[i : i + 150]
        try:
            result = client.table("market_news").select("guid").in_("guid", batch).execute()
            seen.update(r["guid"] for r in (result.data or []))
        except Exception:
            logger.exception("get_seen_market_guids failed")
    return seen


def get_seen_congress_ids(ids: list[str]) -> set[str]:
    """Return the subset of `ids` already stored in congress_trades (chunked)."""
    if not ids:
        return set()
    seen: set[str] = set()
    client = get_client()
    for i in range(0, len(ids), 150):
        batch = ids[i : i + 150]
        try:
            result = client.table("congress_trades").select("id").in_("id", batch).execute()
            seen.update(r["id"] for r in (result.data or []))
        except Exception:
            logger.exception("get_seen_congress_ids failed")
    return seen


def congress_trades_has_rows() -> bool:
    """True if congress_trades already has any rows (suppresses the first-seed alert flood)."""
    try:
        result = get_client().table("congress_trades").select("id").limit(1).execute()
        return bool(result.data)
    except Exception:
        logger.exception("congress_trades_has_rows failed")
        return True


def market_news_has_rows() -> bool:
    """True if market_news already has any rows (suppresses the first-seed alert flood)."""
    try:
        result = get_client().table("market_news").select("id").limit(1).execute()
        return bool(result.data)
    except Exception:
        logger.exception("market_news_has_rows failed")
        return True


def get_seen_news_guids(cik: str, guids: list[str]) -> set[str]:
    """Return the subset of `guids` already stored for this company in company_news.

    Lets news_ingest tell genuinely-new headlines from re-pulls of ones it already
    has, so Discord only notifies on the delta. Google News guids run ~200–500 chars,
    so the lookup is chunked small — a full feed (~100 guids) in one `in_()` builds a
    URL past PostgREST's request limit and 400s, which would make EVERY headline look
    new (and re-alert) each poll.
    """
    if not guids:
        return set()
    seen: set[str] = set()
    client = get_client()
    for i in range(0, len(guids), 25):
        batch = guids[i : i + 25]
        try:
            result = (
                client.table("company_news").select("guid")
                .eq("cik", cik).in_("guid", batch).execute()
            )
            seen.update(r["guid"] for r in (result.data or []))
        except Exception:
            logger.exception("get_seen_news_guids failed for %s", cik)
    return seen


def get_company_summary(cik: str) -> dict[str, Any] | None:
    """Return the precomputed company_summary row for a cik (price snapshot), or None.

    Used to enrich the Discord news alert with live market context (last close, day
    change, YTD, distance off the 52-week high). Best-effort: returns None on miss.
    """
    try:
        result = (
            get_client().table("company_summary")
            .select("last_close, chg_1d, ret_ytd, pct_off_high, rsi14, as_of, "
                    "pct_from_50, pct_from_200, ma_cross, vol_spike, "
                    "new_52w_high, new_52w_low, net_insider_90d, cluster_buy")
            .eq("cik", cik).limit(1).execute()
        )
        rows = result.data or []
        return rows[0] if rows else None
    except Exception:
        logger.exception("get_company_summary failed for %s", cik)
        return None


def fetch_company_summaries() -> list[dict[str, Any]]:
    """Return every company_summary row (paged) for watchlist-wide surfaces.

    One tiny row per company, so this stays cheap at any watchlist size. Used by
    the daily Discord brief (tools/daily_brief.py). Fails soft to [].
    """
    try:
        return _select_all(
            "company_summary",
            "cik, ticker, last_close, as_of, chg_1d, ret_ytd, pct_off_high, rsi14, "
            "ma_cross, vol_spike, new_52w_high, new_52w_low, net_insider_90d, cluster_buy",
        )
    except Exception:
        logger.exception("fetch_company_summaries failed")
        return []


def fetch_earnings_dates() -> list[dict[str, Any]]:
    """Return (cik, ticker, reported_date) for every earnings event, paged.

    Feeds the daily brief's earnings radar: per-company historical report dates
    → estimated next report. The table is small (a few rows/company/year), so a
    paged full read stays cheap at any watchlist size. Fails soft to [].
    """
    try:
        return _select_all("earnings_events", "cik, ticker, reported_date")
    except Exception:
        logger.exception("fetch_earnings_dates failed")
        return []


def company_has_rows(table: str, cik: str) -> bool:
    """True if `table` already has any rows for this cik.

    Generic first-seed suppression (same contract as company_has_news): a
    company's very first ingest of a dataset seeds silently instead of flooding
    the webhook. Fails safe to True so a transient error can't be misread as a
    first seed.
    """
    try:
        result = get_client().table(table).select("cik").eq("cik", cik).limit(1).execute()
        return bool(result.data)
    except Exception:
        logger.exception("company_has_rows(%s) failed for %s", table, cik)
        return True


def company_has_news(cik: str) -> bool:
    """True if the company already has any company_news rows.

    Used to suppress the notification flood on a company's FIRST-ever news ingest
    (where every headline is 'new'): the first pull seeds silently; later pulls
    notify only the incremental headlines. Fails safe to True so a transient error
    can't be misread as a first seed.
    """
    try:
        result = get_client().table("company_news").select("id").eq("cik", cik).limit(1).execute()
        return bool(result.data)
    except Exception:
        logger.exception("company_has_news failed for %s", cik)
        return True


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
    """Return the subset of accession numbers already present in `table`.

    The `.in_(...)` list is chunked: an accession is ~20 chars, so a few hundred
    in one filter blows past PostgREST's URL-length limit and 414s (the global IPO
    pass passes ~300/run). Chunking keeps each request URL bounded at any scale.
    """
    if not accession_numbers:
        return set()
    seen: set[str] = set()
    client = get_client()
    for i in range(0, len(accession_numbers), 150):
        batch = accession_numbers[i : i + 150]
        try:
            result = (
                client.table(table).select("accession_number")
                .in_("accession_number", batch).execute()
            )
            seen.update(r["accession_number"] for r in (result.data or []))
        except Exception:
            logger.exception("get_seen_accessions failed for %s", table)
    return seen


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


def prune_old_ipos(days: int = 120) -> int:
    """Delete `ipos` rows whose latest filing is older than `days`.

    The IPO pipeline is a rolling recent-activity surface: a registration that
    neither prices nor withdraws within the window is stale, and priced/withdrawn
    deals age out of "active". The extractor's own ~3-week scan window keeps ingest
    bounded; this prunes the persisted tail so the table stays small. Monthly
    cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client()
            .table("ipos")
            .delete()
            .lt("filed_at", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_ipos failed")
        return 0


def prune_old_news(days: int = 30) -> int:
    """Delete `company_news` rows whose article is older than `days`.

    company_news is a rolling recent-headlines surface (like the filings feed),
    not an archive: news_ingest re-pulls the latest headlines each cadence and
    upserts, so stale items past the window are dead weight. Keeping ~30 days
    bounds the table's growth (which scales with N companies × time). Rows with a
    NULL published_at are left alone (we can't age them). Monthly cadence
    (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_client()
            .table("company_news")
            .delete()
            .lt("published_at", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_news failed")
        return 0


def prune_old_market_news(days: int = 30) -> int:
    """Delete `market_news` rows older than `days` (rolling recent-intel window)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        result = (
            get_client().table("market_news").delete()
            .lt("published_at", cutoff).execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_market_news failed")
        return 0


def prune_old_reddit_trends(days: int = 30) -> int:
    """Delete `reddit_trends` snapshots older than `days` (rolling recent-buzz window).

    One top-N snapshot per day, so the table is tiny; ~30 days is enough history
    for day-over-day and week-over-week comparisons. Monthly cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client().table("reddit_trends").delete()
            .lt("trend_date", cutoff).execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_reddit_trends failed")
        return 0


def prune_old_congress_trades(days: int = 400) -> int:
    """Delete `congress_trades` rows whose transaction is older than `days`.

    The source feed is a rolling window of the most recent disclosures, so the
    table only grows with time; ~400 days keeps a year of consensus history (the
    Congress view aggregates 30–90-day windows) while staying tiny. Monthly
    cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client().table("congress_trades").delete()
            .lt("transaction_date", cutoff).execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_congress_trades failed")
        return 0


def prune_old_cot_reports(days: int = 1200) -> int:
    """Delete `cot_reports` rows older than `days` (~3.3y rolling window).

    The COT positioning index is a percentile over a trailing 3-year range, so
    the window keeps just enough history for a full 156-week lookback plus
    margin. ~28 markets × 52 weeks/year — the table stays tiny. Monthly
    cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client().table("cot_reports").delete()
            .lt("report_date", cutoff).execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_cot_reports failed")
        return 0


def prune_old_options_snapshots(days: int = 400) -> int:
    """Delete `options_snapshots` rows older than `days` (~13 months).

    One small row per company per day. The window is sized to the IV-rank
    lookback (a trailing 1-year percentile) plus a month of margin — trimming
    tighter would degrade the rank the longer the pipeline runs. Monthly
    cadence (cleanup.py).
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()
    try:
        result = (
            get_client().table("options_snapshots").delete()
            .lt("snapshot_date", cutoff).execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_old_options_snapshots failed")
        return 0


def prune_manager_portfolios(keep_quarters: int = 4) -> int:
    """Delete `manager_portfolios` rows older than the latest `keep_quarters` filing quarters.

    `manager_portfolios` gains one filing quarter (~managers × top-N positions +
    exits) every 13F cycle and is otherwise never pruned, so it grows unbounded with
    time. The Institutional Investors view only ever uses each manager's latest
    quarter (display) and the one before it (the buy/sell diff + emerging-consensus
    baseline); the frontend's 400-day window spans ~4 quarter-ends. Keeping the latest
    `keep_quarters` distinct `period_of_report` quarters preserves every displayed
    value and the prior-quarter baseline (with a late-filer margin) while bounding both
    the frontend `fetchManagerPortfolios` read and the backend `_prior_lookup`
    full-table scan as quarters accumulate. Monthly cadence (cleanup.py).
    """
    try:
        periods = sorted(
            {r["period_of_report"] for r in _select_all("manager_portfolios", "period_of_report")
             if r.get("period_of_report")},
            reverse=True,
        )
        if len(periods) <= keep_quarters:
            return 0
        cutoff = periods[keep_quarters - 1]  # oldest quarter we keep; delete strictly older
        result = (
            get_client()
            .table("manager_portfolios")
            .delete()
            .lt("period_of_report", cutoff)
            .execute()
        )
        return len(result.data or [])
    except Exception:
        logger.exception("prune_manager_portfolios failed")
        return 0
