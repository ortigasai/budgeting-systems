import type { ReactNode } from "react";

export function TabBar<T extends string>({ tabs, active, onChange }: { tabs: readonly { id: T; label: string }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${active === t.id ? "bg-emerald-800 text-white shadow-sm" :"text-slate-600 hover:bg-white hover:text-emerald-800"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-xs font-semibold tracking-wide text-emerald-800">{children}</div>;
}
