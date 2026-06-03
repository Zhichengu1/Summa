"use client";
// Generic sortable/filterable table — the 13f.info workhorse. Every dataset
// renders through this: pass columns, an accessor + formatter per column, and
// an optional row-click. Sorting and filtering run entirely client-side.
import { useMemo, useState, type ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  /** Raw value used for sorting/filtering. */
  value: (row: T) => string | number | null;
  /** Rendered cell (defaults to the raw value). */
  render?: (row: T) => ReactNode;
  align?: "left" | "right";
  width?: string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  filterable?: boolean;
  filterPlaceholder?: string;
  empty?: ReactNode;
  maxHeight?: string;
};

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, initialSort, filterable,
  filterPlaceholder = "Filter…", empty = "No data.", maxHeight,
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

  function toggleSort(key: string) {
    setSort((s) =>
      s?.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }

  return (
    <div className="dt-wrap">
      {filterable && (
        <input
          className="dt-filter"
          placeholder={filterPlaceholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div className="dt-scroll" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
        <table className="dt">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  style={{ textAlign: c.align ?? "left", width: c.width, cursor: "pointer" }}
                >
                  {c.header}
                  <span className="dt-arrow">
                    {sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td className="dt-empty" colSpan={columns.length}>{empty}</td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={onRowClick ? "dt-clickable" : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
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
