/* ---------------------------------------------------------
 * FILTER TABLE
 * Beautiful UI's filter chips, fed by the app: chips with a
 * dot and a count that pick what a table shows. A state in a
 * cell is a `StatusDot`, the same dot beside its label.
 * --------------------------------------------------------- */

export type PillTone = "green" | "orange" | "blue" | "red" | "neutral";

/** The dot of each tone, as the chips show it. */
export const TONE_DOT: Record<PillTone, string> = {
  green: "var(--green)",
  orange: "var(--orange)",
  blue: "var(--accent-blue)",
  red: "var(--red)",
  neutral: "var(--ink-3)",
};

export type Filter<K extends string> = { key: K; label: string; count?: number; tone?: PillTone };

/** Chips that pick one of `filters`; each with its dot (a tone) and its count. */
export function FilterChips<K extends string>({ filters, value, onChange, label }: { filters: Filter<K>[]; value: K; onChange: (key: K) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 py-1" style={{ scrollbarWidth: "none" }}>
      {filters.map((filter) => {
        const active = value === filter.key;
        return (
          <button
            key={filter.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter.key)}
            className={`flex h-6.5 shrink-0 items-center gap-1.5 rounded-chip px-2.5 text-[12px] font-medium transition-[background-color,box-shadow,color] duration-200 ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`}
          >
            {filter.tone !== undefined && <span className="size-1.5 rounded-full" style={{ background: TONE_DOT[filter.tone] }} />}
            {filter.label}
            {filter.count !== undefined && <span className={`rounded-[4px] px-1 text-[10.5px] tabular-nums ${active ? "bg-field text-ink-2" : "text-ink-3"}`}>{filter.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
