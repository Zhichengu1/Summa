"""End-of-day price ingest — populates `daily_prices` from Yahoo Finance.

This is the ONLY non-SEC data source in the pipeline. Yahoo's public chart
endpoint returns keyless daily OHLCV JSON, which we pull server-side (the
browser can't cross-origin, and the frontend stays read-only). Prices are
end-of-day, not realtime.

Best-effort by contract: any failure (Yahoo down, unknown ticker, malformed
payload) logs and returns 0 without raising, so a price hiccup never breaks the
SEC ingest. The frontend renders price UI only when rows exist.

(Stooq's keyless CSV was the first choice but it now gates downloads behind an
API key, so we use Yahoo's chart endpoint, which remains free and keyless.)
"""

import datetime as _dt
import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

import db

logger = logging.getLogger(__name__)

_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=2y&interval=1d"
# ~2y of sessions covers a 52-week high plus YTD/3M/1M returns without bloat.
_TIMEOUT = 15
_MAX_ATTEMPTS = 3
# A browser-like UA avoids Yahoo returning an empty/blocked body.
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Summa/1.0)"}


def _yahoo_symbol(ticker: str) -> str:
    """Map an SEC/Stooq-style ticker to Yahoo's symbol form (BRK.B -> BRK-B)."""
    return ticker.strip().upper().replace(".", "-")


def _fetch_chart(ticker: str) -> dict[str, Any] | None:
    """Fetch and JSON-decode the Yahoo chart result for a ticker, or None."""
    url = _CHART_URL.format(symbol=_yahoo_symbol(ticker))
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 (fixed https host)
                payload = json.loads(resp.read().decode("utf-8", "replace"))
            chart = (payload or {}).get("chart") or {}
            if chart.get("error"):
                logger.warning("  prices: yahoo error for %s: %s", ticker, chart["error"])
                return None
            results = chart.get("result") or []
            return results[0] if results else None
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == _MAX_ATTEMPTS:
                logger.exception("  prices: fetch failed for %s after %d attempts", ticker, attempt)
                return None
            time.sleep(2 ** (attempt - 1))  # 1s, 2s backoff
    return None


def _rows_from_chart(cik: str, ticker: str, result: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn one Yahoo chart result into daily_prices rows (skipping null bars)."""
    timestamps = result.get("timestamp") or []
    quote = (((result.get("indicators") or {}).get("quote") or [{}])[0]) or {}
    opens, highs = quote.get("open") or [], quote.get("high") or []
    lows, closes = quote.get("low") or [], quote.get("close") or []
    volumes = quote.get("volume") or []

    def _at(arr: list, i: int) -> float | None:
        v = arr[i] if i < len(arr) else None
        return float(v) if isinstance(v, (int, float)) else None

    rows: list[dict[str, Any]] = []
    for i, ts in enumerate(timestamps):
        close = _at(closes, i)
        if close is None:  # holidays / gaps come back as null — skip them
            continue
        date = _dt.datetime.fromtimestamp(ts, tz=_dt.timezone.utc).date().isoformat()
        rows.append({
            "cik": cik, "ticker": ticker, "date": date,
            "open": _at(opens, i), "high": _at(highs, i),
            "low": _at(lows, i), "close": close, "volume": _at(volumes, i),
        })
    return rows


def ingest_prices(cik: str, ticker: str) -> int:
    """Pull EOD prices for one ticker into `daily_prices`. Best-effort; never raises."""
    if not ticker:
        return 0
    result = _fetch_chart(ticker)
    if not result:
        return 0
    rows = _rows_from_chart(cik, ticker, result)
    if not rows:
        logger.warning("  %s prices: parsed 0 rows", ticker)
        return 0
    written = db.upsert_many("daily_prices", rows, on_conflict="cik,date")
    logger.info("  %s prices: %d daily bars", ticker, written)
    return written
