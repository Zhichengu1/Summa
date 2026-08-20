"""Curated theme taxonomy — the deterministic vocabulary behind Phase 2.

This is the ONLY place a raw phrase becomes a canonical theme. No model is
involved: each theme is a hand-written key with a label, a category, and a list
of surface patterns that identify it in filing prose. `match_themes()` runs the
patterns over a block of text and returns per-theme hit counts.

Design rules for the pattern lists (they are why this stays honest):
  • Multi-word phrases wherever a single word is ambiguous. "cloud" alone
    matches weather and boilerplate; "cloud infrastructure" does not.
  • Short/ambiguous acronyms are anchored to uppercase-with-boundaries via an
    explicit `\\b` regex, never a naive substring — "AI" must not match "said".
  • A pattern earns its place only if a false positive would be rare in a 10-K.
    Breadth (how many companies say it) is the headline metric, so a sloppy
    pattern inflates the trend directly.
  • Extend the taxonomy when a genuinely new theme appears; do not widen an
    existing theme's patterns to swallow it — that silently rewrites history.

stdlib only, so the edgar-free tools (requirements-news.txt) can import it.
"""

import re
from typing import NamedTuple


class Theme(NamedTuple):
    """One canonical theme: its stable key, display label, category, patterns."""

    key: str
    label: str
    category: str
    patterns: tuple[str, ...]


# Categories group themes on the Trends view. Order is display order.
CATEGORIES: tuple[tuple[str, str], ...] = (
    ("ai", "AI & Compute"),
    ("cloud", "Cloud & Software"),
    ("hardware", "Silicon & Hardware"),
    ("energy", "Energy & Climate"),
    ("health", "Health & Bio"),
    ("industrial", "Industrial & Supply Chain"),
    ("consumer", "Consumer & Commerce"),
    ("finance", "Finance & Capital"),
)

# The taxonomy. Keys are permanent — renaming one orphans its stored history.
THEMES: tuple[Theme, ...] = (
    # ── AI & Compute ────────────────────────────────────────────────────────
    Theme("generative_ai", "Generative AI", "ai", (
        "generative ai", "generative artificial intelligence", "large language model",
        "foundation model", "llm", "chatbot", "copilot", "prompt engineering",
        "transformer model",
    )),
    Theme("ai_infrastructure", "AI Infrastructure", "ai", (
        "ai infrastructure", "ai data center", "ai datacenter", "gpu cluster",
        "training cluster", "accelerated computing", "ai accelerator",
        "inference capacity", "ai compute", "model training",
    )),
    Theme("machine_learning", "Machine Learning & Automation", "ai", (
        "machine learning", "deep learning", "neural network", "computer vision",
        "natural language processing", "predictive analytics", "intelligent automation",
    )),
    Theme("autonomy", "Autonomy & Robotics", "ai", (
        "autonomous vehicle", "self-driving", "self driving", "robotaxi",
        "driver assistance", "humanoid robot", "robotics", "autonomous system",
        "unmanned",
    )),
    Theme("edge_ai", "Edge & On-Device AI", "ai", (
        "edge computing", "on-device", "on device inference", "edge inference",
        "edge ai",
    )),

    # ── Cloud & Software ────────────────────────────────────────────────────
    Theme("cloud_infrastructure", "Cloud Infrastructure", "cloud", (
        "cloud infrastructure", "public cloud", "hybrid cloud", "multicloud",
        "multi-cloud", "cloud platform", "cloud migration", "infrastructure as a service",
        "platform as a service", "hyperscaler",
    )),
    Theme("saas", "Subscription & SaaS", "cloud", (
        "software as a service", "saas", "subscription revenue", "recurring revenue",
        "annual recurring revenue", "subscription model",
    )),
    Theme("cybersecurity", "Cybersecurity", "cloud", (
        "cybersecurity", "cyber security", "zero trust", "threat detection",
        "endpoint security", "ransomware", "data breach", "identity management",
        "security operations",
    )),
    Theme("data_platform", "Data Platform & Analytics", "cloud", (
        "data platform", "data warehouse", "data lake", "business intelligence",
        "data analytics", "real-time analytics", "data governance",
    )),
    Theme("digital_payments", "Digital Payments", "cloud", (
        "digital payment", "digital wallet", "contactless payment", "payment platform",
        "buy now pay later", "embedded finance", "payment processing",
    )),

    # ── Silicon & Hardware ──────────────────────────────────────────────────
    Theme("semiconductors", "Advanced Semiconductors", "hardware", (
        "semiconductor", "advanced node", "process node", "foundry", "wafer",
        "chip design", "custom silicon", "system on chip", "chiplet",
        "high bandwidth memory",
    )),
    Theme("networking", "High-Speed Networking", "hardware", (
        "high-speed networking", "interconnect", "infiniband", "optical transceiver",
        "network fabric", "400g", "800g", "fiber optic",
    )),
    Theme("quantum", "Quantum Computing", "hardware", (
        "quantum computing", "quantum processor", "qubit", "quantum error correction",
    )),
    Theme("spatial_computing", "AR / VR & Spatial", "hardware", (
        "augmented reality", "virtual reality", "mixed reality", "spatial computing",
        "metaverse", "smart glasses", "headset",
    )),
    Theme("space", "Space & Satellite", "hardware", (
        "satellite constellation", "low earth orbit", "launch vehicle", "spacecraft",
        "space-based", "satellite broadband",
    )),

    # ── Energy & Climate ────────────────────────────────────────────────────
    Theme("electrification", "Electrification & EVs", "energy", (
        "electric vehicle", "battery electric", "charging network", "charging infrastructure",
        "electrification", "powertrain electrification",
    )),
    Theme("battery", "Battery & Storage", "energy", (
        "battery cell", "energy storage", "grid-scale storage", "lithium-ion",
        "battery manufacturing", "gigafactory", "solid-state battery",
    )),
    Theme("renewables", "Renewables", "energy", (
        "renewable energy", "solar power", "wind power", "offshore wind",
        "photovoltaic", "clean energy", "power purchase agreement",
    )),
    Theme("nuclear", "Nuclear & Next-Gen Power", "energy", (
        "nuclear power", "small modular reactor", "smr", "nuclear energy",
        "fusion energy", "geothermal",
    )),
    Theme("hydrogen_ccs", "Hydrogen & Carbon Capture", "energy", (
        "green hydrogen", "hydrogen fuel", "carbon capture", "carbon sequestration",
        "decarbonization", "net zero", "net-zero", "emissions reduction",
    )),
    Theme("grid", "Grid & Power Demand", "energy", (
        "grid capacity", "power demand", "transmission infrastructure", "utility scale",
        "load growth", "interconnection queue",
    )),

    # ── Health & Bio ────────────────────────────────────────────────────────
    Theme("glp1", "GLP-1 & Metabolic", "health", (
        "glp-1", "glp 1", "obesity treatment", "weight loss drug", "incretin",
        "metabolic disease",
    )),
    Theme("cell_gene", "Cell & Gene Therapy", "health", (
        "gene therapy", "cell therapy", "car-t", "gene editing", "crispr",
        "mrna", "messenger rna",
    )),
    Theme("oncology", "Oncology Pipeline", "health", (
        "oncology", "immuno-oncology", "antibody-drug conjugate", "checkpoint inhibitor",
        "tumor", "solid tumor",
    )),
    Theme("digital_health", "Digital Health", "health", (
        "telehealth", "digital health", "remote patient monitoring", "virtual care",
        "health data platform",
    )),
    Theme("ai_drug_discovery", "AI in Drug Discovery", "health", (
        "ai-driven drug discovery", "computational drug discovery", "in silico",
        "machine learning drug",
    )),

    # ── Industrial & Supply Chain ───────────────────────────────────────────
    Theme("onshoring", "Onshoring & Domestic Capacity", "industrial", (
        "onshoring", "reshoring", "nearshoring", "domestic manufacturing",
        "domestic capacity", "supply chain resilience", "regionalization",
        "friend-shoring", "friendshoring",
    )),
    Theme("supply_chain", "Supply-Chain Constraint", "industrial", (
        "supply chain disruption", "component shortage", "capacity constraint",
        "logistics cost", "lead time", "inventory correction",
    )),
    Theme("industrial_automation", "Industrial Automation", "industrial", (
        "industrial automation", "factory automation", "warehouse automation",
        "digital twin", "predictive maintenance", "industrial iot",
    )),
    Theme("tariffs", "Tariffs & Trade Policy", "industrial", (
        "tariff", "trade restriction", "export control", "sanctions", "trade policy",
        "customs duty",
    )),
    Theme("critical_minerals", "Critical Minerals", "industrial", (
        "rare earth", "critical mineral", "lithium supply", "cobalt", "copper supply",
        "mineral supply chain",
    )),

    # ── Consumer & Commerce ─────────────────────────────────────────────────
    Theme("retail_media", "Retail Media & Advertising", "consumer", (
        "retail media", "digital advertising", "advertising platform", "ad revenue",
        "programmatic advertising", "first-party data",
    )),
    Theme("streaming", "Streaming & Content", "consumer", (
        "streaming service", "subscription video", "content spend", "ad-supported tier",
        "live sports rights",
    )),
    Theme("ecommerce", "E-commerce & Fulfillment", "consumer", (
        "e-commerce", "ecommerce", "online marketplace", "fulfillment network",
        "last mile", "same-day delivery",
    )),
    Theme("loyalty", "Loyalty & Personalization", "consumer", (
        "loyalty program", "personalization", "customer lifetime value",
        "membership program",
    )),

    # ── Finance & Capital ───────────────────────────────────────────────────
    Theme("digital_assets", "Digital Assets", "finance", (
        "digital asset", "cryptocurrency", "blockchain", "stablecoin", "tokenization",
        "bitcoin",
    )),
    Theme("private_credit", "Private Credit & Alternatives", "finance", (
        "private credit", "private markets", "alternative asset", "direct lending",
        "infrastructure fund",
    )),
    Theme("capital_return", "Capital Return", "finance", (
        "share repurchase", "stock repurchase", "buyback", "dividend increase",
        "return of capital",
    )),
    Theme("restructuring", "Restructuring & Cost Discipline", "finance", (
        "restructuring plan", "cost reduction", "workforce reduction", "headcount reduction",
        "operational efficiency", "margin expansion program",
    )),
)

THEME_BY_KEY: dict[str, Theme] = {t.key: t for t in THEMES}
CATEGORY_LABEL: dict[str, str] = dict(CATEGORIES)

def _compile(pattern: str) -> re.Pattern[str]:
    """Compile one surface pattern into a word-boundary-anchored regex.

    Three properties matter, and all three are why a naive `in text` is wrong:
      • Boundaries — `(?<![\\w-])` stops "ai" matching inside "said" and stops
        a hyphenated compound counting as its own parts.
      • Whitespace tolerance — extracted filing text line-wraps mid-phrase, so a
        literal space matches any run of whitespace.
      • Plurals — filings say "tariffs" and "wafers" far more often than the
        singular, so an optional trailing s/es is part of the match.
    """
    # Escape first: several patterns contain '-' and '.' that must stay literal.
    # re.escape's treatment of a space differs across versions, so strip both forms.
    body = re.escape(pattern).replace(r"\ ", " ").replace(" ", r"\s+")
    return re.compile(rf"(?<![\w-]){body}(?:e?s)?(?![\w-])", re.IGNORECASE)


# Compiled once at import: ~200 small regexes, reused for every filing.
_COMPILED: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = tuple(
    (t.key, tuple(_compile(p) for p in t.patterns)) for t in THEMES
)


def match_themes(text: str, *, min_hits: int = 2) -> dict[str, int]:
    """Count canonical-theme hits in `text`. Returns {theme_key: mention_count}.

    A theme must clear `min_hits` to be recorded at all: one passing mention of
    "blockchain" in a risk-factor list is boilerplate, whereas a theme a company
    is genuinely investing in recurs throughout Business and MD&A. This single
    threshold is what keeps breadth counts meaningful rather than exhaustive.
    """
    if not text:
        return {}
    out: dict[str, int] = {}
    for key, patterns in _COMPILED:
        hits = 0
        for pat in patterns:
            hits += len(pat.findall(text))
        if hits >= min_hits:
            out[key] = hits
    return out


def theme_label(key: str) -> str:
    """Display label for a theme key (falls back to the key itself)."""
    t = THEME_BY_KEY.get(key)
    return t.label if t else key


def theme_category(key: str) -> str:
    """Category key for a theme key (falls back to 'other')."""
    t = THEME_BY_KEY.get(key)
    return t.category if t else "other"
