"use client";
// Generic sortable/filterable table — the 13f.info workhorse. Every dataset
// renders through this: pass columns, an accessor + formatter per column, and
// an optional row-click. Sorting and filtering run entirely client-side.
//
// Interaction details: headers are real buttons (keyboard-sortable, aria-sort);
// the first click on a text column sorts A→Z and on a numeric column high→low —
// the direction people expect for each; clickable rows are focusable and open on
// Enter/Space; the filter shows "n of m" so a narrowed list is never mistaken for
// the whole set.
import { useMemo, useState, type ReactNode } from "react";

import { SearchField } from "./SearchField";

export type Column<T> = {
  key: string;
  header: string;
  /** Raw value used for sorting/filtering. */
  value: (row: T) => string | number | null;
  /** Rendered cell (defaults to the raw value). */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
  width?: string;
  /** Extra class on the column's th + td (e.g. "col-opt" — a view can hide it on narrow layouts). */
  className?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Hover / focus intent on a row (e.g. to open a peek card beside it). */
  onRowEnter?: (row: T, el: HTMLElement, immediate: boolean) => void;
  onRowLeave?: () => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  filterable?: boolean;
  filterPlaceholder?: string;
  empty?: ReactNode;
  maxHeight?: string;
  /** No outer border/shadow — for nesting inside a Panel. */
  flush?: boolean;
  /** Tighter row padding. */
  dense?: boolean;
};

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, onRowEnter, onRowLeave, initialSort, filterable,
  filterPlaceholder = "Filter…", empty = "No data.", maxHeight, flush = false, dense = false,
}: Props<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) =>
      columns.some((c) => String(c.value(r) ?? "").toLowerCase().includes(needle)),
    );
  }, [rows, q, columns]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sort, columns]);

  // Numeric columns start high→low, text columns A→Z; a second click flips.
  function toggleSort(col: Column<T>) {
    setSort((s) => {
      if (s?.key === col.key) return { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" };
      const sample = rows.find((r) => col.value(r) != null);
      const numeric = sample != null && typeof col.value(sample) === "number";
      return { key: col.key, dir: numeric ? "desc" : "asc" };
    });
  }

  const narrowed = q.trim() !== "";

  return (
    <div className={`dt-wrap${flush ? " flush" : ""}${dense ? " dense" : ""}`}>
      {filterable && (
        <div className="dt-filter-row">
          <SearchField value={q} onChange={setQ} placeholder={filterPlaceholder} />
          {narrowed && (
            <span className="dt-filter-count">
              {filtered.length.toLocaleString()} of {rows.length.toLocaleString()}
            </span>
          )}
        </div>
      )}
      <div className="dt-scroll" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        <table className="dt">
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.className}
                    aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                    style={{ textAlign: c.align ?? "left", width: c.width }}
                  >
                    <button
                      type="button"
                      className={`dt-sort${active ? " active" : ""}`}
                      onClick={() => toggleSort(c)}
                      title={c.header ? `Sort by ${c.header}` : undefined}
                      tabIndex={c.header ? 0 : -1}
                    >
                      {c.header}
                      {c.header && (
                        <span className="dt-arrow" aria-hidden>
                          {active ? (sort!.dir === "asc" ? "▲" : "▼") : "▾"}
                        </span>
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td className="dt-empty" colSpan={columns.length}>
                  {narrowed ? <>No rows match “{q.trim()}”.</> : empty}
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.target !== e.currentTarget) return;   // let inner buttons/links handle their own keys
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r); }
                  } : undefined}
                  onMouseEnter={onRowEnter ? (e) => onRowEnter(r, e.currentTarget, false) : undefined}
                  onMouseLeave={onRowLeave}
                  onFocus={onRowEnter ? (e) => { if (e.target === e.currentTarget) onRowEnter(r, e.currentTarget, true); } : undefined}
                  onBlur={onRowLeave ? (e) => { if (e.target === e.currentTarget) onRowLeave(); } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={onRowClick ? "dt-clickable" : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.className} style={{ textAlign: c.align ?? "left" }}>
                      {c.render ? c.render(r) : String(c.value(r) ?? "—")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
