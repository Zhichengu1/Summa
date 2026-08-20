"""Phase 2 trend aggregation — `theme_mentions` → `theme_trends`.

A GLOBAL pass (once per run, like entity_ingest — never per company). It reads
the per-company theme rows the ingest already persisted and answers the
cross-company question Phase 1 cannot: *what are tracked companies collectively
converging on, and where is the money actually going?*

Two signals, deliberately kept separate because they disagree in useful ways:
  • BREADTH — how many distinct companies talk about a theme in a quarter. Cheap
    to say, so breadth alone is talk.
  • CAPITAL — the R&D + capex attributed to the theme (see theme_ingest for the
    attribution rule). Expensive, so capital is commitment.
A theme rising on breadth with no capital behind it is a narrative; one rising
on both is an actual buildout. `momentum_score` weights breadth velocity,
capital velocity and current adoption; `stage` names where the theme sits.

Everything here is arithmetic over stored rows — no EDGAR, no external API, no
model. The `summary` sentence is a template filled with the computed numbers, so
the same rows always produce the same prose.

Cost: one paged read of a small table plus one small profiles read, then a
wholesale replace of a few hundred aggregate rows. Self-gated to INTERVAL_TRENDS
(default weekly) because trends move slowly and the pipeline ticks every 10
minutes.
"""

import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import db
from ingest.theme_taxonomy import theme_category, theme_label

logger = logging.getLogger(__name__)

# Trends move on a quarterly reporting cycle; recomputing more often than weekly
# just burns reads. Env-tunable like every other cadence in the project.
INTERVAL_TRENDS_H = float(os.environ.get("INTERVAL_TRENDS", "168"))
# Quarters of history to publish. Eight covers a two-year series with a
# year-over-year comparison at every point.
TREND_QUARTERS = int(os.environ.get("TREND_QUARTERS", "8"))
# A quarter needs at least this many reporting companies before its breadth
# numbers mean anything — early/partial quarters are computed but flagged thin.
MIN_COVERAGE = int(os.environ.get("TREND_MIN_COVERAGE", "3"))
# Companies listed as a theme's drivers on the frontend.
_MAX_DRIVERS = 6


# ── period helpers ──────────────────────────────────────────────────────────

def _quarter_label(period: str) -> str:
    """'2026-03-31' → 'Q1 2026'."""
    try:
        d = date.fromisoformat(period)
    except (ValueError, TypeError):
        return period
    return f"Q{(d.month - 1) // 3 + 1} {d.year}"


def _prev_quarter(period: str) -> str:
    """The calendar quarter end immediately before `period`."""
    d = date.fromisoformat(period)
    q = (d.month - 1) // 3          # 0..3
    year, q_prev = (d.year - 1, 3) if q == 0 else (d.year, q - 1)
    month = q_prev * 3 + 3
    return date(year, month, {3: 31, 6: 30, 9: 30, 12: 31}[month]).isoformat()


# ── scoring ─────────────────────────────────────────────────────────────────

def _velocity(now: float, prior: float) -> float:
    """Growth of `now` over `prior`, clamped to [-1, 2] so one tiny base can't
    dominate the ranking (a theme going 1 → 4 companies is +200%, not +∞)."""
    if prior <= 0:
        return 1.0 if now > 0 else 0.0
    return max(-1.0, min(2.0, (now - prior) / prior))


def _norm(v: float) -> float:
    """Map a clamped velocity in [-1, 2] onto [0, 1]."""
    return (v + 1.0) / 3.0


def _momentum(breadth_vel: float, capital_vel: float, adoption: float) -> float:
    """Blend the three signals into a 0–100 score.

    Breadth carries the most weight because it is the thing Phase 2 exists to
    measure (convergence across companies); capital confirms it with real
    dollars; adoption is a small level term so an already-universal theme does
    not outrank a genuinely emerging one on velocity alone.
    """
    score = 100.0 * (0.45 * _norm(breadth_vel) + 0.35 * _norm(capital_vel) + 0.20 * adoption)
    return round(score, 1)


def _stage(adoption: float, breadth_vel: float, capital_vel: float) -> str:
    """Classify a theme's lifecycle position from adoption level + velocity."""
    growing = breadth_vel > 0.15 or capital_vel > 0.25
    shrinking = breadth_vel < -0.1 or (capital_vel < -0.2 and breadth_vel <= 0)
    if shrinking:
        return "cooling"
    if adoption >= 0.5:
        return "accelerating" if growing else "mainstream"
    if growing:
        return "accelerating" if adoption >= 0.25 else "emerging"
    return "emerging" if adoption < 0.25 else "mainstream"


def _fmt_money(v: float) -> str:
    """Compact USD for the templated summary, e.g. '$8.2B'."""
    a = abs(v)
    if a >= 1e9:
        return f"${v / 1e9:.1f}B"
    if a >= 1e6:
        return f"${v / 1e6:.0f}M"
    return f"${v:,.0f}"


def _summary(
    label: str, period: str, company_count: int, coverage: int,
    breadth_delta: int, capital_flow: float, stage: str, sector: str | None,
) -> str:
    """Build the one-sentence read from the computed numbers (template, no model).

    Deterministic by construction: the same aggregate row always yields the same
    sentence, and every clause is dropped when it has nothing to say.
    """
    share = round(100 * company_count / coverage) if coverage else 0
    parts = [
        f"{company_count} of {coverage} reporting compan{'y' if coverage == 1 else 'ies'} "
        f"({share}%) cite {label} in {_quarter_label(period)}"
    ]
    if breadth_delta > 0:
        parts.append(f"up {breadth_delta} from the prior quarter")
    elif breadth_delta < 0:
        parts.append(f"down {abs(breadth_delta)} from the prior quarter")
    if capital_flow > 0:
        parts.append(f"with {_fmt_money(capital_flow)} of attributed R&D and capex behind it")
    tail = f" — {stage}" + (f", led by {sector}" if sector else "") + "."
    return ", ".join(parts) + tail


# ── aggregation ─────────────────────────────────────────────────────────────

def _sector_map() -> dict[str, str]:
    """{cik: sector} from company_profiles, for the sector breakdown."""
    try:
        rows = db._select_all("company_profiles", "cik, sector")
    except Exception:
        logger.exception("sector map unavailable — sector breakdown will be empty")
        return {}
    return {r["cik"]: r["sector"] for r in rows if r.get("sector") and r["sector"] != "—"}


def _recent_periods(mentions: list[dict[str, Any]], quarters: int) -> list[str]:
    """The newest `quarters` calendar quarters present in the mention rows."""
    return sorted({m["period"] for m in mentions if m.get("period")})[-quarters:]


def build_trends(mentions: list[dict[str, Any]], sectors: dict[str, str]) -> list[dict[str, Any]]:
    """Aggregate mention rows into `theme_trends` rows. Pure — no I/O.

    Kept side-effect-free so the scoring can be reasoned about (and exercised)
    without a database; `ingest_trends` does the reading and writing around it.
    """
    periods = _recent_periods(mentions, TREND_QUARTERS + 1)  # +1 = prior-quarter baseline
    if not periods:
        return []
    wanted = set(periods)

    # (period, theme) → per-company aggregates, plus per-period coverage.
    grouped: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
    coverage: dict[str, set[str]] = {}
    for m in mentions:
        period, theme, cik = m.get("period"), m.get("theme_key"), m.get("cik")
        if period not in wanted or not theme or not cik:
            continue
        coverage.setdefault(period, set()).add(cik)
        bucket = grouped.setdefault((period, theme), {})
        entry = bucket.setdefault(cik, {"mentions": 0.0, "capital": 0.0, "ticker": ""})
        entry["mentions"] += float(m.get("mention_count") or 0)
        entry["capital"] += float(m.get("capital_signal") or 0)
        entry["ticker"] = m.get("ticker") or entry["ticker"]

    rows: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc).isoformat()
    # The oldest period only exists as the prior-quarter baseline; don't publish it.
    for period in periods[1:] if len(periods) > 1 else periods:
        prior = _prev_quarter(period)
        cover = len(coverage.get(period, ()))
        for theme in {t for (p, t) in grouped if p == period}:
            companies = grouped[(period, theme)]
            prior_companies = grouped.get((prior, theme), {})

            company_count = len(companies)
            prior_count = len(prior_companies)
            capital_flow = sum(c["capital"] for c in companies.values())
            prior_capital = sum(c["capital"] for c in prior_companies.values())

            adoption = company_count / cover if cover else 0.0
            breadth_vel = _velocity(company_count, prior_count)
            capital_vel = _velocity(capital_flow, prior_capital)
            stage = _stage(adoption, breadth_vel, capital_vel)

            # Sector split of the attributed capital; the leading sector labels
            # the theme, the full map drives the allocation chart.
            sector_flow: dict[str, float] = {}
            for cik, c in companies.items():
                sec = sectors.get(cik)
                if sec and c["capital"]:
                    sector_flow[sec] = round(sector_flow.get(sec, 0.0) + c["capital"], 2)
            # Name-ordered tie-break, so an even split labels the theme the same
            # way on every recompute instead of following dict iteration order.
            lead_sector = min(sector_flow, key=lambda s: (-sector_flow[s], s)) if sector_flow else None

            drivers = sorted(
                (
                    {"cik": cik, "ticker": str(c.get("ticker") or ""),
                     "mentions": int(c["mentions"]), "capital": round(c["capital"], 2)}
                    for cik, c in companies.items()
                ),
                key=lambda d: (-d["capital"], -d["mentions"], d["ticker"]),
            )[:_MAX_DRIVERS]

            label = theme_label(theme)
            rows.append({
                "theme_key": theme,
                "period": period,
                "label": label,
                "category": theme_category(theme),
                "company_count": company_count,
                "coverage": cover,
                "mention_total": int(sum(c["mentions"] for c in companies.values())),
                "breadth_delta": company_count - prior_count,
                "breadth_growth": round(100 * breadth_vel, 1),
                "capital_flow": round(capital_flow, 2),
                "capital_growth": round(100 * capital_vel, 1) if prior_capital > 0 else None,
                "momentum_score": _momentum(breadth_vel, capital_vel, adoption),
                "stage": stage,
                "sector": lead_sector,
                "sector_flow": sector_flow or None,
                "drivers": drivers,
                "thin": cover < MIN_COVERAGE,
                "summary": _summary(label, period, company_count, cover,
                                    company_count - prior_count, capital_flow,
                                    stage, lead_sector),
                "updated_at": now,
            })
    return rows


def _is_due() -> bool:
    """True when the aggregate is missing or older than INTERVAL_TRENDS hours."""
    last = db.latest_theme_trends_at()
    if not last:
        return True
    try:
        stamp = datetime.fromisoformat(last.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return True
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - stamp >= timedelta(hours=INTERVAL_TRENDS_H)


def ingest_trends() -> None:
    """Recompute `theme_trends` from stored mentions (global, weekly-gated)."""
    if not _is_due():
        logger.info("Trends: aggregate is fresh (< %.0fh) — skipping", INTERVAL_TRENDS_H)
        return

    mentions = db.fetch_theme_mentions()
    if not mentions:
        logger.info("Trends: no theme_mentions yet — nothing to aggregate")
        return

    rows = build_trends(mentions, _sector_map())
    if not rows:
        logger.info("Trends: %d mentions produced no publishable quarters", len(mentions))
        return

    written = db.replace_theme_trends(rows)
    latest = max(r["period"] for r in rows)
    top = sorted(
        (r for r in rows if r["period"] == latest),
        key=lambda r: -r["momentum_score"],
    )[:3]
    logger.info(
        "Trends: %d rows across %d quarters (latest %s) — top: %s",
        written, len({r["period"] for r in rows}), _quarter_label(latest),
        ", ".join(f"{r['label']} {r['momentum_score']:.0f}" for r in top) or "—",
    )
