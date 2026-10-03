import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableOption {
  value: string;
  label: string;
  sublabel?: string;
}

// Notes item 6: "Allow search in Expense Line Items." A plain <select> can't
// be typed into, and the real catalog is ~230+ rows — this is a small
// typeahead combobox used for the Category/Item/Company pickers.
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Search…",
  disabled,
  hideUntilTyped,
}: {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hideUntilTyped?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q)
    );
  }, [options, query]);

  return (
    <div ref={containerRef} className="relative">
      <input
        className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
        placeholder={placeholder}
        disabled={disabled}
        value={open ? query : (selected?.label ?? "")}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && (!hideUntilTyped || query.trim()) && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">No matches</div>
          ) : (
            filtered.map((o) => (
              <button
                type="button"
                key={o.value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQuery("");
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-emerald-50 ${
                  o.value === value ? "bg-emerald-50 font-medium" : ""
                }`}
              >
                {o.label}
                {o.sublabel && <span className="ml-1 text-xs text-slate-400">{o.sublabel}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
