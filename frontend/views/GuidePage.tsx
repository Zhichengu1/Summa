// Data Guide view — a static reference page that defines every data domain the
// warehouse tracks, ranked by how directly it tends to move the share price.
// Fully self-contained (its own data + types, CSS classes only), so it is the
// reference pattern for extracting a top-level view out of app/page.tsx.

type ImpactTier = "high" | "medium" | "signal";

type DataDef = {
  name: string;
  source: string;        // SEC form / feed the data comes from
  where: string;         // where in this app to find it
  definition: string;    // what the numbers actually are
  why: string;           // why it moves the stock for shareholders
};

const IMPACT_TIERS: { tier: ImpactTier; label: string; blurb: string; items: DataDef[] }[] = [
  {
    tier: "high",
    label: "High impact — direct price drivers",
    blurb: "Disclosures that routinely move a stock the same day they hit the wire. Watch these first.",
    items: [
      {
        name: "Earnings Results & Guidance",
        source: "8-K · Item 2.02",
        where: "Company → Catalysts",
        definition: "Quarterly revenue, diluted EPS, and net income, plus any change to forward guidance (raised / lowered / withdrawn / maintained).",
        why: "A beat or miss versus analyst expectations is the single most common cause of a large one-day move. A guidance change resets the market's whole forward valuation.",
      },
      {
        name: "Material Corporate Events",
        source: "8-K",
        where: "Company → Catalysts",
        definition: "Classified disclosures of mergers & acquisitions, financial restatements, executive departures, capital returns (buybacks / dividends), and cyber incidents.",
        why: "An 8-K exists precisely to flag events a reasonable investor would consider important. M&A and restatements can move a stock 20%+ in a session.",
      },
      {
        name: "Activist & Large-Stake Ownership",
        source: "SC 13D / 13G",
        where: "Company → Ownership",
        definition: "A filing triggered when an investor crosses 5% ownership. 13D signals intent to influence the company (activist); 13G is a passive stake.",
        why: "Activist positions often precede board fights, spin-offs, or buyout pressure. The market reacts to the filer's reputation and the stated purpose of the stake.",
      },
      {
        name: "Insider Transactions",
        source: "Form 4",
        where: "Company → Ownership",
        definition: "Open-market buys and sells by officers and directors, with price, share count, resulting holdings, and whether the trade was under a pre-planned 10b5-1 plan.",
        why: "Cluster buying by insiders is a well-documented bullish signal; large discretionary selling can signal lost confidence in the near-term outlook.",
      },
    ],
  },
  {
    tier: "medium",
    label: "Medium impact — valuation & capital flows",
    blurb: "Sets the fair value of the equity and the supply of shares. Moves the price over quarters more than over hours.",
    items: [
      {
        name: "Fundamentals (Financial Statements)",
        source: "10-K · 10-Q",
        where: "Company → Fundamentals",
        definition: "Income statement, balance sheet, and cash-flow trends — revenue growth, margins, debt levels, and free cash flow over time.",
        why: "These anchor the long-term fair value. Deteriorating margins or rising leverage erode the price gradually even when no single headline lands.",
      },
      {
        name: "Securities Offerings",
        source: "S-1 · S-3 · 424B",
        where: "Company → Catalysts",
        definition: "New issuance of stock or debt and the dollar amount raised.",
        why: "Equity offerings dilute existing shareholders and usually pressure the price short-term. Debt raises change the company's risk profile and interest burden.",
      },
      {
        name: "Institutional Holdings",
        source: "13F-HR",
        where: "Company → Ownership",
        definition: "Quarterly positions of institutional managers (>$100M AUM): shares held, position value, and quarter-over-quarter change.",
        why: "Shows 'smart money' accumulation or distribution — but it is filed up to 45 days after quarter-end, so it confirms a trend rather than predicting one.",
      },
    ],
  },
  {
    tier: "signal",
    label: "Signals & red flags — early-warning context",
    blurb: "Rarely move the price alone, but they front-run the disclosures above. Treat them as leading indicators.",
    items: [
      {
        name: "Late-Filing Notices",
        source: "NT 10-K · NT 10-Q",
        where: "Company → Catalysts",
        definition: "A notification that a required report will be filed late, together with the stated reason.",
        why: "Often the first public sign of accounting problems, internal-control weakness, or distress — frequently a leading indicator of a sharp decline.",
      },
      {
        name: "Proposed Insider Sales",
        source: "Form 144",
        where: "Company → Ownership",
        definition: "An insider's notice of intent to sell restricted stock — proposed share count and approximate value, before any sale executes.",
        why: "Signals selling intent ahead of the executed Form 4. Weaker than an actual transaction, but a useful early warning of insider distribution.",
      },
      {
        name: "Filing Volume & Velocity",
        source: "All forms",
        where: "Overview · Feed",
        definition: "How many filings a company submits and how fast, surfaced as the 30-day count and the filing-volume chart.",
        why: "A sudden burst of 8-Ks or an unusual filing cadence is context, not a verdict — it tells you where to look closer among the higher-impact data.",
      },
    ],
  },
];

function ImpactPill({ tier }: { tier: ImpactTier }) {
  const label = tier === "high" ? "High" : tier === "medium" ? "Medium" : "Signal";
  return <span className={`impact-pill impact-${tier}`}>{label}</span>;
}

export function GuidePage() {
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Data Guide</h1>
        <div className="page-sub">
          What every data point means — and how much it tends to move the share price. Ordered most to least impactful.
        </div>
      </div>

      {IMPACT_TIERS.map((group) => (
        <div className="section" key={group.tier}>
          <div className="guide-tier-head">
            <ImpactPill tier={group.tier} />
            <div>
              <div className={`guide-tier-label tier-${group.tier}`}>{group.label}</div>
              <div className="guide-tier-blurb">{group.blurb}</div>
            </div>
          </div>
          <div className="guide-grid">
            {group.items.map((d) => (
              <div className={`guide-card tier-${group.tier}`} key={d.name}>
                <div className="guide-card-head">
                  <span className="guide-card-name">{d.name}</span>
                  <span className="guide-card-source">{d.source}</span>
                </div>
                <div className="guide-def">{d.definition}</div>
                <div className="guide-why">
                  <span className="guide-why-label">Why it matters</span> {d.why}
                </div>
                <div className="guide-where">Find it in: <span>{d.where}</span></div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
