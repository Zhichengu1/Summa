"""
sec_scraper.py — Summa pipeline entry point.

Two modes:
  Pipeline mode (default):
      python sec_scraper.py
      Fetches the four EDGAR RSS feeds, deduplicates via Redis,
      filters to the watchlist, and processes new filings.

  Search mode:
      python sec_scraper.py --search "Apple"
      Interactive company lookup → recent SEC filings →
      stock-price-relevant signal summary.
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

# Force UTF-8 output on Windows so Unicode chars (✓, —, ═) don't crash
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import requests
from dotenv import load_dotenv

from cik_map import CORE_WATCHLIST, search_by_name, add_to_watchlist
from db import (
    upsert_filing, insert_filing_event, upsert_company_meta,
    delete_old_filings, delete_old_filing_events,
    delete_superseded_filings, prune_filing_history,
)

load_dotenv()

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ─── Constants ────────────────────────────────────────────────────────────────

SEC_BASE    = "https://www.sec.gov"
DATA_BASE   = "https://data.sec.gov"
EDGAR_FULL  = "https://efts.sec.gov/LATEST/search-index"

RATE_DELAY      = 0.12   # 120 ms between requests → ≤8 req/s (SEC hard limit: 10/s)
REQUEST_TIMEOUT = 15     # seconds
RETENTION_DAYS  = 30     # filings older than this are deleted from Supabase on each run

# 8-K items that materially affect stock price — used in search results
HIGH_IMPACT_8K_ITEMS: dict[str, str] = {
    "1.01": "Material Definitive Agreement",
    "1.02": "Termination of Material Agreement",
    "1.03": "Bankruptcy or Receivership",
    "2.01": "Completion of Acquisition / Disposition",
    "2.02": "Results of Operations (Earnings Release)",
    "2.04": "Triggering Events — Accelerated Debt",
    "2.05": "Costs Associated with Exit / Disposal Activities",
    "2.06": "Material Impairment",
    "3.01": "Notice of Delisting",
    "4.01": "Change in Certifying Accountant",
    "4.02": "Non-Reliance on Prior Financial Statements",
    "5.01": "Change in Control",
    "5.02": "Departure / Appointment of Director or Officer",
    "7.01": "Regulation FD Disclosure",
}


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

def _headers() -> dict[str, str]:
    """Return SEC-compliant request headers."""
    agent = os.getenv("SEC_USER_AGENT", "").strip('"')
    if not agent:
        raise RuntimeError("SEC_USER_AGENT not set in .env")
    return {
        "User-Agent":      agent,
        "Accept-Encoding": "gzip, deflate",
        "Accept":          "application/json, text/xml, */*",
    }


def _get(url: str, retries: int = 3) -> requests.Response:
    """Rate-limited GET with exponential backoff on failure."""
    headers = _headers()
    for attempt in range(retries):
        time.sleep(RATE_DELAY)
        try:
            r = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            return r
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response else 0
            if status == 429:
                # Escalating backoff: 4s → 8s → 16s across the three attempts
                wait = 4 * (2 ** attempt)
                log.warning("SEC rate-limited (attempt %d/%d). Backing off %ds…", attempt + 1, retries, wait)
                time.sleep(wait)
            elif attempt == retries - 1:
                raise
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed after {retries} retries: {url}")


# ─── Redis deduplication ──────────────────────────────────────────────────────

def _redis_client():
    """Return an Upstash Redis client, or None if credentials missing."""
    url   = os.getenv("UPSTASH_REDIS_URL", "")
    token = os.getenv("UPSTASH_REDIS_TOKEN", "")
    if not url or not token:
        log.warning("UPSTASH_REDIS_URL / TOKEN not set — deduplication disabled.")
        return None
    from upstash_redis import Redis
    return Redis(url=url, token=token)


def _is_seen(redis, accession: str) -> bool:
    """Return True if this accession number has already been processed."""
    if redis is None:
        return False
    return bool(redis.get(f"seen:{accession}"))


def _mark_seen(redis, accession: str) -> None:
    """Mark accession as processed. TTL = 30 days (matches DB retention window)."""
    if redis is None:
        return
    redis.set(f"seen:{accession}", "1", ex=60 * 60 * 24 * 30)


# ─── Company filing history ───────────────────────────────────────────────────

def fetch_company_filings(cik: str) -> dict[str, Any]:
    """
    Fetch full submission history for a company from data.sec.gov.
    Returns the raw JSON payload (see EDGAR data API docs).
    """
    padded = cik.zfill(10)
    url    = f"{DATA_BASE}/submissions/CIK{padded}.json"
    log.info("Fetching submission history: CIK %s", padded)
    return _get(url).json()


def _parse_recent_filings(
    data: dict[str, Any],
    forms: list[str],
    limit: int = 10,
    cutoff_days: int | None = RETENTION_DAYS,
) -> list[dict[str, Any]]:
    """
    Extract recent filings of the given form types from a submissions JSON payload.
    Returns up to `limit` results sorted newest-first, capped at `cutoff_days` old.

    Pass cutoff_days=None to disable the date filter (used by search mode so the
    user can see older history without it being silently truncated).
    """
    recent = data.get("filings", {}).get("recent", {})
    if not recent:
        return []

    accessions   = recent.get("accessionNumber", [])
    form_types   = recent.get("form", [])
    filed_dates  = recent.get("filingDate", [])
    descriptions = recent.get("primaryDocument", [])
    report_dates = recent.get("reportDate", [])
    items_list   = recent.get("items", [])          # populated for 8-K

    # Derive the ISO date string for the oldest acceptable filing.
    # EDGAR returns filings newest-first, so the first time filed < cutoff_str
    # we can break rather than scanning the entire history.
    cutoff_str: str | None = None
    if cutoff_days is not None:
        cutoff_str = (
            datetime.now(timezone.utc) - timedelta(days=cutoff_days)
        ).strftime("%Y-%m-%d")

    # Scan at most 6× what we need: enough headroom to find the target form types
    # even when recent history is dominated by 8-Ks, without iterating all 1000+ rows.
    max_scan = min(limit * 6, 300)
    results = []
    for i, acc in enumerate(accessions[:max_scan]):
        ft = form_types[i] if i < len(form_types) else ""
        if ft not in forms:
            continue

        filed = filed_dates[i]  if i < len(filed_dates)  else ""
        desc  = descriptions[i] if i < len(descriptions)  else ""
        rdate = report_dates[i] if i < len(report_dates)  else ""
        items = items_list[i]   if i < len(items_list)    else ""

        # EDGAR returns newest-first: once we cross the cutoff every subsequent
        # entry is also too old, so break immediately rather than scanning further.
        if cutoff_str and filed and filed < cutoff_str:
            break

        # Build direct document URL — skip if primary document name is missing
        if not desc:
            log.debug("Skipping %s: no primary document name", acc)
            continue
        acc_path     = acc.replace("-", "")
        cik_clean    = str(data.get("cik", "")).zfill(10)
        document_url = f"{SEC_BASE}/Archives/edgar/data/{int(cik_clean)}/{acc_path}/{desc}"
        index_url    = f"{SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK={cik_clean}&type={ft}&dateb=&owner=include&count=10"

        results.append({
            "accession":    acc,
            "form_type":    ft,
            "filed_date":   filed,
            "report_date":  rdate,
            "description":  desc,
            "document_url": document_url,
            "index_url":    index_url,
            "8k_items":     items,
        })

        if len(results) >= limit:
            break

    return results


def _classify_8k_impact(items_str: str) -> list[tuple[str, str, bool]]:
    """
    Parse an 8-K items string (e.g. '2.02,5.02') and return
    list of (item_number, description, is_high_impact).
    """
    if not items_str:
        return []
    out = []
    for item in items_str.split(","):
        item = item.strip()
        if item in HIGH_IMPACT_8K_ITEMS:
            out.append((item, HIGH_IMPACT_8K_ITEMS[item], True))
        else:
            out.append((item, "Other disclosure", False))
    return out


# ─── Pipeline mode ────────────────────────────────────────────────────────────

def run_pipeline() -> None:
    """
    Main pipeline: poll the EDGAR submissions API per watchlist company,
    deduplicate via Redis, and persist new filings to Supabase.

    Why per-company API instead of the global RSS feed:
      The global RSS returns only the 20 most recent filings across all 10,000+
      SEC filers. A watchlist company that filed earlier in the polling window
      is silently dropped. The per-company submissions API guarantees coverage
      for exactly the 7 companies we care about (7 API calls per run).
    """
    log.info("=" * 60)
    log.info("SUMMA PIPELINE  —  %s UTC", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"))
    log.info("Watchlist: %d companies", len(CORE_WATCHLIST))
    log.info("=" * 60)

    redis     = _redis_client()
    new_total = 0

    for cik, info in CORE_WATCHLIST.items():
        ticker = info["ticker"]
        name   = info["name"]
        log.info("Checking  %-6s  %s", ticker, name[:40])

        try:
            data = fetch_company_filings(cik)
        except Exception as exc:
            log.warning("  ✗ Failed to fetch %s: %s", ticker, exc)
            continue

        # Fetch the last 10 qualifying filings within the retention window.
        # EDGAR returns newest-first, so _parse_recent_filings breaks early
        # once it crosses the cutoff — no need to scan 1000+ rows.
        recent = _parse_recent_filings(
            data,
            forms=["10-K", "10-Q", "8-K", "DEF 14A"],
            limit=10,
            cutoff_days=RETENTION_DAYS,
        )

        for filing in recent:
            accession = filing["accession"]

            if _is_seen(redis, accession):
                log.debug("  Skip (seen): %s", accession)
                continue

            log.info(
                "NEW  %-8s  %-6s  %-30s  %s",
                filing["form_type"], ticker, name[:30], filing["filed_date"],
            )

            filed_iso = (filing["filed_date"] + "T00:00:00+00:00") if filing["filed_date"] else None

            is_friday_dump = False
            if filed_iso:
                try:
                    filed_dt = datetime.fromisoformat(filed_iso)
                    et_mins  = (filed_dt.hour - 4) % 24 * 60 + filed_dt.minute
                    is_friday_dump = filed_dt.weekday() == 4 and et_mins >= 15 * 60 + 30
                except Exception:
                    pass

            row = {
                "accession_number": accession,
                "cik":              cik,
                "ticker":           ticker,
                "company_name":     name,
                "form_type":        filing["form_type"],
                "filed_at":         filed_iso,
                "period_of_report": filing["report_date"] or None,
                "filing_url":       filing["document_url"],
                "friday_dump":      is_friday_dump,
                "signals_flagged":  False,
            }
            try:
                upsert_filing(row)
                if filing["form_type"] == "8-K":
                    insert_filing_event(cik, accession, filed_iso or "")
                elif filing["form_type"] == "10-Q":
                    prune_filing_history(cik, "10-Q", keep=10)
                elif filing["form_type"] == "10-K":
                    prune_filing_history(cik, "10-K", keep=2)
                elif filing["form_type"] == "DEF 14A":
                    delete_superseded_filings(cik, "DEF 14A", accession)
                log.info("  ✓ Persisted: %s", accession)
                # Only mark seen and count after a confirmed successful write.
                # If the DB write fails we leave the accession unmarked so the
                # next run can retry it — do NOT move these outside the try block.
                _mark_seen(redis, accession)
                new_total += 1
            except Exception as exc:
                log.warning("  ✗ DB write failed — will retry next run: %s", exc)

        time.sleep(0.5)  # brief pause between companies to respect SEC rate limits

    if new_total == 0:
        log.info("No new filings — all entries already seen.")
    else:
        log.info("Pipeline complete. %d new filing(s) persisted.", new_total)

    # Purge rows outside the retention window so Supabase storage stays bounded.
    run_cleanup(days=RETENTION_DAYS)


# ─── Cleanup mode ─────────────────────────────────────────────────────────────

def run_cleanup(days: int = RETENTION_DAYS) -> None:
    """Delete filings and filing_events older than `days` days from Supabase."""
    try:
        n_filings = delete_old_filings(days)
        n_events  = delete_old_filing_events(days)
        if n_filings or n_events:
            log.info("Cleanup: removed %d filing(s) and %d event(s) older than %d days.",
                     n_filings, n_events, days)
        else:
            log.debug("Cleanup: nothing to remove (all rows within %d-day window).", days)
    except Exception as exc:
        log.warning("Cleanup failed (non-fatal): %s", exc)


# ─── Backfill mode ────────────────────────────────────────────────────────────

def run_backfill(limit: int = 20) -> None:
    """
    Fetch the most recent `limit` filings for every watchlist company
    from the EDGAR submissions API and persist them to Supabase.

    Use this to populate historical data that RSS polling missed (e.g. Q1 10-Qs
    that were filed before the pipeline was running in GitHub Actions).
    """
    log.info("=" * 60)
    log.info("SUMMA BACKFILL  —  %s UTC", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"))
    log.info("Watchlist: %d companies  ·  %d filings per company", len(CORE_WATCHLIST), limit)
    log.info("=" * 60)

    total_persisted = 0
    total_skipped   = 0

    for cik, info in CORE_WATCHLIST.items():
        ticker = info["ticker"]
        name   = info["name"]
        log.info("%-6s  %s", ticker, name[:50])

        try:
            data = fetch_company_filings(cik)
        except Exception as exc:
            log.warning("  ✗ Failed to fetch %s: %s", ticker, exc)
            continue

        try:
            upsert_company_meta({"cik": cik, "ticker": ticker, "company_name": name})
        except Exception as exc:
            log.debug("company_meta write: %s", exc)

        recent = _parse_recent_filings(
            data,
            forms=["10-K", "10-Q", "8-K", "DEF 14A"],
            limit=limit,
            cutoff_days=None,  # backfill: no date filter — fetch the most recent `limit` filings regardless of age
        )

        persisted = 0
        for filing in recent:
            filed_iso = (filing["filed_date"] + "T00:00:00+00:00") if filing["filed_date"] else None
            row = {
                "accession_number": filing["accession"],
                "cik":              cik,
                "ticker":           ticker,
                "company_name":     name,
                "form_type":        filing["form_type"],
                "filed_at":         filed_iso,
                "period_of_report": filing["report_date"] or None,
                "filing_url":       filing["document_url"],
                "signals_flagged":  False,
            }
            try:
                upsert_filing(row)
                if filing["form_type"] == "10-Q":
                    prune_filing_history(cik, "10-Q", keep=10)
                elif filing["form_type"] == "10-K":
                    prune_filing_history(cik, "10-K", keep=2)
                elif filing["form_type"] == "DEF 14A":
                    delete_superseded_filings(cik, "DEF 14A", filing["accession"])
                persisted += 1
            except Exception as exc:
                log.debug("Skip %s: %s", filing["accession"], exc)
                total_skipped += 1

        log.info("  ✓ %d/%d persisted", persisted, len(recent))
        total_persisted += persisted
        time.sleep(0.5)  # brief pause between companies

    log.info("Backfill complete. %d filings persisted, %d skipped.", total_persisted, total_skipped)


# ─── Search mode ──────────────────────────────────────────────────────────────

def _print_divider(char: str = "─", width: int = 70) -> None:
    print(char * width)


def _fmt_date(iso: str) -> str:
    """Format ISO date string to human-readable."""
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%b %d, %Y")
    except Exception:
        return iso[:10]


def run_search(query: str) -> None:
    """
    Interactive search: find a company, fetch recent filings,
    and print stock-price-relevant signal summary.
    """
    print()
    _print_divider("═")
    print(f"  SUMMA FILING SEARCH  —  \"{query}\"")
    _print_divider("═")

    # ── Step 1: resolve company ───────────────────────────────────────────────
    print("\n[1/3] Searching company registry…")
    matches = search_by_name(query, live=True)

    if not matches:
        print(f"  ✗  No company found matching '{query}'.")
        print("      Try a shorter name or ticker symbol (e.g. 'Apple', 'AAPL').")
        return

    # If multiple matches, let the user pick
    if len(matches) > 1:
        print(f"\n  Found {len(matches)} matches:\n")
        for i, m in enumerate(matches[:10]):
            print(f"  [{i+1}]  {m['ticker']:<8}  {m['name']}")
        print()
        try:
            choice = int(input("  Enter number to select (1): ").strip() or "1") - 1
            choice = max(0, min(choice, len(matches) - 1))
        except ValueError:
            choice = 0
        company = matches[choice]
    else:
        company = matches[0]

    print(f"\n  ✓  Selected: {company['ticker']}  —  {company['name']}  (CIK {company['cik']})")

    # ── Step 2: fetch filing history ──────────────────────────────────────────
    print("\n[2/3] Fetching SEC filing history…")
    try:
        data = fetch_company_filings(company["cik"])
    except Exception as exc:
        print(f"  ✗  Failed to fetch filings: {exc}")
        return

    total_filings = len(data.get("filings", {}).get("recent", {}).get("accessionNumber", []))
    print(f"  ✓  {total_filings} total historical filings found")

    # Pull recent filings — no date cutoff in search mode so the user sees full history
    recent = _parse_recent_filings(data, forms=["10-K", "10-Q", "8-K", "DEF 14A"], limit=15, cutoff_days=None)

    if not recent:
        print("  ✗  No recent 10-K / 10-Q / 8-K / DEF 14A filings found.")
        return

    # ── Step 3: display results ───────────────────────────────────────────────
    print(f"\n[3/3] Stock-price relevant filings for {company['ticker']}\n")
    _print_divider()

    for filing in recent:
        ft        = filing["form_type"]
        filed     = _fmt_date(filing["filed_date"])
        rdate     = _fmt_date(filing["report_date"]) if filing["report_date"] else "—"
        items     = _classify_8k_impact(filing["8k_items"])
        has_alert = any(hi for _, _, hi in items)

        # Header line
        alert_flag = "  ⚠  MATERIAL EVENT" if has_alert else ""
        print(f"\n  {ft:<10}  Filed: {filed:<15}  Period: {rdate}{alert_flag}")
        print(f"  {'':10}  {filing['document_url']}")

        # Form-type-specific context
        if ft == "10-K":
            print("  ├─ Annual report — contains full financials, MD&A, Risk Factors")
            print("  └─ Key signals: revenue growth, margin changes, new risk disclosures")

        elif ft == "10-Q":
            print("  ├─ Quarterly report — interim financials and MD&A update")
            print("  └─ Key signals: YoY/QoQ metric changes, guidance language shifts")

        elif ft == "8-K":
            if items:
                for item_num, item_desc, is_high in items:
                    icon = "⚠ " if is_high else "  "
                    print(f"  ├─ {icon}Item {item_num}: {item_desc}")
            else:
                print("  └─ Material event filing (items not parsed)")

        elif ft == "DEF 14A":
            print("  ├─ Proxy statement — executive compensation, board changes")
            print("  └─ Key signals: new directors, large pay packages, governance shifts")

        _print_divider("·")

    # ── Persist discovered filings to Supabase ───────────────────────────────
    print("\n[4/4] Persisting to Supabase…")
    cik_padded = company["cik"].zfill(10)
    try:
        upsert_company_meta({
            "cik":          cik_padded,
            "ticker":       company["ticker"],
            "company_name": company["name"],
        })
    except Exception as exc:
        log.debug("company_meta write: %s", exc)

    persisted = 0
    for filing in recent:
        filed_iso = (filing["filed_date"] + "T00:00:00+00:00") if filing["filed_date"] else None
        row = {
            "accession_number": filing["accession"],
            "cik":              cik_padded,
            "ticker":           company["ticker"],
            "company_name":     company["name"],
            "form_type":        filing["form_type"],
            "filed_at":         filed_iso,
            "period_of_report": filing["report_date"] or None,
            "filing_url":       filing["document_url"],
            "signals_flagged":  False,
        }
        try:
            upsert_filing(row)
            persisted += 1
        except Exception as exc:
            log.debug("Skipping %s: %s", filing["accession"], exc)
    print(f"  ✓ {persisted}/{len(recent)} filings persisted.")

    # ── Add to watchlist prompt ───────────────────────────────────────────────
    if company["cik"] not in CORE_WATCHLIST:
        print(f"\n  {company['ticker']} is not in your watchlist.")
        ans = input(f"  Add {company['ticker']} to watchlist for live monitoring? [y/N]: ").strip().lower()
        if ans == "y":
            add_to_watchlist(company["cik"], company["ticker"], company["name"])
            print(f"  ✓  {company['ticker']} added. Watchlist now has {len(CORE_WATCHLIST)} companies.")
    else:
        print(f"\n  ✓  {company['ticker']} is already in your watchlist.")

    print()
    _print_divider("═")


# ─── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Summa SEC scraper — pipeline or interactive search",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python sec_scraper.py                   # run pipeline\n"
            "  python sec_scraper.py --search Apple    # search filings\n"
            "  python sec_scraper.py --search TSLA     # search by ticker\n"
        ),
    )
    parser.add_argument(
        "--search", "-s",
        metavar="COMPANY",
        help="Search for a company by name or ticker and show recent filings",
    )
    parser.add_argument(
        "--backfill", "-b",
        action="store_true",
        help="Fetch recent filings for all watchlist companies from EDGAR and persist to Supabase",
    )
    parser.add_argument(
        "--backfill-limit",
        type=int,
        default=20,
        metavar="N",
        help="Number of recent filings per company in backfill mode (default: 20)",
    )
    parser.add_argument(
        "--cleanup", "-c",
        action="store_true",
        help=f"Delete filings and filing_events older than {RETENTION_DAYS} days from Supabase",
    )
    args = parser.parse_args()

    if args.cleanup:
        run_cleanup()
    elif args.backfill:
        run_backfill(limit=args.backfill_limit)
    elif args.search:
        run_search(args.search)
    else:
        run_pipeline()


if __name__ == "__main__":
    main()
