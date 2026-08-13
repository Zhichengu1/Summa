"""Options-chain snapshot ingest → `options_snapshots`.

The call-vs-put decision layer. For each company we pull the FULL US options
chain once per day and boil it down to one small row of the metrics that
actually decide a directional options trade:

  • flow      — call vs put volume / open interest / premium ($) traded today
  • pricing   — IV30 vs 30-day realized vol, plus an IV rank over our own
                accumulating history (are options cheap or rich right now?)
  • skew      — 25-delta put IV minus call IV (what the market fears)
  • the move  — the front expiry's ATM straddle as a % of spot (what is
                already priced in) and max pain (where OI pins price)
  • unusual   — the day's biggest volume-over-open-interest contracts

Source: CBOE's public delayed-quotes JSON
(`cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`). Free, keyless,
~15 minutes delayed, and it returns every listed expiry/strike in ONE request
with bid/ask, volume, open interest, IV and greeks — the exchange's own data.
(yfinance's option_chain needs a request per expiry and carries no greeks.)
The same host's `_VIX.json` gives the volatility regime, fetched once per run.

Best-effort by contract, like price_ingest: any failure (CBOE down, no listed
options, malformed payload) logs and returns 0 without raising, so an options
hiccup never breaks the SEC ingest. Companies with no options simply never get
a row and the UI omits them.
"""

import datetime as _dt
import json
import logging
import math
import time
import urllib.error
import urllib.request
from typing import Any

import db

logger = logging.getLogger(__name__)

_CHAIN_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
_VIX_URL = "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json"
_TIMEOUT = 30
_MAX_ATTEMPTS = 3
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; Summa/1.0)"}

# A contract needs a real two-sided market before its IV/mid means anything.
_MIN_OI_FOR_SKEW = 5
# "Unusual" = today's volume dwarfs the resting open interest (new positioning,
# not existing holders trading). Both floors must clear to filter out noise.
_UNUSUAL_MIN_VOLUME = 250
_UNUSUAL_VOL_OI_RATIO = 3.0
_UNUSUAL_TOP_N = 6
# Deep-ITM contracts (|delta| high) are dominated by stock-replacement and box
# trades — huge premium, no directional information. Screen them out so the
# "unusual" list stays actual speculative positioning.
_UNUSUAL_MAX_ABS_DELTA = 0.75
# The horizon a directional options trade is actually sized to. The front expiry
# can be 0–1 DTE, whose expected move says nothing about a swing thesis.
_NEAR_TERM_DTE = 30
# IV rank is a percentile of our own stored history; below this many observations
# it is statistically meaningless, so we publish NULL and let the UI say so.
_IV_RANK_MIN_OBS = 20
_IV_RANK_DAYS = 365

_vix_cache: tuple[float | None, float | None] | None = None


def _cboe_symbol(ticker: str) -> str:
    """Map a ticker to CBOE's symbol form (BRK.B -> BRK-B, matching Yahoo's)."""
    return ticker.strip().upper().replace(".", "-")


def _fetch_json(url: str, label: str) -> dict[str, Any] | None:
    """Fetch and JSON-decode a CBOE endpoint, or None on any failure."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310 (fixed https host)
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:  # no listed options for this underlying — not an error
                logger.info("  options: no chain listed for %s", label)
                return None
            if attempt == _MAX_ATTEMPTS:
                logger.warning("  options: HTTP %s for %s", exc.code, label)
                return None
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == _MAX_ATTEMPTS:
                logger.exception("  options: fetch failed for %s after %d attempts", label, attempt)
                return None
        time.sleep(2 ** (attempt - 1))  # 1s, 2s backoff
    return None


def _vix() -> tuple[float | None, float | None]:
    """(VIX level, VIX % change) — fetched once per process and reused."""
    global _vix_cache
    if _vix_cache is None:
        payload = _fetch_json(_VIX_URL, "VIX") or {}
        data = payload.get("data") or {}
        _vix_cache = (_num(data.get("current_price")), _num(data.get("price_change_percent")))
    return _vix_cache


def _num(v: Any) -> float | None:
    """Coerce to float, or None for missing/non-numeric/NaN values."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return None if math.isnan(v) or math.isinf(v) else float(v)


def _parse_symbol(sym: str) -> tuple[str, str, float] | None:
    """Split an OCC symbol ('AAPL260814C00110000') into (expiry ISO, 'C'|'P', strike)."""
    if len(sym) < 16:
        return None
    strike_part, right, date_part = sym[-8:], sym[-9], sym[-15:-9]
    if right not in ("C", "P") or not (strike_part.isdigit() and date_part.isdigit()):
        return None
    try:
        expiry = _dt.datetime.strptime(date_part, "%y%m%d").date().isoformat()
    except ValueError:
        return None
    return expiry, right, int(strike_part) / 1000.0


def _mid(bid: float | None, ask: float | None) -> float | None:
    """Mid price of a two-sided quote, or None when either side is missing."""
    if bid is None or ask is None or ask <= 0:
        return None
    return (bid + ask) / 2.0


def _contracts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize CBOE's raw option list into parsed contract dicts."""
    out: list[dict[str, Any]] = []
    for o in (payload.get("data") or {}).get("options") or []:
        parsed = _parse_symbol(str(o.get("option") or ""))
        if not parsed:
            continue
        expiry, right, strike = parsed
        bid, ask = _num(o.get("bid")), _num(o.get("ask"))
        out.append({
            "expiry": expiry, "right": right, "strike": strike,
            "volume": _num(o.get("volume")) or 0.0,
            "oi": _num(o.get("open_interest")) or 0.0,
            "iv": _num(o.get("iv")), "delta": _num(o.get("delta")),
            "theta": _num(o.get("theta")), "vega": _num(o.get("vega")),
            "bid": bid, "ask": ask,
            "mid": _mid(bid, ask), "last": _num(o.get("last_trade_price")),
        })
    return out


def _dte(expiry: str, today: _dt.date) -> int:
    """Calendar days from `today` to an ISO expiry date."""
    return (_dt.date.fromisoformat(expiry) - today).days


# ─── Metric blocks ──────────────────────────────────────────────────────────────

def _flow(contracts: list[dict[str, Any]]) -> dict[str, Any]:
    """Whole-chain call/put volume, open interest and premium ($) traded."""
    agg = {"C": {"vol": 0.0, "oi": 0.0, "prem": 0.0}, "P": {"vol": 0.0, "oi": 0.0, "prem": 0.0}}
    for c in contracts:
        side = agg[c["right"]]
        side["vol"] += c["volume"]
        side["oi"] += c["oi"]
        price = c["mid"] if c["mid"] is not None else c["last"]
        if price:
            side["prem"] += c["volume"] * price * 100.0  # 100 shares per contract

    def ratio(put: float, call: float) -> float | None:
        return round(put / call, 4) if call > 0 else None

    return {
        "call_volume": int(agg["C"]["vol"]), "put_volume": int(agg["P"]["vol"]),
        "call_oi": int(agg["C"]["oi"]), "put_oi": int(agg["P"]["oi"]),
        "call_premium": round(agg["C"]["prem"], 2), "put_premium": round(agg["P"]["prem"], 2),
        "pc_volume_ratio": ratio(agg["P"]["vol"], agg["C"]["vol"]),
        "pc_oi_ratio": ratio(agg["P"]["oi"], agg["C"]["oi"]),
        "pc_premium_ratio": ratio(agg["P"]["prem"], agg["C"]["prem"]),
        "contracts_count": len(contracts),
    }


def _front_expiry(contracts: list[dict[str, Any]], today: _dt.date) -> str | None:
    """Nearest not-yet-expired expiry that actually traded today."""
    traded: dict[str, float] = {}
    for c in contracts:
        if _dte(c["expiry"], today) >= 0:
            traded[c["expiry"]] = traded.get(c["expiry"], 0.0) + c["volume"]
    live = [e for e, v in traded.items() if v > 0] or list(traded)
    return min(live) if live else None


def _expected_move(contracts: list[dict[str, Any]], expiry: str, spot: float) -> dict[str, Any]:
    """ATM straddle price for `expiry` and the implied ±% move it represents.

    The straddle is what the market charges to be long both sides — i.e. the
    move already priced in. A directional buyer needs MORE than this to win.
    """
    at = [c for c in contracts if c["expiry"] == expiry]
    if not at:
        return {"atm_straddle": None, "expected_move_pct": None}
    strike = min({c["strike"] for c in at}, key=lambda k: abs(k - spot))
    legs = {c["right"]: c for c in at if c["strike"] == strike}
    call, put = legs.get("C"), legs.get("P")
    if not call or not put:
        return {"atm_straddle": None, "expected_move_pct": None}
    cp = call["mid"] if call["mid"] is not None else call["last"]
    pp = put["mid"] if put["mid"] is not None else put["last"]
    if cp is None or pp is None or spot <= 0:
        return {"atm_straddle": None, "expected_move_pct": None}
    straddle = cp + pp
    return {
        "atm_straddle": round(straddle, 4),
        "expected_move_pct": round(straddle / spot * 100.0, 4),
    }


def _max_pain(contracts: list[dict[str, Any]], expiry: str, spot: float) -> dict[str, Any]:
    """Strike where total in-the-money OI payout is smallest, for `expiry`.

    Where the most open interest expires worthless — a soft magnet into expiry
    when OI is large relative to float turnover. Distance from spot is the
    tradable part, so we store both.
    """
    at = [c for c in contracts if c["expiry"] == expiry and c["oi"] > 0]
    strikes = sorted({c["strike"] for c in at})
    if len(strikes) < 3:
        return {"max_pain": None, "max_pain_pct": None}
    best_strike, best_pain = None, None
    for k in strikes:
        pain = 0.0
        for c in at:
            intrinsic = (k - c["strike"]) if c["right"] == "C" else (c["strike"] - k)
            if intrinsic > 0:
                pain += intrinsic * c["oi"] * 100.0
        if best_pain is None or pain < best_pain:
            best_strike, best_pain = k, pain
    if best_strike is None or spot <= 0:
        return {"max_pain": None, "max_pain_pct": None}
    return {
        "max_pain": round(best_strike, 4),
        "max_pain_pct": round((best_strike - spot) / spot * 100.0, 4),
    }


def _nearest_expiry(contracts: list[dict[str, Any]], today: _dt.date, target_dte: int) -> str | None:
    """The listed expiry closest to `target_dte` days out (ignoring today's expiry)."""
    dated = {c["expiry"] for c in contracts if _dte(c["expiry"], today) >= 1}
    return min(dated, key=lambda e: abs(_dte(e, today) - target_dte)) if dated else None


def _skew(contracts: list[dict[str, Any]], today: _dt.date, target_dte: int = _NEAR_TERM_DTE) -> dict[str, Any]:
    """25-delta skew: put IV minus call IV (vol points) at the ~30-day expiry.

    Positive = downside protection costs more than upside (the normal state for
    equities; an unusually HIGH reading means fear is already paid for, which
    makes long puts expensive and put-spreads/covered downside better value).
    """
    expiry = _nearest_expiry(contracts, today, target_dte)
    if not expiry:
        return {"skew_25d": None, "skew_expiry": None}
    pool = [c for c in contracts if c["expiry"] == expiry and c["iv"] and c["delta"] is not None
            and c["oi"] >= _MIN_OI_FOR_SKEW]
    puts = [c for c in pool if c["right"] == "P" and c["delta"] < 0]
    calls = [c for c in pool if c["right"] == "C" and c["delta"] > 0]
    if not puts or not calls:
        return {"skew_25d": None, "skew_expiry": None}
    put = min(puts, key=lambda c: abs(abs(c["delta"]) - 0.25))
    call = min(calls, key=lambda c: abs(c["delta"] - 0.25))
    return {
        "skew_25d": round((put["iv"] - call["iv"]) * 100.0, 4),
        "skew_expiry": expiry,
    }


def _unusual(contracts: list[dict[str, Any]], today: _dt.date, spot: float) -> list[dict[str, Any]]:
    """Top contracts whose volume dwarfs open interest — today's new positioning."""
    hits = []
    for c in contracts:
        if c["volume"] < _UNUSUAL_MIN_VOLUME or _dte(c["expiry"], today) < 0:
            continue
        if c["oi"] > 0 and c["volume"] / c["oi"] < _UNUSUAL_VOL_OI_RATIO:
            continue
        if c["delta"] is None or abs(c["delta"]) > _UNUSUAL_MAX_ABS_DELTA:
            continue
        price = c["mid"] if c["mid"] is not None else c["last"]
        hits.append({
            "right": c["right"], "strike": round(c["strike"], 4), "expiry": c["expiry"],
            "dte": _dte(c["expiry"], today),
            "volume": int(c["volume"]), "oi": int(c["oi"]),
            "vol_oi": round(c["volume"] / c["oi"], 2) if c["oi"] > 0 else None,
            "iv": round(c["iv"] * 100.0, 2) if c["iv"] else None,
            "delta": round(c["delta"], 4) if c["delta"] is not None else None,
            "premium": round((price or 0.0) * c["volume"] * 100.0, 2),
            "otm_pct": round((c["strike"] - spot) / spot * 100.0, 2) if spot > 0 else None,
        })
    hits.sort(key=lambda h: h["premium"], reverse=True)
    return hits[:_UNUSUAL_TOP_N]


# The tradeable shortlist. A delta ladder per side per expiry: ~0.60 (in-the-money,
# behaves most like stock), 0.50 (at-the-money), 0.40/0.30 (the usual directional
# buys), 0.20 (lottery). Storing a LADDER rather than one "pick" is what lets the
# frontend price vertical spreads — a spread needs a long and a short leg from the
# same expiry — and lets the ranking be retuned without a re-ingest.
_CANDIDATE_TARGET_DELTAS = (0.60, 0.50, 0.40, 0.30, 0.20)
_CANDIDATE_DTE_TARGETS = (30, 60)
# Liquidity floors. A contract with no bid cannot be exited at any price, and thin
# open interest means the quoted mid is fiction — both are how a "cheap" option
# turns out to cost far more than the screen said.
_CANDIDATE_MIN_OI = 25
_CANDIDATE_MIN_ABS_DELTA = 0.10
_CANDIDATE_MAX_ABS_DELTA = 0.75


def _candidates(contracts: list[dict[str, Any]], today: _dt.date) -> list[dict[str, Any]]:
    """A liquid delta-ladder of actually-tradeable contracts, both sides, two expiries.

    Raw per-contract economics only (quote, greeks, liquidity) — breakeven, cost per
    delta, spread cost and the value ranking are derived in the frontend so they stay
    retunable (lib/domain/options.ts).
    """
    expiries: list[str] = []
    for target in _CANDIDATE_DTE_TARGETS:
        e = _nearest_expiry(contracts, today, target)
        if e and e not in expiries:
            expiries.append(e)

    out: list[dict[str, Any]] = []
    for expiry in expiries:
        for right in ("C", "P"):
            pool = [
                c for c in contracts
                if c["expiry"] == expiry and c["right"] == right
                and c["mid"] and c["mid"] > 0 and (c["bid"] or 0) > 0
                and c["delta"] is not None and c["oi"] >= _CANDIDATE_MIN_OI
                and _CANDIDATE_MIN_ABS_DELTA <= abs(c["delta"]) <= _CANDIDATE_MAX_ABS_DELTA
            ]
            if not pool:
                continue
            # Nearest contract to each target delta; dedupe by strike, since a thin
            # chain can resolve several targets to the same contract.
            picked: dict[float, dict[str, Any]] = {}
            for target in _CANDIDATE_TARGET_DELTAS:
                best = min(pool, key=lambda c: abs(abs(c["delta"]) - target))
                picked[best["strike"]] = best
            for c in sorted(picked.values(), key=lambda c: c["strike"]):
                out.append({
                    "right": right, "strike": round(c["strike"], 4),
                    "expiry": expiry, "dte": _dte(expiry, today),
                    "bid": c["bid"], "ask": c["ask"], "mid": round(c["mid"], 4),
                    "iv": round(c["iv"] * 100.0, 2) if c["iv"] else None,
                    "delta": round(c["delta"], 4),
                    "theta": round(c["theta"], 4) if c["theta"] is not None else None,
                    "vega": round(c["vega"], 4) if c["vega"] is not None else None,
                    "oi": int(c["oi"]), "volume": int(c["volume"]),
                })
    return out


def _realized_vol(closes: list[float], window: int = 30) -> float | None:
    """Annualized 30-session realized volatility (%), the yardstick for IV30."""
    if len(closes) < window + 1:
        return None
    rets = [math.log(closes[i] / closes[i - 1])
            for i in range(len(closes) - window, len(closes))
            if closes[i] > 0 and closes[i - 1] > 0]
    if len(rets) < window // 2:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return round(math.sqrt(var) * math.sqrt(252) * 100.0, 4)


def _iv_rank(history: list[float], iv30: float) -> dict[str, Any]:
    """Percentile of today's IV30 within our stored trailing history.

    True IV rank needs a year of observations; the table accumulates one per
    company per day, so this is NULL until `_IV_RANK_MIN_OBS` snapshots exist.
    Until then `iv_rv_ratio` (IV vs realized vol) carries the cheap/rich read,
    because that one works from day one off `daily_prices`.
    """
    if len(history) < _IV_RANK_MIN_OBS:
        return {"iv_rank": None, "iv_rank_obs": len(history)}
    below = sum(1 for h in history if h <= iv30)
    return {"iv_rank": round(below / len(history) * 100.0, 2), "iv_rank_obs": len(history)}


# ─── Entry point ────────────────────────────────────────────────────────────────

def build_snapshot(payload: dict[str, Any], closes: list[float],
                   iv_history: list[float], today: _dt.date) -> dict[str, Any] | None:
    """Turn one CBOE chain payload into an `options_snapshots` row (pure).

    Split out from `ingest_options` so the math is testable without network or
    database access.
    """
    data = payload.get("data") or {}
    spot = _num(data.get("current_price")) or _num(data.get("close"))
    contracts = _contracts(payload)
    if not spot or spot <= 0 or not contracts:
        return None

    # CBOE reports iv30 as a percentage (e.g. 28.4), not a decimal.
    iv30 = _num(data.get("iv30"))
    rv30 = _realized_vol(closes)

    row: dict[str, Any] = {
        "snapshot_date": today.isoformat(),
        "spot": round(spot, 4),
        "price_change_pct": _num(data.get("price_change_percent")),
        "iv30": iv30,
        "iv30_change_pct": _num(data.get("iv30_change_percent")),
        "rv30": rv30,
        "iv_rv_ratio": round(iv30 / rv30, 4) if iv30 and rv30 and rv30 > 0 else None,
    }
    row.update(_iv_rank(iv_history, iv30) if iv30 else {"iv_rank": None, "iv_rank_obs": len(iv_history)})
    row.update(_flow(contracts))
    row.update(_skew(contracts, today))

    # Two horizons: the front expiry (pin risk / what's priced into the next few
    # sessions) and the ~30-day expiry a directional trade is actually sized to.
    front = _front_expiry(contracts, today)
    row["front_expiry"] = front
    row["front_dte"] = _dte(front, today) if front else None
    if front:
        row.update(_expected_move(contracts, front, spot))
        row.update(_max_pain(contracts, front, spot))
    else:
        row.update({"atm_straddle": None, "expected_move_pct": None,
                    "max_pain": None, "max_pain_pct": None})

    near = _nearest_expiry(contracts, today, _NEAR_TERM_DTE)
    row["near_expiry"] = near
    row["near_dte"] = _dte(near, today) if near else None
    row["near_move_pct"] = _expected_move(contracts, near, spot)["expected_move_pct"] if near else None

    row["unusual"] = _unusual(contracts, today, spot)
    row["candidates"] = _candidates(contracts, today)
    return row


def ingest_options(cik: str, ticker: str) -> int:
    """Snapshot one company's options chain into `options_snapshots`. Never raises."""
    if not ticker:
        return 0
    payload = _fetch_json(_CHAIN_URL.format(symbol=_cboe_symbol(ticker)), ticker)
    if not payload:
        return 0

    today = _dt.datetime.now(_dt.timezone.utc).date()
    closes = db.fetch_recent_closes(cik, 60)
    iv_history = db.fetch_iv_history(cik, _IV_RANK_DAYS)
    row = build_snapshot(payload, closes, iv_history, today)
    if not row:
        logger.info("  %s options: chain empty or unpriced, skip", ticker)
        return 0

    vix, vix_change = _vix()
    row.update({"cik": cik, "ticker": ticker, "vix": vix, "vix_change_pct": vix_change,
                "updated_at": _dt.datetime.now(_dt.timezone.utc).isoformat()})
    written = db.upsert_options_snapshots([row])
    logger.info(
        "  %s options: spot %.2f · IV30 %s · P/C vol %s · exp move %s%% · %d contracts",
        ticker, row["spot"], row.get("iv30"), row.get("pc_volume_ratio"),
        row.get("expected_move_pct"), row.get("contracts_count") or 0,
    )
    return written
