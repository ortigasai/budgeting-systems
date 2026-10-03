import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

// Sorts rows by one column at a time. Click a header once for ascending,
// again for descending, a third time to clear back to the original order.
// Numbers sort numerically; everything else sorts case-insensitively, and
// blanks always go last.
export function useTableSort<T>(rows: T[], getValue: (row: T, key: string) => string | number | null | undefined) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const aBlank = av === null || av === undefined || av === "";
      const bBlank = bv === null || bv === undefined || bv === "";
      if (aBlank && bBlank) return 0;
      if (aBlank) return 1;
      if (bBlank) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }, [rows, sortKey, sortDir, getValue]);

  function toggle(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
    }
  }

  return { sorted, sortKey, sortDir, toggle };
}
