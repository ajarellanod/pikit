import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreVert } from "iconoir-react";
import GlideMenu from "./GlideMenu";

/* ---------------------------------------------------------
 * ACTIONS MENU
 * The "…" of a row or a header: a dots button that opens, over
 * everything, the menu of what can be done to the thing it is on
 * (Rename, Archive, Delete…). One menu wherever the thing shows:
 * the sidebar's rows, a list's rows, a page's header.
 * Keyboard: Enter, Space or ArrowDown open it on the first item,
 * ArrowUp on the last; ArrowUp/ArrowDown, Home/End move; Escape
 * closes it back to its button; Tab closes it.
 * Also the menu's pieces (`MenuRow`, `MenuSeparator`, `MenuPopover`),
 * which the sidebar's foot menu uses too.
 * --------------------------------------------------------- */

/** One thing the menu does. */
export type ActionsMenuItem = { key: string; label: string; icon: ReactNode; danger?: boolean; onSelect: () => void };

/** Where the menu opens from its button: below it, its right edge on the button's (`end`) or its left (`start`). Above when there is no room below. */
export type ActionsMenuPlacement = "bottom-end" | "bottom-start";

/** One row of a menu. */
export function MenuRow({
  icon,
  children,
  trailing,
  onClick,
  height = "h-9",
  danger = false,
  role,
}: {
  icon?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  height?: string;
  danger?: boolean;
  role?: "menuitem";
}) {
  return (
    <button
      data-menu-row
      type="button"
      role={role}
      tabIndex={role === "menuitem" ? -1 : undefined}
      onClick={onClick}
      className={`relative z-10 flex ${height} w-full items-center gap-1.5 rounded-[8px] px-2 text-left ${role === "menuitem" ? "outline-none" : ""}`}
    >
      {icon !== undefined && <span className={`flex size-5 shrink-0 items-center justify-center [&_svg]:size-4 ${danger ? "text-red" : "text-ink-2"}`}>{icon}</span>}
      <span className={`min-w-0 flex-1 truncate text-[13.5px] ${danger ? "text-red" : "text-ink"}`}>{children}</span>
      {trailing}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}

/** A menu over everything, anchored at `position`: below a point (`top`), or above one (`bottom`); at `left`, or ending at `right`. */
export function MenuPopover({
  position,
  children,
  width = "w-64",
  label,
  role,
  onKeyDown,
  menuRef,
}: {
  position: { top?: number; bottom?: number; left?: number; right?: number };
  children: ReactNode;
  width?: string;
  label?: string;
  role?: "menu";
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  menuRef?: Ref<HTMLDivElement>;
}) {
  const above = position.bottom !== undefined;
  const fromRight = position.right !== undefined;
  return createPortal(
    <div
      ref={menuRef}
      data-workspace-menu
      role={role}
      aria-label={label}
      tabIndex={role === undefined ? undefined : -1}
      onKeyDown={onKeyDown}
      className={`fixed z-50 ${width} rounded-[14px] bg-surface p-1.5 shadow-overlay outline-none`}
      style={{
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        right: position.right,
        animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: `${above ? "bottom" : "top"} ${fromRight ? "right" : "left"}`,
      }}
    >
      <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
        {children}
      </GlideMenu>
    </div>,
    document.body,
  );
}

const ROW_HEIGHT = 37;
const GAP = 4;

/** Where the menu of a button at `rect` opens: below it unless there is no room, then above. */
function placeOf(rect: DOMRect, placement: ActionsMenuPlacement, rows: number): { top?: number; bottom?: number; left?: number; right?: number } {
  const height = rows * ROW_HEIGHT + 12;
  const vertical = rect.bottom + GAP + height > window.innerHeight - 8 && rect.top - GAP - height > 8 ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP };
  const horizontal = placement === "bottom-end" ? { right: Math.max(8, window.innerWidth - rect.right) } : { left: Math.max(8, rect.left) };
  return { ...vertical, ...horizontal };
}

/**
 * A dots button and the menu of `actions` it opens. `label` names the button ("Actions for …"); the menu
 * is named after it. Open state is its own, or the caller's (`open`, `onOpenChange`: one menu open at a
 * time in a list). An item chosen closes the menu, then runs.
 */
export function ActionsMenu({
  actions,
  label,
  placement = "bottom-end",
  open: controlled,
  onOpenChange,
  className = "",
  iconSize = 16,
  width = "w-44",
}: {
  actions: readonly ActionsMenuItem[];
  label: string;
  placement?: ActionsMenuPlacement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** the button's classes (its size, colours, when it shows); `aria-expanded:` styles it open */
  className?: string;
  iconSize?: number;
  width?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left?: number; right?: number }>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Which item gets the focus when the menu opens: the first, the last, or none (opened by a pointer). */
  const focusOnOpen = useRef<"first" | "last" | undefined>(undefined);

  const told = useRef(onOpenChange);
  told.current = onOpenChange;
  const isControlled = controlled !== undefined;
  const setOpen = (next: boolean) => {
    if (!isControlled) setOwn(next);
    told.current?.(next);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const show = (focus: "first" | "last" | undefined) => {
    const rect = button.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setPosition(placeOf(rect, placement, actions.length));
    focusOnOpen.current = focus;
    setOpen(true);
  };

  // Opened by the caller (controlled) without a click here: placed from the button.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = button.current?.getBoundingClientRect();
    if (rect !== undefined) setPosition(placeOf(rect, placement, actions.length));
  }, [open, placement, actions.length]);

  // Once per opening: the focus in the menu, and what closes it.
  useEffect(() => {
    if (!open) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const focus = focusOnOpen.current;
    focusOnOpen.current = undefined;
    if (focus === "first") items[0]?.focus();
    else if (focus === "last") items.at(-1)?.focus();
    else menu.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) closeRef.current(false);
    };
    // The page moving under it (a list scrolled, the window resized): it closes, never floats astray.
    const moved = (event: Event) => {
      if (!(event.target instanceof Node && menu.current?.contains(event.target))) closeRef.current(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", moved);
    document.addEventListener("scroll", moved, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at < 0 ? items.length - 1 : at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") close(false);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => (open ? close(false) : show(event.detail === 0 ? "first" : undefined))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
        className={`flex shrink-0 items-center justify-center ${className}`}
      >
        <MoreVert width={iconSize} height={iconSize} strokeWidth={2} />
      </button>
      {open && (
        <MenuPopover position={position} width={width} role="menu" label={label} onKeyDown={onMenuKey} menuRef={menu}>
          {actions.map((action) => (
            <MenuRow
              key={action.key}
              role="menuitem"
              icon={action.icon}
              danger={action.danger === true}
              onClick={() => {
                close(false);
                action.onSelect();
              }}
            >
              {action.label}
            </MenuRow>
          ))}
        </MenuPopover>
      )}
    </>
  );
}
