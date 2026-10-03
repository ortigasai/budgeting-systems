import type { CSSProperties } from "react";
import type { SortDir } from "../lib/useTableSort";

// A table header cell that toggles sorting when clicked. Shows ▲/▼ for the
// active column so it's clear which one the rows follow.
export function SortableHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onToggle,
  align = "left",
  className = "",
  rowSpan,
  style,
}: {
  label: string;
  sortKey: string;
  activeKey: string | null;
  dir: SortDir;
  onToggle: (key: string) => void;
  align?: "left" | "right" | "center";
  className?: string;
  rowSpan?: number;
  style?: CSSProperties;
}) {
  const active = activeKey === sortKey;
  const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th rowSpan={rowSpan} style={style} className={`${alignClass} ${className}`}>
      <button type="button" onClick={() => onToggle(sortKey)} className="inline-flex items-center gap-1 font-semibold hover:underline">
        {label}
        <span aria-hidden className={`text-[10px] ${active ? "opacity-100" : "opacity-30"}`}>
          {active ? (dir === "asc" ? "▲" : "▼") : "▲"}
        </span>
      </button>
    </th>
  );
}

// Single text box above a table that narrows its rows by any matching text.
export function TableFilter({ value, onChange, placeholder = "Filter rows…", count, total }: { value: string; onChange: (v: string) => void; placeholder?: string; count: number; total: number }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-64 rounded border border-slate-300 px-2 py-1"
      />
      {value && (
        <button type="button" onClick={() => onChange("")} className="text-emerald-700 hover:underline">
          Clear
        </button>
      )}
      <span className="text-slate-500">
        Showing {count} of {total}
      </span>
    </div>
  );
}
