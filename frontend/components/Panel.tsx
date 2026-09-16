// Panel — the dashboard card chrome: a header row (title, optional count pill,
// optional subtitle, right-aligned actions) over a body. Pure presentational;
// views compose their own content inside it.
import type { ReactNode } from "react";

export function Panel({
  title, count, sub, actions, children, className, flush = false,
}: {
  title: ReactNode;
  count?: number | string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Body has no padding (for tables / lists that draw their own rows). */
  flush?: boolean;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
      <header className="panel-head">
        <div className="panel-head-main">
          <h2 className="panel-title">
            {title}
            {count != null && <span className="panel-count">{count}</span>}
          </h2>
          {sub && <div className="panel-sub">{sub}</div>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className={`panel-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

/** Small text-link button used in panel headers ("View all →"). */
export function PanelLink({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return <button className="panel-link" onClick={onClick} title={title}>{children}</button>;
}
