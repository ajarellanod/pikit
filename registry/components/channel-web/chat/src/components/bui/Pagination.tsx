/* ---------------------------------------------------------
 * PAGINATION
 * Compact: "Previous", the pages' numbers, "Next". The
 * current page outlined, the others quiet; past seven
 * pages, the first, the last and the current one's
 * neighbours, an ellipsis for the rest. Pages count from 1.
 * Which page shows is the caller's.
 * --------------------------------------------------------- */

/** The slots of a pagination of `pages` at `page`: page numbers, and `"gap"` for an ellipsis. At most seven. */
export function pageItems(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: Math.max(pages, 0) }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "gap", pages];
  if (page >= pages - 3) return [1, "gap", pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, "gap", page - 1, page, page + 1, "gap", pages];
}

function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={back ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

export default function Pagination({ page, pages, onChange, label = "Pages", className = "" }: { page: number; pages: number; onChange: (page: number) => void; label?: string; className?: string }) {
  if (pages <= 1) return null;
  const go = (to: number) => to !== page && to >= 1 && to <= pages && onChange(to);
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex items-center gap-1">
        <li>
          <button type="button" className="btn btn-ghost px-2.5 max-sm:w-(--control-h) max-sm:px-0" disabled={page <= 1} onClick={() => go(page - 1)} aria-label="Go to the previous page">
            <Chevron back />
            <span className="max-sm:hidden">Previous</span>
          </button>
        </li>
        {pageItems(page, pages).map((item, at) =>
          item === "gap" ? (
            <li key={at === 1 ? "gap-start" : "gap-end"} className="flex w-7 justify-center text-ink-3" aria-hidden>
              …
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                className={`btn min-w-(--control-h) px-2 tabular-nums ${item === page ? "btn-outline" : "btn-ghost text-ink-2 hover:text-ink"}`}
                aria-current={item === page ? "page" : undefined}
                aria-label={`Page ${item}`}
                onClick={() => go(item)}
              >
                {item}
              </button>
            </li>
          ),
        )}
        <li>
          <button type="button" className="btn btn-ghost px-2.5 max-sm:w-(--control-h) max-sm:px-0" disabled={page >= pages} onClick={() => go(page + 1)} aria-label="Go to the next page">
            <span className="max-sm:hidden">Next</span>
            <Chevron />
          </button>
        </li>
      </ul>
    </nav>
  );
}
