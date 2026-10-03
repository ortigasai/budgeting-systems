import { createContext, useContext, useState, type ReactNode } from "react";

// Note 12 revision - "All tables and charts should be able to be viewed
// into a bigger pop-up window." Wraps a chart/table with an "Expand" button
// that swaps its normal inline rendering for a large centered overlay
// showing the exact same content - only one of the two ever renders at a
// time (not both, one hidden), so a wrapped child's own internal state
// (search text, sort order, open/closed rows) doesn't fork into two
// independent copies while expanded.
//
// `inlineExpand` lets a table place the button itself (via <ExpandButton />)
// next to its own content instead of at the section's top-right corner.
type ExpandState = { open: () => void; expanded: boolean };
const ExpandContext = createContext<ExpandState>({ open: () => {}, expanded: false });

export function ExpandButton() {
  const { open, expanded } = useContext(ExpandContext);
  if (expanded) return null;
  return (
    <button
      onClick={open}
      title="View in a bigger window"
      className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-100"
    >
      ⤢ Expand
    </button>
  );
}

export function ExpandableSection({ title, children, className, inlineExpand }: { title?: string; children: ReactNode; className?: string; inlineExpand?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4" onClick={() => setExpanded(false)}>
        {/* w-[97vw] (not max-w-6xl) - the point of "expand" is to use the
            screen's own width instead of being boxed to the same ~1152px
            cap regardless of monitor size, so a wide table gets real room
            on the left/right instead of a narrow column floating in a sea
            of dimmed backdrop. Height stays content-sized (max-h-full, not
            a fixed vh) so a short table/chart doesn't get stretched into a
            mostly-empty box. */}
        <div className="flex max-h-full w-[97vw] flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <div className="text-sm font-semibold text-slate-700">{title ?? "Expanded view"}</div>
            <button onClick={() => setExpanded(false)} className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100">
              Close ✕
            </button>
          </div>
          <div className="overflow-auto p-4">
            <ExpandContext.Provider value={{ open: () => {}, expanded: true }}>{children}</ExpandContext.Provider>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {!inlineExpand && (
        <div className="mb-1 flex justify-end">
          <ExpandButton />
        </div>
      )}
      <ExpandContext.Provider value={{ open: () => setExpanded(true), expanded: false }}>{children}</ExpandContext.Provider>
    </div>
  );
}
