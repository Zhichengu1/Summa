// Loading-state placeholders. Pure presentational atoms (CSS classes only, no
// data or hooks) shared across the company tabs while their data resolves.
// Extracted from app/page.tsx as the reference pattern for leaf-component splits.

export function SkeletonKpi() {
  return (
    <div className="skeleton-kpi">
      <div className="skeleton" style={{ height: 10, width: "45%" }} />
      <div className="skeleton" style={{ height: 26, width: "65%" }} />
      <div className="skeleton" style={{ height: 10, width: "55%" }} />
    </div>
  );
}

export function SkeletonChart({ height = 220 }: { height?: number }) {
  return (
    <div className="skeleton-chart">
      <div className="skeleton" style={{ height: 10, width: "35%", marginBottom: 14 }} />
      <div className="skeleton" style={{ height }} />
    </div>
  );
}

export function LoadingFundamentals() {
  return (
    <div className="skeleton-block">
      <div className="kpi-strip">
        {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonKpi key={i} />)}
      </div>
      <SkeletonChart height={300} />
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart /><SkeletonChart /><SkeletonChart />
      </div>
    </div>
  );
}

export function LoadingOwnership() {
  return (
    <div className="skeleton-block">
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart />
      </div>
      <SkeletonChart height={180} />
    </div>
  );
}

export function LoadingCatalysts() {
  return (
    <div className="skeleton-block">
      <div className="chart-grid">
        <SkeletonChart /><SkeletonChart />
      </div>
      <SkeletonChart height={160} />
    </div>
  );
}
