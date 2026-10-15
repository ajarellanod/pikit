import { Check, NavArrowDown, Search } from "iconoir-react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ---------------------------------------------------------
 * COMBOBOX
 * A select of our own: a trigger like a field (`.control`),
 * and a list over everything with the chosen option checked,
 * a search at its top when there are many, descriptions and
 * group headings. Keyboard: arrows, Home/End, Enter, Escape,
 * type-ahead. The list goes into the dialog the trigger is in
 * (Radix's, or a <dialog>), so focus and clicks stay inside.
 * --------------------------------------------------------- */

export interface ComboboxOption {
  value: string;
  label: string;
  /** a line under the label */
  description?: string;
  /** the heading it is listed under; options of a group stay together, in their order */
  group?: string;
  disabled?: boolean;
}

/** More options than this: a search at the top of the list (`search` decides otherwise). */
const SEARCH_FROM = 7;
const GAP = 4;
const MARGIN = 8;
const MAX_HEIGHT = 320;

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (option: ComboboxOption, query: string) => {
  const text = `${option.label} ${option.description ?? ""}`.toLowerCase();
  return words(query).every((word) => text.includes(word));
};

type Place = { top: number; left: number; width: number; maxHeight: number; above: boolean };

export function Combobox({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose",
  disabled = false,
  id,
  className = "",
  search,
  searchPlaceholder = "Search",
  empty = "Nothing matches",
}: {
  value: string;
  options: readonly ComboboxOption[];
  onChange: (value: string) => void;
  /** its accessible name */
  label: string;
  /** shown when no option has `value` */
  placeholder?: string;
  disabled?: boolean;
  /** the trigger's id (a `<label htmlFor>`) */
  id?: string;
  /** the trigger's classes (its width) */
  className?: string;
  /** a search at the top of the list; by default when there are more than six options */
  search?: boolean;
  searchPlaceholder?: string;
  /** said when the search matches nothing */
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  const [place, setPlace] = useState<Place>();
  const [host, setHost] = useState<Element>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const origin = useRef({ top: 0, left: 0 });
  const listId = useId();
  const searching = search ?? options.length >= SEARCH_FROM;

  const chosen = options.find((option) => option.value === value);
  const shown = useMemo(() => (searching && query.trim() !== "" ? options.filter((option) => matches(option, query)) : [...options]), [options, query, searching]);
  // Grouped in the order each group first appears; options without a group first.
  const groups = useMemo(() => {
    const byGroup = new Map<string | undefined, ComboboxOption[]>();
    for (const option of shown) byGroup.set(option.group, [...(byGroup.get(option.group) ?? []), option]);
    const ungrouped = byGroup.get(undefined);
    byGroup.delete(undefined);
    return [...(ungrouped === undefined ? [] : [[undefined, ungrouped] as const]), ...byGroup];
  }, [shown]);
  const ordered = groups.flatMap(([, each]) => each);
  const enabled = ordered.filter((option) => option.disabled !== true);
  const optionId = (option: ComboboxOption) => `${listId}-${ordered.indexOf(option)}`;

  const show = (seed?: string) => {
    if (disabled) return;
    // Inside a dialog, the list goes into it: a modal keeps its focus and its clicks, and a <dialog> is on top of the page.
    setHost(trigger.current?.closest('dialog, [role="dialog"]') ?? document.body);
    setQuery(searching && seed !== undefined ? seed : "");
    setActive(chosen?.disabled === true ? undefined : chosen?.value);
    setPlace(undefined);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  const pick = (option: ComboboxOption) => {
    if (option.disabled === true) return;
    close(true);
    if (option.value !== value) onChange(option.value);
  };

  // The active option: the first enabled one when the search leaves it out.
  useEffect(() => {
    if (open && (active === undefined || !enabled.some((option) => option.value === active))) setActive(enabled[0]?.value);
  }, [open, active, enabled]);

  // Placed under the trigger (above it when there is no room), as wide as it at least. A fixed element
  // inside a transformed dialog is placed from the dialog: measured where (0, 0) lands, and moved from there.
  useLayoutEffect(() => {
    if (!open || popover.current === null || trigger.current === null) return;
    const el = popover.current;
    const rect = trigger.current.getBoundingClientRect();
    const box = host === undefined || host === document.body ? new DOMRect(0, 0, window.innerWidth, window.innerHeight) : host.getBoundingClientRect();
    const bounds = { top: Math.max(box.top, 0) + MARGIN, bottom: Math.min(box.bottom, window.innerHeight) - MARGIN, left: Math.max(box.left, 0) + MARGIN, right: Math.min(box.right, window.innerWidth) - MARGIN };
    // Measured once an opening, while it is still at (0, 0) and not scaled by its entrance.
    if (place === undefined) {
      const at = el.getBoundingClientRect();
      origin.current = { top: at.top, left: at.left };
    }
    const height = Math.min(el.scrollHeight, MAX_HEIGHT);
    const below = bounds.bottom - rect.bottom - GAP;
    const over = rect.top - GAP - bounds.top;
    const above = below < height && over > below;
    const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, above ? over : below));
    const width = Math.min(Math.max(rect.width, 220), bounds.right - bounds.left);
    const left = Math.min(Math.max(rect.left, bounds.left), bounds.right - width);
    const top = above ? rect.top - GAP - Math.min(height, maxHeight) : rect.bottom + GAP;
    const next = { top: top - origin.current.top, left: left - origin.current.left, width, maxHeight, above };
    if (place === undefined || Math.abs(next.top - place.top) > 0.5 || Math.abs(next.left - place.left) > 0.5 || next.width !== place.width || next.maxHeight !== place.maxHeight) setPlace(next);
  }, [open, host, place, shown.length]);

  // Once per opening: the focus in the list (or its search), and what closes it.
  useEffect(() => {
    if (!open) return;
    (searching ? input.current : list.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) closeRef.current(false);
    };
    // Escape closes the list, not the dialog around it: taken first, at the window, before the dialog's own listener.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    const moved = (event: Event) => {
      if (!(event.target instanceof Node && popover.current?.contains(event.target))) closeRef.current(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open, searching]);

  // The active option stays in view.
  const activeIndex = ordered.findIndex((option) => option.value === active);
  useEffect(() => {
    if (open && activeIndex >= 0 && place !== undefined) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId, place]);

  /** Type-ahead: the first option whose label starts with what was typed in the last half second. */
  const typeAhead = (key: string) => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at > 500 ? key : typed.current.text + key, at: now };
    const text = typed.current.text.toLowerCase();
    const found = enabled.find((option) => option.label.toLowerCase().startsWith(text)) ?? enabled.find((option) => option.label.toLowerCase().startsWith(key.toLowerCase()));
    if (found !== undefined) setActive(found.value);
    return found;
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = enabled.findIndex((option) => option.value === active);
    const go = (index: number) => {
      event.preventDefault();
      const option = enabled[Math.min(Math.max(index, 0), enabled.length - 1)];
      if (option !== undefined) setActive(option.value);
    };
    if (event.key === "ArrowDown") go(at < 0 ? 0 : at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? enabled.length - 1 : at - 1);
    else if (event.key === "Home" && !searching) go(0);
    else if (event.key === "End" && !searching) go(enabled.length - 1);
    else if (event.key === "PageDown") go(at + 8);
    else if (event.key === "PageUp") go(at - 8);
    else if (event.key === "Enter" || (event.key === " " && !searching)) {
      event.preventDefault();
      const option = enabled[at];
      if (option !== undefined) pick(option);
    } else if (event.key === "Tab") {
      event.preventDefault();
      close(true);
    } else if (!searching && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) typeAhead(event.key);
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      show();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Typed on the closed trigger: the list opens there (into the search, or at the option).
      event.preventDefault();
      show(event.key);
      if (!searching) typeAhead(event.key);
    }
  };

  const activeOption = ordered.find((option) => option.value === active);
  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
        className={`control flex min-w-0 cursor-pointer items-center gap-2 pr-2 text-left disabled:cursor-not-allowed ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${chosen === undefined ? "text-ink-3" : ""}`}>{chosen?.label ?? placeholder}</span>
        <NavArrowDown width={15} height={15} strokeWidth={2} aria-hidden className={`shrink-0 text-ink-2 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open &&
        host !== undefined &&
        createPortal(
          <div
            ref={popover}
            onKeyDown={onListKey}
            className="fixed z-50 flex flex-col overflow-hidden rounded-[10px] border border-(--control-border) bg-surface text-ink shadow-overlay"
            style={{
              top: place?.top ?? 0,
              left: place?.left ?? 0,
              width: place?.width,
              maxHeight: place?.maxHeight ?? MAX_HEIGHT,
              visibility: place === undefined ? "hidden" : undefined,
              animation: place === undefined ? undefined : "pop-in 140ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: place?.above === true ? "bottom" : "top",
            }}
          >
            {searching && (
              <div className="flex h-(--control-h) shrink-0 items-center gap-2 border-b border-line px-2.5">
                <Search width={14} height={14} strokeWidth={2} className="shrink-0 text-ink-3" aria-hidden />
                <input
                  ref={input}
                  role="combobox"
                  aria-label={`${label}: search`}
                  aria-autocomplete="list"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={activeOption === undefined ? undefined : optionId(activeOption)}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3 pointer-coarse:text-[16px]"
                />
              </div>
            )}
            <div
              ref={list}
              id={listId}
              role="listbox"
              aria-label={label}
              tabIndex={searching ? undefined : -1}
              aria-activedescendant={searching || activeOption === undefined ? undefined : optionId(activeOption)}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none"
            >
              {ordered.length === 0 && <p className="px-2 py-2 text-[13px] text-ink-3">{empty}</p>}
              {groups.map(([group, each]) => (
                <div key={group ?? ""} role={group === undefined ? undefined : "group"} aria-label={group}>
                  {group !== undefined && <div className="px-2 pt-2 pb-1 text-[12px] font-medium text-ink-3">{group}</div>}
                  {each.map((option) => {
                    const selected = option.value === value;
                    const isActive = option.value === active;
                    return (
                      <div
                        key={option.value}
                        id={optionId(option)}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={option.disabled === true || undefined}
                        onPointerMove={() => option.disabled !== true && !isActive && setActive(option.value)}
                        onClick={() => pick(option)}
                        className={`flex min-h-8 cursor-pointer items-start gap-2 rounded-[6px] py-1.5 pr-2 pl-1.5 text-[14px] leading-5 ${isActive ? "bg-(--control-hover)" : ""} ${option.disabled === true ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink">{selected && <Check width={14} height={14} strokeWidth={2.2} aria-hidden />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-ink">{option.label}</span>
                          {option.description !== undefined && <span className="block text-[12.5px] leading-[1.4] text-ink-3">{option.description}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          host,
        )}
    </>
  );
}
