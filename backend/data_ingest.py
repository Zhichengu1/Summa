"""Fundamentals ingest — populates `financial_facts` from XBRL statements.

Strategy:
  1. MultiFinancials.extract(filings) — the public edgartools API for stitched
     multi-period statements. Falls back to XBRLS.from_filings() if unavailable.
  2. _normalize_std() post-processes every row: maps the raw GAAP concept name
     (e.g. "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax") to the
     short normalized key the frontend uses (e.g. "Revenue"). This ensures chart
     series always find data even when standard_concept is None in the DataFrame.

Values are stored in actual dollars (edgartools reports in actual units).
"""

import logging
import math
import re
from datetime import date
from typing import Any

import pandas as pd

import db

logger = logging.getLogger(__name__)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_STATEMENTS = [
    ("income",   "income_statement"),
    ("balance",  "balance_sheet"),
    ("cashflow", "cashflow_statement"),
]

# ─── Concept normalization map ─────────────────────────────────────────────────
# Raw GAAP concept base name (strip "us-gaap_" prefix) → standard_concept value
# used by the frontend's seriesFor() / isMetric() queries.
_STD_MAP: dict[str, str] = {
    # Revenue
    "Revenues": "Revenue",
    "Revenue": "Revenue",
    "RevenueFromContractWithCustomerExcludingAssessedTax": "Revenue",
    "RevenueFromContractWithCustomerIncludingAssessedTax": "Revenue",
    "SalesRevenueNet": "Revenue",
    "SalesRevenueGoodsNet": "Revenue",
    "RevenueNet": "Revenue",
    "NetRevenues": "Revenue",
    "TotalRevenues": "Revenue",
    # Cost of revenue
    "CostOfRevenue": "CostOfRevenue",
    "CostOfGoodsSold": "CostOfRevenue",
    "CostOfGoodsAndServicesSold": "CostOfRevenue",
    "CostOfSales": "CostOfRevenue",
    # Gross profit
    "GrossProfit": "GrossProfit",
    # R&D
    "ResearchAndDevelopmentExpense": "RAndDExpense",
    "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost": "RAndDExpense",
    # SG&A
    "SellingGeneralAndAdministrativeExpense": "SGAndAExpense",
    "GeneralAndAdministrativeExpense": "SGAndAExpense",
    "SellingAndMarketingExpense": "SGAndAExpense",
    # Operating income
    "OperatingIncomeLoss": "OperatingIncome",
    "OperatingIncome": "OperatingIncome",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest": "OperatingIncome",
    # Net income
    "NetIncomeLoss": "NetIncome",
    "NetIncome": "NetIncome",
    "ProfitLoss": "NetIncome",
    "NetIncomeLossAvailableToCommonStockholdersBasic": "NetIncome",
    "IncomeLossFromContinuingOperations": "NetIncome",
    # EPS
    "EarningsPerShareDiluted": "EarningsPerShareDiluted",
    "EarningsPerShareBasic": "EarningsPerShareBasic",
    # Shares
    "CommonStockSharesOutstanding": "SharesOutstanding",
    "WeightedAverageNumberOfDilutedSharesOutstanding": "DilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic": "BasicSharesOutstanding",
    # Cash & equivalents
    "CashAndCashEquivalentsAtCarryingValue": "CashAndCashEquivalents",
    "CashAndCashEquivalents": "CashAndCashEquivalents",
    "CashCashEquivalentsAndShortTermInvestments": "CashAndCashEquivalents",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents": "CashAndCashEquivalents",
    "CashCashEquivalentsAndRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect": "CashAndCashEquivalents",
    # Long-term debt
    "LongTermDebtNoncurrent": "LongTermDebt",
    "LongTermDebt": "LongTermDebt",
    "LongTermDebtAndCapitalLeaseObligations": "LongTermDebt",
    "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities": "LongTermDebt",
    # Assets / liabilities
    "Assets": "TotalAssets",
    "Liabilities": "TotalLiabilities",
    "AssetsCurrent": "CurrentAssets",
    "LiabilitiesCurrent": "CurrentLiabilities",
    "StockholdersEquity": "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest": "StockholdersEquity",
    "RetainedEarningsAccumulatedDeficit": "RetainedEarnings",
    # Cash flow
    "NetCashProvidedByUsedInOperatingActivities": "OperatingCashFlow",
    "NetCashProvidedByUsedInInvestingActivities": "InvestingCashFlow",
    "NetCashProvidedByUsedInFinancingActivities": "FinancingCashFlow",
    "PaymentsToAcquirePropertyPlantAndEquipment": "CapEx",
    "CapitalExpendituresIncurredButNotYetPaid": "CapEx",
    "PaymentsForRepurchaseOfCommonStock": "ShareRepurchases",
    "PaymentsOfDividends": "Dividends",
    "PaymentsOfDividendsCommonStock": "Dividends",
    # Depreciation (used for FCF calculation)
    "DepreciationDepletionAndAmortization": "DepreciationAmortization",
    "DepreciationAndAmortization": "DepreciationAmortization",
}


def _strip_prefix(concept: str) -> str:
    for p in ("us-gaap_", "ifrs-full_", "dei_", "invest_", "srt_"):
        if concept.startswith(p):
            return concept[len(p):]
    return concept


def _normalize_std(concept: str, existing_std: str | None) -> str | None:
    """Return the best standard_concept value for a row."""
    # If the existing value already maps to one of our known names, keep it.
    if existing_std:
        s = str(existing_std).strip()
        if s and s not in ("None", "nan"):
            # Check if existing value is itself a known base name
            return _STD_MAP.get(s, s)
    # Derive from the concept name.
    base = _strip_prefix(concept)
    return _STD_MAP.get(base)


def _period_cols(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns if isinstance(c, str) and _DATE_RE.match(c)]


def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _melt(
    df: pd.DataFrame, *, cik: str, ticker: str, statement: str, period_type: str
) -> list[dict[str, Any]]:
    period_cols = _period_cols(df)
    rows: list[dict[str, Any]] = []
    for order, (_, line) in enumerate(df.iterrows()):
        concept = str(line.get("concept") or "").strip()
        label = str(line.get("label") or "").strip()
        if not concept or not label:
            continue
        raw_std = line.get("standard_concept")
        std = _normalize_std(concept, None if raw_std is None else str(raw_std))
        for col in period_cols:
            v = _safe_float(line.get(col))
            if v is None:
                continue
            try:
                period_end = date.fromisoformat(col)
            except ValueError:
                continue
            rows.append({
                "cik": cik, "ticker": ticker,
                "statement": statement,
                "label": label,
                "concept": concept,
                "standard_concept": std,
                "period_end": period_end.isoformat(),
                "period_type": period_type,
                "fiscal_year": period_end.year,
                "value": v,
                "display_order": order,
            })
    return rows


# ─── Public entry point ────────────────────────────────────────────────────────

def ingest_fundamentals(
    cik: str, ticker: str, *, annual_lookback: int = 5, quarterly_lookback: int = 8
) -> int:
    """Ingest annual (10-K) and quarterly (10-Q) fundamentals for one company."""
    from edgar import Company  # noqa: PLC0415 — lazy import avoids edgar overhead at module level
    company = Company(cik)
    total = 0
    total += _ingest_period(
        company, cik=cik, ticker=ticker,
        form="10-K", period_type="annual", lookback=annual_lookback,
    )
    total += _ingest_period(
        company, cik=cik, ticker=ticker,
        form="10-Q", period_type="quarterly", lookback=quarterly_lookback,
    )
    return total


def _ingest_period(
    company: Any, *, cik: str, ticker: str, form: str, period_type: str, lookback: int
) -> int:
    try:
        filings = company.get_filings(form=form).head(lookback)
        if not filings:
            logger.info("  no %s filings for %s", form, ticker)
            return 0
    except Exception:
        logger.exception("  get_filings(%s) failed for %s", form, ticker)
        return 0

    multi = _extract_multi(filings, ticker, form)
    if multi is None:
        return 0

    rows: list[dict[str, Any]] = []
    for stmt_key, method in _STATEMENTS:
        try:
            stmt = getattr(multi, method)()
            df = stmt.to_dataframe()
            rows.extend(_melt(df, cik=cik, ticker=ticker, statement=stmt_key, period_type=period_type))
        except Exception:
            logger.exception("  %s.%s() failed for %s", form, method, ticker)

    if not rows:
        logger.warning("  %s %s: 0 facts extracted — check XBRL availability", ticker, period_type)
        return 0

    written = db.upsert_many(
        "financial_facts", rows,
        on_conflict="cik,statement,concept,period_end,period_type",
    )
    logger.info("  %s %s: %d facts", ticker, period_type, written)
    return written


def _extract_multi(filings: Any, ticker: str, form: str) -> Any:
    """Try MultiFinancials.extract() first; fall back to XBRLS.from_filings()."""
    # Preferred: MultiFinancials is the public API wrapper around XBRLS.
    try:
        from edgar import MultiFinancials  # type: ignore[attr-defined]
        return MultiFinancials.extract(filings)
    except Exception as exc:
        logger.debug("  MultiFinancials.extract failed for %s (%s): %s", ticker, form, exc)

    # Fallback: lower-level XBRLS
    try:
        from edgar.xbrl import XBRLS
        return XBRLS.from_filings(filings)
    except Exception:
        logger.exception("  XBRLS.from_filings also failed for %s (%s)", ticker, form)
        return None
