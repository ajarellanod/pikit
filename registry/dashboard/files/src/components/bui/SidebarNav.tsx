import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavArrowDown, Search, SidebarCollapse, Xmark } from "iconoir-react";
import GlideMenu from "./GlideMenu";

/* ---------------------------------------------------------
 * SIDEBAR NAV
 * Beautiful UI's harness sidebar, fed by the app: a workspace
 * menu, primary navigation, a searchable list of chats, and a
 * collapse that keeps every icon in place. Icons: iconoir.
 * --------------------------------------------------------- */

export type SidebarItem = {
  key: string;
  label: string;
  icon: ReactNode;
  /** a short figure at the row's end */
  count?: string;
  active?: boolean;
  /** the link's target, for a new tab; a plain click calls `onSelect` */
  href?: string;
  onSelect: () => void;
};

export type SidebarChat = {
  id: string;
  label: string;
  /** what it is, at the row's end: its channel */
  meta?: string;
  busy?: boolean;
  active?: boolean;
  href?: string;
};

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

const CHAT_SEARCH_MOTION = {
  duration: 180,
  closedWidth: 28,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

/** A plain left click follows `onSelect`; any other (a new tab) follows the link. */
function follow(event: MouseEvent, onSelect: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onSelect();
}

function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu rowSelector="[data-row]" highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2" className="group/glide flex flex-col gap-px">
      {children}
    </GlideMenu>
  );
}

function RailButton({ item }: { item: SidebarItem }) {
  const { icon, label, active = false, count, href, onSelect } = item;
  return (
    <a
      data-row
      href={href}
      onClick={(event) => follow(event, onSelect)}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center [&_svg]:size-[18px] ${active ? "text-ink" : "text-ink-2"}`}>{icon}</span>
      <span className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>{label}</span>
      {count && <span className="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{count}</span>}
    </a>
  );
}

/** One row of the workspace menu. */
export function MenuRow({ icon, children, trailing, onClick, height = "h-9" }: { icon?: ReactNode; children: ReactNode; trailing?: ReactNode; onClick?: () => void; height?: string }) {
  return (
    <button data-menu-row type="button" onClick={onClick} className={`relative z-10 flex ${height} w-full items-center gap-1.5 rounded-[8px] px-2 text-left`}>
      {icon !== undefined && <span className="flex size-5 shrink-0 items-center justify-center text-ink-2 [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{children}</span>
      {trailing}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />;
}

function WorkspaceMenu({ position, children }: { position: { top: number; left: number }; children: ReactNode }) {
  return createPortal(
    <div
      data-workspace-menu
      className="fixed z-50 w-64 rounded-[14px] bg-surface p-1.5 shadow-overlay"
      style={{ top: position.top, left: position.left, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
    >
      <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
        {children}
      </GlideMenu>
    </div>,
    document.body,
  );
}

export default function SidebarNav({
  workspace,
  menu,
  items,
  chats,
  onPickChat,
  chatsFooter,
  chatsEmpty = "No chats yet",
  defaultCollapsed = false,
  className = "",
}: {
  workspace: { name: string; logo: ReactNode };
  /** the workspace menu's rows (`MenuRow`, `MenuSeparator`); `close` closes it */
  menu: (close: () => void) => ReactNode;
  items: SidebarItem[];
  chats: SidebarChat[];
  onPickChat: (id: string) => void;
  /** after the chats: "older" */
  chatsFooter?: ReactNode;
  chatsEmpty?: string;
  defaultCollapsed?: boolean;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePosition, setWorkspacePosition] = useState({ top: 0, left: 0 });
  const [chatsOpen, setChatsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const needle = query.trim().toLowerCase();
  const visibleChats = chats.filter((chat) => `${chat.label} ${chat.meta ?? ""}`.toLowerCase().includes(needle));

  useEffect(() => {
    if (!workspaceOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!target.closest("[data-workspace-trigger]") && !target.closest("[data-workspace-menu]")) setWorkspaceOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setWorkspaceOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [workspaceOpen]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const collapse = () => {
    setCollapsed(true);
    setWorkspaceOpen(false);
    setSearchOpen(false);
    setQuery("");
  };

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Navigation"
      className={`relative flex h-full shrink-0 overflow-hidden transition-[width] ${className}`}
      style={
        {
          width: collapsed ? SIDEBAR_MOTION.collapsedWidth : SIDEBAR_MOTION.expandedWidth,
          transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
          transitionTimingFunction: SIDEBAR_MOTION.easing,
          "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
          "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
          "--sidebar-easing": SIDEBAR_MOTION.easing,
        } as CSSProperties
      }
    >
      <div className="flex min-h-0 w-[224px] shrink-0 flex-col">
        <div className="relative mb-2.5 h-10 shrink-0">
          <button
            ref={workspaceButtonRef}
            data-workspace-trigger
            type="button"
            aria-expanded={workspaceOpen}
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => {
              if (!workspaceOpen && workspaceButtonRef.current) {
                const rect = workspaceButtonRef.current.getBoundingClientRect();
                setWorkspacePosition({ top: rect.bottom + 6, left: rect.left });
              }
              setWorkspaceOpen((open) => !open);
            }}
            className="sidebar-workspace-control absolute top-1 left-2 flex h-8 w-[164px] items-center rounded-[8px] px-2 text-left transition-[background-color,transform] duration-100 hover:bg-hover-2 active:scale-[0.99]"
          >
            <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink">{workspace.logo}</span>
            <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">{workspace.name}</span>
            <span className="sidebar-copy ml-1 flex shrink-0 text-ink-3">
              <NavArrowDown width={16} height={16} strokeWidth={2} />
            </span>
          </button>

          {workspaceOpen && <WorkspaceMenu position={workspacePosition}>{menu(() => setWorkspaceOpen(false))}</WorkspaceMenu>}

          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={collapse}
            className="sidebar-collapse-control absolute top-1 right-2 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <SidebarCollapse width={18} height={18} />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsed(false)}
            className="sidebar-expand-control absolute top-0.5 left-2 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <SidebarCollapse width={18} height={18} className="rotate-180" />
          </button>
        </div>

        <GlideGroup>
          {items.map((item) => (
            <RailButton key={item.key} item={item} />
          ))}
        </GlideGroup>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          <div className="sidebar-copy relative mx-2 mb-1 h-8">
            <button
              type="button"
              aria-hidden={searchOpen}
              aria-expanded={chatsOpen}
              tabIndex={searchOpen ? -1 : 0}
              onClick={() => setChatsOpen((open) => !open)}
              className={`absolute inset-y-0 left-0 flex items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform,color] hover:text-ink-2 ${searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing }}
            >
              <NavArrowDown width={16} height={16} strokeWidth={2} className="transition-transform duration-200" style={{ transform: chatsOpen ? "rotate(0deg)" : "rotate(-90deg)" }} />
              <span>Chats</span>
            </button>

            <button
              type="button"
              aria-label="Search chats"
              aria-expanded={searchOpen}
              onClick={() => {
                setChatsOpen(true);
                setSearchOpen(true);
              }}
              className={`absolute top-0 right-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] ${searchOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
              style={{ transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms` }}
            >
              <Search width={16} height={16} strokeWidth={1.8} />
            </button>

            <div
              className={`absolute top-0 right-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2 ${searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
              style={{ width: searchOpen ? "100%" : CHAT_SEARCH_MOTION.closedWidth, transitionDuration: `${CHAT_SEARCH_MOTION.duration}ms`, transitionTimingFunction: CHAT_SEARCH_MOTION.easing }}
            >
              <span className="ml-2 flex shrink-0 items-center justify-center">
                <Search width={15} height={15} strokeWidth={1.8} />
              </span>
              <input
                ref={searchRef}
                value={query}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearchOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Search chats"
                aria-label="Search the chats"
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                aria-label="Close chat search"
                tabIndex={searchOpen ? 0 : -1}
                onClick={() => {
                  setSearchOpen(false);
                  setQuery("");
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
              >
                <Xmark width={16} height={16} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {chatsOpen && (
            <GlideGroup>
              {visibleChats.map((chat) => (
                <a
                  key={chat.id}
                  data-row
                  href={chat.href}
                  title={chat.meta === undefined ? chat.label : `${chat.label} (${chat.meta})`}
                  aria-current={chat.active ? "page" : undefined}
                  onClick={(event) => follow(event, () => onPickChat(chat.id))}
                  className={`sidebar-row relative z-10 mx-2 flex h-8 items-center gap-2 rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${chat.active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`}
                >
                  <span className={`sidebar-copy min-w-0 flex-1 truncate text-[14px] font-medium ${chat.active ? "text-ink" : "text-ink-2"}`}>{chat.label}</span>
                  {chat.busy === true && (
                    <span aria-label="Running" className="sidebar-copy size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />
                  )}
                  {chat.meta !== undefined && <span className="sidebar-copy shrink-0 text-[12px] font-medium text-ink-3">{chat.meta}</span>}
                </a>
              ))}
              {visibleChats.length === 0 && <div className="sidebar-copy mx-2 px-2 py-2 text-[12.5px] text-ink-3">{needle === "" ? chatsEmpty : "No chats found"}</div>}
              {chatsFooter}
            </GlideGroup>
          )}
        </div>
      </div>
    </aside>
  );
}
