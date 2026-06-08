"""Per-company summary precompute → `company_summary`.

Writes ONE small row per company (latest price, technical snapshot, recent-activity
counts) so the frontend's watchlist-wide surfaces (Overview table, Momentum Scanner)
read a single bounded query instead of every company's full price history. This is
the piece that lets those views scale to any watchlist size.

Pure aggregation over rows already in the warehouse (daily_prices, filings,
insider_transactions) — no EDGAR/network calls. The technicals math mirrors the
frontend's lib/technicals.ts + lib/prices.ts so the precomputed values match what
the per-company page derives client-side.
"""

import logging
from datetime import datetime, timezone, timedelta

import db

logger = logging.getLogger(__name__)

_DAY = 86_400.0


# ─── Technicals (ported from frontend lib/technicals.ts + lib/prices.ts) ─────────

def _sma(xs: list[float], n: int) -> float | None:
    return sum(xs[-n:]) / n if len(xs) >= n else None


def _sma_at(xs: list[float], n: int, end: int) -> float | None:
    if end + 1 < n:
        return None
    return sum(xs[end + 1 - n : end + 1]) / n


def _rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gain = loss = 0.0
    for i in range(len(closes) - period, len(closes)):
        d = closes[i] - closes[i - 1]
        if d >= 0:
            gain += d
        else:
            loss -= d
    avg_gain, avg_loss = gain / period, loss / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def _cross(closes: list[float], lookback: int = 5) -> str | None:
    n = len(closes)
    if n < 201:
        return None
    for k in range(lookback):
        cur, prev = n - 1 - k, n - 2 - k
        f1, s1 = _sma_at(closes, 50, cur), _sma_at(closes, 200, cur)
        f0, s0 = _sma_at(closes, 50, prev), _sma_at(closes, 200, prev)
        if None in (f1, s1, f0, s0):
            continue
        if f0 <= s0 and f1 > s1:   # type: ignore[operator]
            return "golden"
        if f0 >= s0 and f1 < s1:   # type: ignore[operator]
            return "death"
    return None


def _pct(now: float | None, then: float | None) -> float | None:
    if now is None or then is None or then == 0:
        return None
    return (now - then) / abs(then) * 100


def _technicals(rows: list[dict]) -> dict:
    """Compute the price + technical snapshot from ascending daily_prices rows."""
    closes = [float(r["close"]) for r in rows if r.get("close") is not None]
    if len(closes) < 2:
        return {}
    vols = [float(r.get("volume") or 0) for r in rows if r.get("close") is not None]
    dates = [r["date"] for r in rows if r.get("close") is not None]
    last = closes[-1]
    as_of = dates[-1]

    # close on/before a target epoch-seconds, scanning back
    def close_as_of(target: float) -> float | None:
        for i in range(len(dates) - 1, -1, -1):
            if datetime.fromisoformat(dates[i]).timestamp() <= target:
                return closes[i]
        return None

    now = datetime.fromisoformat(as_of).timestamp()
    year252 = closes[-252:]
    hi, lo = max(year252), min(year252)
    s50, s200 = _sma(closes, 50), _sma(closes, 200)
    avg_vol30 = sum(vols[-30:]) / 30 if len(vols) >= 30 else None
    year_start = datetime(datetime.fromisoformat(as_of).year, 1, 1, tzinfo=timezone.utc).timestamp()
    ytd_base = next((closes[i] for i in range(len(dates)) if datetime.fromisoformat(dates[i]).timestamp() >= year_start), None)

    return {
        "last_close": round(last, 4),
        "as_of": as_of,
        "chg_1d": _round(_pct(last, closes[-2])),
        "ret_ytd": _round(_pct(last, ytd_base)),
        "pct_off_high": _round((last - hi) / hi * 100 if hi > 0 else None),
        "rsi14": _round(_rsi(closes)),
        "pct_from_50": _round((last - s50) / s50 * 100 if s50 else None),
        "pct_from_200": _round((last - s200) / s200 * 100 if s200 else None),
        "ma_cross": _cross(closes),
        "vol_spike": _round(vols[-1] / avg_vol30 if avg_vol30 else None),
        "new_52w_high": last >= hi,
        "new_52w_low": last <= lo,
        "spark": [round(c, 4) for c in closes[-60:]],
    }


def _round(v: float | None, places: int = 4) -> float | None:
    return round(v, places) if v is not None else None


# ─── Activity counts ────────────────────────────────────────────────────────────

def _activity(filings: list[dict], insider: list[dict]) -> dict:
    now = datetime.now(timezone.utc)
    cutoff30 = now - timedelta(days=30)
    cutoff90 = now - timedelta(days=90)

    def parse(iso: str | None) -> datetime | None:
        if not iso:
            return None
        try:
            d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return None

    dated = [(parse(f.get("filed_at")), f) for f in filings]
    dated = [(d, f) for d, f in dated if d]
    dated.sort(key=lambda x: x[0], reverse=True)
    filings_30d = sum(1 for d, _ in dated if d >= cutoff30)
    last_form = dated[0][1].get("form_type") if dated else None
    last_at = dated[0][1].get("filed_at") if dated else None

    net = 0.0
    buyers: set[str] = set()
    for t in insider:
        d = parse(t.get("transaction_date") or t.get("filed_at"))
        if not d or d < cutoff90 or t.get("value") is None:
            continue
        code = (t.get("transaction_code") or "").upper()
        if code == "P":
            net += float(t["value"]); buyers.add(t.get("filer_name") or "")
        elif code == "S":
            net -= float(t["value"])

    return {
        "filings_30d": filings_30d,
        "last_filing_form": last_form,
        "last_filing_at": last_at,
        "net_insider_90d": round(net, 2),
        "cluster_buy": len(buyers) >= 3,
    }


# ─── Entry point ────────────────────────────────────────────────────────────────

def ingest_summary(cik: str, ticker: str) -> None:
    """Recompute and upsert the company_summary row for one company."""
    client = db.get_client()
    # Most-recent 400 sessions: order desc + limit (newest), then reverse to
    # ascending for _technicals. Ascending + limit would return the OLDEST rows
    # once a company exceeds 400 bars, so the snapshot would go stale as
    # daily_prices accumulates.
    prices = (
        client.table("daily_prices").select("date, close, volume")
        .eq("cik", cik).order("date", desc=True).limit(400).execute().data or []
    )
    if not prices:
        return  # nothing to summarize yet; skip (row appears once prices land)
    prices.reverse()  # ascending, as _technicals expects

    filings = (
        client.table("filings").select("form_type, filed_at")
        .eq("cik", cik).order("filed_at", desc=True).limit(50).execute().data or []
    )
    insider = (
        client.table("insider_transactions")
        .select("transaction_code, transaction_date, filed_at, value, filer_name")
        .eq("cik", cik).order("transaction_date", desc=True).limit(200).execute().data or []
    )

    row = {"cik": cik, "ticker": ticker, "updated_at": datetime.now(timezone.utc).isoformat()}
    row.update(_technicals(prices))
    row.update(_activity(filings, insider))
    db.upsert_summary(row)
