#!/usr/bin/env python3
"""Summa Phase 1 ingest orchestrator.

For each selected company: refresh metadata, then ingest each dataset. The
fundamentals + filings-feed slices are live; the remaining extractors are
wired in and run best-effort (they no-op until implemented).

Two-level staged cadence (the default cron path) keeps every run inside the
Actions window and within EDGAR/Supabase limits no matter how large the watchlist
grows:
  • Company level — each run visits at most INGEST_MAX_PER_RUN companies:
    never-ingested first, then fair rotation by longest-since-visited.
  • Dataset level — within a visit, each dataset only runs if its own cadence has
    elapsed (DATASET_INTERVALS_H). The cheap filings feed refreshes every visit;
    heavy XBRL fundamentals and 13F refresh ~weekly. So a visit is cheap unless a
    heavy slice is genuinely due, and quarterly data is never re-parsed every run.

Coverage scales by spreading work across runs, not by doing more per run.

Run:  python main.py             # staged cadence (what the cron uses)
      python main.py AAPL MSFT   # force a specific subset, every dataset
      python main.py --all       # force the entire active watchlist (manual)
      python main.py --queued    # only never-ingested / newly queued companies

Tuning (env): INGEST_MAX_PER_RUN (default 12); INTERVAL_<DATASET> hours overrides.
"""

import logging
import os
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
from edgar import set_identity

import db
from ingest import data_ingest
from ingest import filings_ingest
from watchlist import WATCHLIST, WatchedCompany, get_active_watchlist

try:
    from extractors import insider_extractor
except Exception:  # pragma: no cover
    insider_extractor = None
try:
    from extractors import institutional_extractor
except Exception:  # pragma: no cover
    institutional_extractor = None
try:
    from extractors import event_extractor
except Exception:  # pragma: no cover
    event_extractor = None
try:
    from extractors import ownership_extractor
except Exception:  # pragma: no cover
    ownership_extractor = None
try:
    from ingest import reference_ingest
except Exception:  # pragma: no cover
    reference_ingest = None
try:
    from ingest import entity_ingest
except Exception:  # pragma: no cover
    entity_ingest = None
try:
    from ingest import price_ingest
except Exception:  # pragma: no cover
    price_ingest = None
try:
    from ingest import summary_ingest
except Exception:  # pragma: no cover
    summary_ingest = None

load_dotenv()

# Windows consoles default to cp1252, which can't encode the em-dash / ▶ used
# in log output. Force UTF-8 so local runs don't crash with UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("summa")

set_identity(os.environ.get("EDGAR_IDENTITY", "Summa/1.0 (contact@example.com)"))


def _preflight() -> bool:
    """Verify the warehouse schema is applied before ingesting.

    The new Phase 1 schema (companies, financial_facts, …) must be created by
    running schema.sql in the Supabase SQL Editor. If the `companies` table is
    missing, fail fast with actionable guidance instead of a raw stack trace.
    """
    try:
        db.get_client().table("companies").select("cik").limit(1).execute()
        return True
    except Exception as exc:
        if "companies" in str(exc) or "PGRST205" in str(exc):
            logger.error(
                "Schema not applied: the 'companies' table is missing.\n"
                "  → Open the Supabase SQL Editor and run schema.sql (in the repo root),\n"
                "    then re-run this command. schema.sql is idempotent (safe to re-run)."
            )
            return False
        logger.exception("Preflight check failed")
        return False


# Per-run budget. Each cron tick visits at most this many companies so a run never
# overruns the Actions window or hammers EDGAR; the rest wait for the next tick.
# Which datasets actually run on a visit is governed by per-dataset cadence below,
# so a visit is cheap unless a heavy slice is genuinely due.
MAX_PER_RUN     = int(os.environ.get("INGEST_MAX_PER_RUN", "12"))

# Wall-clock budget (seconds). The loop never *starts* a new company once this
# much time has elapsed, so a run exits cleanly and commits its per-company state
# instead of being killed mid-write by the Actions timeout-minutes cap. Set well
# below that cap to leave room for pip install + the final writes. The next cron
# tick resumes with the still-stale companies (scheduler orders by staleness).
TIME_BUDGET_S   = float(os.environ.get("INGEST_TIME_BUDGET_S", "360"))

# Per-dataset cadence (hours): inside a visited company, only refresh datasets
# whose interval has elapsed. Tuned to each dataset's real update frequency so we
# never re-parse quarterly XBRL or 13F every visit. 0 = every visit. Env-tunable.
DATASET_INTERVALS_H: dict[str, float] = {
    "filings":       float(os.environ.get("INTERVAL_FILINGS",       "0")),    # feed: every visit
    "events":        float(os.environ.get("INTERVAL_EVENTS",        "12")),   # 8-Ks land often
    "insider":       float(os.environ.get("INTERVAL_INSIDER",       "24")),   # Form 4 daily-ish
    "ownership":     float(os.environ.get("INTERVAL_OWNERSHIP",     "48")),   # 13D/G, 144 occasional
    "fundamentals":  float(os.environ.get("INTERVAL_FUNDAMENTALS",  "168")),  # XBRL: quarterly → weekly
    # NOTE: 13F institutional is NOT a per-company dataset — it is a global, quarterly
    # roll-forward (institutional_extractor.ingest_institutional_global, wired in main()).
    # Per-company only runs once for first-time/forced coverage (see process()).
    "prices":        float(os.environ.get("INTERVAL_PRICES",        "24")),   # EOD bars: daily
    "reference":     float(os.environ.get("INTERVAL_REFERENCE",     "720")),  # SIC/seed ~static → monthly
    "summary":       float(os.environ.get("INTERVAL_SUMMARY",       "0")),    # cheap recompute; refresh every visit
}


def _age_hours(iso: str | None, now: datetime) -> float | None:
    """Hours since `iso` (an ISO timestamp), or None if never/unparseable."""
    if not iso:
        return None
    try:
        last = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return (now - last).total_seconds() / 3600.0
    except (ValueError, TypeError):
        return None


def _any_due(datasets: dict[str, str], now: datetime) -> bool:
    """True if at least one dataset's cadence has elapsed (so a visit is worthwhile)."""
    for ds, interval in DATASET_INTERVALS_H.items():
        age = _age_hours(datasets.get(ds), now)
        if age is None or age >= interval:
            return True
    return False


def _schedule(
    active: list[WatchedCompany], state: dict[str, dict], *, queued_only: bool = False,
) -> list[WatchedCompany]:
    """Pick this run's batch: never-ingested first, then companies with a due
    dataset ordered by longest-since-visited (fair rotation), capped at MAX_PER_RUN.

    Visit cadence is driven by per-dataset due-ness, not a blunt timer: a company
    with `filters`-interval 0 is always worth a visit (keeps the live feed fresh),
    while heavy slices still throttle inside process(). Companies with nothing due
    are skipped so cap slots aren't wasted.
    """
    now = datetime.now(timezone.utc)

    never: list[WatchedCompany] = []
    due: list[tuple[float, WatchedCompany]] = []
    for c in active:
        st = state.get(c["cik"])
        if not st or not st.get("last"):
            never.append(c)
            continue
        if _any_due(st.get("datasets", {}), now):
            due.append((_age_hours(st.get("last"), now) or 0.0, c))

    if queued_only:
        selected = never
    else:
        due.sort(key=lambda x: x[0], reverse=True)   # longest-since-visited first
        selected = never + [c for _, c in due]

    return selected[:MAX_PER_RUN] if MAX_PER_RUN > 0 else selected


def _select(
    argv: list[str], active: list[WatchedCompany], state: dict[str, dict],
) -> tuple[list[WatchedCompany], bool]:
    """Resolve the run's company list from CLI args + the staged scheduler.

    Returns (companies, force) — force=True means explicit/manual selection, in
    which case per-dataset cadence is bypassed so every dataset is re-pulled.
    """
    flags = {a.lower() for a in argv if a.startswith("-")}
    tickers = [a for a in argv if not a.startswith("-")]

    if "--all" in flags:                       # manual full refresh
        return active, True
    if tickers:                                # explicit subset, ignore cadence
        wanted = {t.upper() for t in tickers}
        return [c for c in active if c["ticker"].upper() in wanted], True
    return _schedule(active, state, queued_only="--queued" in flags), False


def _run_optional(module: object, fn: str, *args: object) -> bool:
    """Run an optional extractor. Returns True only if it actually ran cleanly."""
    if module is None or not hasattr(module, fn):
        return False
    try:
        getattr(module, fn)(*args)
        return True
    except NotImplementedError:
        logger.info("  %s.%s not implemented yet - skipping", getattr(module, "__name__", "?"), fn)
        return False
    except Exception:
        logger.exception("  %s.%s failed", getattr(module, "__name__", "?"), fn)
        return False


def process(company: WatchedCompany, datasets: dict[str, str], *, force: bool = False) -> None:
    """Ingest a company, running only the datasets whose cadence is due.

    `datasets` is the company's stored {dataset: last-run ISO}. `force` bypasses
    cadence (explicit CLI runs). On success each dataset's timestamp is advanced
    and the merged state is persisted in a single write.
    """
    cik, ticker, name = company["cik"], company["ticker"], company["name"]
    now = datetime.now(timezone.utc)

    def due(ds: str) -> bool:
        if force:
            return True
        age = _age_hours(datasets.get(ds), now)
        return age is None or age >= DATASET_INTERVALS_H.get(ds, 0)

    pending = [ds for ds in DATASET_INTERVALS_H if due(ds)]
    if not pending:
        logger.info("> %s (%s) — all datasets fresh, skip", ticker, cik)
        return
    logger.info("> %s (%s) — %s", ticker, cik, ", ".join(pending))

    db.upsert_company({"cik": cik, "ticker": ticker, "name": name})

    new_state = dict(datasets)
    stamp = now.isoformat()

    # Core slices (raise on hard failure → don't stamp that dataset).
    if due("filings"):
        try:
            filings_ingest.ingest_filings_feed(cik, ticker, name); new_state["filings"] = stamp
        except Exception:
            logger.exception("  filings_feed failed for %s", ticker)
    if due("fundamentals"):
        try:
            data_ingest.ingest_fundamentals(cik, ticker); new_state["fundamentals"] = stamp
        except Exception:
            logger.exception("  fundamentals failed for %s", ticker)

    # Optional extractors — stamp only when they actually ran.
    if due("events")        and _run_optional(event_extractor,         "ingest_events",        cik, ticker): new_state["events"] = stamp
    if due("insider")       and _run_optional(insider_extractor,       "ingest_insider",       cik, ticker): new_state["insider"] = stamp
    if due("ownership")     and _run_optional(ownership_extractor,     "ingest_ownership",     cik, ticker): new_state["ownership"] = stamp
    # 13F is global/quarterly (ingest_institutional_global below). Per-company runs
    # only ONCE — to give a brand-new or force-ingested company its first holder
    # coverage; ongoing refresh is the global pass's job.
    if (force or "institutional" not in datasets) and _run_optional(institutional_extractor, "ingest_institutional", cik, ticker): new_state["institutional"] = stamp
    if due("prices")        and _run_optional(price_ingest,            "ingest_prices",        cik, ticker): new_state["prices"] = stamp
    if due("reference")     and _run_optional(reference_ingest,        "ingest_profile",       cik, ticker): new_state["reference"] = stamp

    # Summary runs LAST so it aggregates the data the slices above just wrote.
    if due("summary")       and _run_optional(summary_ingest,          "ingest_summary",       cik, ticker): new_state["summary"] = stamp

    db.update_company_state(cik, new_state)   # one write: dataset_state + last_ingested_at


def main() -> int:
    if not _preflight():
        return 2
    active = get_active_watchlist()
    state = db.fetch_ingest_state()
    companies, force = _select(sys.argv[1:], active, state)
    if not companies:
        logger.info("Nothing due this run (all companies fresh). Exiting.")
        _run_optional(entity_ingest, "ingest_entities")
        return 0
    logger.info("Summa ingest | %d compan%s (cap %d)",
                len(companies), "y" if len(companies) == 1 else "ies", MAX_PER_RUN)
    seed_ciks = {c["cik"] for c in WATCHLIST}
    start = time.monotonic()
    ok = 0
    for i, c in enumerate(companies):
        # Never *start* a company past the budget: a partial process() doesn't
        # persist its state (one write at the end), so stopping between companies
        # keeps progress resumable and avoids a mid-write kill by the job timeout.
        elapsed = time.monotonic() - start
        if i > 0 and elapsed >= TIME_BUDGET_S:
            logger.info("Time budget reached (%.0fs ≥ %.0fs) — %d/%d done, "
                        "%d deferred to next tick",
                        elapsed, TIME_BUDGET_S, ok, len(companies), len(companies) - i)
            break
        try:
            process(c, state.get(c["cik"], {}).get("datasets", {}), force=force)
            ok += 1
            # Flip queued (non-seed) companies to 'ingested' so the UI can reflect it.
            if c["cik"] not in seed_ciks:
                db.mark_watchlist_ingested(c["cik"])
        except Exception:
            logger.exception("Failed for %s", c["ticker"])
    # Global passes (run once, not per company).
    _run_optional(entity_ingest, "ingest_entities")
    # Institutional 13F roll-forward (global, quarterly): incrementally pulls any
    # manager filings missing for the current quarter, then refreshes per-company
    # holders + manager_portfolios for the WHOLE watchlist in one pass. No-ops (one
    # small query, no EDGAR) once the quarter is captured, so cost is O(1) per quarter
    # regardless of watchlist size.
    _run_optional(institutional_extractor, "ingest_institutional_global")
    logger.info("Done | %d/%d companies processed", ok, len(companies))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
