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
from bs4 import BeautifulSoup
from dotenv import load_dotenv

from cik_map import CORE_WATCHLIST, search_by_name, add_to_watchlist
from db import upsert_filing, insert_filing_event, upsert_company_meta

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

RATE_DELAY  = 0.12          # 120 ms between requests → ≤8 req/s (under SEC 10/s limit)
REQUEST_TIMEOUT = 15        # seconds

# RSS feeds — one per form type, always returns last ~40 filings
RSS_FEEDS: dict[str, str] = {
    "10-K":    f"{SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=10-K&dateb=&owner=include&count=40&search_text=&output=atom",
    "10-Q":    f"{SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=10-Q&dateb=&owner=include&count=40&search_text=&output=atom",
    "8-K":     f"{SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=8-K&dateb=&owner=include&count=40&search_text=&output=atom",
    "DEF 14A": f"{SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=DEF+14A&dateb=&owner=include&count=40&search_text=&output=atom",
}

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
                wait = 2 ** (attempt + 1)
                log.warning("SEC rate-limited. Backing off %ds…", wait)
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


# ─── RSS feed parsing ─────────────────────────────────────────────────────────

def fetch_rss_entries(form_type: str) -> list[dict[str, str]]:
    """
    Fetch one EDGAR RSS feed and return a list of filing entries.
    Each entry has: accession, cik, company, form_type, filed_at, filing_url.
    """
    url = RSS_FEEDS[form_type]
    log.info("Fetching RSS  %-8s …", form_type)
    r    = _get(url)
    soup = BeautifulSoup(r.content, "xml")

    entries = []
    for entry in soup.find_all("entry"):
        try:
            title       = entry.find("title").get_text(strip=True)
            filing_url  = entry.find("link")["href"]
            updated     = entry.find("updated").get_text(strip=True)
            category    = entry.find("category")
            accession   = entry.find("accession-number")

            # CIK lives in the filing URL: /cgi-bin/browse-edgar?action=getcompany&CIK=0000320193…
            cik_raw     = ""
            filing_link = entry.find("filing-href")
            if filing_link:
                href = filing_link.get_text(strip=True)
                # path: /Archives/edgar/data/320193/…
                parts = href.split("/")
                if "data" in parts:
                    candidate = parts[parts.index("data") + 1]
                    # Validate: CIK must be purely numeric (max 10 digits)
                    if candidate.isdigit() and len(candidate) <= 10:
                        cik_raw = candidate

            entries.append({
                "accession":  accession.get_text(strip=True) if accession else "",
                "cik":        cik_raw.zfill(10) if cik_raw else "",
                "company":    title,
                "form_type":  form_type,
                "filed_at":   updated,
                "filing_url": filing_url,
            })
        except Exception as exc:
            log.debug("Skipping malformed entry: %s", exc)

    log.info("  → %d entries parsed", len(entries))
    return entries


# ─── Company filing history (for search mode) ─────────────────────────────────

def fetch_company_filings(cik: str) -> dict[str, Any]:
    """
    Fetch full submission history for a company from data.sec.gov.
    Returns the raw JSON payload (see EDGAR data API docs).
    """
    padded = cik.zfill(10)
    url    = f"{DATA_BASE}/submissions/CIK{padded}.json"
    log.info("Fetching submission history: CIK %s", padded)
    return _get(url).json()


def _parse_recent_filings(data: dict[str, Any], forms: list[str], limit: int = 10) -> list[dict[str, Any]]:
    """
    Extract recent filings of the given form types from a submissions JSON payload.
    Returns up to `limit` results sorted newest-first.
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

    MAX_SCAN = 200  # don't iterate the full filing history (can be 1000+ rows)
    results = []
    for i, acc in enumerate(accessions[:MAX_SCAN]):
        ft = form_types[i] if i < len(form_types) else ""
        if ft not in forms:
            continue

        filed = filed_dates[i]  if i < len(filed_dates)  else ""
        desc  = descriptions[i] if i < len(descriptions)  else ""
        rdate = report_dates[i] if i < len(report_dates)  else ""
        items = items_list[i]   if i < len(items_list)   else ""

        # Build direct document URL — skip if primary document name is missing
        if not desc:
            log.debug("Skipping %s: no primary document name", acc)
            continue
        acc_path    = acc.replace("-", "")
        cik_clean   = str(data.get("cik", "")).zfill(10)
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
    Main pipeline: poll all four RSS feeds, deduplicate, filter to watchlist,
    and log each new qualifying filing for downstream processing.
    """
    log.info("=" * 60)
    log.info("SUMMA PIPELINE  —  %s UTC", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"))
    log.info("Watchlist: %d companies", len(CORE_WATCHLIST))
    log.info("=" * 60)

    redis    = _redis_client()
    new_total = 0

    for form_type in RSS_FEEDS:
        entries = fetch_rss_entries(form_type)

        for entry in entries:
            accession = entry["accession"]
            cik       = entry["cik"]

            # CIK filter first — discard non-watchlist entries without touching Redis.
            # This keeps Redis usage well under the 10,000 commands/day free limit.
            # (160 entries/run × 144 runs/day = 23,040 GET commands if Redis ran first.)
            if cik not in CORE_WATCHLIST:
                continue

            # Redis deduplication — only runs for watchlist companies (~2–5 per run).
            # This is the weekend/holiday handler: on Saturday every accession was
            # already stored on Friday, so the script exits immediately with 0 new entries.
            if _is_seen(redis, accession):
                continue

            company_info = CORE_WATCHLIST[cik]
            log.info(
                "NEW  %-8s  %-6s  %-30s  %s",
                entry["form_type"],
                company_info["ticker"],
                company_info["name"][:30],
                entry["filed_at"][:10],
            )

            # ── Compute friday_dump flag ──────────────────────────────────
            filed_dt = None
            try:
                filed_dt = datetime.fromisoformat(
                    entry["filed_at"].replace("Z", "+00:00")
                )
            except Exception:
                pass

            is_friday_dump = False
            if filed_dt:
                # Friday (weekday=4) after 15:30 ET (UTC-4 during EDT)
                et_mins = (filed_dt.hour - 4) % 24 * 60 + filed_dt.minute
                is_friday_dump = filed_dt.weekday() == 4 and et_mins >= 15 * 60 + 30

            # ── Persist base row to Supabase ──────────────────────────────
            row = {
                "accession_number": accession,
                "cik":              cik,
                "ticker":           company_info["ticker"],
                "company_name":     company_info["name"],
                "form_type":        form_type,
                "filed_at":         entry["filed_at"],
                "filing_url":       entry["filing_url"],
                "friday_dump":      is_friday_dump,
                "signals_flagged":  False,
            }
            try:
                upsert_filing(row)
                if form_type == "8-K":
                    insert_filing_event(cik, accession, entry["filed_at"])
                log.info("  ✓ Persisted: %s", accession)
            except Exception as exc:
                log.warning("  ✗ DB write failed: %s", exc)

            # TODO Phase 1 continuation:
            # 1. html_cleaner.fetch_and_clean(entry["filing_url"])
            # 2. signal_extractor.extract(cleaned_sections) — updates row with signals
            # 3. gemini_enricher.enrich(signals)  — only if signals_flagged = true
            # 4. discord_notify.send(result)       — only if signals_flagged = true

            _mark_seen(redis, accession)
            new_total += 1

    if new_total == 0:
        log.info("No new filings — all accession numbers already seen (normal on weekends/holidays).")
    else:
        log.info("Pipeline complete. %d new filing(s) queued for processing.", new_total)


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

    # Pull recent annual, quarterly, material event, and proxy filings
    recent = _parse_recent_filings(data, forms=["10-K", "10-Q", "8-K", "DEF 14A"], limit=15)

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
    args = parser.parse_args()

    if args.search:
        run_search(args.search)
    else:
        run_pipeline()


if __name__ == "__main__":
    main()
