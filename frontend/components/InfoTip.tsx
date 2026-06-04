"use client";
// Lightweight, dependency-free definition tooltips. CSS-driven popover shown on
// hover and keyboard focus (so it is accessible and static-export safe).
//
//   <InfoTip def="…" />            → a small ⓘ icon that reveals the definition
//   <Term def="…">Gross Margin</Term> → text with a dotted underline + the same popover
//
// `def` may be passed directly, or omitted with `term` to look the text up in the
// shared GLOSSARY.

import { defOf } from "../lib/glossary";

function resolve(def?: string, term?: string): string | undefined {
  if (def) return def;
  if (term) return defOf(term);
  return undefined;
}

export function InfoTip({ def, term }: { def?: string; term?: string }) {
  const text = resolve(def, term);
  if (!text) return null;
  return (
    <span className="infotip" tabIndex={0} role="note" aria-label={text}>
      <span className="infotip-icon" aria-hidden>ⓘ</span>
      <span className="infotip-pop" role="tooltip">{text}</span>
    </span>
  );
}

export function Term({
  children, def, term,
}: { children: React.ReactNode; def?: string; term?: string }) {
  const text = resolve(def, term ?? (typeof children === "string" ? children : undefined));
  if (!text) return <>{children}</>;
  return (
    <span className="infotip term" tabIndex={0} role="note" aria-label={text}>
      <span className="term-label">{children}</span>
      <span className="infotip-pop" role="tooltip">{text}</span>
    </span>
  );
}
